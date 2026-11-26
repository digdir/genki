import type { Translation } from '@genai/i18n';
import type { api as source } from '../nb/api';

export const api = {
  unknownUser: 'Unknown user',
  loginFailed: 'The sign-in failed.',
  loginUnavailable: 'Sign-in is not available here.',
  exportReason: 'Export of the audit log',
} satisfies Translation<typeof source>;
