import type { PlainKey } from '../i18n';
import type { ServiceStatus } from './services';

export const statusKeys: Record<ServiceStatus, PlainKey> = {
  Utkast: 'services.statusDraft',
  'I test': 'services.statusTest',
  'I bruk': 'services.statusLive',
  'Satt på pause': 'services.statusPaused',
  Arkivert: 'services.statusArchived',
};
