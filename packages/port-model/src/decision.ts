import type { Usage } from '@genai/contracts';
import type { ModelInfo } from './port.js';

export { maxDecisionQuestions } from '@genai/kernel';

export type DecisionQuestion =
  | { type: 'predicate'; name: string; instructions: string }
  | {
      type: 'choice';
      name: string;
      instructions: string;
      choices: { value: string; description?: string | undefined }[];
    }
  | {
      type: 'score';
      name: string;
      instructions: string;
      levels: { label: string; description?: string | undefined }[];
    };

export interface DecisionMessage {
  role: 'user';
  content: string;
}

export interface DecisionRequest {
  input: string | DecisionMessage[];
  questions: DecisionQuestion[];
}

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

export const answerOf = (result: DecisionResult, name: string) =>
  result.answers.find((a) => a.name === name);
