import type { Translation } from '@genai/i18n';
import type { errors as source } from '../nb/errors';

export const errors = {
  heading: 'Error messages',
  intro: 'Your runs that failed in the last 30 days.',
  loading: 'Loading failed runs …',
  loadFailed: 'We could not load your runs.',
  noAccess: 'You do not have access to see runs in this organisation.',
  tryAgain: 'Try again',
  empty: 'None of your runs have failed in the last 30 days.',
  today: 'Today at {time}',
  yesterday: 'Yesterday at {time}',
  onDay: '{day} at {time}',
  retryWith: 'Try again with {service}',
} satisfies Translation<typeof source>;
