import { isFormInput, type Input, type Part, type Ref } from '@genai/contracts';
import type { Emitted, InvocationContext, Strategy } from '@genai/kernel';
import {
  baseInstructions,
  defaultMaxOutputTokens,
  instructionsConfig,
  languageInstructionsConfig,
  ModelError,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ModelPort,
} from '@genai/port-model';
import { z } from 'zod';
import { runtimeSkills, skillsSection } from './skills.js';

export * from './skills.js';

export const singleCallConfig = z.strictObject({
  instructions: instructionsConfig,
  languageInstructions: languageInstructionsConfig.optional(),
  examples: z.array(z.string().min(1)).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoning: z.enum(['low', 'medium', 'high']).optional(),
});

export type SingleCallConfig = z.infer<typeof singleCallConfig>;

const outputField = z.looseObject({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'date', 'list']),
  description: z.string().min(1),
  required: z.boolean().optional(),
});

export const singleCallRuntimeConfig = z.looseObject({
  strategy: singleCallConfig,
  output: z.looseObject({
    kind: z.enum(['answer', 'fields', 'document']),
    fields: z.array(outputField).optional(),
  }),
  model: z.looseObject({
    primary: z.string().min(1),
    fallback: z.string().min(1).optional(),
    tenant: z.string().min(1).optional(),
  }),
  skills: runtimeSkills,
});

export type SingleCallRuntimeConfig = z.infer<typeof singleCallRuntimeConfig>;
type OutputField = z.infer<typeof outputField>;

const fieldSchema: Record<OutputField['type'], Record<string, unknown>> = {
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  date: { type: 'string', format: 'date' },
  list: { type: 'array', items: { type: 'string' } },
};

const fieldValidator: Record<OutputField['type'], z.ZodType> = {
  string: z.string(),
  number: z.number(),
  boolean: z.boolean(),
  date: z.iso.date(),
  list: z.array(z.string()),
};

const jsonSchemaFor = (fields: OutputField[]) => ({
  type: 'object',
  properties: Object.fromEntries(
    fields.map((f) => [
      f.name,
      f.required === false
        ? { anyOf: [fieldSchema[f.type], { type: 'null' }], description: f.description }
        : { ...fieldSchema[f.type], description: f.description },
    ]),
  ),
  required: fields.map((f) => f.name),
  additionalProperties: false,
});

const validatorFor = (fields: OutputField[]) =>
  z.strictObject(
    Object.fromEntries(
      fields.map((f) => [
        f.name,
        f.required === false ? fieldValidator[f.type].nullable() : fieldValidator[f.type],
      ]),
    ),
  );

const partText = (part: Part): string => {
  if (part.body.kind === 'text') return part.body.text;
  if (part.body.kind === 'json') return JSON.stringify(part.body.json);
  throw new Error(`single-call reads text and JSON input only, not ${part.mime}`);
};

const historyOf = (data: unknown): ChatMessage[] => {
  const history = (data as { history?: unknown } | null)?.history;
  return (Array.isArray(history) ? history : []).flatMap((turn): ChatMessage[] => {
    const { role, text } = (turn ?? {}) as { role?: unknown; text?: unknown };
    return (role === 'user' || role === 'assistant') && typeof text === 'string' && text.trim()
      ? [{ role, content: text }]
      : [];
  });
};

const withoutHistory = (data: unknown) =>
  data && typeof data === 'object' && !Array.isArray(data) && 'history' in data
    ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'history'))
    : data;

const userContent = (input: Input): string => {
  const texts = (input.parts ?? []).map(partText);
  if (input.data !== undefined && !isFormInput(input))
    texts.push(JSON.stringify(withoutHistory(input.data)));
  if (texts.length === 0) throw new Error('single-call needs some input');
  return texts.join('\n\n');
};

const messagesFor = (config: SingleCallRuntimeConfig, input: Input): ChatMessage[] => [
  {
    role: 'system',
    content: baseInstructions(config.strategy.instructions) + skillsSection(config.skills),
  },
  ...(config.strategy.examples ?? []).map((content) => ({ role: 'system' as const, content })),
  ...historyOf(input.data),
  { role: 'user', content: userContent(input) },
];

const retryable = (error: unknown) =>
  error instanceof ModelError && (error.code === 'rate_limited' || error.code === 'unavailable');

async function* callModel(
  port: ModelPort,
  request: ChatRequest,
  stream: boolean,
  delivered: { text: boolean },
): AsyncGenerator<Emitted, ChatResult> {
  if (!stream || !port.info().capabilities.includes('stream')) return await port.chat(request);
  for await (const chunk of port.chatStream(request)) {
    if (chunk.kind === 'done') return chunk.result;
    delivered.text = true;
    yield { type: 'kernel.part.delta', data: { text: chunk.text } };
  }
  throw new ModelError('unavailable', 'the stream ended without a result');
}

export const singleCall: Strategy<SingleCallRuntimeConfig> = {
  id: 'single-call',
  version: '1',
  requires: { kernel: 1, ports: ['model'], features: [] },

  run: async function* (ctx: InvocationContext, input: Input, raw: SingleCallRuntimeConfig) {
    const config = singleCallRuntimeConfig.parse(raw);
    const { output, model } = config;
    if (output.kind === 'document') throw new Error('single-call cannot produce documents yet');
    const fields = output.kind === 'fields' ? (output.fields ?? []) : undefined;
    if (fields?.length === 0) throw new Error('an output of kind fields needs fields');

    const request: ChatRequest = {
      purpose: 'answer',
      messages: messagesFor(config, input),
      ...(config.strategy.temperature === undefined
        ? {}
        : { temperature: config.strategy.temperature }),
      maxTokens: config.strategy.maxTokens ?? defaultMaxOutputTokens,
      ...(config.strategy.reasoning ? { reasoning: config.strategy.reasoning } : {}),
      ...(fields ? { jsonSchema: { name: 'fields', schema: jsonSchemaFor(fields) } } : {}),
    };
    const ref = (id: string): Ref => ({ kind: 'model', id, tenant: model.tenant ?? ctx.tenant });
    const delivered = { text: false };

    let result: ChatResult;
    try {
      result = yield* callModel(
        await ctx.use<ModelPort>('model', ref(model.primary)),
        request,
        !fields,
        delivered,
      );
    } catch (error) {
      if (!model.fallback || !retryable(error) || delivered.text || ctx.signal.aborted) throw error;
      const fallback = await ctx.use<ModelPort>('model', ref(model.fallback));
      result = yield* callModel(fallback, request, !fields, delivered);
    }

    if (!fields) {
      yield {
        type: 'kernel.result',
        data: [{ mime: 'text/plain', body: { kind: 'text', text: result.content } }],
      };
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      throw new Error('the model did not return valid JSON for the fields');
    }
    const checked = validatorFor(fields).safeParse(parsed);
    if (!checked.success)
      throw new Error(`the model returned fields that do not match: ${checked.error.message}`);
    yield {
      type: 'kernel.result',
      data: [{ mime: 'application/json', body: { kind: 'json', json: checked.data } }],
    };
  },
};
export * from './schema-labels.js';
