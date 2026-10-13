import type { Context } from 'hono';
import { problem } from './http.js';
import { t } from './i18n/index.js';

export const unknownTestPerson = (c: Context) =>
  problem(c, 404, t('services.devLoginUnknownPerson'));
