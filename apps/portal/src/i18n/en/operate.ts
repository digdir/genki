import type { Translation } from '@genai/i18n';
import type { operate as source } from '../nb/operate';
import { integrationsArea } from './operate-integrations';
import { settingsArea } from './operate-settings';
import { accessArea } from './operate-access';
import { logArea } from './operate-log';
import { usageArea } from './operate-usage';
import { qualityArea } from './operate-quality';
import { apirefArea } from './operate-apiref';

export const operate = {
  ...integrationsArea,
  ...settingsArea,
  ...accessArea,
  ...logArea,
  ...usageArea,
  ...qualityArea,
  ...apirefArea,
} satisfies Translation<typeof source>;
