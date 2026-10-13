import type { Translation } from '@genai/i18n';
import type { support as source } from '../nb/support';

export const support = {
  expiredNotice: 'The support access has run out of time. The session has ended.',
  endedNotice: 'The session has ended.',
  endedEarlyReason: 'Ended by the operator before time',
  reasonTooShort: 'Write a reason of at least {min} characters. It is now {count}.',
  saveFailed: 'Could not save. Try again shortly.',
} satisfies Translation<typeof source>;
