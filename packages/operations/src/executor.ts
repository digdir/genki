import type { ResourceProvenance, Usage } from '@genai/contracts';
import {
  encodeBase64,
  isMediaInput,
  shape as shapes,
  ShapeError,
  walk,
  withoutTrailingSlashes,
  type Credential,
  type Gate,
  type GateChunk,
  type GatePayload,
  type GateTarget,
  type ObjectLedger,
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
  type Resource,
  type Step,
} from './descriptor.js';
import {
  acceptOf,
  AnswerFormatError,
  contentTypeFits,
  decodeAnswer,
  encodeBody,
  readFrames,
  recordedBody,
  streamTypeFits,
} from './encoding.js';
import { evaluate, holds } from './mapping.js';
import type { ConnectProvider } from './websocket.js';
import { ModuleError, runModule, sha256Of } from './module.js';
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
  /** Hosts besides the connection's own that an answer URL may lead to; the operator sets them. */
  allowedHosts?: readonly string[];
  /** The connection's name, as the ledger records it. */
  connection?: string;
  tenant?: string;
  run?: string;
  ledger?: ObjectLedger;
  /** Opens the provider's WebSocket for a session step; tests give a connection to a fake provider. */
  connect?: ConnectProvider;
  /** The bytes of a module by its SHA-256; a descriptor's module runs only from bytes that match its pin. */
  modules?: (sha256: string) => Uint8Array | undefined;
  now?: () => Date;
  /** Waits between polls and before a retry; tests pass one that does not wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface Answer<Res = unknown> {
  result: Res;
  usage: Usage;
  dropped: number;
}

export const maxRequestsPerCall = 100;
export const maxStreamEvents = 50_000;
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
  links: Map<string, string>;
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

const placed = (placement: CredentialPlacement, value: string) => {
  if (placement.place === 'query') return { query: { [placement.name]: value }, headers: {} };
  if (placement.place === 'header')
    return {
      query: {},
      headers: { [placement.name]: placement.scheme ? `${placement.scheme} ${value}` : value },
    };
  return { query: {}, headers: {} };
};

interface Placed {
  query: Record<string, string>;
  headers: Record<string, string>;
  fields?: Record<string, string>;
  value: string;
}

/** Only the gate places a credential: the connection's, or a secret an earlier step bound. */
const credentialFor = async (
  step: Step,
  endpoint: DescribedEndpoint,
  state: RunState,
): Promise<Placed> => {
  if (step.auth) {
    const secret = state.secrets.get(`${step.auth.secret.step}.${step.auth.secret.field}`);
    if (!secret) throw new ShapeError(`step ${step.name} has no secret to place`);
    return { ...placed(step.auth, secret), value: secret };
  }
  const { credential } = endpoint;
  const value = await credentialValue(credential);
  const placement = step.credential;
  if (placement.place === 'module') return { query: {}, headers: {}, value };
  if (placement.place === 'basic')
    return {
      query: {},
      headers: {
        authorization: `Basic ${Buffer.from(`${placement.username}:${value}`).toString('base64')}`,
      },
      value,
    };
  if (placement.place === 'form')
    return { query: {}, headers: {}, fields: { [placement.name]: value }, value };
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
  return { ...placed(placement, value), value };
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
  const walked = walk(shape, value, { side: 'request', issued: state.issued, wire: true });
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
  step.request.path.replace(/\{([^{}]*)\}/g, (_, name: string) => {
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

interface Prepared {
  body: unknown;
  query: Record<string, string>;
  headers: Record<string, string>;
  filenames: Record<string, string> | undefined;
  path: string;
  follow: URL | undefined;
  media: string[];
  deletes: boolean;
}

const mediaTypesFrom = (shape: Shape): string[] => {
  const u = unwrapped(shape);
  return u.kind === 'media' ? [...(u.types ?? [u.type])] : [];
};

const hostAllowed = (url: URL, endpoint: DescribedEndpoint) => {
  const own = new URL(endpoint.baseURL);
  return (
    url.host === own.host ||
    (endpoint.allowedHosts ?? []).some((h) => h.toLowerCase() === url.host.toLowerCase())
  );
};

const followed = (
  descriptor: Descriptor,
  step: Step,
  endpoint: DescribedEndpoint,
  state: RunState,
) => {
  const follow = step.request.follow;
  if (!follow) return undefined;
  const text = state.links.get(`${follow.step}.${follow.field}`);
  const at = `${descriptor.id} step ${step.name}`;
  if (!text) throw new ShapeError(`${at}: no link was bound by ${follow.step}`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ShapeError(`${at}: the answer's link is not a URL`);
  }
  const own = new URL(endpoint.baseURL);
  if (url.username || url.password)
    throw new ShapeError(`${at}: the answer's link carries a login`);
  if (url.protocol !== 'https:' && url.protocol !== own.protocol)
    throw new ShapeError(`${at}: the answer's link is not https`);
  if (!hostAllowed(url, endpoint))
    throw new ShapeError(
      `${at}: the answer's link leads to ${url.host}, which is neither the connection's host nor one the operator allows`,
    );
  return url;
};

const prepare = (
  descriptor: Descriptor,
  step: Step,
  endpoint: DescribedEndpoint,
  state: RunState,
  options: SendOptions,
): Prepared => {
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
  const filenames = step.wire.filenames
    ? stringValues(
        walkedOrRefused(
          descriptor,
          step,
          'file names',
          step.wire.filenames,
          evaluate(step.request.filenames, scope),
          state,
          options,
        ),
      )
    : undefined;
  const follow = followed(descriptor, step, endpoint, state);
  return {
    body,
    query,
    headers,
    filenames,
    path: follow ? '' : pathOf(descriptor, step, state),
    follow,
    media: step.response.encoding === 'binary' ? mediaTypesFrom(step.wire.response) : [],
    deletes: descriptor.resources.some((r) => r.delete === step.name),
  };
};

const bytesOf = async (body: RequestInit['body']): Promise<Uint8Array> => {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString());
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new ShapeError('a module signs a text body');
};

/** The headers a step's module returns for the request about to go out, walked against what the step declares. */
const moduleHeaders = async (
  descriptor: Descriptor,
  step: Step,
  endpoint: DescribedEndpoint,
  state: RunState,
  options: SendOptions,
  sent: { body: RequestInit['body']; path: string; key: string },
): Promise<Record<string, string>> => {
  const spec = step.module;
  if (!spec) return {};
  const at = `${descriptor.id} step ${step.name}`;
  const declared = descriptor.modules[spec.use];
  const bytes = declared ? endpoint.modules?.(declared.sha256) : undefined;
  if (!declared || !bytes) throw new ShapeError(`${at}: the module ${spec.use} is not stored`);
  if (sha256Of(bytes) !== declared.sha256)
    throw new ShapeError(`${at}: the module ${spec.use} does not match its pinned SHA-256`);
  const text = (value: string) => new TextEncoder().encode(value);
  const now = (endpoint.now ?? (() => new Date()))();
  let emitted: [string, string][];
  try {
    emitted = await runModule({
      bytes,
      inputs: {
        body: await bytesOf(sent.body),
        method: text(step.request.method),
        path: text(sent.path),
        timestamp: text(String(Math.floor(now.getTime() / 1000))),
      },
      keys: declared.keys.includes('connection') ? { connection: sent.key } : {},
    });
  } catch (error) {
    if (error instanceof ModuleError) throw new ShapeError(`${at}: ${error.message}`);
    throw error;
  }
  const names = emitted.map(([name]) => name);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length > 0) throw new ShapeError(`${at}: the module returned ${twice[0]} twice`);
  const walked = walkedOrRefused(
    descriptor,
    step,
    'what the module returned',
    shapes.object(spec.emits),
    Object.fromEntries(emitted),
    state,
    options,
  ) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(spec.headers).map(([header, name]) => [header, walked[name] ?? '']),
  );
};

type Dispatched =
  { response: Response; request: RecordedRequest } | { gone: true; request: RecordedRequest };

const dispatch = async (
  descriptor: Descriptor,
  step: Step,
  endpoint: DescribedEndpoint,
  state: RunState,
  options: SendOptions,
  fail: NonNullable<SendOptions['fail']>,
  prepared: Prepared,
): Promise<Dispatched> => {
  const sleep = endpoint.sleep ?? defaultSleep;
  let retries = 0;
  for (;;) {
    state.requests += 1;
    if (state.requests > maxRequestsPerCall)
      throw fail(undefined, `${descriptor.id} made more than ${maxRequestsPerCall} requests`);
    const own = !prepared.follow || prepared.follow.host === new URL(endpoint.baseURL).host;
    const credential: Placed = own
      ? await credentialFor(step, endpoint, state)
      : { query: {}, headers: {}, value: '' };
    const url =
      prepared.follow ?? new URL(`${withoutTrailingSlashes(endpoint.baseURL)}${prepared.path}`);
    if (!prepared.follow)
      for (const [name, value] of Object.entries({
        ...descriptor.api.query,
        ...prepared.query,
        ...credential.query,
      }))
        url.searchParams.set(name, value);
    const filenames = prepared.filenames ? { filenames: prepared.filenames } : {};
    const encoded = encodeBody(step.request.encoding, prepared.body, {
      ...filenames,
      ...(credential.fields ? { fields: credential.fields } : {}),
    });
    const signed = await moduleHeaders(descriptor, step, endpoint, state, options, {
      body: encoded.body,
      path: `${url.pathname}${url.search}`,
      key: credential.value,
    });
    const signals = [
      ...(options.signal ? [options.signal] : []),
      ...(endpoint.timeoutMs ? [AbortSignal.timeout(endpoint.timeoutMs)] : []),
    ];
    const response = await (endpoint.fetch ?? globalThis.fetch)(url, {
      method: step.request.method,
      redirect: 'manual',
      headers: {
        ...(encoded.contentType ? { 'content-type': encoded.contentType } : {}),
        accept: step.response.stream
          ? step.response.stream.framing === 'sse'
            ? 'text/event-stream'
            : 'application/x-ndjson, text/plain'
          : acceptOf(step.response.encoding, prepared.media),
        ...(prepared.follow ? {} : descriptor.api.headers),
        ...prepared.headers,
        ...signed,
        ...credential.headers,
      },
      ...(encoded.body === undefined ? {} : { body: encoded.body }),
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
    }).catch((error: unknown) => {
      if (credential.value && error instanceof Error && error.message.includes(credential.value))
        throw new Error(error.message.replaceAll(credential.value, '[redacted]'));
      throw error;
    });
    const recorded = credential.fields
      ? encodeBody(step.request.encoding, prepared.body, filenames)
      : encoded;
    const request: RecordedRequest = {
      method: step.request.method,
      path: prepared.follow ? `${prepared.follow.host}${prepared.follow.pathname}` : prepared.path,
      ...(prepared.follow || !Object.keys({ ...descriptor.api.query, ...prepared.query }).length
        ? {}
        : { query: { ...descriptor.api.query, ...prepared.query } }),
      ...(Object.keys(prepared.headers).length ? { headers: prepared.headers } : {}),
      body: await recordedBody(recorded.body, recorded.contentType ?? null),
    };
    if (!response.ok) {
      const errorBody = await readErrorBody(response);
      const errorHeaders = Object.fromEntries(response.headers);
      state.exchanges.push({
        step: step.name,
        request,
        response: { status: response.status, body: errorBody },
      });
      if (prepared.deletes && response.status === 404) return { gone: true, request };
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
    return { response, request };
  }
};

const ledgerNow = (endpoint: DescribedEndpoint) => (endpoint.now ?? (() => new Date()))();

const finish = async (
  descriptor: Descriptor,
  step: Step,
  endpoint: DescribedEndpoint,
  state: RunState,
  scope: Record<string, unknown>,
  answer: { response: unknown; headers: Record<string, unknown> },
) => {
  runChecks(descriptor, step, { ...scope, ...answer });
  const bound: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(step.bind)) {
    const value = evaluate(spec.from, answer);
    if (spec.class.kind === 'secret') {
      if (typeof value !== 'string' || !value)
        throw new ShapeError(`${descriptor.id} step ${step.name}: the secret ${field} is not text`);
      state.secrets.set(`${step.name}.${field}`, value);
      continue;
    }
    if (spec.class.kind === 'url') {
      if (typeof value !== 'string' || !value)
        throw new ShapeError(`${descriptor.id} step ${step.name}: the link ${field} is not text`);
      state.links.set(`${step.name}.${field}`, value);
      continue;
    }
    const checked = walk(spec.class.shape, value, { side: 'result' });
    if (checked.problems.length > 0)
      throw new ShapeError(
        `${descriptor.id} step ${step.name}: bind.${field}: ${checked.problems.join('; ')}`,
      );
    bound[field] = checked.value;
    if (unwrapped(spec.class.shape).kind === 'issued' && typeof checked.value === 'string') {
      state.issued.add(checked.value);
      const resource = descriptor.resources.find((r) => r.step === step.name && r.field === field);
      if (resource) await record(descriptor, resource, endpoint, state, checked.value);
    }
  }
  state.steps[step.name] = bound;
  state.ran.add(step.name);
  for (const resource of descriptor.resources) {
    const id = state.steps[resource.step]?.[resource.field];
    if (resource.delete === step.name && typeof id === 'string' && endpoint.ledger)
      await endpoint.ledger.deleted({
        tenant: endpoint.tenant ?? '',
        connection: endpoint.connection ?? '',
        objectId: id,
      });
  }
};

const record = async (
  descriptor: Descriptor,
  resource: Resource,
  endpoint: DescribedEndpoint,
  state: RunState,
  objectId: string,
) => {
  if (!endpoint.ledger)
    throw new ShapeError(
      `${descriptor.id} keeps objects at the provider and the call has no ledger`,
    );
  await endpoint.ledger.created({
    tenant: endpoint.tenant ?? '',
    run: endpoint.run ?? '',
    connection: endpoint.connection ?? '',
    descriptor: descriptor.id,
    deployment: state.deployment,
    step: resource.step,
    field: resource.field,
    objectId,
    deleteBy: new Date(
      ledgerNow(endpoint).getTime() + resource.longestSeconds * 1000,
    ).toISOString(),
    deletable: resource.delete !== undefined,
  });
};

const runStep = async (
  descriptor: Descriptor,
  step: Step,
  endpoint: DescribedEndpoint,
  state: RunState,
  options: SendOptions,
  fail: NonNullable<SendOptions['fail']>,
) => {
  if (step.session)
    throw fail(undefined, `${descriptor.id} is a live session; it runs as a session`);
  const sleep = endpoint.sleep ?? defaultSleep;
  const scope = { input: state.input, deployment: state.deployment, steps: state.steps };
  const prepared = prepare(descriptor, step, endpoint, state, options);
  let waited = 0;
  for (;;) {
    const sent = await dispatch(descriptor, step, endpoint, state, options, fail, prepared);
    if ('gone' in sent) {
      const answer = { response: undefined, headers: {} };
      await finish(descriptor, step, endpoint, state, scope, answer);
      return answer;
    }
    const { response, request } = sent;
    const contentType = response.headers.get('content-type');
    if (!contentTypeFits(step.response.encoding, contentType, prepared.media))
      throw fail(
        undefined,
        `${descriptor.id} step ${step.name} declares a ${prepared.media.join(' or ') || step.response.encoding} answer, and the provider answered ${contentType ?? 'without a content type'}`,
      );
    let raw: unknown;
    try {
      raw = await decodeAnswer(step.response.encoding, response, maxAnswerBytes, prepared.media);
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
    const until = step.until;
    if (until) {
      const failing = until.fail;
      if (
        failing &&
        holds(evaluate(failing.test ?? until.test, answer), evaluate(failing.equals, answer))
      ) {
        const mapped = evaluate(failing.message, answer);
        throw fail(
          undefined,
          typeof mapped === 'string'
            ? mapped.slice(0, 500)
            : `${descriptor.id} step ${step.name}: the provider reported a failure`,
          failing.kind,
        );
      }
      if (!holds(evaluate(until.test, answer), evaluate(until.equals, answer))) {
        const after = retryAfterSeconds(response.headers.get('retry-after'));
        const wait = Math.max(until.intervalSeconds, Math.min(after ?? 0, maxRetryWaitSeconds));
        if (waited + wait > until.longestSeconds)
          throw fail(
            undefined,
            `${descriptor.id} step ${step.name} did not finish within ${until.longestSeconds} seconds`,
            'unavailable',
          );
        waited += wait;
        await sleep(wait * 1000, options.signal);
        continue;
      }
    }
    await finish(descriptor, step, endpoint, state, scope, answer);
    return answer;
  }
};

const lookupPath = (value: unknown, path: readonly string[]): unknown => {
  let at = value;
  for (const key of path) {
    if (Array.isArray(at)) at = at[Number(key)];
    else at = isRecord(at) ? at[key] : undefined;
  }
  return at;
};

export interface StreamedText {
  kind: 'delta';
  text: string;
}

async function* runStreamStep(
  descriptor: Descriptor,
  step: Step,
  endpoint: DescribedEndpoint,
  state: RunState,
  options: SendOptions,
  fail: NonNullable<SendOptions['fail']>,
): AsyncGenerator<StreamedText, { response: unknown; headers: Record<string, unknown> }> {
  const spec = step.response.stream as NonNullable<Step['response']['stream']>;
  const at = `${descriptor.id} step ${step.name}`;
  const scope = { input: state.input, deployment: state.deployment, steps: state.steps };
  const prepared = prepare(descriptor, step, endpoint, state, options);
  const sent = await dispatch(descriptor, step, endpoint, state, options, fail, prepared);
  if ('gone' in sent) throw fail(undefined, `${at}: the provider has no stream to read`);
  const { response, request } = sent;
  const contentType = response.headers.get('content-type');
  if (!streamTypeFits(spec.framing, contentType))
    throw fail(
      undefined,
      `${at} declares a ${spec.framing} stream, and the provider answered ${contentType ?? 'without a content type'}`,
    );
  const waitsForEnd = spec.end !== undefined || Object.values(spec.events).some((e) => e.done);
  const frames: { event?: string; data: unknown }[] = [];
  const usage: Record<string, unknown> = {};
  let text = '';
  let last: unknown;
  let ended = false;
  try {
    for await (const frame of readFrames(response, spec.framing, maxAnswerBytes)) {
      if (spec.end !== undefined && frame.data === spec.end) {
        frames.push({ ...(frame.event ? { event: frame.event } : {}), data: frame.data });
        ended = true;
        break;
      }
      if (frames.length >= maxStreamEvents)
        throw fail(undefined, `${at}: the stream sent more than ${maxStreamEvents} events`);
      let parsed: unknown = frame.data;
      const parse = () => {
        try {
          return JSON.parse(frame.data) as unknown;
        } catch {
          throw fail(undefined, `${at}: the stream sent a part that is not JSON`);
        }
      };
      let name: string;
      if (spec.framing === 'lines') name = 'line';
      else if (spec.name) {
        parsed = parse();
        const named = lookupPath(parsed, spec.name);
        name = typeof named === 'string' ? named : '';
      } else name = frame.event ?? 'message';
      const event = spec.events[name];
      if (!event)
        throw fail(
          undefined,
          `${at}: the stream sent an event it does not declare (${name.slice(0, 64)}), so it is ended`,
        );
      if (spec.framing !== 'lines' && !spec.name)
        parsed = ['text', 'plain'].includes(event.shape.kind) ? frame.data : parse();
      frames.push({ ...(frame.event ? { event: frame.event } : {}), data: parsed });
      const walked = walk(event.shape, parsed, { side: 'result' });
      if (walked.problems.length > 0)
        throw new ShapeError(
          `the provider streamed ${at} an event outside its shape (${name}): ${walked.problems.join('; ')}`,
        );
      state.dropped += walked.dropped;
      if (event.fail) {
        const mapped = evaluate(event.fail.message, { event: walked.value });
        throw fail(
          undefined,
          typeof mapped === 'string'
            ? mapped.slice(0, 500)
            : `${at}: the provider reported a failure`,
          event.fail.kind,
        );
      }
      last = walked.value;
      const mappedUsage = evaluate(step.usage, { response: walked.value, headers: {} });
      if (isRecord(mappedUsage))
        for (const [key, value] of Object.entries(mappedUsage))
          if (value !== undefined && value !== null) usage[key] = value;
      if (event.delta) {
        const piece = lookupPath(walked.value, event.delta);
        if (typeof piece === 'string' && piece !== '') {
          text += piece;
          yield { kind: 'delta', text: piece };
        }
      }
      if (event.done) {
        ended = true;
        break;
      }
    }
  } catch (error) {
    if (error instanceof AnswerFormatError) throw fail(undefined, `${at}: ${error.message}`);
    throw error;
  }
  if (waitsForEnd && !ended)
    throw fail(undefined, `${at}: the stream ended without its final event`, 'unavailable');
  state.exchanges.push({
    step: step.name,
    request,
    response: { status: response.status, body: frames },
  });
  addUsage(state.usage, usage);
  const answer = {
    response: { text, ...(last === undefined ? {} : { last }) },
    headers: {},
  };
  await finish(descriptor, step, endpoint, state, scope, answer);
  return answer;
}

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

const newState = (input: unknown, deployment: string): RunState => ({
  input,
  deployment,
  steps: {},
  secrets: new Map(),
  links: new Map(),
  issued: new Set(),
  usage: {},
  dropped: 0,
  exchanges: [],
  last: { response: undefined, headers: {} },
  requests: 0,
  ran: new Set(),
});

async function* runDescriptor<Res>(
  descriptor: Descriptor,
  endpoint: DescribedEndpoint,
  deployment: string,
  input: unknown,
  options: SendOptions,
): AsyncGenerator<StreamedText, Answer<Res>> {
  const fail =
    options.fail ?? ((status, message, kind) => new OperationError(status, message, kind));
  if (descriptor.resources.length > 0 && !endpoint.ledger)
    throw fail(
      undefined,
      `${descriptor.id} keeps objects at the provider and the call has no ledger`,
      'processor',
    );
  const state = newState(input, deployment);
  let failure: unknown;
  try {
    try {
      for (const step of descriptor.steps)
        state.last = step.response.stream
          ? yield* runStreamStep(descriptor, step, endpoint, state, options, fail)
          : await runStep(descriptor, step, endpoint, state, options, fail);
    } catch (error) {
      failure = error;
    }
  } finally {
    for (const step of descriptor.finally) {
      if (!readsOnly(step, state.ran)) continue;
      try {
        await runStep(descriptor, step, endpoint, state, options, fail);
      } catch (error) {
        if (!descriptor.resources.some((r) => r.delete === step.name)) failure ??= error;
      }
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
}

/** Sends a typed input that the gate has already held to its shape, step by step, and maps the answer back. */
export const describedSend = async <Res = unknown>(
  descriptor: Descriptor,
  endpoint: DescribedEndpoint,
  deployment: string,
  input: unknown,
  options: SendOptions = {},
): Promise<Answer<Res>> => {
  const run = runDescriptor<Res>(descriptor, endpoint, deployment, input, options);
  for (;;) {
    const next = await run.next();
    if (next.done) return next.value;
  }
};

/** Streams a descriptor's text deltas, then its answer; the gate masks, restores and meters what passes. */
export async function* describedStream<Res = unknown>(
  descriptor: Descriptor,
  endpoint: DescribedEndpoint,
  deployment: string,
  input: unknown,
  options: SendOptions = {},
): AsyncGenerator<StreamedText | { kind: 'answer'; answer: Answer<Res> }> {
  const run = runDescriptor<Res>(descriptor, endpoint, deployment, input, options);
  for (;;) {
    const next = await run.next();
    if (next.done) {
      yield { kind: 'answer', answer: next.value };
      return;
    }
    yield next.value;
  }
}

/** Deletes one leftover object at the provider by running its descriptor's delete step alone. */
export const deleteProviderObject = async (
  descriptor: Descriptor,
  resource: Resource,
  endpoint: DescribedEndpoint,
  object: { objectId: string; deployment: string },
  options: SendOptions = {},
): Promise<void> => {
  const step = [...descriptor.steps, ...descriptor.finally].find((s) => s.name === resource.delete);
  if (!step)
    throw new ShapeError(`${descriptor.id} has no step ${resource.delete ?? ''} to delete with`);
  const fail =
    options.fail ?? ((status, message, kind) => new OperationError(status, message, kind));
  const binding = descriptor.steps.find((s) => s.name === resource.step)?.bind[resource.field];
  if (binding?.class.kind === 'shape') {
    const checked = walk(binding.class.shape, object.objectId, { side: 'result' });
    if (checked.problems.length > 0)
      throw new ShapeError(`${descriptor.id}: ${object.objectId} is not an id of this descriptor`);
  }
  const state = newState({}, object.deployment);
  state.steps[resource.step] = { [resource.field]: object.objectId };
  state.issued.add(object.objectId);
  await runStep(descriptor, step, endpoint, state, options, fail);
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

/** The same call as a stream: the descriptor's text deltas pass through the gate's masking, then its result. */
export const describedStreamCall = <Res = unknown>(
  call: DescribedCall,
  input: unknown,
): AsyncIterable<GateChunk<Res>> => {
  const { descriptor } = call;
  let answered: Answer<Res> | undefined;
  const payload: GatePayload<Res> = {
    shape: { request: descriptor.input, result: descriptor.output },
    usage: () => answered && (call.priced ? call.priced(answered.usage) : answered.usage),
    dropped: () => answered?.dropped,
    ...(call.provenance ? { provenance: call.provenance } : {}),
  };
  return call.gate.stream<unknown, Res>(
    call.ctx,
    { ...call.target, descriptor: descriptor.id },
    payload,
    input,
    async function* (sent) {
      for await (const part of describedStream<Res>(
        descriptor,
        call.endpoint,
        call.deployment,
        sent,
        {
          signal: call.ctx.signal,
          ...(call.fail ? { fail: call.fail } : {}),
          ...(call.inspect ? { inspect: call.inspect } : {}),
        },
      )) {
        if (part.kind === 'delta') yield part;
        else {
          answered = part.answer;
          yield { kind: 'done', result: part.answer.result };
        }
      }
    },
  );
};

/** What the session executor shares with this file; not part of the package's surface. */
export const executorInternals = {
  newState,
  prepare,
  credentialFor,
  runStep,
  readsOnly,
  lookupPath,
  addUsage,
  isRecord,
};
export type { RunState };
