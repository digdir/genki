import type { Translation } from '@genai/i18n';
import type { feedback as source } from '../nb/feedback';

export const feedback = {
  label: 'Feedback on the answer',
  useful: 'Was the answer useful?',
  yes: 'Yes',
  no: 'No',
  whatWrong: 'What was wrong? (optional)',
  reasonWrong: 'Wrong',
  reasonNoSource: 'Missing source',
  reasonOutdated: 'Out of date',
  reasonHard: 'Hard to understand',
  comment: 'Comment (optional)',
  counter: '{length} of {max} characters. Do not write personal data.',
  send: 'Send',
  skip: 'Skip',
  thanksDetails: 'Thank you! The feedback is stored for the service, not for you as a person.',
  thanks: 'Thank you!',
  notSent: 'The feedback was not sent. Please try again in a moment.',
} satisfies Translation<typeof source>;
