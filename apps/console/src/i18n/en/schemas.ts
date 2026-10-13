import type { Translation } from '@genai/i18n';
import type { schemas as nb } from '../nb/schemas';

export const schemas = {
  page: 'Schemas',
  eyebrow: 'For developers',
  intro:
    'Everything that can be configured on the platform, described by the schemas the API enforces. The form below is generated from the schema, with no code of its own for the screen.',
  loading: 'Loading schemas',
  choose: 'Schema',
  empty: 'The API has no schemas yet.',
  formTitle: 'Form',
  preview: 'This would be sent',
  check: 'Check the form',
  valid: 'The form matches the schema.',
  reset: 'Clear',
  version: 'Version {version}',
} satisfies Translation<typeof nb>;
