import type { Usage } from '@genai/contracts';
import { z } from 'zod';
import type { ModelInfo } from './port.js';

export const maxDecisionQuestions = 400;

const text = z.string().min(1);
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'must be letters, digits, _ or -');

const question = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('predicate'), name, instructions: text }),
  z.strictObject({
    type: z.literal('choice'),
    name,
    instructions: text,
    choices: z
      .array(z.strictObject({ value: text, description: text.optional() }))
      .min(2)
      .refine((c) => new Set(c.map((x) => x.value)).size === c.length, 'values must be unique'),
  }),
  z.strictObject({
    type: z.literal('score'),
    name,
    instructions: text,
    levels: z.array(z.strictObject({ label: text, description: text.optional() })).min(2),
  }),
]);

const message = z.strictObject({ role: z.literal('user'), content: z.string() });

export const decisionRequestShape = z.strictObject({
  input: z.union([z.string(), z.array(message).min(1)]),
  questions: z
    .array(question)
    .min(1)
    .max(maxDecisionQuestions)
    .refine(
      (q) => new Set(q.map((x) => x.name)).size === q.length,
      'question names must be unique',
    ),
});

export type DecisionQuestion = z.infer<typeof question>;
export type DecisionMessage = z.infer<typeof message>;
export type DecisionRequest = z.infer<typeof decisionRequestShape>;

export type DecisionAnswer =
  | { type: 'predicate'; name: string; probability: number }
  | {
      type: 'choice';
      name: string;
      choice: string;
      probabilities: { value: string; probability: number }[];
      confidence: number;
    }
  | {
      type: 'score';
      name: string;
      score: number;
      probabilities: { value: number; label: string; probability: number }[];
      confidence: number;
    }
  | { type: 'refusal'; name: string | null };

export interface DecisionResult {
  answers: DecisionAnswer[];
  usage: Usage;
  servedModel: string;
  /** True when probabilities come from the model's answer distribution, not from generated text. */
  calibrated: boolean;
  dropped?: number;
}

export interface DecisionPort {
  info(): ModelInfo;
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

export const decisionRequestProblem = (request: unknown): string | undefined => {
  const parsed = decisionRequestShape.safeParse(request);
  if (parsed.success) return undefined;
  return parsed.error.issues
    .map((i) => `${i.path.map(String).join('.') || 'request'}: ${i.message}`)
    .join('; ');
};

export const answerOf = (result: DecisionResult, name: string) =>
  result.answers.find((a) => a.name === name);
