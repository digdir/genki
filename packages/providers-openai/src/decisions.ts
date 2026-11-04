import {
  ModelError,
  type DecisionAnswer,
  type DecisionRequest,
  type DecisionResult,
  type DeploymentConfig,
} from '@genai/port-model';
import { z } from 'zod';

export const decisionsPath = '/decisions';

const probability = z.number().min(0).max(1);
const count = z.number().int().min(0);

const wireAnswer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('predicate'), name: z.string(), probability }),
  z.object({
    type: z.literal('choice'),
    name: z.string(),
    choice: z.string(),
    probabilities: z.array(z.object({ value: z.string(), probability })),
    confidence: probability,
  }),
  z.object({
    type: z.literal('score'),
    name: z.string(),
    score: z.number(),
    probabilities: z.array(z.object({ value: z.number(), label: z.string(), probability })),
    confidence: probability,
  }),
  z.object({ type: z.literal('refusal'), name: z.string().nullable() }),
]);

const wireResponse = z.object({
  model: z.string().optional(),
  answers: z.array(wireAnswer),
  usage: z.object({
    input_tokens: count,
    input_tokens_details: z
      .object({ cached_tokens: count.optional(), cache_write_tokens: count.optional() })
      .optional(),
    output_tokens: count,
    output_tokens_details: z.object({ reasoning_tokens: count.optional() }).optional(),
    total_tokens: count.optional(),
  }),
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const droppedFields = (raw: unknown, kept: unknown): number => {
  if (Array.isArray(raw) && Array.isArray(kept))
    return raw.reduce<number>((sum, item, i) => sum + droppedFields(item, kept[i]), 0);
  if (!isObject(raw) || !isObject(kept)) return 0;
  return Object.entries(raw).reduce(
    (sum, [key, value]) => sum + (key in kept ? droppedFields(value, kept[key]) : 1),
    0,
  );
};

export const decisionsBody = (model: DeploymentConfig, request: DecisionRequest) => ({
  model: model.deployment,
  input:
    typeof request.input === 'string'
      ? request.input
      : request.input.map((m) => ({ role: m.role, content: m.content })),
  questions: request.questions.map((q) => {
    const base = { type: q.type, name: q.name, instructions: q.instructions };
    if (q.type === 'choice')
      return {
        ...base,
        choices: q.choices.map((c) => ({
          value: c.value,
          ...(c.description ? { description: c.description } : {}),
        })),
      };
    if (q.type === 'score')
      return {
        ...base,
        levels: q.levels.map((l) => ({
          label: l.label,
          ...(l.description ? { description: l.description } : {}),
        })),
      };
    return base;
  }),
});

export const decisionsResult = (
  model: DeploymentConfig,
  request: DecisionRequest,
  raw: unknown,
): DecisionResult => {
  const parsed = wireResponse.safeParse(raw);
  if (!parsed.success)
    throw new ModelError('unavailable', 'the decision response does not have the decide shape');
  const body = parsed.data;
  const answers: DecisionAnswer[] = body.answers;
  if (
    answers.length !== request.questions.length ||
    answers.some((a, i) => a.name !== null && a.name !== request.questions[i]?.name)
  )
    throw new ModelError('unavailable', 'the decision answers do not match the questions');
  const cached = body.usage.input_tokens_details?.cached_tokens;
  const dropped = droppedFields(raw, body);
  return {
    answers,
    usage: {
      inputTokens: body.usage.input_tokens,
      outputTokens: body.usage.output_tokens,
      ...(cached ? { cachedInputTokens: cached } : {}),
      requests: 1,
    },
    servedModel: body.model ?? model.deployment,
    calibrated: true,
    ...(dropped ? { dropped } : {}),
  };
};
