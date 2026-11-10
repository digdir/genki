import { soundsLikeRefusal } from '@genai/strategy-agent-loop';
import type { ServiceRunSuccess } from './draft-runner.js';

const shortRefusalLength = 80;

type Answered = Pick<ServiceRunSuccess, 'noAnswer' | 'answer' | 'parts'>;

// Test runs: only a run or strategy mark counts, not a blank answer.
export const markedNotFound = (outcome: Answered) =>
  outcome.noAnswer || outcome.parts.some((p) => p.meta?.noAnswer === true);

// Batch runs also count a short answer that reads as a refusal.
export const notFoundOf = (outcome: Answered) =>
  markedNotFound(outcome) ||
  (outcome.answer.trim().length <= shortRefusalLength && soundsLikeRefusal(outcome.answer));
