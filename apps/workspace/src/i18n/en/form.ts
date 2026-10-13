import type { Translation } from '@genai/i18n';
import type { form as source } from '../nb/form';

export const form = {
  required: 'Required',
  fillIn: 'Fill in "{label}".',
  chooseFirst: 'Choose {label} first',
  noMatches: 'No matches',
  clear: 'Clear {label}',
  searchAmong: 'Type to search among {count} options.',
  chooseMany: 'You can choose more than one.',
  choose: 'Choose',
} satisfies Translation<typeof source>;
