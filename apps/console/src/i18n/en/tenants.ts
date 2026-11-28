import type { Translation } from '@genai/i18n';
import type { tenants as source } from '../nb/tenants';

export const tenants = {
  notAvailable: 'Not available',
  notPriced: 'Not priced',
  status: 'Status',
} satisfies Translation<typeof source>;
