import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { JudgePrompt } from './evaluators.js';

const criterion = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().min(1),
});

export const judgePrompt = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().min(1),
  system: z.string().min(1),
  template: z.string().min(1),
  criteria: z.array(criterion).min(1),
  scale: z
    .strictObject({ min: z.number().int(), max: z.number().int() })
    .refine((s) => s.max > s.min, 'max must be above min')
    .optional(),
});

export const parseJudgePrompt = (text: string): JudgePrompt => {
  const parsed = judgePrompt.parse(parseYaml(text));
  return { ...parsed, scale: parsed.scale ?? { min: 0, max: 1 } };
};

export const bundledJudge = (id: 'answer-quality' | 'pairwise-preference'): JudgePrompt =>
  parseJudgePrompt(readFileSync(join(import.meta.dirname, '..', 'judges', `${id}.yaml`), 'utf8'));
