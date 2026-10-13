import { z } from 'zod';

export const answerLanguages = ['nb', 'nn', 'en'] as const;
export type AnswerLanguage = (typeof answerLanguages)[number];

export const maxInstructionChars = 64 * 1024;

const text = z.string().min(1).max(maxInstructionChars);
const perLanguage = z.partialRecord(z.enum(answerLanguages), text);

export const instructionsConfig = z.union([
  text,
  perLanguage.refine(
    (v) => Object.keys(v).length > 0,
    'give instructions for at least one language',
  ),
]);
export type InstructionsConfig = z.infer<typeof instructionsConfig>;

export const languageInstructionsConfig = perLanguage;
export type LanguageInstructions = z.infer<typeof languageInstructionsConfig>;

export const baseInstructions = (instructions: InstructionsConfig): string =>
  typeof instructions === 'string'
    ? instructions
    : (answerLanguages.map((l) => instructions[l]).find((t) => t !== undefined) ?? '');
