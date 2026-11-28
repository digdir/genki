import type { Translation } from '@genai/i18n';
import type { contentView as source } from '../nb/contentView';

export const contentView = {
  title: 'View content from {tenant}',
  lead: 'May contain personal data. Applies for the rest of the day.',
  hint: 'The organisation sees it in its log.',
  cta: 'View the content',
  failed: 'Could not save the reason. Try again shortly.',
} satisfies Translation<typeof source>;
