import { isDeepStrictEqual } from 'node:util';
import { priceUnits, unitFields, unitNamePattern, type PriceUnit } from '@genai/contracts';
import {
  decideShape,
  embedShape,
  mediaTypePattern,
  mediaTypesOf,
  rerankShape,
  shape,
  type OperationShape,
  type Shape,
} from '@genai/kernel';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { pathsOf, rootsOf } from './mapping.js';
import { moduleLimits } from './module.js';
import {
  DescriptorError,
  fieldNames,
  holdsJson,
  holdsKind,
  holdsMedia,
  isScalar,
  shapeAtPath,
  shapeOf,
  shapesNamed,
  unwrapped,
} from './shape.js';

export const descriptorIdPattern = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*@[1-9]\d*$/;

export const descriptorStatuses = ['review', 'described', 'typed'] as const;
export type DescriptorStatus = (typeof descriptorStatuses)[number];

export const requestEncodings = ['json', 'multipart', 'form', 'binary', 'text', 'ndjson'] as const;
export type RequestEncoding = (typeof requestEncodings)[number];
export const responseEncodings = ['json', 'binary', 'text', 'ndjson'] as const;
export const streamFramings = ['sse', 'ndjson', 'lines'] as const;
export type StreamFraming = (typeof streamFramings)[number];
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
export const maxResourceLifeSeconds = 30 * 86_400;
export const maxSessionSeconds = 3600;

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
const dataUrlText = /data:[a-z0-9.+-]{1,127}\/[a-z0-9.+-]{1,127}[;,]/i;
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
  z.strictObject({ form: paramName }),
  z.strictObject({
    basic: z.strictObject({ username: z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/) }),
  }),
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
  path: z
    .string()
    .regex(/^\/[A-Za-z0-9/_.{}-]*$/)
    .optional(),
  follow: z.string().startsWith('$steps.').optional(),
  encoding: z.enum(requestEncodings).default('json'),
  body: z.unknown().optional(),
  parts: z.unknown().optional(),
  filenames: z.record(fieldName, z.unknown()).optional(),
  query: z.record(paramName, z.unknown()).default({}),
  headers: z.record(headerName, z.unknown()).default({}),
});

const eventName = z.string().regex(/^[a-z0-9._:-]{1,64}$/i);

const streamFile = z.strictObject({
  framing: z.enum(streamFramings),
  name: z.string().startsWith('$event').optional(),
  end: z.string().min(1).max(64).optional(),
  events: z
    .record(
      eventName,
      z.strictObject({
        shape: z.unknown(),
        delta: z.string().startsWith('$event').optional(),
        done: z.literal(true).optional(),
        fail: z
          .strictObject({ kind: z.enum(operationErrorKinds), message: z.unknown().optional() })
          .optional(),
      }),
    )
    .refine((e) => Object.keys(e).length > 0, 'declare at least one event'),
});

const websocketFile = z.strictObject({
  longestSeconds: z.number().min(1).max(maxSessionSeconds),
  maxMessages: z.number().int().min(1).max(100_000).default(10_000),
  maxMessageBytes: z.number().int().min(1).max(1_048_576).default(262_144),
  client: z.strictObject({
    name: z.string().startsWith('$event').optional(),
    events: z.record(eventName, z.strictObject({ shape: z.unknown() })),
    binary: z.string().optional(),
    binaryAs: z.strictObject({ event: eventName, field: fieldName }).optional(),
  }),
  server: z.strictObject({
    name: z.string().startsWith('$event').optional(),
    events: z.record(
      eventName,
      z.strictObject({
        shape: z.unknown(),
        transcript: z.string().startsWith('$event').optional(),
        usage: usageFile.optional(),
        done: z.literal(true).optional(),
        fail: z
          .strictObject({ kind: z.enum(operationErrorKinds), message: z.unknown().optional() })
          .optional(),
      }),
    ),
    binary: z.string().optional(),
  }),
});

const resourceFile = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}\.[a-z][a-zA-Z0-9_]{0,31}$/),
  delete: stepName.optional(),
  longestSeconds: z.number().int().min(60).max(maxResourceLifeSeconds),
});

export const moduleKeyNames = ['connection'] as const;

const moduleName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

const moduleFile = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  keys: z.array(z.enum(moduleKeyNames)).max(1).default([]),
});

const stepModuleFile = z.strictObject({
  use: moduleName,
  emits: z.record(moduleName, z.unknown()),
  headers: z.record(headerName, moduleName),
});

const stepFields = {
  request: requestFile,
  response: z
    .strictObject({
      encoding: z.enum(responseEncodings).default('json'),
      headers: z.record(headerName, z.unknown()).default({}),
      stream: streamFile.optional(),
    })
    .default({ encoding: 'json', headers: {} }),
  wire: z.strictObject({
    request: z.unknown().optional(),
    query: z.unknown().optional(),
    headers: z.unknown().optional(),
    filenames: z.unknown().optional(),
    response: z.unknown().optional(),
  }),
  usage: usageFile.default({}),
  bind: z.record(fieldName, z.strictObject({ from: z.unknown(), class: z.unknown() })).default({}),
  until: z
    .strictObject({
      test: z.unknown(),
      equals: z.unknown().optional(),
      intervalSeconds: z.number().min(0.1).max(60),
      longestSeconds: z.number().min(1).max(maxUntilSeconds),
      fail: z
        .strictObject({
          test: z.unknown().optional(),
          equals: z.unknown().optional(),
          kind: z.enum(operationErrorKinds),
          message: z.unknown().optional(),
        })
        .optional(),
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

const stepFile = z.strictObject({
  name: stepName,
  auth: stepAuthFile.optional(),
  credential: authFile.optional(),
  websocket: websocketFile.optional(),
  module: stepModuleFile.optional(),
  ...stepFields,
});

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
  stream: z.literal('none').default('none'),
  resources: z.array(resourceFile).max(10).default([]),
  modules: z.record(moduleName, moduleFile).default({}),
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
  | { place: 'header'; name: string; scheme?: string }
  | { place: 'query'; name: string }
  | { place: 'form'; name: string }
  | { place: 'basic'; username: string };

export type SecretPlacement =
  { place: 'header'; name: string; scheme?: string } | { place: 'query'; name: string };

export type BindClass = { kind: 'secret' } | { kind: 'url' } | { kind: 'shape'; shape: Shape };

export type Check =
  | { kind: 'same-names'; expected: unknown; actual: unknown }
  | { kind: 'count'; of: unknown; sameAs?: unknown; min?: number; max?: number }
  | { kind: 'one-of'; value: unknown; in: unknown };

export interface ErrorRule {
  status: number | number[] | '4xx' | '5xx';
  kind: OperationErrorKind;
  message?: unknown;
}

export interface StreamEvent {
  shape: Shape;
  delta?: string[];
  done: boolean;
  fail?: { kind: OperationErrorKind; message?: unknown };
}

export interface StreamSpec {
  framing: StreamFraming;
  name?: string[];
  end?: string;
  events: Record<string, StreamEvent>;
}

export interface SessionEvent {
  shape: Shape;
  transcript?: string[];
  usage?: Record<string, unknown>;
  done?: boolean;
  fail?: { kind: OperationErrorKind; message?: unknown };
}

export interface SessionSpec {
  longestSeconds: number;
  maxMessages: number;
  maxMessageBytes: number;
  client: {
    name?: string[];
    events: Record<string, SessionEvent>;
    binary?: string;
    binaryAs?: { event: string; field: string };
  };
  server: { name?: string[]; events: Record<string, SessionEvent>; binary?: string };
}

export interface Step {
  name: string;
  auth?: SecretPlacement & { secret: { step: string; field: string } };
  credential: CredentialPlacement;
  request: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    follow?: { step: string; field: string };
    encoding: RequestEncoding;
    body?: unknown;
    filenames?: Record<string, unknown>;
    query: Record<string, unknown>;
    headers: Record<string, unknown>;
  };
  response: { encoding: ResponseEncoding; headers: Record<string, Shape>; stream?: StreamSpec };
  session?: SessionSpec;
  module?: StepModule;
  wire: { request?: Shape; query?: Shape; headers?: Shape; filenames?: Shape; response: Shape };
  usage: Record<string, unknown>;
  bind: Record<string, { from: unknown; class: BindClass }>;
  until?: {
    test: unknown;
    equals?: unknown;
    intervalSeconds: number;
    longestSeconds: number;
    fail?: { test?: unknown; equals?: unknown; kind: OperationErrorKind; message?: unknown };
  };
  retry: { attempts: number; longestWaitSeconds: number };
  errors: ErrorRule[];
  checks: Check[];
}

export interface DescriptorModule {
  sha256: string;
  keys: string[];
}

export interface StepModule {
  use: string;
  emits: Record<string, Shape>;
  headers: Record<string, string>;
}

export interface Resource {
  step: string;
  field: string;
  delete?: string;
  longestSeconds: number;
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
  resources: Resource[];
  modules: Record<string, DescriptorModule>;
  result: unknown;
  /** Every unit the descriptor's usage mappings name, built-in and open. */
  units: string[];
  stream: 'none' | StreamFraming;
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
  if ('form' in auth) return { place: 'form', name: auth.form };
  if ('basic' in auth) return { place: 'basic', username: auth.basic.username };
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

const classesAt = (s: Shape): Shape[] => {
  switch (s.kind) {
    case 'optional':
      return classesAt(s.shape);
    case 'array':
      return classesAt(s.item);
    case 'variant':
      return Object.values(s.options).flatMap(classesAt);
    case 'either':
      return s.options.flatMap(classesAt);
    default:
      return [s];
  }
};

const checkEveryFieldClassified = (
  at: string,
  wires: Shape[],
  template: unknown,
  path: string[],
) => {
  if (Array.isArray(template)) {
    for (const item of template) checkEveryFieldClassified(at, wires, item, path);
    return;
  }
  if (!isRecord(template)) return;
  const keys = Object.keys(template);
  if (keys.length > 0 && keys.every((k) => k.startsWith('$'))) {
    if ('$map' in template) checkEveryFieldClassified(at, wires, template.$map, path);
    return;
  }
  const here = wires.flatMap(classesAt);
  if (here.some((c) => c.kind === 'json')) return;
  for (const [key, value] of Object.entries(template)) {
    const children = here.flatMap((c) =>
      c.kind === 'object' && key in c.fields ? [c.fields[key] as Shape] : [],
    );
    if (children.length === 0)
      throw new DescriptorError(
        `${at}.${[...path, key].join('.')}: ${key} has no class; every value that goes out is classified`,
      );
    checkEveryFieldClassified(at, children, value, [...path, key]);
  }
};

const stepPath = /^\$steps\.([a-z][a-z0-9_]*)\.([a-z][a-zA-Z0-9_]*)$/;

/** A field filled from input may never carry a URL or a provider object, and a provider object comes only from a bound step value. */
const checkFieldSources = (
  at: string,
  wire: Shape | undefined,
  template: unknown,
  bound: Map<string, Bound>,
  keeps: boolean,
) => {
  const kept = !keeps && wire ? fieldNames(wire).filter((f) => keptOutFields.has(f)) : [];
  if (kept.length > 0) throw new DescriptorError(`${at}: may not carry ${kept.join(', ')}`);
  const urls = wire ? fieldNames(wire).filter((f) => urlFields.has(f)) : [];
  if (urls.length > 0)
    throw new DescriptorError(
      `${at}: may not carry ${urls.join(', ')}; input never names a URL; an answer link is followed only through request.follow`,
    );
  if (wire) checkEveryFieldClassified(at, [wire], template, []);
  for (const [key, value] of mappedFields(template)) {
    if (
      wire &&
      rootsOf(value).some((r) => r !== 'steps') &&
      shapesNamed(wire, key).some((d) => d.kind === 'opaque')
    )
      throw new DescriptorError(
        `${at}.${key}: opaque state is replayed from an earlier step, never filled from input, which could carry a URL out`,
      );
    if (providerObjectFields.has(key) && rootsOf(value).some((r) => r !== 'steps'))
      throw new DescriptorError(
        `${at}.${key}: a provider object id comes only from a value bound in an earlier step, never from input`,
      );
    const found = typeof value === 'string' ? stepPath.exec(value) : null;
    const source = found ? bound.get(`${found[1]}.${found[2]}`) : undefined;
    if (source?.class.kind === 'shape' && source.class.shape.kind === 'issued' && wire) {
      const declared = shapesNamed(wire, key);
      if (declared.length === 0 || declared.some((d) => d.kind !== 'issued'))
        throw new DescriptorError(
          `${at}.${key}: an id the provider issued is declared issued where it goes out, so the gate checks where it came from`,
        );
    }
  }
};

const checkDataUrls = (
  at: string,
  wire: Shape | undefined,
  request: z.infer<typeof requestFile>,
) => {
  const outside = JSON.stringify([request.query, request.headers, request.filenames]);
  if (outside.includes('$dataUrl'))
    throw new DescriptorError(`${at}: $dataUrl belongs in a json request body only`);
  const body = request.encoding === 'multipart' ? request.parts : request.body;
  const used = mappedFields(body).filter(
    ([, v]) => isRecord(v) && Object.keys(v).length === 1 && '$dataUrl' in v,
  );
  if (used.length === 0 && !JSON.stringify(body ?? null).includes('$dataUrl')) return;
  if (request.encoding !== 'json')
    throw new DescriptorError(`${at}: $dataUrl belongs in a json request body only`);
  for (const [key] of used) {
    const declared = wire ? shapesNamed(wire, key) : [];
    if (declared.length === 0 || declared.some((d) => d.kind !== 'media'))
      throw new DescriptorError(
        `${at}.${key}: a data URL carries media, so the field is declared media in wire.request`,
      );
  }
  if (JSON.stringify(body).split('$dataUrl').length - 1 !== used.length)
    throw new DescriptorError(`${at}: $dataUrl fills a body field of its own`);
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
const eventSegment = /^(?:[A-Za-z_][A-Za-z0-9_-]*|\d{1,6})$/;

const eventPath = (at: string, path: string): string[] => {
  const segments = path.split('.').slice(1);
  if (path.split('.')[0] !== '$event' || !segments.every((s) => eventSegment.test(s)))
    throw new DescriptorError(`${at}: ${path} is not a path from $event`);
  return segments;
};

const textLike = (s: Shape | undefined): boolean => {
  if (!s) return false;
  const u = unwrapped(s);
  if (u.kind === 'text') return true;
  return u.kind === 'either' && u.options.every((o) => o.kind === 'text' || o.kind === 'null');
};

const toStream = (at: string, spec: z.infer<typeof streamFile>): StreamSpec => {
  const events: Record<string, StreamEvent> = {};
  for (const [name, e] of Object.entries(spec.events)) {
    const shape = shapeOf(e.shape, `${at}: stream.events.${name}.shape`);
    if (holdsMedia(shape)) throw new DescriptorError(`${at}: a stream event carries no media`);
    if (spec.framing === 'lines' && (name !== 'line' || !['text', 'plain'].includes(shape.kind)))
      throw new DescriptorError(
        `${at}: a lines stream has one event, line, and it is text or plain`,
      );
    const delta = e.delta ? eventPath(`${at}: ${name}.delta`, e.delta) : undefined;
    if (delta && !textLike(shapeAtPath(shape, delta)))
      throw new DescriptorError(
        `${at}: stream.events.${name}.delta must point at a text field, so the gate can mask and restore it`,
      );
    if (e.fail) checkRoots(e.fail.message, ['event'], `${at}: stream.events.${name}.fail`);
    events[name] = {
      shape,
      ...(delta ? { delta } : {}),
      done: e.done === true,
      ...(e.fail ? { fail: e.fail } : {}),
    };
  }
  if (spec.framing === 'lines' && spec.name)
    throw new DescriptorError(`${at}: a lines stream has no event names to read`);
  return {
    framing: spec.framing,
    ...(spec.name ? { name: eventPath(`${at}: stream.name`, spec.name) } : {}),
    ...(spec.end ? { end: spec.end } : {}),
    events,
  };
};

const toSession = (at: string, spec: z.infer<typeof websocketFile>): SessionSpec => {
  const side = (which: 'client' | 'server') => {
    const given = spec[which];
    const events: Record<string, SessionEvent> = {};
    for (const [name, e] of Object.entries(given.events)) {
      const where = `${at}: websocket.${which}.events.${name}`;
      const shape = shapeOf(e.shape, `${where}.shape`);
      if (shape.kind !== 'object') throw new DescriptorError(`${where}: a message is an object`);
      if (holdsMedia(shape) || holdsKind(shape, 'issued'))
        throw new DescriptorError(`${where}: media goes in binary frames, never in a text message`);
      const extra =
        which === 'server'
          ? (e as z.infer<typeof websocketFile>['server']['events'][string])
          : undefined;
      const transcript = extra?.transcript
        ? eventPath(`${where}.transcript`, extra.transcript)
        : undefined;
      if (transcript && !textLike(shapeAtPath(shape, transcript)))
        throw new DescriptorError(`${where}.transcript must point at a text field`);
      if (extra?.usage) checkRoots(extra.usage, ['event'], `${where}.usage`);
      if (extra?.fail) checkRoots(extra.fail.message, ['event'], `${where}.fail`);
      events[name] = {
        shape,
        ...(transcript ? { transcript } : {}),
        ...(extra?.usage ? { usage: usageByField(extra.usage) } : {}),
        ...(extra?.done ? { done: true } : {}),
        ...(extra?.fail ? { fail: extra.fail } : {}),
      };
    }
    if (given.binary !== undefined && !mediaTypePattern.test(given.binary.toLowerCase()))
      throw new DescriptorError(`${at}: websocket.${which}.binary is one media type`);
    const binaryAs =
      which === 'client'
        ? (given as { binaryAs?: { event: string; field: string } }).binaryAs
        : undefined;
    if (binaryAs) {
      const where = `${at}: websocket.client.binaryAs`;
      const carrier = events[binaryAs.event]?.shape;
      if (!given.binary || !given.name)
        throw new DescriptorError(`${where}: needs client.binary and client.name`);
      if (carrier?.kind !== 'object' || carrier.fields[binaryAs.field]?.kind !== 'opaque')
        throw new DescriptorError(
          `${where}: ${binaryAs.event} is a declared client event whose ${binaryAs.field} is opaque`,
        );
    }
    return {
      ...(given.name ? { name: eventPath(`${at}: websocket.${which}.name`, given.name) } : {}),
      events,
      ...(given.binary ? { binary: given.binary.toLowerCase() } : {}),
      ...(binaryAs ? { binaryAs } : {}),
    };
  };
  return {
    longestSeconds: spec.longestSeconds,
    maxMessages: spec.maxMessages,
    maxMessageBytes: spec.maxMessageBytes,
    client: side('client'),
    server: side('server'),
  };
};

const checkCredential = (
  at: string,
  placement: CredentialPlacement,
  request: z.infer<typeof requestFile>,
  wireRequest: Shape | undefined,
  apiQuery: Record<string, string>,
) => {
  if (
    placement.place === 'query' &&
    (placement.name in request.query || placement.name in apiQuery)
  )
    throw new DescriptorError(
      `${at}: request.query.${placement.name} is where the credential goes`,
    );
  if (placement.place === 'form') {
    if (request.encoding !== 'form')
      throw new DescriptorError(`${at}: a credential in a form field belongs in a form request`);
    if (wireRequest?.kind === 'object' && placement.name in wireRequest.fields)
      throw new DescriptorError(
        `${at}: wire.request.${placement.name} is where the credential goes`,
      );
  }
};

const toStepModule = (
  at: string,
  raw: z.infer<typeof stepFile>,
  modules: Record<string, DescriptorModule>,
): StepModule => {
  const spec = raw.module as z.infer<typeof stepModuleFile>;
  if (!(spec.use in modules))
    throw new DescriptorError(`${at}: module.use ${spec.use} is not declared under modules`);
  if (raw.websocket || raw.response.stream)
    throw new DescriptorError(`${at}: a module signs a plain request, not a stream or a session`);
  if (raw.request.follow !== undefined)
    throw new DescriptorError(`${at}: a module signs a request to the connection, not a link`);
  if (!['json', 'ndjson', 'text', 'form'].includes(raw.request.encoding))
    throw new DescriptorError(`${at}: a module signs a json, ndjson, text or form body`);
  const emits = Object.fromEntries(
    Object.entries(spec.emits).map(([name, value]) => {
      const emitted = shapeOf(value, `${at}: module.emits.${name}`);
      const pinned =
        (emitted.kind === 'ref' && emitted.pattern && /^\^.*\$$/.test(emitted.pattern.source)) ||
        emitted.kind === 'enum';
      if (!pinned)
        throw new DescriptorError(
          `${at}: module.emits.${name}: a module returns a value pinned by an anchored ref pattern or an enum, never free text`,
        );
      return [name, emitted];
    }),
  );
  const mapped = Object.entries(spec.headers);
  for (const [header, emit] of mapped) {
    if (reservedHeaderNames.has(header.toLowerCase()))
      throw new DescriptorError(
        `${at}: module.headers.${header}: credentials come from the endpoint`,
      );
    if (!(emit in emits))
      throw new DescriptorError(
        `${at}: module.headers.${header} names ${emit}, which emits does not declare`,
      );
  }
  const unused = Object.keys(emits).filter((e) => !mapped.some(([, m]) => m === e));
  if (unused.length > 0)
    throw new DescriptorError(`${at}: module.emits ${unused.join(', ')} is mapped to no header`);
  if (
    Object.keys(raw.request.headers).some((h) =>
      mapped.some(([m]) => m.toLowerCase() === h.toLowerCase()),
    )
  )
    throw new DescriptorError(
      `${at}: a header the module sets is not also mapped in request.headers`,
    );
  return {
    use: spec.use,
    emits,
    headers: Object.fromEntries(mapped.map(([h, e]) => [h.toLowerCase(), e])),
  };
};

const toStep = (
  at: string,
  raw: z.infer<typeof stepFile>,
  bound: Map<string, Bound>,
  defaults: {
    placement: CredentialPlacement;
    apiQuery: Record<string, string>;
    keeps: boolean;
    modules: Record<string, DescriptorModule>;
  },
  status: DescriptorStatus,
): Step => {
  const { request } = raw;
  const sessionSpec = raw.websocket ? toSession(at, raw.websocket) : undefined;
  const moduleSpec = raw.module ? toStepModule(at, raw, defaults.modules) : undefined;
  if ((request.path === undefined) === (request.follow === undefined))
    throw new DescriptorError(
      `${at}: a request has a path, or follows a link an earlier step bound`,
    );
  const path = request.path ?? '';
  let follow: Step['request']['follow'];
  if (request.follow) {
    const found = stepPath.exec(request.follow);
    const source = found ? bound.get(`${found[1]}.${found[2]}`) : undefined;
    if (!found || source?.class.kind !== 'url')
      throw new DescriptorError(
        `${at}: request.follow must be a link an earlier step binds as url; input never names a URL`,
      );
    if (request.method !== 'GET' || request.body !== undefined || request.parts !== undefined)
      throw new DescriptorError(`${at}: a followed link is read with a GET and no body`);
    follow = { step: found[1] as string, field: found[2] as string };
  }
  if (!defaults.keeps && !sessionSpec && keptOutPath.test(path))
    throw new DescriptorError(`${at}: request.path ${path} is kept out of descriptors`);
  if (path.includes('..') || path.includes('//'))
    throw new DescriptorError(`${at}: request.path ${path} is kept out of descriptors`);
  for (const [, placeholder = ''] of path.matchAll(placeholderPattern)) {
    if (placeholder === 'deployment') continue;
    const ref = bound.get(placeholder.replace(/^steps\./, ''));
    if (
      !placeholder.startsWith('steps.') ||
      !ref ||
      ref.class.kind !== 'shape' ||
      ref.class.shape.kind !== 'issued'
    )
      throw new DescriptorError(
        `${at}: request.path may only hold {deployment} or {steps.<step>.<field>} bound as an issued id with a pattern; input never chooses a path`,
      );
  }
  const template = request.encoding === 'multipart' ? request.parts : request.body;
  if (request.encoding === 'multipart' && request.body !== undefined)
    throw new DescriptorError(`${at}: a multipart request maps its parts, not a body`);
  if (request.encoding !== 'multipart' && request.parts !== undefined)
    throw new DescriptorError(`${at}: only a multipart request has parts`);
  if (request.encoding !== 'multipart' && request.filenames !== undefined)
    throw new DescriptorError(`${at}: only a multipart request has filenames`);
  if (template !== undefined && ['GET', 'DELETE'].includes(request.method))
    throw new DescriptorError(`${at}: a ${request.method} request has no body`);
  if (template !== undefined && raw.wire.request === undefined)
    throw new DescriptorError(
      `${at}: maps a request body without wire.request; every value that goes out is classified`,
    );
  if (sessionSpec && (request.method !== 'GET' || template !== undefined))
    throw new DescriptorError(`${at}: a websocket session opens with a GET and no body`);
  const wireRequest =
    raw.wire.request === undefined ? undefined : shapeOf(raw.wire.request, `${at}: wire.request`);
  const stream = raw.response.stream ? toStream(at, raw.response.stream) : undefined;
  if (stream && (raw.until || sessionSpec))
    throw new DescriptorError(`${at}: a streamed answer is read once, so it has no until`);
  if ((stream || sessionSpec) && raw.wire.response !== undefined)
    throw new DescriptorError(
      `${at}: wire.response is not declared for a ${stream ? 'stream' : 'session'}; its events are`,
    );
  if (!stream && !sessionSpec && raw.wire.response === undefined)
    throw new DescriptorError(`${at}: wire.response is required`);
  const eventShapes = Object.values(stream?.events ?? {}).map((e) => e.shape);
  const wireResponse = stream
    ? shape.object({
        text: shape.text,
        last: shape.optional(
          eventShapes.length === 1 ? (eventShapes[0] as Shape) : shape.either(...eventShapes),
        ),
      })
    : sessionSpec
      ? shape.object({ transcript: shape.text })
      : shapeOf(raw.wire.response, `${at}: wire.response`);
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
  if (!stream && !sessionSpec) {
    const responseKind = unwrapped(wireResponse).kind;
    if (raw.response.encoding === 'text' && !['text', 'plain'].includes(responseKind))
      throw new DescriptorError(`${at}: a text answer is text or plain`);
    if (raw.response.encoding === 'binary' && responseKind !== 'media')
      throw new DescriptorError(`${at}: a binary answer is one media value`);
    if (raw.response.encoding === 'ndjson' && responseKind !== 'array')
      throw new DescriptorError(`${at}: an ndjson answer is a list`);
  }
  if (mediaTypesOf(wireResponse).some((t) => t.endsWith('/*')))
    throw new DescriptorError(`${at}: wire.response: media coming back names its media types`);
  checkFieldSources(`${at}: wire.request`, wireRequest, template, bound, defaults.keeps);
  checkDataUrls(at, wireRequest, request);
  checkModelFields(at, wireRequest, template);
  for (const name of [...Object.keys(request.headers), ...Object.keys(raw.response.headers)])
    if (reservedHeaderNames.has(name.toLowerCase()))
      throw new DescriptorError(
        `${at}: header ${name} is set by the gate; credentials come from the connection`,
      );
  const placement = raw.credential ? placementOf(raw.credential) : defaults.placement;
  checkCredential(at, placement, request, wireRequest, defaults.apiQuery);
  const wireQuery = scalarFields(`${at}: wire.query`, raw.wire.query, request.query);
  const wireHeaders = scalarFields(`${at}: wire.headers`, raw.wire.headers, request.headers);
  let wireFilenames: Shape | undefined;
  if (request.filenames) {
    wireFilenames = scalarFields(`${at}: wire.filenames`, raw.wire.filenames, request.filenames);
    const parts = wireRequest?.kind === 'object' ? wireRequest.fields : {};
    for (const part of Object.keys(request.filenames)) {
      const kind = unwrapped(parts[part] ?? shape.nothing);
      if (
        kind.kind !== 'media' &&
        !(kind.kind === 'array' && unwrapped(kind.item).kind === 'media')
      )
        throw new DescriptorError(`${at}: filenames.${part} names a part that is not media`);
    }
    for (const field of Object.values(wireFilenames?.kind === 'object' ? wireFilenames.fields : {}))
      if (!['text', 'plain'].includes(unwrapped(field).kind))
        throw new DescriptorError(`${at}: a file name is text or plain`);
  } else if (raw.wire.filenames !== undefined)
    throw new DescriptorError(`${at}: wire.filenames without filenames`);
  const requestRoots = ['input', 'deployment', 'steps', 'item'];
  checkRoots(template, requestRoots, `${at}: request.body`);
  checkRoots(request.query, requestRoots, `${at}: request.query`);
  checkRoots(request.headers, requestRoots, `${at}: request.headers`);
  checkRoots(request.filenames, requestRoots, `${at}: request.filenames`);
  for (const path of pathsOf([template, request.query, request.headers, request.filenames]).filter(
    (p) => p.startsWith('$steps.'),
  )) {
    const [, step, field] = path.split('.');
    const found = bound.get(`${step}.${field}`);
    if (!found) throw new DescriptorError(`${at}: reads ${path}, which no earlier step binds`);
    if (found.class.kind === 'secret')
      throw new DescriptorError(`${at}: reads ${path}, a secret only the gate may place`);
    if (found.class.kind === 'url')
      throw new DescriptorError(`${at}: reads ${path}, a link only the gate may follow`);
  }
  const answerRoots = ['response', 'headers', 'item'];
  checkRoots(raw.usage, answerRoots, `${at}: usage`);
  if (raw.until) {
    checkRoots(raw.until, answerRoots, `${at}: until`);
    if (raw.until.fail) checkRoots(raw.until.fail, answerRoots, `${at}: until.fail`);
  }
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
          : spec.class === 'url'
            ? { kind: 'url' }
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
  if (Object.values(bind).some((b) => b.class.kind === 'url') && raw.wire.response === undefined)
    throw new DescriptorError(`${at}: a link is bound from an answer, not a stream`);
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
    credential: placement,
    request: {
      method: request.method,
      path,
      ...(follow ? { follow } : {}),
      encoding: request.encoding,
      ...(template === undefined ? {} : { body: template }),
      ...(request.filenames ? { filenames: request.filenames } : {}),
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
      ...(stream ? { stream } : {}),
    },
    ...(sessionSpec ? { session: sessionSpec } : {}),
    ...(moduleSpec ? { module: moduleSpec } : {}),
    wire: {
      ...(wireRequest ? { request: wireRequest } : {}),
      ...(wireQuery ? { query: wireQuery } : {}),
      ...(wireHeaders ? { headers: wireHeaders } : {}),
      ...(wireFilenames ? { filenames: wireFilenames } : {}),
      response: wireResponse,
    },
    usage: usageByField(raw.usage),
    bind,
    ...(raw.until
      ? {
          until: {
            test: raw.until.test,
            ...(raw.until.equals === undefined ? {} : { equals: raw.until.equals }),
            intervalSeconds: raw.until.intervalSeconds,
            longestSeconds: raw.until.longestSeconds,
            ...(raw.until.fail ? { fail: raw.until.fail } : {}),
          },
        }
      : {}),
    retry: raw.retry,
    errors: raw.errors,
    checks: raw.checks.map((c): Check => {
      if ('same-names' in c) return { kind: 'same-names', ...c['same-names'] };
      if ('count' in c) return { kind: 'count', ...c.count } as Check;
      return { kind: 'one-of', ...c['one-of'] };
    }),
  };
};

const resourcesOf = (
  at: string,
  given: z.infer<typeof resourceFile>[],
  bound: Map<string, Bound>,
  steps: Step[],
  finallySteps: Step[],
): Resource[] =>
  given.map((r) => {
    const found = bound.get(r.id);
    if (!found || found.class.kind !== 'shape' || found.class.shape.kind !== 'issued')
      throw new DescriptorError(
        `${at}: resources: ${r.id} must be an id an earlier step binds as issued`,
      );
    const [step = '', field = ''] = r.id.split('.');
    if (r.delete) {
      const deleting = [...steps, ...finallySteps].find((s) => s.name === r.delete);
      if (!deleting || deleting.request.method !== 'DELETE')
        throw new DescriptorError(
          `${at}: resources: ${r.id} is deleted by ${r.delete}, which must be a DELETE step`,
        );
      const reads = pathsOf([
        deleting.request.body,
        deleting.request.query,
        deleting.request.headers,
      ]);
      const others = [...deleting.request.path.matchAll(placeholderPattern)]
        .map((m) => m[1] ?? '')
        .filter((p) => p !== 'deployment' && p !== `steps.${r.id}`);
      if (others.length > 0 || reads.some((p) => p.startsWith('$steps.')))
        throw new DescriptorError(
          `${at}: resources: ${r.delete} may read only the id ${r.id}, since a sweep runs it alone`,
        );
      if (!deleting.request.path.includes(`{steps.${r.id}}`))
        throw new DescriptorError(`${at}: resources: ${r.delete} deletes {steps.${r.id}}`);
    }
    return {
      step,
      field,
      ...(r.delete ? { delete: r.delete } : {}),
      longestSeconds: r.longestSeconds,
    };
  });

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
  const texts = strings({ ...d, summary: '' });
  if (texts.some((s) => urlLike.test(s)))
    throw new DescriptorError(
      `${at}: a descriptor names no URL; the endpoint comes from the catalogue`,
    );
  if (texts.some((s) => dataUrlText.test(s)))
    throw new DescriptorError(`${at}: a data URL is built only by $dataUrl from media`);
  for (const name of Object.keys(d.api.headers))
    if (reservedHeaderNames.has(name.toLowerCase()))
      throw new DescriptorError(`${at}: api.headers.${name}: credentials come from the endpoint`);
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
  rawSteps.forEach((s, i) => {
    if ((s.response.stream || s.websocket) && i !== rawSteps.length - 1)
      throw new DescriptorError(
        `${at}: step ${s.name}: a streamed answer or a session is the last step`,
      );
  });
  if (d.finally.some((s) => s.response.stream || s.websocket))
    throw new DescriptorError(`${at}: a finally step is one plain request`);
  const keeps = d.resources.length > 0;
  if (Object.keys(d.modules).length > moduleLimits.maxModules)
    throw new DescriptorError(
      `${at}: a descriptor names at most ${moduleLimits.maxModules} modules`,
    );
  const modules: Record<string, DescriptorModule> = Object.fromEntries(
    Object.entries(d.modules).map(([name, m]) => [name, { sha256: m.sha256, keys: m.keys }]),
  );
  const defaults = { placement, apiQuery: d.api.query, keeps, modules };
  const bound = new Map<string, Bound>();
  const steps = rawSteps.map((s) => toStep(`${at}: step ${s.name}`, s, bound, defaults, d.status));
  const finallySteps = d.finally.map((s) => {
    if (Object.keys(s.bind).length > 0)
      throw new DescriptorError(`${at}: step ${s.name}: a finally step binds nothing`);
    return toStep(`${at}: step ${s.name}`, s, bound, defaults, d.status);
  });
  const resources = resourcesOf(at, d.resources, bound, steps, finallySteps);
  checkRoots(
    d.result,
    ['response', 'headers', 'input', 'deployment', 'usage', 'dropped', 'item', 'steps'],
    `${at}: result`,
  );
  for (const path of pathsOf(d.result).filter((p) => p.startsWith('$steps.'))) {
    const [, step, field] = path.split('.');
    const found = bound.get(`${step}.${field}`);
    if (!found || found.class.kind === 'secret' || found.class.kind === 'url')
      throw new DescriptorError(`${at}: result reads ${path}, which no step binds as a value`);
    if (found.class.kind === 'shape' && found.class.shape.kind === 'issued')
      throw new DescriptorError(
        `${at}: result reads ${path}, an id the provider issued stays in the run`,
      );
  }
  const input = shapeOf(d.input, `${at}: input`);
  const output = shapeOf(d.output, `${at}: output`);
  if (holdsKind(input, 'issued') || holdsKind(output, 'issued'))
    throw new DescriptorError(
      `${at}: an issued id is neither input nor output; it comes from an answer and stays in the run`,
    );
  if (mediaTypesOf(output).some((t) => t.endsWith('/*')))
    throw new DescriptorError(`${at}: output: media coming back names its media types`);
  const streaming = steps.find((s) => s.response.stream)?.response.stream;
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
    resources,
    modules,
    result: d.result,
    units: [
      ...new Set([
        ...steps.flatMap((s) => unitsOf(s.usage)),
        ...steps.flatMap((s) =>
          Object.values(s.session?.server.events ?? {}).flatMap((e) => unitsOf(e.usage ?? {})),
        ),
      ]),
    ],
    stream: streaming?.framing ?? 'none',
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
