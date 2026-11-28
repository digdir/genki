import type { Translation } from '@genai/i18n';
import type { support as source } from '../nb/support';

export const support = {
  reasonTooShort: 'Write a reason of at least {min} characters. It is now {count}.',
  saveFailed: 'Could not save. Try again shortly.',
} satisfies Translation<typeof source>;
