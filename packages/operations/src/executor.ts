import type { ResourceProvenance, Usage } from '@genai/contracts';
import {
  encodeBase64,
  isMediaInput,
  ShapeError,
  walk,
  withoutTrailingSlashes,
  type Credential,
  type Gate,
  type GatePayload,
  type GateTarget,
  type PortContext,
  type Shape,
} from '@genai/kernel';
import {
  maxRetryWaitSeconds,
  modelFieldsOf,
  type CredentialPlacement,
  type Descriptor,
  type ErrorRule,
  type OperationErrorKind,
  type Step,
} from './descriptor.js';
import {
  acceptOf,
  AnswerFormatError,
  contentTypeFits,
  decodeAnswer,
  encodeBody,
  recordedBody,
} from './encoding.js';
import { evaluate, holds } from './mapping.js';
import { unwrapped } from './shape.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class OperationError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
    readonly kind?: OperationErrorKind,
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
  /** Waits between polls and before a retry; tests pass one that does not wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface Answer<Res = unknown> {
  result: Res;
  usage: Usage;
  dropped: number;
}

export const maxRequestsPerCall = 100;
export const maxAnswerBytes = 32 * 1024 * 1024;

/** One request and its answer as a fixture records it. */
export interface RecordedRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body: unknown;
}

export interface RecordedResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface StepExchange {
  step: string;
  request: RecordedRequest;
  response: RecordedResponse;
}

/** One call as a fixture records it: the masked typed input, every wire request and answer, and the result. */
export interface WireExchange {
  deployment: string;
  input: unknown;
  request?: RecordedRequest;
  response?: RecordedResponse;
  steps?: StepExchange[];
  result: unknown;
  usage: Usage;
  dropped: number;
}

export interface SendOptions {
  signal?: AbortSignal;
  fail?: (status: number | undefined, message: string, kind?: OperationErrorKind) => Error;
  observe?: (exchange: WireExchange) => void;
  /** Sees each classified value before it is encoded; operation@1 uses it to look for text that was not input text. */
  inspect?: (shape: Shape, value: unknown) => void;
}

const usageFieldNames = new Set([
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'audioSeconds',
  'images',
  'videoSeconds',
  'characters',
  'requests',
]);

const countOf = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
};

const addUsage = (total: Usage, mapped: unknown) => {
  if (!isRecord(mapped)) return;
  for (const [key, value] of Object.entries(mapped)) {
    const count = countOf(value);
    if (count === undefined) continue;
    if (usageFieldNames.has(key)) {
      const field = key as keyof Omit<Usage, 'units'>;
      total[field] = (total[field] ?? 0) + count;
    } else total.units = { ...total.units, [key]: (total.units?.[key] ?? 0) + count };
  }
};

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    });
  });

/** Seconds a `Retry-After` header asks for, as a number of seconds or an HTTP date. */
export const retryAfterSeconds = (header: string | null, now = Date.now()): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - now) / 1000);
};

const statusMatches = (rule: ErrorRule['status'], status: number) =>
  rule === '4xx'
    ? status >= 400 && status < 500
    : rule === '5xx'
      ? status >= 500
      : Array.isArray(rule)
        ? rule.includes(status)
        : rule === status;

const defaultMessage = (body: unknown, status: number) => {
  const b = isRecord(body) ? body : {};
  const error = isRecord(b.error) ? b.error : {};
  const message = error.message ?? b.message;
  return typeof message === 'string' ? message.slice(0, 500) : `the provider answered ${status}`;
};

const readErrorBody = async (response: Response) => {
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 500);
  }
};

interface RunState {
  input: unknown;
  deployment: string;
  steps: Record<string, Record<string, unknown>>;
  secrets: Map<string, string>;
  issued: Set<string>;
  usage: Usage;
  dropped: number;
  exchanges: StepExchange[];
  last: { response: unknown; headers: Record<string, unknown> };
  requests: number;
  ran: Set<string>;
}

const credentialValue = async (credential: Credential) =>
  credential.kind === 'bearer' ? credential.token() : credential.key();

const placed = (placement: CredentialPlacement, value: string) =>
  placement.place === 'query'
    ? { query: { [placement.name]: value }, headers: {} }
    : {
        query: {},
        headers: {
          [placement.name]: placement.scheme ? `${placement.scheme} ${value}` : value,
        },
      };

/** Only the gate places a credential: the connection's, or a secret an earlier step bound. */
const credentialFor = async (
  descriptor: Descriptor,
  step: Step,
  endpoint: DescribedEndpoint,
  state: RunState,
) => {
  if (step.auth) {
    const secret = state.secrets.get(`${step.auth.secret.step}.${step.auth.secret.field}`);
    if (!secret) throw new ShapeError(`step ${step.name} has no secret to place`);
    return { ...placed(step.auth, secret), value: secret };
  }
  const { credential } = endpoint;
  const value = await credentialValue(credential);
  if (credential.kind === 'bearer')
    return { query: {}, headers: { authorization: `Bearer ${value}` }, value };
  if (credential.header) {
    const header = credential.header.toLowerCase();
    return {
      query: {},
      headers: { [header]: header === 'authorization' ? `Bearer ${value}` : value },
      value,
    };
  }
  return { ...placed(descriptor.auth, value), value };
};

const walkedOrRefused = (
  descriptor: Descriptor,
  step: Step,
  what: string,
  shape: Shape,
  value: unknown,
  state: RunState,
  options: SendOptions,
) => {
  const walked = walk(shape, value, { side: 'request', issued: state.issued });
  const notRead = walked.inputs.filter((i) => !isMediaInput(i.value)).map((i) => i.path);
  const problems = [
    ...walked.problems,
    ...walked.media.map((m) => `${m}: media`),
    ...notRead.map((p) => `${p}: media the gate has not admitted`),
  ];
  if (problems.length > 0)
    throw new ShapeError(
      `${descriptor.id} step ${step.name} built ${what} outside its wire shape: ${problems.join('; ')}`,
    );
  options.inspect?.(shape, walked.value);
  return walked.value;
};

const withDeployment = (value: unknown, fields: string[], deployment: string) =>
  fields.reduce(
    (b, field) => (isRecord(b) && field in b ? { ...b, [field]: deployment } : b),
    value,
  );

const pathOf = (descriptor: Descriptor, step: Step, state: RunState) =>
  step.request.path.replace(/\{([^}]*)\}/g, (_, name: string) => {
    if (name === 'deployment') return encodeURIComponent(state.deployment);
    const [, from = '', field = ''] = name.split('.');
    const value = state.steps[from]?.[field];
    if (typeof value !== 'string' || !state.issued.has(value))
      throw new ShapeError(
        `${descriptor.id} step ${step.name}: {${name}} was not issued in this run`,
      );
    if (/^[a-z][a-z0-9+.-]*:|\/\//i.test(value))
      throw new ShapeError(
        `${descriptor.id} step ${step.name}: {${name}} is a URL; Genki does not follow answer URLs`,
      );
    return encodeURIComponent(value);
  });

const stringValues = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, typeof v === 'string' ? v : String(v)]],
    ),
  );

const runChecks = (descriptor: Descriptor, step: Step, scope: Record<string, unknown>) => {
  for (const check of step.checks) {
    const fail = (message: string) => {
      throw new OperationError(undefined, `${descriptor.id} step ${step.name}: ${message}`);
    };
    if (check.kind === 'same-names') {
      const expected = evaluate(check.expected, scope);
      const actual = evaluate(check.actual, scope);
      if (!Array.isArray(expected) || !Array.isArray(actual)) fail('same-names reads two lists');
      const want = [...(expected as unknown[])].map(String).sort();
      const got = [...(actual as unknown[])].map(String).sort();
      if (JSON.stringify(want) !== JSON.stringify(got))
        fail(`the answer names ${got.join(', ')}, not ${want.join(', ')}`);
    } else if (check.kind === 'count') {
      const of = evaluate(check.of, scope);
      if (!Array.isArray(of)) return fail('count reads a list');
      const same = check.sameAs === undefined ? undefined : evaluate(check.sameAs, scope);
      if (same !== undefined && (!Array.isArray(same) || same.length !== of.length))
        fail(`the answer has ${of.length} items, not ${Array.isArray(same) ? same.length : '?'}`);
      if (check.min !== undefined && of.length < check.min)
        fail(`the answer has ${of.length} items, fewer than ${check.min}`);
      if (check.max !== undefined && of.length > check.max)
        fail(`the answer has ${of.length} items, more than ${check.max}`);
    } else {
      const value = evaluate(check.value, scope);
      const allowed = evaluate(check.in, scope);
      if (!Array.isArray(allowed)) return fail('one-of reads a list');
      for (const v of Array.isArray(value) ? value : [value])
        if (!allowed.includes(v)) fail(`${String(v)} is not one of ${allowed.join(', ')}`);
    }
  }
};

const runStep = async (
  descriptor: Descriptor,
  step: Step,
  endpoint: DescribedEndpoint,
  state: RunState,
  options: SendOptions,
  fail: NonNullable<SendOptions['fail']>,
) => {
  const sleep = endpoint.sleep ?? defaultSleep;
  const scope = { input: state.input, deployment: state.deployment, steps: state.steps };
  const built = evaluate(step.request.body, scope);
  const body =
    step.wire.request === undefined
      ? undefined
      : walkedOrRefused(
          descriptor,
          step,
          'a request',
          step.wire.request,
          withDeployment(built, modelFieldsOf(step.wire.request), state.deployment),
          state,
          options,
        );
  const query = step.wire.query
    ? stringValues(
        walkedOrRefused(
          descriptor,
          step,
          'a query',
          step.wire.query,
          withDeployment(
            evaluate(step.request.query, scope),
            modelFieldsOf(step.wire.query),
            state.deployment,
          ),
          state,
          options,
        ),
      )
    : {};
  const headers = step.wire.headers
    ? stringValues(
        walkedOrRefused(
          descriptor,
          step,
          'headers',
          step.wire.headers,
          evaluate(step.request.headers, scope),
          state,
          options,
        ),
      )
    : {};
  const path = pathOf(descriptor, step, state);
  const responseMedia =
    step.response.encoding === 'binary'
      ? (unwrapped(step.wire.response) as { type: string }).type
      : undefined;
  let waited = 0;
  let retries = 0;
  for (;;) {
    state.requests += 1;
    if (state.requests > maxRequestsPerCall)
      throw fail(undefined, `${descriptor.id} made more than ${maxRequestsPerCall} requests`);
    const credential = await credentialFor(descriptor, step, endpoint, state);
    const url = new URL(`${withoutTrailingSlashes(endpoint.baseURL)}${path}`);
    for (const [name, value] of Object.entries({
      ...descriptor.api.query,
      ...query,
      ...credential.query,
    }))
      url.searchParams.set(name, value);
    const encoded = encodeBody(step.request.encoding, body);
    const signals = [
      ...(options.signal ? [options.signal] : []),
      ...(endpoint.timeoutMs ? [AbortSignal.timeout(endpoint.timeoutMs)] : []),
    ];
    const response = await (endpoint.fetch ?? globalThis.fetch)(url, {
      method: step.request.method,
      headers: {
        ...(encoded.contentType ? { 'content-type': encoded.contentType } : {}),
        accept: acceptOf(step.response.encoding, responseMedia),
        ...descriptor.api.headers,
        ...headers,
        ...credential.headers,
      },
      ...(encoded.body === undefined ? {} : { body: encoded.body }),
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
    }).catch((error: unknown) => {
      if (
        Object.keys(credential.query).length > 0 &&
        error instanceof Error &&
        error.message.includes(credential.value)
      )
        throw new Error(error.message.replaceAll(credential.value, '[redacted]'));
      throw error;
    });
    const request: RecordedRequest = {
      method: step.request.method,
      path,
      ...(Object.keys({ ...descriptor.api.query, ...query }).length
        ? { query: { ...descriptor.api.query, ...query } }
        : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      body: await recordedBody(encoded.body, encoded.contentType ?? null),
    };
    if (!response.ok) {
      const errorBody = await readErrorBody(response);
      const errorHeaders = Object.fromEntries(response.headers);
      state.exchanges.push({
        step: step.name,
        request,
        response: { status: response.status, body: errorBody },
      });
      const rule = step.errors.find((r) => statusMatches(r.status, response.status));
      const kind = rule?.kind ?? (response.status === 429 ? 'rate-limited' : undefined);
      const after = retryAfterSeconds(response.headers.get('retry-after'));
      if (
        kind === 'rate-limited' &&
        after !== undefined &&
        after <= step.retry.longestWaitSeconds &&
        retries < step.retry.attempts
      ) {
        retries += 1;
        await sleep(after * 1000, options.signal);
        continue;
      }
      const mapped = rule?.message
        ? evaluate(rule.message, { response: errorBody, headers: errorHeaders })
        : undefined;
      throw fail(
        response.status,
        typeof mapped === 'string'
          ? mapped.slice(0, 500)
          : defaultMessage(errorBody, response.status),
        rule?.kind,
      );
    }
    const contentType = response.headers.get('content-type');
    if (!contentTypeFits(step.response.encoding, contentType, responseMedia))
      throw fail(
        undefined,
        `${descriptor.id} step ${step.name} declares a ${responseMedia ?? step.response.encoding} answer, and the provider answered ${contentType ?? 'without a content type'}`,
      );
    let raw: unknown;
    try {
      raw = await decodeAnswer(step.response.encoding, response, maxAnswerBytes);
    } catch (error) {
      if (error instanceof AnswerFormatError)
        throw fail(undefined, `${descriptor.id} step ${step.name}: ${error.message}`);
      throw error;
    }
    const recordedHeaders: Record<string, string> = {};
    const answerHeaders: Record<string, unknown> = {};
    for (const [name, shape] of Object.entries(step.response.headers)) {
      const value = response.headers.get(name);
      if (value === null) continue;
      recordedHeaders[name] = value;
      answerHeaders[name] = unwrapped(shape).kind === 'number' ? countOf(value) : value;
    }
    state.exchanges.push({
      step: step.name,
      request,
      response: {
        status: response.status,
        ...(Object.keys(recordedHeaders).length ? { headers: recordedHeaders } : {}),
        body: raw,
      },
    });
    const walked = walk(step.wire.response, raw, { side: 'result' });
    const walkedHeaders = walk({ kind: 'object', fields: step.response.headers }, answerHeaders, {
      side: 'result',
    });
    const problems = [...walked.problems, ...walkedHeaders.problems];
    if (problems.length > 0)
      throw new ShapeError(
        `the provider answered ${descriptor.id} step ${step.name} outside its wire shape: ${problems.join('; ')}`,
      );
    state.dropped += walked.dropped;
    const answer = {
      response: walked.value,
      headers: walkedHeaders.value as Record<string, unknown>,
    };
    addUsage(state.usage, evaluate(step.usage, answer));
    if (
      step.until &&
      !holds(evaluate(step.until.test, answer), evaluate(step.until.equals, answer))
    ) {
      const after = retryAfterSeconds(response.headers.get('retry-after'));
      const wait = Math.max(step.until.intervalSeconds, Math.min(after ?? 0, maxRetryWaitSeconds));
      if (waited + wait > step.until.longestSeconds)
        throw fail(
          undefined,
          `${descriptor.id} step ${step.name} did not finish within ${step.until.longestSeconds} seconds`,
          'unavailable',
        );
      waited += wait;
      await sleep(wait * 1000, options.signal);
      continue;
    }
    runChecks(descriptor, step, { ...scope, ...answer });
    const bound: Record<string, unknown> = {};
    for (const [field, spec] of Object.entries(step.bind)) {
      const value = evaluate(spec.from, answer);
      if (spec.class.kind === 'secret') {
        if (typeof value !== 'string' || !value)
          throw new ShapeError(
            `${descriptor.id} step ${step.name}: the secret ${field} is not text`,
          );
        state.secrets.set(`${step.name}.${field}`, value);
        continue;
      }
      const checked = walk(spec.class.shape, value, { side: 'result' });
      if (checked.problems.length > 0)
        throw new ShapeError(
          `${descriptor.id} step ${step.name}: bind.${field}: ${checked.problems.join('; ')}`,
        );
      if (unwrapped(spec.class.shape).kind === 'ref' && typeof checked.value === 'string')
        state.issued.add(checked.value);
      bound[field] = checked.value;
    }
    state.steps[step.name] = bound;
    state.ran.add(step.name);
    return answer;
  }
};

const readsOnly = (step: Step, ran: Set<string>) =>
  JSON.stringify([step.request, step.auth ?? null])
    .match(/\$?steps\.([a-z][a-z0-9_]*)\./g)
    ?.map((m) => m.replace(/^\$?steps\./, '').replace(/\.$/, ''))
    .every((name) => ran.has(name)) ?? true;

const inlineMedia = (value: unknown): unknown => {
  if (isMediaInput(value)) return { mediaType: value.mediaType, data: encodeBase64(value.body) };
  if (Array.isArray(value)) return value.map(inlineMedia);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inlineMedia(v)]));
  return value;
};

const withoutSecrets = (exchange: WireExchange, secrets: Iterable<string>): WireExchange => {
  let text = JSON.stringify(exchange);
  for (const secret of secrets)
    text = text.replaceAll(JSON.stringify(secret).slice(1, -1), '[secret]');
  return JSON.parse(text) as WireExchange;
};

/** Sends a typed input that the gate has already held to its shape, step by step, and maps the answer back. */
export const describedSend = async <Res = unknown>(
  descriptor: Descriptor,
  endpoint: DescribedEndpoint,
  deployment: string,
  input: unknown,
  options: SendOptions = {},
): Promise<Answer<Res>> => {
  const fail =
    options.fail ?? ((status, message, kind) => new OperationError(status, message, kind));
  const state: RunState = {
    input,
    deployment,
    steps: {},
    secrets: new Map(),
    issued: new Set(),
    usage: {},
    dropped: 0,
    exchanges: [],
    last: { response: undefined, headers: {} },
    requests: 0,
    ran: new Set(),
  };
  let failure: unknown;
  try {
    for (const step of descriptor.steps)
      state.last = await runStep(descriptor, step, endpoint, state, options, fail);
  } catch (error) {
    failure = error;
  }
  for (const step of descriptor.finally) {
    if (!readsOnly(step, state.ran)) continue;
    try {
      await runStep(descriptor, step, endpoint, state, options, fail);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  const usage = state.usage;
  const result = evaluate(descriptor.result, {
    response: state.last.response,
    headers: state.last.headers,
    input,
    deployment,
    usage,
    dropped: state.dropped,
    steps: state.steps,
  }) as Res;
  if (options.observe) {
    const one = state.exchanges.length === 1 ? state.exchanges[0] : undefined;
    options.observe(
      withoutSecrets(
        {
          deployment,
          input: inlineMedia(input),
          ...(one ? { request: one.request, response: one.response } : { steps: state.exchanges }),
          result,
          usage,
          dropped: state.dropped,
        },
        state.secrets.values(),
      ),
    );
  }
  return { result, usage, dropped: state.dropped };
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
  observe?: SendOptions['observe'];
  inspect?: SendOptions['inspect'];
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
        ...(call.observe ? { observe: call.observe } : {}),
        ...(call.inspect ? { inspect: call.inspect } : {}),
      });
      return answered.result;
    },
  );
};
