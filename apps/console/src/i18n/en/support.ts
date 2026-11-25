import type { Translation } from '@genai/i18n';
import type { support as source } from '../nb/support';

export const support = {
  reasonTooShort: 'Write a reason of at least {min} characters. It is now {count}.',
  saveFailed: 'Could not save. Try again shortly.',
  contentReasonTitle: 'Reason to see content',
  contentReasonLead: "{tenant}'s content may contain personal data. Write why you need to see it.",
  contentReasonHint: 'At least 10 characters.',
  contentReasonSees:
    "The reason holds for you and this organisation for the rest of the day and shows in the organisation's log.",
  contentReasonCta: 'See content',
} satisfies Translation<typeof source>;
