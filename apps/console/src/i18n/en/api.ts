import type { Translation } from '@genai/i18n';
import type { api as source } from '../nb/api';

export const api = {
  unknownUser: 'Unknown user',
  loginFailed: 'The sign-in failed.',
  loginUnavailable: 'Sign-in is not available here.',
  reminderReason: 'Reminder about onboarding',
  exportReason: 'Export of the audit log',
  tracingReason: 'Changed tracing',
} satisfies Translation<typeof source>;
