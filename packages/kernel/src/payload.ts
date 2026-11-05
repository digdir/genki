import {
  decodeBase64,
  isInlineMedia,
  isMediaInput,
  isMediaRef,
  mediaRefKind,
  mediaTypeCovers,
  type MediaRef,
} from './media.js';

export type Shape =
  | { kind: 'text' }
  | { kind: 'media'; type: string; types?: readonly string[] }
  | { kind: 'plain'; min?: number }
  | { kind: 'opaque' }
  | { kind: 'ref'; pattern?: RegExp }
  | { kind: 'issued'; pattern: RegExp }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'number'; integer?: boolean; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'null' }
  | { kind: 'json' }
  | { kind: 'optional'; shape: Shape }
  | { kind: 'object'; fields: Readonly<Record<string, Shape>> }
  | { kind: 'array'; item: Shape; min?: number; max?: number; unique?: string }
  | { kind: 'variant'; key: string; options: Readonly<Record<string, Shape>> }
  | { kind: 'either'; options: readonly Shape[] };

export interface OperationShape {
  request: Shape;
  result: Shape;
}

/** Text that may hold personal data: masked, restored and the only place media can hide. */
export const text: Shape = { kind: 'text' };
/** Media of one type, a `type/*` or a list of types: needs consent in a request, kept as a blob of the run in a result. */
export const media = (type: string | readonly string[]): Shape =>
  typeof type === 'string'
    ? { kind: 'media', type }
    : type.length === 1
      ? { kind: 'media', type: type[0] as string }
      : { kind: 'media', type: type[0] as string, types: type };
/** A string written by a service or a tool: kept as it is, but a URL or encoded data is refused in a request. */
export const plain = (min?: number): Shape => ({ kind: 'plain', ...(min ? { min } : {}) });
/** State the provider issued and an adapter replays unread, such as an encrypted reasoning blob. */
export const opaque: Shape = { kind: 'opaque' };
/** An identifier: refused in a request when it is a URL or a provider-side object id. */
export const ref = (pattern?: RegExp): Shape => ({ kind: 'ref', ...(pattern ? { pattern } : {}) });
/** An object id the provider issued in an answer of the same run; never taken from input. */
export const issued = (pattern: RegExp): Shape => ({ kind: 'issued', pattern });
export const oneOf = (...values: string[]): Shape => ({ kind: 'enum', values });
export const number = (limits: { integer?: boolean; min?: number; max?: number } = {}): Shape => ({
  kind: 'number',
  ...limits,
});
export const boolean: Shape = { kind: 'boolean' };
export const nothing: Shape = { kind: 'null' };
/** A JSON value such as a JSON Schema or tool input: no text to mask, no media. */
export const json: Shape = { kind: 'json' };
export const optional = (shape: Shape): Shape => ({ kind: 'optional', shape });
export const object = (fields: Record<string, Shape>): Shape => ({ kind: 'object', fields });
export const array = (
  item: Shape,
  limits: { min?: number; max?: number; unique?: string } = {},
): Shape => ({ kind: 'array', item, ...limits });
export const variant = (key: string, options: Record<string, Record<string, Shape>>): Shape => ({
  kind: 'variant',
  key,
  options: Object.fromEntries(
    Object.entries(options).map(([tag, fields]) => [tag, object({ [key]: oneOf(tag), ...fields })]),
  ),
});
export const either = (...options: Shape[]): Shape => ({ kind: 'either', options });

const urlLike = /^(?:[a-z][a-z0-9+.-]*:\/\/|data:|blob:)/i;
const dataUrl = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+[^,\s]*,/i;
export const longestBase64Run = 64;
const base64Run = new RegExp(`[A-Za-z0-9+/_-]{${longestBase64Run + 1},}`);
const providerObjectId =
  /^(?:file|assistant|asst|thread|resp|vs|vsfb|batch|upload|conv|cntr|ftjob|ckpt)[-_][a-z0-9]/i;

export interface WalkOptions {
  side: 'request' | 'result';
  map?: (text: string) => string;
  keepMedia?: boolean;
  /** Object ids the provider issued earlier in the same run; an `issued` value in a request must be one. */
  issued?: ReadonlySet<string>;
  /** A walk of what goes on the wire: text may not hold a data URL there. */
  wire?: boolean;
  /** Replaces a media value in a request once the gate has admitted and read it. */
  mapMedia?: (value: unknown) => unknown;
}

export interface MediaInputFound {
  path: string;
  type: string;
  value: unknown;
}

export interface MediaFound {
  path: string;
  ref: MediaRef;
  body: Uint8Array;
}

export interface Walked<T = unknown> {
  value: T;
  problems: string[];
  media: string[];
  outputs: MediaFound[];
  inputs: MediaInputFound[];
  dropped: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJson = (value: unknown, depth = 0): boolean => {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isJson(v, depth + 1));
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype)
    return Object.values(value).every((v) => v === undefined || isJson(v, depth + 1));
  return false;
};

const where = (path: string) => path || 'payload';

const mapStrings = (value: unknown, map: (text: string) => string): unknown => {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, map));
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [map(k), mapStrings(v, map)]));
  return value;
};

const walkAt = <T>(shape: Shape, value: unknown, options: WalkOptions, base: string): Walked<T> => {
  const problems: string[] = [];
  const media: string[] = [];
  const outputs: MediaFound[] = [];
  const inputs: MediaInputFound[] = [];
  let dropped = 0;
  const request = options.side === 'request';

  const visit = (s: Shape, v: unknown, path: string): unknown => {
    const problem = (message: string) => {
      problems.push(`${where(path)}: ${message}`);
      return v;
    };
    switch (s.kind) {
      case 'text':
        if (typeof v === 'string' && options.wire && dataUrl.test(v))
          return problem('a data URL is media, which a media field carries');
        if (typeof v === 'string') return options.map ? options.map(v) : v;
        if (typeof v === 'object' && v !== null) {
          media.push(where(path));
          return v;
        }
        return problem('must be text');
      case 'media': {
        const rules = s.types ?? [s.type];
        const named = rules.join(', ');
        const single = rules.length === 1 && !s.type.endsWith('/*');
        if (request) {
          const typed =
            isMediaRef(v) || isInlineMedia(v) || isMediaInput(v) ? v.mediaType : undefined;
          if (typed !== undefined && !rules.some((r) => mediaTypeCovers(r, typed)))
            return problem(`must be ${named}, not ${typed}`);
          if (typed === undefined && (typeof v !== 'string' || !single || !decodeBase64(v)))
            return problem(`must be ${named} as a media reference or base64`);
          inputs.push({ path: where(path), type: typed ?? s.type, value: v });
          return options.mapMedia ? options.mapMedia(v) : v;
        }
        if (isMediaRef(v))
          return rules.some((r) => mediaTypeCovers(r, v.mediaType))
            ? v
            : problem(`must be ${named}, not ${v.mediaType}`);
        const inline = isInlineMedia(v) ? v : undefined;
        if (inline && !rules.some((r) => mediaTypeCovers(r, inline.mediaType)))
          return problem(`must be ${named}, not ${inline.mediaType}`);
        if (!inline && !single)
          return problem(`must name its media type, one of ${named}, with its data`);
        const data = inline ? inline.data : v;
        if (typeof data !== 'string') return problem(`must be encoded ${named}`);
        const body = decodeBase64(data);
        if (!body) return problem(`must be base64 encoded ${named}`);
        if (!options.keepMedia) return v;
        const ref: MediaRef = {
          kind: mediaRefKind,
          mediaType: inline ? inline.mediaType.toLowerCase() : s.type,
          bytes: body.byteLength,
          sha256: '',
          tenant: '',
          path: '',
        };
        outputs.push({ path: where(path), ref, body });
        return ref;
      }
      case 'plain':
        if (typeof v !== 'string') return problem('must be a string');
        if (s.min && v.length < s.min) return problem(`must have at least ${s.min} characters`);
        if (request && urlLike.test(v.trimStart()))
          return problem('a URL or data URL is not allowed here');
        if (request && base64Run.test(v))
          return problem('encoded data such as base64 is not allowed here');
        return v;
      case 'opaque':
        return typeof v === 'string' ? v : problem('must be a string');
      case 'ref':
        if (typeof v !== 'string') return problem('must be a string');
        if (request && urlLike.test(v)) return problem('a URL is not allowed here');
        if (request && providerObjectId.test(v))
          return problem('a provider-side object id is not allowed here');
        if (s.pattern && !s.pattern.test(v)) return problem(`must match ${String(s.pattern)}`);
        return v;
      case 'issued':
        if (typeof v !== 'string') return problem('must be a string');
        if (!s.pattern.test(v)) return problem(`must match ${String(s.pattern)}`);
        if (request && urlLike.test(v)) return problem('a URL is not allowed here');
        if (request && !options.issued?.has(v))
          return problem('must be an id the provider issued earlier in this call, never input');
        return v;
      case 'enum':
        return typeof v === 'string' && s.values.includes(v)
          ? v
          : problem(`must be one of ${s.values.join(', ')}`);
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) return problem('must be a number');
        if (s.integer && !Number.isInteger(v)) return problem('must be a whole number');
        if (s.min !== undefined && v < s.min) return problem(`must be at least ${s.min}`);
        if (s.max !== undefined && v > s.max) return problem(`must be at most ${s.max}`);
        return v;
      case 'boolean':
        return typeof v === 'boolean' ? v : problem('must be true or false');
      case 'null':
        return v === null ? v : problem('must be null');
      case 'json':
        if (!isJson(v)) return problem('must be plain JSON');
        return options.map ? mapStrings(v, options.map) : v;
      case 'optional':
        return visit(s.shape, v, path);
      case 'object': {
        if (!isRecord(v)) return problem('must be an object');
        const out: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(s.fields)) {
          const at = path ? `${path}.${key}` : key;
          if (v[key] === undefined) {
            if (field.kind !== 'optional') problems.push(`${at}: is required`);
            continue;
          }
          out[key] = visit(field, v[key], at);
        }
        for (const [key, extra] of Object.entries(v)) {
          if (key in s.fields || extra === undefined) continue;
          if (request) problems.push(`${path ? `${path}.${key}` : key}: is not allowed`);
          else dropped += 1;
        }
        return out;
      }
      case 'array': {
        if (!Array.isArray(v)) return problem('must be a list');
        if (s.min !== undefined && v.length < s.min)
          return problem(`must have at least ${s.min} items`);
        if (s.max !== undefined && v.length > s.max)
          return problem(`must have at most ${s.max} items`);
        if (s.unique) {
          const keys = v.map((item) => (isRecord(item) ? item[s.unique as string] : undefined));
          if (new Set(keys).size !== keys.length) return problem(`${s.unique} must be unique`);
        }
        return v.map((item, i) => visit(s.item, item, `${path}[${i}]`));
      }
      case 'variant': {
        const tag = isRecord(v) ? v[s.key] : undefined;
        const option = typeof tag === 'string' ? s.options[tag] : undefined;
        if (!option) return problem(`${s.key} must be one of ${Object.keys(s.options).join(', ')}`);
        return visit(option, v, path);
      }
      case 'either': {
        const tries = s.options.map((option) => walkAt(option, v, options, path));
        const structural = tries.filter((_, i) => s.options[i]?.kind !== 'text');
        const candidates =
          typeof v === 'object' && v !== null && structural.length ? structural : tries;
        const chosen =
          tries.find((t) => t.problems.length === 0 && t.media.length === 0) ??
          candidates.find((t) => t.problems.length === 0) ??
          candidates[0];
        if (!chosen) return problem('has no shape');
        problems.push(...chosen.problems);
        media.push(...chosen.media);
        outputs.push(...chosen.outputs);
        inputs.push(...chosen.inputs);
        dropped += chosen.dropped;
        return chosen.value;
      }
    }
  };

  return { value: visit(shape, value, base) as T, problems, media, outputs, inputs, dropped };
};

export const mediaTypesOf = (s: Shape): string[] => {
  switch (s.kind) {
    case 'media':
      return [...(s.types ?? [s.type])];
    case 'object':
      return [...new Set(Object.values(s.fields).flatMap(mediaTypesOf))];
    case 'array':
      return mediaTypesOf(s.item);
    case 'optional':
      return mediaTypesOf(s.shape);
    case 'variant':
      return [...new Set(Object.values(s.options).flatMap(mediaTypesOf))];
    case 'either':
      return [...new Set(s.options.flatMap(mediaTypesOf))];
    default:
      return [];
  }
};

/** Walks a value through its closed shape: validates, finds media, maps text and drops what the shape does not know. */
export const walk = <T = unknown>(shape: Shape, value: unknown, options: WalkOptions): Walked<T> =>
  walkAt<T>(shape, value, options, '');

const usage = object({
  inputTokens: optional(number({ min: 0 })),
  outputTokens: optional(number({ min: 0 })),
  cachedInputTokens: optional(number({ min: 0 })),
  requests: optional(number({ min: 0 })),
  costMicroNok: optional(number({ min: 0 })),
});

const toolCall = object({ id: ref(), name: plain(), arguments: text });

/** Chat as the model port has it; `continuation` is the replay state each adapter declares. */
export const chatShape = (continuations: readonly Shape[] = []): OperationShape => {
  const continuation = continuations.length
    ? { continuation: optional(either(...continuations)) }
    : {};
  return {
    request: object({
      messages: array(
        variant('role', {
          system: { content: text },
          user: { content: text },
          assistant: { content: text, toolCalls: optional(array(toolCall)), ...continuation },
          tool: { content: text, toolCallId: ref() },
        }),
      ),
      tools: optional(array(object({ name: plain(), description: plain(), parameters: json }))),
      temperature: optional(number()),
      maxTokens: optional(number({ integer: true, min: 1 })),
      reasoning: optional(oneOf('low', 'medium', 'high')),
      jsonSchema: optional(object({ name: plain(), schema: json })),
      purpose: optional(oneOf('answer')),
    }),
    result: object({
      content: text,
      toolCalls: array(toolCall),
      finishReason: oneOf('stop', 'length', 'tool_calls', 'content_filter', 'other'),
      usage,
      servedModel: plain(),
      ...continuation,
      droppedParameters: optional(array(oneOf('temperature', 'reasoning', 'maxTokens'))),
    }),
  };
};

export const embedShape: OperationShape = {
  request: array(text),
  result: object({
    vectors: array(array(number())),
    usage: object({ inputTokens: number({ min: 0 }) }),
  }),
};

export const rerankShape: OperationShape = {
  request: object({ query: text, documents: array(text) }),
  result: array(object({ index: number({ integer: true }), score: number(), rank: number() })),
};

export const maxDecisionQuestions = 400;

const questionName = ref(/^[a-zA-Z0-9_-]{1,64}$/);
const probability = number({ min: 0, max: 1 });

export const decideShape: OperationShape = {
  request: object({
    input: either(text, array(object({ role: oneOf('user'), content: text }), { min: 1 })),
    questions: array(
      variant('type', {
        predicate: { name: questionName, instructions: plain(1) },
        choice: {
          name: questionName,
          instructions: plain(1),
          choices: array(object({ value: plain(1), description: optional(plain(1)) }), {
            min: 2,
            unique: 'value',
          }),
        },
        score: {
          name: questionName,
          instructions: plain(1),
          levels: array(object({ label: plain(1), description: optional(plain(1)) }), { min: 2 }),
        },
      }),
      { min: 1, max: maxDecisionQuestions, unique: 'name' },
    ),
  }),
  result: object({
    answers: array(
      variant('type', {
        predicate: { name: plain(), probability },
        choice: {
          name: plain(),
          choice: plain(),
          probabilities: array(object({ value: plain(), probability })),
          confidence: probability,
        },
        score: {
          name: plain(),
          score: number(),
          probabilities: array(object({ value: number(), label: plain(), probability })),
          confidence: probability,
        },
        refusal: { name: either(plain(), nothing) },
      }),
    ),
    usage,
    servedModel: plain(),
    calibrated: boolean,
    dropped: optional(number({ integer: true, min: 0 })),
  }),
};
