import { isDeepStrictEqual } from 'node:util';
import { priceUnits, unitFields, unitNamePattern, type PriceUnit } from '@genai/contracts';
import {
  decideShape,
  embedShape,
  mediaTypesOf,
  rerankShape,
  type OperationShape,
  type Shape,
} from '@genai/kernel';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { pathsOf, rootsOf } from './mapping.js';
import {
  DescriptorError,
  fieldNames,
  holdsJson,
  holdsMedia,
  isScalar,
  shapeOf,
  unwrapped,
} from './shape.js';

export const descriptorIdPattern = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*@[1-9]\d*$/;

export const descriptorStatuses = ['review', 'described', 'typed'] as const;
export type DescriptorStatus = (typeof descriptorStatuses)[number];

export const requestEncodings = ['json', 'multipart', 'form', 'binary', 'text', 'ndjson'] as const;
export type RequestEncoding = (typeof requestEncodings)[number];
export const responseEncodings = ['json', 'binary', 'text', 'ndjson'] as const;
export type ResponseEncoding = (typeof responseEncodings)[number];
export const operationErrorKinds = [
  'invalid',
  'unavailable',
  'rate-limited',
  'refused',
  'processor',
] as const;
export type OperationErrorKind = (typeof operationErrorKinds)[number];

export const maxSteps = 10;
export const maxRetryWaitSeconds = 60;
export const maxUntilSeconds = 600;

/** The operations Genki has its own types for; a typed descriptor must declare exactly their shapes. */
export const typedShapes: Readonly<Record<string, OperationShape>> = {
  embed: embedShape,
  decide: decideShape,
  rerank: rerankShape,
};

const credentialHeaderNames = new Set([
  'authorization',
  'api-key',
  'x-api-key',
  'cookie',
  'proxy-authorization',
]);
const reservedHeaderNames = new Set([
  ...credentialHeaderNames,
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
]);
const keptOutPath =
  /\/(?:realtime|batch(?:es)?|files|uploads|vector_stores|assistants|threads|conversations|containers|fine_tuning|agents)(?:\/|$)|\/responses\/\{/i;
const keptOutFields = new Set(['store', 'background']);
const providerObjectFields = new Set([
  'previous_response_id',
  'conversation',
  'file_id',
  'file_ids',
  'vector_store_ids',
  'assistant_id',
  'thread_id',
]);
const urlFields = new Set([
  'image_url',
  'file_url',
  'audio_url',
  'video_url',
  'url',
  'callback_url',
]);
const urlLike = /[a-z][a-z0-9+.-]*:\/\//i;
const modelFieldNames = new Set(['model', 'model_id', 'deployment', 'deployment_id', 'engine']);

/** The top-level wire request fields that name the model; the executor always sets them to the catalogue deployment. */
export const modelFieldsOf = (wireRequest: Shape | undefined): string[] =>
  wireRequest?.kind === 'object'
    ? Object.keys(wireRequest.fields).filter((f) => modelFieldNames.has(f))
    : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const literal = z.string().max(200);

const usageFields = Object.values(unitFields) as string[];

/** The built-in units a usage mapping reports, whether it names units or the usage fields that count them. */
export const reportedUnits = (usage: Record<string, unknown>): PriceUnit[] =>
  priceUnits.filter((unit) => unit in usage || unitFields[unit] in usage);

const usageByField = (usage: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(usage)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [(unitFields as Record<string, string>)[key] ?? key, value]),
  );

/** The units a step's usage mapping names: built-in units by their unit names, then the open ones. */
const unitsOf = (usage: Record<string, unknown>): string[] => [
  ...reportedUnits(usage),
  ...Object.keys(usage).filter((k) => !usageFields.includes(k) && !(k in unitFields)),
];

export const apiFamilyPattern = /^[a-z][a-z0-9-]*$/;

/** The API family each endpoint protocol of ADR 0021 became (ADR 0048). */
export const legacyProtocolFamilies: Readonly<Record<string, string>> = {
  'openai-chat': 'openai',
  'anthropic-messages': 'anthropic',
  'openai-embeddings': 'openai',
};

/** API ids renamed after models could bind them; a stored binding to the old id keeps working. */
export const renamedApiIds: Readonly<Record<string, string>> = {
  'openai/embed@1': 'openai/embeddings@1',
};

export const currentApiId = (id: string) => renamedApiIds[id] ?? id;

export const familyOfProtocol = (protocol: string) => legacyProtocolFamilies[protocol] ?? protocol;

const withFamily = (value: unknown): unknown => {
  if (!isRecord(value) || !isRecord(value.api) || !('protocol' in value.api)) return value;
  const { protocol, ...api } = value.api;
  return {
    ...value,
    api: 'family' in api ? value.api : { family: familyOfProtocol(String(protocol)), ...api },
  };
};

const headerName = z.string().regex(/^[a-z0-9-]+$/i);
const paramName = z.string().regex(/^[a-z0-9_.[\]-]+$/i);
const stepName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const fieldName = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,31}$/);

const authFile = z.union([
  z.strictObject({ keyHeader: headerName }),
  z.strictObject({
    header: headerName,
    scheme: z
      .string()
      .regex(/^[A-Za-z-]{1,32}$/)
      .optional(),
  }),
  z.strictObject({ query: paramName }),
]);

const stepAuthFile = z.union([
  z.strictObject({
    header: headerName,
    scheme: z
      .string()
      .regex(/^[A-Za-z-]{1,32}$/)
      .optional(),
    secret: z.string().startsWith('$steps.'),
  }),
  z.strictObject({ query: paramName, secret: z.string().startsWith('$steps.') }),
]);

const usageFile = z.record(
  z
    .string()
    .regex(unitNamePattern)
    .or(z.enum(usageFields as [string])),
  z.unknown(),
);

const statusRule = z.union([
  z.number().int().min(400).max(599),
  z.array(z.number().int().min(400).max(599)).min(1),
  z.enum(['4xx', '5xx']),
]);

const checkFile = z.union([
  z.strictObject({
    'same-names': z.strictObject({ expected: z.unknown(), actual: z.unknown() }),
  }),
  z.strictObject({
    count: z.strictObject({
      of: z.unknown(),
      sameAs: z.unknown().optional(),
      min: z.number().int().min(0).optional(),
      max: z.number().int().min(0).optional(),
    }),
  }),
  z.strictObject({ 'one-of': z.strictObject({ value: z.unknown(), in: z.unknown() }) }),
]);

const requestFile = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().regex(/^\/[A-Za-z0-9/_.{}-]*$/),
  encoding: z.enum(requestEncodings).default('json'),
  body: z.unknown().optional(),
  parts: z.unknown().optional(),
  query: z.record(paramName, z.unknown()).default({}),
  headers: z.record(headerName, z.unknown()).default({}),
});

const stepFields = {
  request: requestFile,
  response: z
    .strictObject({
      encoding: z.enum(responseEncodings).default('json'),
      headers: z.record(headerName, z.unknown()).default({}),
    })
    .default({ encoding: 'json', headers: {} }),
  wire: z.strictObject({
    request: z.unknown().optional(),
    query: z.unknown().optional(),
    headers: z.unknown().optional(),
    response: z.unknown(),
  }),
  usage: usageFile.default({}),
  bind: z.record(fieldName, z.strictObject({ from: z.unknown(), class: z.unknown() })).default({}),
  until: z
    .strictObject({
      test: z.unknown(),
      equals: z.unknown().optional(),
      intervalSeconds: z.number().min(0.1).max(60),
      longestSeconds: z.number().min(1).max(maxUntilSeconds),
    })
    .optional(),
  retry: z
    .strictObject({
      attempts: z.number().int().min(0).max(5),
      longestWaitSeconds: z.number().min(0).max(maxRetryWaitSeconds),
    })
    .default({ attempts: 2, longestWaitSeconds: 10 }),
  errors: z
    .array(
      z.strictObject({
        status: statusRule,
        kind: z.enum(operationErrorKinds),
        message: z.unknown().optional(),
      }),
    )
    .default([]),
  checks: z.array(checkFile).default([]),
};

const stepFile = z.strictObject({ name: stepName, auth: stepAuthFile.optional(), ...stepFields });

const streamFile = z.union([
  z.literal('none'),
  z.strictObject({
    events: z.record(
      z.string().regex(/^[a-z0-9._-]+$/i),
      z.strictObject({
        shape: z.unknown(),
        delta: z.string().startsWith('$').optional(),
        done: z.literal(true).optional(),
      }),
    ),
  }),
]);

export const descriptorFile = z.strictObject({
  id: z.string().regex(descriptorIdPattern),
  operation: z.string().regex(/^[a-z][a-z0-9-]*$/),
  status: z.enum(descriptorStatuses),
  summary: z.string().min(1).max(500),
  api: z.strictObject({
    family: z.string().regex(apiFamilyPattern),
    version: z.string().min(1).max(64),
    query: z.record(paramName, literal).default({}),
    headers: z.record(headerName, literal).default({}),
  }),
  auth: authFile.default({ keyHeader: 'authorization' }),
  input: z.unknown(),
  output: z.unknown(),
  result: z.unknown(),
  stream: streamFile,
  steps: z.array(stepFile).min(1).max(maxSteps).optional(),
  finally: z.array(stepFile).max(maxSteps).default([]),
  request: requestFile.optional(),
  response: stepFields.response,
  wire: stepFields.wire.optional(),
  usage: usageFile.optional(),
  until: stepFields.until,
  retry: stepFields.retry,
  errors: stepFields.errors,
  checks: stepFields.checks,
});

export type CredentialPlacement =
  { place: 'header'; name: string; scheme?: string } | { place: 'query'; name: string };

export type BindClass = { kind: 'secret' } | { kind: 'shape'; shape: Shape };

export type Check =
  | { kind: 'same-names'; expected: unknown; actual: unknown }
  | { kind: 'count'; of: unknown; sameAs?: unknown; min?: number; max?: number }
  | { kind: 'one-of'; value: unknown; in: unknown };

export interface ErrorRule {
  status: number | number[] | '4xx' | '5xx';
  kind: OperationErrorKind;
  message?: unknown;
}

export interface Step {
  name: string;
  auth?: CredentialPlacement & { secret: { step: string; field: string } };
  request: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    encoding: RequestEncoding;
    body?: unknown;
    query: Record<string, unknown>;
    headers: Record<string, unknown>;
  };
  response: { encoding: ResponseEncoding; headers: Record<string, Shape> };
  wire: { request?: Shape; query?: Shape; headers?: Shape; response: Shape };
  usage: Record<string, unknown>;
  bind: Record<string, { from: unknown; class: BindClass }>;
  until?: { test: unknown; equals?: unknown; intervalSeconds: number; longestSeconds: number };
  retry: { attempts: number; longestWaitSeconds: number };
  errors: ErrorRule[];
  checks: Check[];
}

export interface Descriptor {
  id: string;
  operation: string;
  status: DescriptorStatus;
  summary: string;
  api: {
    family: string;
    version: string;
    query: Record<string, string>;
    headers: Record<string, string>;
  };
  auth: CredentialPlacement;
  input: Shape;
  output: Shape;
  steps: Step[];
  finally: Step[];
  result: unknown;
  /** Every unit the descriptor's usage mappings name, built-in and open. */
  units: string[];
  stream: 'none';
}

const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
};

const checkRoots = (template: unknown, allowed: string[], at: string) => {
  const unknown = rootsOf(template).filter((r) => !allowed.includes(r));
  if (unknown.length > 0)
    throw new DescriptorError(`${at}: reads $${unknown.join(', $')}, which is not available here`);
};

const placementOf = (auth: z.infer<typeof authFile>): CredentialPlacement => {
  if ('keyHeader' in auth)
    return auth.keyHeader.toLowerCase() === 'authorization'
      ? { place: 'header', name: 'authorization', scheme: 'Bearer' }
      : { place: 'header', name: auth.keyHeader.toLowerCase() };
  if ('query' in auth) return { place: 'query', name: auth.query };
  return {
    place: 'header',
    name: auth.header.toLowerCase(),
    ...(auth.scheme ? { scheme: auth.scheme } : {}),
  };
};

const mappedFields = (template: unknown): [string, unknown][] => {
  if (!isRecord(template)) return [];
  return Object.entries(template).flatMap(([k, v]) => [
    [k, v] as [string, unknown],
    ...mappedFields(v),
  ]);
};

/** A field filled from input may never carry a URL or a provider object, and a provider object comes only from a bound step value. */
const checkFieldSources = (at: string, wire: Shape | undefined, template: unknown) => {
  const urls = wire ? fieldNames(wire).filter((f) => urlFields.has(f)) : [];
  if (urls.length > 0)
    throw new DescriptorError(
      `${at}: may not carry ${urls.join(', ')}; input never names a URL, and Genki does not follow answer URLs yet`,
    );
  const kept = wire ? fieldNames(wire).filter((f) => keptOutFields.has(f)) : [];
  if (kept.length > 0) throw new DescriptorError(`${at}: may not carry ${kept.join(', ')}`);
  for (const [key, value] of mappedFields(template))
    if (providerObjectFields.has(key) && rootsOf(value).some((r) => r !== 'steps'))
      throw new DescriptorError(
        `${at}.${key}: a provider object id comes only from a value bound in an earlier step, never from input`,
      );
};

const checkModelFields = (at: string, wireRequest: Shape | undefined, body: unknown) => {
  if (!wireRequest) return;
  const top = modelFieldsOf(wireRequest);
  const nested = (
    wireRequest.kind === 'object'
      ? Object.values(wireRequest.fields).flatMap(fieldNames)
      : fieldNames(wireRequest)
  ).filter((f) => modelFieldNames.has(f));
  if (nested.length > 0)
    throw new DescriptorError(
      `${at}: wire.request may name the model only at the top, as $deployment (${nested.join(', ')})`,
    );
  for (const field of top)
    if (!isRecord(body) || body[field] !== '$deployment')
      throw new DescriptorError(
        `${at}: request.body.${field} must be $deployment; the input never chooses the model`,
      );
};

const scalarFields = (at: string, spec: unknown, mapped: Record<string, unknown>) => {
  const names = Object.keys(mapped);
  if (names.length === 0 && spec === undefined) return undefined;
  if (spec === undefined)
    throw new DescriptorError(
      `${at}: maps ${names.join(', ')} without a class; every value that goes out is classified`,
    );
  const shape = shapeOf(spec, at);
  if (shape.kind !== 'object' || !Object.values(shape.fields).every(isScalar))
    throw new DescriptorError(`${at}: must be an object of single values`);
  const unclassified = names.filter((n) => !(n in shape.fields));
  if (unclassified.length > 0)
    throw new DescriptorError(`${at}: ${unclassified.join(', ')} has no class`);
  for (const [name, value] of Object.entries(mapped))
    if (modelFieldNames.has(name) && value !== '$deployment')
      throw new DescriptorError(
        `${at}.${name}: must be $deployment; the input never chooses the model`,
      );
  return shape;
};

interface Bound {
  step: string;
  field: string;
  class: BindClass;
}

const placeholderPattern = /\{([^}]*)\}/g;

const toStep = (
  at: string,
  raw: z.infer<typeof stepFile>,
  bound: Map<string, Bound>,
  placement: CredentialPlacement,
  status: DescriptorStatus,
): Step => {
  const { request } = raw;
  if (keptOutPath.test(request.path) || request.path.includes('..') || request.path.includes('//'))
    throw new DescriptorError(`${at}: request.path ${request.path} is kept out of descriptors`);
  for (const [, placeholder = ''] of request.path.matchAll(placeholderPattern)) {
    if (placeholder === 'deployment') continue;
    const ref = bound.get(placeholder.replace(/^steps\./, ''));
    if (
      !placeholder.startsWith('steps.') ||
      !ref ||
      ref.class.kind !== 'shape' ||
      ref.class.shape.kind !== 'ref' ||
      !ref.class.shape.pattern
    )
      throw new DescriptorError(
        `${at}: request.path may only hold {deployment} or {steps.<step>.<field>} bound as a ref with a pattern; input never chooses a path`,
      );
  }
  const template = request.encoding === 'multipart' ? request.parts : request.body;
  if (request.encoding === 'multipart' && request.body !== undefined)
    throw new DescriptorError(`${at}: a multipart request maps its parts, not a body`);
  if (request.encoding !== 'multipart' && request.parts !== undefined)
    throw new DescriptorError(`${at}: only a multipart request has parts`);
  if (template !== undefined && ['GET', 'DELETE'].includes(request.method))
    throw new DescriptorError(`${at}: a ${request.method} request has no body`);
  if (template !== undefined && raw.wire.request === undefined)
    throw new DescriptorError(
      `${at}: maps a request body without wire.request; every value that goes out is classified`,
    );
  const wireRequest =
    raw.wire.request === undefined ? undefined : shapeOf(raw.wire.request, `${at}: wire.request`);
  const wireResponse = shapeOf(raw.wire.response, `${at}: wire.response`);
  if (wireRequest) {
    const kinds = Object.values(wireRequest.kind === 'object' ? wireRequest.fields : {});
    const encoding = request.encoding;
    if ((encoding === 'form' || encoding === 'multipart') && wireRequest.kind !== 'object')
      throw new DescriptorError(`${at}: a ${encoding} request is an object of fields`);
    if (encoding === 'form' && !kinds.every(isScalar))
      throw new DescriptorError(`${at}: a form request holds single values only`);
    if (
      encoding === 'multipart' &&
      !kinds.every((k) => {
        const u = unwrapped(k);
        return isScalar(u) || u.kind === 'media' || (u.kind === 'array' && isScalar(u.item));
      })
    )
      throw new DescriptorError(
        `${at}: a multipart part is a single value, a list of them or media`,
      );
    if (encoding === 'binary' && wireRequest.kind !== 'media')
      throw new DescriptorError(`${at}: a binary request body is one media value`);
    if (encoding === 'text' && !['text', 'plain'].includes(wireRequest.kind))
      throw new DescriptorError(`${at}: a text request body is text or plain`);
    if (encoding === 'ndjson' && wireRequest.kind !== 'array')
      throw new DescriptorError(`${at}: an ndjson request body is a list`);
    if (['form', 'text', 'ndjson'].includes(encoding) && holdsMedia(wireRequest))
      throw new DescriptorError(`${at}: a ${encoding} request cannot carry media`);
    if (status !== 'typed' && encoding !== 'json' && holdsJson(wireRequest))
      throw new DescriptorError(`${at}: only a json request body may carry json`);
  }
  const responseKind = unwrapped(wireResponse).kind;
  if (raw.response.encoding === 'text' && !['text', 'plain'].includes(responseKind))
    throw new DescriptorError(`${at}: a text answer is text or plain`);
  if (raw.response.encoding === 'binary' && responseKind !== 'media')
    throw new DescriptorError(`${at}: a binary answer is one media value`);
  if (raw.response.encoding === 'ndjson' && responseKind !== 'array')
    throw new DescriptorError(`${at}: an ndjson answer is a list`);
  if (mediaTypesOf(wireResponse).some((t) => t.endsWith('/*')))
    throw new DescriptorError(`${at}: wire.response: media coming back names one media type`);
  checkFieldSources(`${at}: wire.request`, wireRequest, template);
  checkModelFields(at, wireRequest, template);
  for (const name of [...Object.keys(request.headers), ...Object.keys(raw.response.headers)])
    if (reservedHeaderNames.has(name.toLowerCase()))
      throw new DescriptorError(
        `${at}: header ${name} is set by the gate; credentials come from the connection`,
      );
  if (placement.place === 'query' && placement.name in request.query)
    throw new DescriptorError(
      `${at}: request.query.${placement.name} is where the credential goes`,
    );
  const wireQuery = scalarFields(`${at}: wire.query`, raw.wire.query, request.query);
  const wireHeaders = scalarFields(`${at}: wire.headers`, raw.wire.headers, request.headers);
  const requestRoots = ['input', 'deployment', 'steps', 'item'];
  checkRoots(template, requestRoots, `${at}: request.body`);
  checkRoots(request.query, requestRoots, `${at}: request.query`);
  checkRoots(request.headers, requestRoots, `${at}: request.headers`);
  for (const path of pathsOf([template, request.query, request.headers]).filter((p) =>
    p.startsWith('$steps.'),
  )) {
    const [, step, field] = path.split('.');
    const found = bound.get(`${step}.${field}`);
    if (!found) throw new DescriptorError(`${at}: reads ${path}, which no earlier step binds`);
    if (found.class.kind === 'secret')
      throw new DescriptorError(`${at}: reads ${path}, a secret only the gate may place`);
  }
  const answerRoots = ['response', 'headers', 'item'];
  checkRoots(raw.usage, answerRoots, `${at}: usage`);
  if (raw.until) checkRoots(raw.until, answerRoots, `${at}: until`);
  for (const rule of raw.errors) checkRoots(rule.message, answerRoots, `${at}: errors`);
  checkRoots(
    raw.checks,
    ['input', 'deployment', 'response', 'headers', 'steps', 'item'],
    `${at}: checks`,
  );
  const bind = Object.fromEntries(
    Object.entries(raw.bind).map(([field, spec]) => {
      checkRoots(spec.from, answerRoots, `${at}: bind.${field}`);
      const cls: BindClass =
        spec.class === 'secret'
          ? { kind: 'secret' }
          : { kind: 'shape', shape: shapeOf(spec.class, `${at}: bind.${field}.class`) };
      if (cls.kind === 'shape' && holdsMedia(cls.shape))
        throw new DescriptorError(`${at}: bind.${field}: media is not bound between steps`);
      return [field, { from: spec.from, class: cls }];
    }),
  );
  const secrets = Object.entries(bind).filter(([, b]) => b.class.kind === 'secret');
  if (secrets.length > 0 && (Object.keys(bind).length > 1 || Object.keys(raw.usage).length > 0))
    throw new DescriptorError(
      `${at}: a step that binds a secret binds nothing else and maps no usage, so nothing can read it`,
    );
  let auth: Step['auth'];
  if (raw.auth) {
    const [, step = '', field = ''] = raw.auth.secret.split('.');
    const found = bound.get(`${step}.${field}`);
    if (!found || found.class.kind !== 'secret' || raw.auth.secret.split('.').length !== 3)
      throw new DescriptorError(
        `${at}: auth.secret must be a value an earlier step binds as secret; a credential never comes from input`,
      );
    auth = {
      ...('query' in raw.auth
        ? { place: 'query' as const, name: raw.auth.query }
        : {
            place: 'header' as const,
            name: raw.auth.header.toLowerCase(),
            ...(raw.auth.scheme ? { scheme: raw.auth.scheme } : {}),
          }),
      secret: { step, field },
    };
  }
  for (const [field, b] of Object.entries(bind))
    bound.set(`${raw.name}.${field}`, { step: raw.name, field, class: b.class });
  return {
    name: raw.name,
    ...(auth ? { auth } : {}),
    request: {
      method: request.method,
      path: request.path,
      encoding: request.encoding,
      ...(template === undefined ? {} : { body: template }),
      query: request.query,
      headers: request.headers,
    },
    response: {
      encoding: raw.response.encoding,
      headers: Object.fromEntries(
        Object.entries(raw.response.headers).map(([name, spec]) => {
          const shape = shapeOf(spec, `${at}: response.headers.${name}`);
          if (!isScalar(shape))
            throw new DescriptorError(`${at}: response.headers.${name} is a single value`);
          return [name.toLowerCase(), shape];
        }),
      ),
    },
    wire: {
      ...(wireRequest ? { request: wireRequest } : {}),
      ...(wireQuery ? { query: wireQuery } : {}),
      ...(wireHeaders ? { headers: wireHeaders } : {}),
      response: wireResponse,
    },
    usage: usageByField(raw.usage),
    bind,
    ...(raw.until ? { until: raw.until } : {}),
    retry: raw.retry,
    errors: raw.errors,
    checks: raw.checks.map((c): Check => {
      if ('same-names' in c) return { kind: 'same-names', ...c['same-names'] };
      if ('count' in c) return { kind: 'count', ...c.count } as Check;
      return { kind: 'one-of', ...c['one-of'] };
    }),
  };
};

/** Validates a parsed descriptor and turns its shapes into the kernel's closed shapes. */
export const toDescriptor = (value: unknown): Descriptor => {
  const parsed = descriptorFile.safeParse(withFamily(value));
  if (!parsed.success)
    throw new DescriptorError(
      parsed.error.issues
        .map((i) => `${i.path.join('.') || 'descriptor'}: ${i.message}`)
        .join('; '),
    );
  const d = parsed.data;
  const at = d.id;
  if (strings({ ...d, summary: '' }).some((s) => urlLike.test(s)))
    throw new DescriptorError(
      `${at}: a descriptor names no URL; the endpoint comes from the catalogue`,
    );
  for (const name of Object.keys(d.api.headers))
    if (reservedHeaderNames.has(name.toLowerCase()))
      throw new DescriptorError(`${at}: api.headers.${name}: credentials come from the endpoint`);
  if (d.stream !== 'none')
    throw new DescriptorError(
      `${at}: stream must be none; Genki does not stream descriptor calls yet`,
    );
  const placement = placementOf(d.auth);
  if (placement.place === 'query' && placement.name in d.api.query)
    throw new DescriptorError(`${at}: api.query.${placement.name} is where the credential goes`);
  let rawSteps: z.infer<typeof stepFile>[];
  if (d.steps) {
    if (d.request || d.wire || d.usage)
      throw new DescriptorError(
        `${at}: a descriptor with steps declares request, wire and usage in each step`,
      );
    rawSteps = d.steps;
  } else {
    if (!d.request || !d.wire || !d.usage)
      throw new DescriptorError(`${at}: a descriptor declares request, wire and usage, or steps`);
    rawSteps = [
      {
        name: 'call',
        request: d.request,
        response: d.response,
        wire: d.wire,
        usage: d.usage,
        bind: {},
        ...(d.until ? { until: d.until } : {}),
        retry: d.retry,
        errors: d.errors,
        checks: d.checks,
      },
    ];
  }
  const names = [...rawSteps, ...d.finally].map((s) => s.name);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length > 0)
    throw new DescriptorError(`${at}: two steps are called ${twice.join(', ')}`);
  const bound = new Map<string, Bound>();
  const steps = rawSteps.map((s) => toStep(`${at}: step ${s.name}`, s, bound, placement, d.status));
  const finallySteps = d.finally.map((s) => {
    if (Object.keys(s.bind).length > 0)
      throw new DescriptorError(`${at}: step ${s.name}: a finally step binds nothing`);
    return toStep(`${at}: step ${s.name}`, s, bound, placement, d.status);
  });
  checkRoots(
    d.result,
    ['response', 'headers', 'input', 'deployment', 'usage', 'dropped', 'item', 'steps'],
    `${at}: result`,
  );
  for (const path of pathsOf(d.result).filter((p) => p.startsWith('$steps.'))) {
    const [, step, field] = path.split('.');
    const found = bound.get(`${step}.${field}`);
    if (!found || found.class.kind === 'secret')
      throw new DescriptorError(`${at}: result reads ${path}, which no step binds as a value`);
  }
  const input = shapeOf(d.input, `${at}: input`);
  const output = shapeOf(d.output, `${at}: output`);
  if (mediaTypesOf(output).some((t) => t.endsWith('/*')))
    throw new DescriptorError(`${at}: output: media coming back must be one media type`);
  const descriptor: Descriptor = {
    id: d.id,
    operation: d.operation,
    status: d.status,
    summary: d.summary,
    api: d.api,
    auth: placement,
    input,
    output,
    steps,
    finally: finallySteps,
    result: d.result,
    units: [...new Set(steps.flatMap((s) => unitsOf(s.usage)))],
    stream: 'none',
  };
  if (descriptor.status === 'typed') {
    const typed = typedShapes[descriptor.operation];
    if (!typed)
      throw new DescriptorError(`${at}: Genki has no own types for ${descriptor.operation}`);
    if (
      !isDeepStrictEqual(typed.request, descriptor.input) ||
      !isDeepStrictEqual(typed.result, descriptor.output)
    )
      throw new DescriptorError(
        `${at}: a typed descriptor declares the input and output shapes of ${descriptor.operation}`,
      );
  }
  return descriptor;
};

/** Parses descriptor text, YAML or JSON, without checking it. */
export const descriptorDocument = (text: string): unknown => {
  try {
    return parseYaml(text);
  } catch (error) {
    throw new DescriptorError(`not valid YAML: ${(error as Error).message}`);
  }
};

export const parseDescriptor = (text: string): Descriptor => toDescriptor(descriptorDocument(text));
