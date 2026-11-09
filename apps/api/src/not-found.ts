import { soundsLikeRefusal } from '@genai/strategy-agent-loop';
import type { ServiceRunSuccess } from './draft-runner.js';

const shortRefusalLength = 80;

type Answered = Pick<ServiceRunSuccess, 'noAnswer' | 'answer' | 'parts'>;

// The run or its strategy said it found nothing, as a test run grades a refusal. A blank or short
// answer is not taken for one there, so a broken answer does not pass a case that expects one.
export const markedNotFound = (outcome: Answered) =>
  outcome.noAnswer || outcome.parts.some((p) => p.meta?.noAnswer === true);

// A batch run also counts a short answer that reads as "found nothing", and an empty one.
export const notFoundOf = (outcome: Answered) =>
  markedNotFound(outcome) ||
  (outcome.answer.trim().length <= shortRefusalLength && soundsLikeRefusal(outcome.answer));
