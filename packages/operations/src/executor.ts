import type { ResourceProvenance, Usage } from '@genai/contracts';
import {
  authHeaders,
  ShapeError,
  walk,
  withoutTrailingSlashes,
  type Credential,
  type Gate,
  type GatePayload,
  type GateTarget,
  type PortContext,
} from '@genai/kernel';
import type { Descriptor } from './descriptor.js';
import { evaluate } from './mapping.js';

export class OperationError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

export interface DescribedEndpoint {
  baseURL: string;
  credential: Credential;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface WireRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface Answer<Res = unknown> {
  result: Res;
  usage: Usage;
  dropped: number;
}

/** Builds the wire request from the typed input and refuses one outside the descriptor's wire shape. */
export const wireRequest = (
  descriptor: Descriptor,
  input: unknown,
  deployment: string,
): WireRequest => {
  const body = evaluate(descriptor.request.body, { input, deployment });
  const walked = walk(descriptor.wire.request, body, { side: 'request' });
  if (walked.media.length > 0 || walked.problems.length > 0)
    throw new ShapeError(
      `${descriptor.id} built a request outside its wire shape: ${[...walked.problems, ...walked.media.map((m) => `${m}: media`)].join('; ')}`,
    );
  return {
    method: descriptor.request.method,
    path: descriptor.request.path.replace('{deployment}', encodeURIComponent(deployment)),
    query: descriptor.api.query,
    headers: descriptor.api.headers,
    body: walked.value,
  };
};

/** Reads a wire answer through the descriptor: unknown fields are dropped and counted. */
export const wireAnswer = <Res = unknown>(
  descriptor: Descriptor,
  raw: unknown,
  input: unknown,
  deployment: string,
): Answer<Res> => {
  const walked = walk(descriptor.wire.response, raw, { side: 'result' });
  if (walked.problems.length > 0)
    throw new ShapeError(
      `the provider answered ${descriptor.id} outside its wire shape: ${walked.problems.join('; ')}`,
    );
  const response = walked.value;
  const usage = evaluate(descriptor.usage, { response }) as Usage;
  const result = evaluate(descriptor.result, {
    response,
    input,
    deployment,
    usage,
    dropped: walked.dropped,
  }) as Res;
  return { result, usage, dropped: walked.dropped };
};

const messageOf = async (response: Response) => {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const message = body.error?.message ?? body.message;
    if (typeof message === 'string') return message.slice(0, 500);
  } catch {
    return `the provider answered ${response.status}`;
  }
  return `the provider answered ${response.status}`;
};

export interface SendOptions {
  signal?: AbortSignal;
  fail?: (status: number | undefined, message: string) => Error;
}

/** Sends a typed input that the gate has already held to its shape, and maps the answer back. */
export const describedSend = async <Res = unknown>(
  descriptor: Descriptor,
  endpoint: DescribedEndpoint,
  deployment: string,
  input: unknown,
  options: SendOptions = {},
): Promise<Answer<Res>> => {
  const fail = options.fail ?? ((status, message) => new OperationError(status, message));
  const request = wireRequest(descriptor, input, deployment);
  const url = new URL(`${withoutTrailingSlashes(endpoint.baseURL)}${request.path}`);
  for (const [name, value] of Object.entries(request.query)) url.searchParams.set(name, value);
  const signals = [
    ...(options.signal ? [options.signal] : []),
    ...(endpoint.timeoutMs ? [AbortSignal.timeout(endpoint.timeoutMs)] : []),
  ];
  const response = await (endpoint.fetch ?? globalThis.fetch)(url, {
    method: request.method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...request.headers,
      ...(await authHeaders(endpoint.credential, descriptor.auth.keyHeader)),
    },
    body: JSON.stringify(request.body),
    ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
  });
  if (!response.ok) throw fail(response.status, await messageOf(response));
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw fail(undefined, `the provider did not answer ${descriptor.id} with JSON`);
  }
  return wireAnswer<Res>(descriptor, raw, input, deployment);
};

export interface DescribedCall {
  gate: Gate;
  ctx: PortContext;
  target: GateTarget;
  descriptor: Descriptor;
  endpoint: DescribedEndpoint;
  deployment: string;
  priced?: (usage: Usage) => Usage;
  provenance?: () => ResourceProvenance | undefined;
  fail?: SendOptions['fail'];
}

/** The one executor: a descriptor call through the gate, held to the descriptor's own shapes. */
export const describedCall = async <Res = unknown>(
  call: DescribedCall,
  input: unknown,
): Promise<Res> => {
  const { descriptor } = call;
  let answered: Answer<Res> | undefined;
  const payload: GatePayload<Res> = {
    shape: { request: descriptor.input, result: descriptor.output },
    usage: () => answered && (call.priced ? call.priced(answered.usage) : answered.usage),
    dropped: () => answered?.dropped,
    ...(call.provenance ? { provenance: call.provenance } : {}),
  };
  return call.gate.call(
    call.ctx,
    { ...call.target, descriptor: descriptor.id },
    payload,
    input,
    async (sent) => {
      answered = await describedSend<Res>(descriptor, call.endpoint, call.deployment, sent, {
        signal: call.ctx.signal,
        ...(call.fail ? { fail: call.fail } : {}),
      });
      return answered.result;
    },
  );
};
