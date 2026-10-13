import type { Translation } from '@genai/i18n';
import type { api as source } from '../nb/api';

export const api = {
  untitledSource: 'Untitled source',
  runFailed: 'The service failed while running.',
  standardReason: 'Changed the written standard in the user menu',
  languageReason: 'Changed the language in the user menu',
  tableEditReason: 'Changed cells in the table',
  tableApproveReason: 'Approved the table after checking the sources',
  unknownUser: 'Unknown user',
} satisfies Translation<typeof source>;
