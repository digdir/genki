import { soundsLikeRefusal } from '@genai/strategy-agent-loop';
import type { ServiceRunSuccess } from './draft-runner.js';

const shortRefusalLength = 80;

// A run found nothing when its answer is empty, when the strategy marked a worded "found
// nothing", or when a short answer reads as one. Batch runs and test runs judge alike.
export const notFoundOf = (outcome: Pick<ServiceRunSuccess, 'noAnswer' | 'answer' | 'parts'>) =>
  outcome.noAnswer ||
  outcome.parts.some((p) => p.meta?.noAnswer === true) ||
  (outcome.answer.trim().length <= shortRefusalLength && soundsLikeRefusal(outcome.answer));
