import type { Ref } from '@genai/contracts';
import type { Emitted } from '@genai/kernel';
import {
  defaultMaxOutputTokens,
  ModelError,
  type ChatRequest,
  type ChatResult,
  type ModelPort,
} from '@genai/port-model';
import { z } from 'zod';
import type { Block, BlockContext } from '../blocks.js';
import type { FlowChunk } from '../services.js';
import { contextFromChunks } from './context.js';
import { chunkSource, type CellSource } from './table.js';

export class StepFailure extends Error {
  constructor(
    readonly code: 'output_truncated' | 'invalid_json' | 'missing_fields',
    message: string,
  ) {
    super(message);
  }
}

const retryable = (error: unknown) =>
  error instanceof ModelError && (error.code === 'rate_limited' || error.code === 'unavailable');

const jsonInstruction = (schema: Record<string, unknown>) =>
  `Answer with one JSON object only, no other text, matching this JSON schema:\n${JSON.stringify(schema)}`;

const adapted = (request: ChatRequest, port: ModelPort): ChatRequest => {
  const capabilities = port.info().capabilities;
  const { reasoning, jsonSchema, ...rest } = request;
  const next: ChatRequest = { ...rest };
  if (reasoning && capabilities.includes('reasoning')) next.reasoning = reasoning;
  if (!jsonSchema) return next;
  if (capabilities.includes('json-schema')) return { ...next, jsonSchema };
  return {
    ...next,
    messages: [...rest.messages, { role: 'user', content: jsonInstruction(jsonSchema.schema) }],
  };
};

async function* callOnce(
  port: ModelPort,
  call: ChatRequest,
  stream: boolean,
  delivered: { text: boolean },
): AsyncGenerator<Emitted, ChatResult> {
  const request = adapted(call, port);
  if (!stream || !port.info().capabilities.includes('stream')) return await port.chat(request);
  for await (const chunk of port.chatStream(request)) {
    if (chunk.kind === 'done') return chunk.result;
    delivered.text = true;
    yield { type: 'kernel.part.delta', data: { text: chunk.text } };
  }
  throw new ModelError('unavailable', 'the stream ended without a result');
}

export async function* callModel(
  ctx: BlockContext,
  request: ChatRequest,
  stream = false,
): AsyncGenerator<Emitted, ChatResult> {
  const model = ctx.config.model;
  if (!model?.primary)
    throw new Error(`step ${ctx.step} needs a model, and the service names none`);
  const tenant = model.tenant ?? ctx.invocation.tenant;
  const ref = (id: string): Ref => ({ kind: 'model', id, tenant });
  const delivered = { text: false };
  try {
    return yield* callOnce(
      await ctx.invocation.use<ModelPort>('model', ref(model.primary)),
      request,
      stream,
      delivered,
    );
  } catch (error) {
    if (!model.fallback || !retryable(error) || delivered.text || ctx.invocation.signal.aborted)
      throw error;
    const fallback = await ctx.invocation.use<ModelPort>('model', ref(model.fallback));
    return yield* callOnce(fallback, request, stream, delivered);
  }
}

const reasoningEffort = z.enum(['low', 'medium', 'high']);

const generation = {
  system: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
};

const messages = (system: string | undefined, prompt: string): ChatRequest['messages'] => [
  ...(system ? [{ role: 'system' as const, content: system }] : []),
  { role: 'user' as const, content: prompt },
];

const tuning = (p: { temperature?: number | undefined; maxTokens?: number | undefined }) => ({
  ...(p.temperature === undefined ? {} : { temperature: p.temperature }),
  maxTokens: p.maxTokens ?? defaultMaxOutputTokens,
});

const modelInput = z.looseObject({ prompt: z.string().min(1) });
const modelParams = z.strictObject({ ...generation, stream: z.boolean().default(false) });

export const modelBlock: Block<z.infer<typeof modelInput>, z.infer<typeof modelParams>> = {
  name: 'model',
  version: '1',
  description: 'One model call with a prompt; streams the answer when asked',
  input: modelInput,
  params: modelParams,
  output: z.strictObject({ text: z.string() }),
  run: async function* (ctx, input, params) {
    const result = yield* callModel(
      ctx,
      {
        messages: messages(params.system, input.prompt),
        ...tuning(params),
        ...(params.stream ? { purpose: 'answer' as const } : {}),
      },
      params.stream,
    );
    return { text: result.content };
  },
};

const extractInput = z.looseObject({
  prompt: z.string().min(1),
  chunks: z.array(z.looseObject({ chunkId: z.string() })).optional(),
});
const extractParams = z.strictObject({
  ...generation,
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .default('extraction'),
  schema: z.record(z.string(), z.unknown()),
  maxContextLength: z.number().int().positive().default(24000),
  maxWindows: z.number().int().positive().max(40).default(6),
  reasoning: reasoningEffort.default('low'),
});

const requiredOf = (schema: Record<string, unknown>) =>
  Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === 'string')
    : [];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isLeaf = (schema: Record<string, unknown>) =>
  schema.type !== 'object' && schema.type !== 'array';

export const citedSchema = (schema: unknown): unknown => {
  if (!isRecord(schema)) return schema;
  if (schema.type === 'object' && isRecord(schema.properties))
    return {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(schema.properties).map(([k, v]) => [k, citedSchema(v)]),
      ),
    };
  if (schema.type === 'array' && isRecord(schema.items))
    return { ...schema, items: citedSchema(schema.items) };
  if (!isLeaf(schema)) return schema;
  return {
    type: 'object',
    properties: { value: schema, sources: { type: 'array', items: { type: 'integer' } } },
    required: ['value', 'sources'],
    additionalProperties: false,
  };
};

const uncite = (
  schema: unknown,
  value: unknown,
  path: string,
  found: Record<string, number[]>,
): unknown => {
  if (!isRecord(schema)) return value;
  if (schema.type === 'object' && isRecord(schema.properties) && isRecord(value)) {
    const properties = schema.properties;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        uncite(properties[k], v, path ? `${path}.${k}` : k, found),
      ]),
    );
  }
  if (schema.type === 'array' && Array.isArray(value))
    return value.map((v, i) => uncite(schema.items, v, path ? `${path}.${i}` : String(i), found));
  if (!isLeaf(schema) || !isRecord(value) || !('value' in value)) return value;
  if (Array.isArray(value.sources))
    found[path] = value.sources.filter((n): n is number => typeof n === 'number');
  return value.value;
};

const evidence = (chunks: FlowChunk[], maxLength: number) => {
  const { docs, used } = contextFromChunks(chunks, chunks.length, maxLength);
  return {
    used,
    text: docs.map((d, i) => `[${i + 1}] ${d.content}`).join('\n\n'),
  };
};

const windowsOf = (chunks: FlowChunk[], maxLength: number, maxWindows: number) => {
  const total = contextFromChunks(chunks, chunks.length, Number.POSITIVE_INFINITY).length;
  const size = Math.max(maxLength, Math.ceil(total / maxWindows));
  const windows: FlowChunk[][] = [];
  let rest = chunks;
  while (rest.length > 0) {
    const { used } = contextFromChunks(rest, rest.length, size);
    const taken =
      used.length === 0 ? rest.length : rest.indexOf(used[used.length - 1] as FlowChunk) + 1;
    windows.push(rest.slice(0, taken));
    rest = rest.slice(taken);
  }
  return windows;
};

const citeInstruction =
  'Every value is an object with "value" and "sources". "sources" lists the numbers of the excerpts the value comes from. Use only the excerpts below; leave a value empty and its sources empty when the excerpts do not say.';

const repairInstruction =
  'The previous answer was not one complete, valid JSON object. Answer again with only the JSON object, as short as the schema allows.';

const maxRepairTokens = 64000;
const fittedTokens = (chars: number) =>
  Math.min(32000, Math.max(8000, 6000 + Math.ceil(chars / 3)));

const parseObject = (text: string): Record<string, unknown> | undefined => {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)?.[1] ?? trimmed;
  try {
    const parsed: unknown = JSON.parse(fenced);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

async function* askForObject(
  ctx: BlockContext,
  request: ChatRequest,
): AsyncGenerator<Emitted, Record<string, unknown>> {
  let current = request;
  for (let attempt = 0; ; attempt += 1) {
    const result = yield* callModel(ctx, current);
    const truncated = result.finishReason === 'length';
    const parsed = truncated ? undefined : parseObject(result.content);
    if (parsed) return parsed;
    if (attempt > 0)
      throw truncated
        ? new StepFailure(
            'output_truncated',
            `step ${ctx.step}: the model ran out of output budget`,
          )
        : new StepFailure('invalid_json', `step ${ctx.step}: the model did not return valid JSON`);
    current = {
      ...request,
      maxTokens: Math.min(maxRepairTokens, (request.maxTokens ?? defaultMaxOutputTokens) * 2),
      messages: [...request.messages, { role: 'user', content: repairInstruction }],
    };
  }
}

type Cites = Record<string, CellSource[]>;
interface Part {
  values: Record<string, unknown>;
  cites: Cites;
}

const empty = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (isRecord(v) && Object.keys(v).length === 0);

const under = (key: string, path: string) =>
  path === '' || key === path || key.startsWith(`${path}.`);

const shifted = (cites: Cites, path: string, offset: number): Cites => {
  const prefix = `${path}.`;
  return Object.fromEntries(
    Object.entries(cites).flatMap(([key, list]) => {
      const m = key.startsWith(prefix) ? /^(\d+)(.*)$/.exec(key.slice(prefix.length)) : null;
      return m ? [[`${prefix}${Number(m[1]) + offset}${m[2]}`, list]] : [];
    }),
  );
};

const mergeAt = (
  schema: unknown,
  parts: { value: unknown; cites: Cites }[],
  path: string,
): { value: unknown; cites: Cites } => {
  const present = parts.filter((p) => p.value !== undefined);
  if (isRecord(schema) && schema.type === 'object' && isRecord(schema.properties)) {
    const properties = schema.properties;
    const keys = [
      ...new Set(present.flatMap((p) => (isRecord(p.value) ? Object.keys(p.value) : []))),
    ];
    const value: Record<string, unknown> = {};
    let cites: Cites = {};
    for (const key of keys) {
      const sub = mergeAt(
        properties[key],
        present.map((p) => ({
          value: isRecord(p.value) ? p.value[key] : undefined,
          cites: p.cites,
        })),
        path ? `${path}.${key}` : key,
      );
      value[key] = sub.value;
      cites = { ...cites, ...sub.cites };
    }
    return { value, cites };
  }
  if (isRecord(schema) && schema.type === 'array') {
    const value: unknown[] = [];
    let cites: Cites = {};
    for (const p of present) {
      const list = Array.isArray(p.value) ? p.value : [];
      cites = { ...cites, ...shifted(p.cites, path, value.length) };
      value.push(...list);
    }
    return { value, cites };
  }
  const chosen = present.find((p) => !empty(p.value)) ?? present[0];
  if (!chosen) return { value: undefined, cites: {} };
  return {
    value: chosen.value,
    cites: Object.fromEntries(Object.entries(chosen.cites).filter(([k]) => under(k, path))),
  };
};

async function* extractWindow(
  ctx: BlockContext,
  prompt: string,
  params: z.infer<typeof extractParams>,
  window: FlowChunk[] | undefined,
): AsyncGenerator<Emitted, Part> {
  const context = window ? evidence(window, Number.MAX_SAFE_INTEGER) : undefined;
  const text = context ? `${prompt}\n\n${citeInstruction}\n\nExcerpts:\n${context.text}` : prompt;
  const schema = context ? (citedSchema(params.schema) as Record<string, unknown>) : params.schema;
  const parsed = yield* askForObject(ctx, {
    messages: messages(params.system, text),
    jsonSchema: { name: params.name, schema },
    reasoning: params.reasoning,
    ...tuning({
      ...params,
      temperature: params.temperature ?? 0,
      maxTokens: params.maxTokens ?? fittedTokens(text.length),
    }),
  });
  const numbers: Record<string, number[]> = {};
  const values = context
    ? (uncite(params.schema, parsed, '', numbers) as Record<string, unknown>)
    : parsed;
  const missing = requiredOf(params.schema).filter((key) => !(key in values));
  if (missing.length > 0)
    throw new StepFailure(
      'missing_fields',
      `step ${ctx.step}: the model left out ${missing.join(', ')}`,
    );
  const cites = Object.fromEntries(
    Object.entries(numbers).map(([path, list]) => [
      path,
      [...new Set(list)].flatMap((n) => {
        const chunk = context?.used[n - 1];
        return chunk ? [chunkSource(chunk)] : [];
      }),
    ]),
  );
  return { values, cites };
}

export const extractBlock: Block<z.infer<typeof extractInput>, z.infer<typeof extractParams>> = {
  name: 'extract',
  version: '1',
  description:
    'Structured extraction: the model fills a JSON schema, citing the chunks each value came from; long inputs are read window by window and merged',
  input: extractInput,
  params: extractParams,
  output: z.record(z.string(), z.unknown()),
  run: async function* (ctx, input, params) {
    const chunks = (input.chunks ?? []) as FlowChunk[];
    const cited = chunks.length > 0;
    if (cited && isRecord(params.schema.properties) && 'citations' in params.schema.properties)
      throw new Error(
        `step ${ctx.step}: a schema that cites sources cannot have a citations field`,
      );
    if (!cited) return (yield* extractWindow(ctx, input.prompt, params, undefined)).values;
    const parts: Part[] = [];
    for (const window of windowsOf(chunks, params.maxContextLength, params.maxWindows))
      parts.push(yield* extractWindow(ctx, input.prompt, params, window));
    const merged =
      parts.length === 1
        ? (parts[0] as Part)
        : (() => {
            const m = mergeAt(
              params.schema,
              parts.map((p) => ({ value: p.values, cites: p.cites })),
              '',
            );
            return { values: m.value as Record<string, unknown>, cites: m.cites };
          })();
    return { ...merged.values, citations: merged.cites };
  },
};

const classifyInput = z.looseObject({ text: z.string().optional() });
const textOf = (input: Record<string, unknown>) =>
  typeof input.text === 'string' && input.text
    ? input.text
    : typeof input.query === 'string'
      ? input.query
      : '';

const classifyParams = z.strictObject({
  ...generation,
  labels: z.array(z.string().min(1)).min(2),
  instructions: z.string().min(1).optional(),
});

export const classifyBlock: Block<z.infer<typeof classifyInput>, z.infer<typeof classifyParams>> = {
  name: 'classify',
  version: '1',
  description: 'Pick exactly one label for a text',
  input: classifyInput,
  params: classifyParams,
  output: z.strictObject({ label: z.string(), reason: z.string() }),
  run: async function* (ctx, input, params) {
    const prompt = [
      params.instructions ?? 'Classify the text with exactly one of the labels.',
      `Labels: ${params.labels.join(', ')}`,
      `Text:\n${input.text ?? textOf(ctx.input)}`,
    ].join('\n\n');
    const result = yield* callModel(ctx, {
      messages: messages(params.system, prompt),
      jsonSchema: {
        name: 'classification',
        schema: {
          type: 'object',
          properties: {
            label: { type: 'string', enum: params.labels },
            reason: { type: 'string' },
          },
          required: ['label', 'reason'],
          additionalProperties: false,
        },
      },
      ...tuning({ temperature: params.temperature ?? 0, maxTokens: params.maxTokens }),
    });
    let parsed: { label?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(result.content) as typeof parsed;
    } catch {
      throw new Error(`step ${ctx.step}: the model did not return a classification`);
    }
    if (typeof parsed.label !== 'string' || !params.labels.includes(parsed.label))
      throw new Error(
        `step ${ctx.step}: the model chose a label outside ${params.labels.join(', ')}`,
      );
    return { label: parsed.label, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  },
};
