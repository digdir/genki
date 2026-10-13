import type { Translation } from '@genai/i18n';
import type { api as source } from '../nb/api';

export const api = {
  unknownUser: 'Unknown user',
  loginCancelled: 'The sign-in was cancelled.',
  loginIncomplete: 'The sign-in could not be completed. Try again.',
  loginWrongIssuer: 'The sign-in came from the wrong issuer.',
  loginFailed: 'The sign-in failed.',
  accessCheckFailed: 'Could not check your access. Try again shortly.',
  reminderReason: 'Reminder about onboarding',
  exportReason: 'Export of the audit log',
  tracingReason: 'Changed tracing',
} satisfies Translation<typeof source>;
