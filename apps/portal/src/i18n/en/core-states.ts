import type { Translation } from '@genai/i18n';
import type { states as source } from '../nb/core-states';

export const states = {
  fallbackRefusal: 'You do not have access to this for the organisation you have chosen.',
  quotaUsedUp: 'The monthly token quota is used up',
  tooManySeconds: {
    one: 'Too many requests. Try again in {count} second.',
    other: 'Too many requests. Try again in {count} seconds.',
  },
  tooMany: 'Too many requests. Try again in a little while.',
  signedOut: 'You are no longer signed in. Sign in again.',
  notFound: 'We could not find what you were looking for.',
  fetchFailed: 'Something went wrong while fetching the data. Try again in a little while.',
  noAccess: 'You do not have access',
  seeUsage: 'See usage',
  couldNotFetch: 'Could not fetch the data',
  loadingLine: '{label} ...',
  slow: 'This is taking longer than usual. We are still fetching.',
  tooSlowTitle: 'This took too long',
  tooSlowText: 'We got no answer within 30 seconds.',
} satisfies Translation<typeof source>;
