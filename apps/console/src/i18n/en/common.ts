import type { Translation } from '@genai/i18n';
import type { common as source } from '../nb/common';

export const common = {
  allTenants: 'All organisations',
  orgNumberName: 'Org. no. {number}',
  reason: 'Reason',
  close: 'Close',
  cancel: 'Cancel',
  retry: 'Try again',
  notDecided: 'Not decided',
  showApiCall: 'Show API call',
  proposedCall: 'Does not exist in the API yet. Proposed call in the same pattern:',
  reasonTooShort: 'Write a reason of at least {min} characters.',
  reasonTooShortAudited: 'Write a reason of at least {min} characters. It is shown in Audit.',
  saveFailed: 'Could not save the change. Try again shortly.',
  todayAt: 'Today, {time}',
  dayAt: '{date}, {time}',
  unavailableTitle: 'Not available yet',
  unavailableText: 'The platform does not have this feature yet.',
  loadFailedTitle: 'Could not load the data',
  loadFailed: 'Something went wrong while loading the data. Try again shortly.',
  loadUnauthenticated: 'You are no longer signed in. Sign in again.',
  loadForbidden: 'You do not have access to this in the operations console.',
  loadNotFound: 'We could not find what you were looking for.',
} satisfies Translation<typeof source>;
