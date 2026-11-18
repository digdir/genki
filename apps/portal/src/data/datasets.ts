import type { PlainKey } from '../i18n';

export type DatasetStatus =
  | 'Klar'
  | 'Delvis lest inn'
  | 'Feilet'
  | 'Innlesing pågår'
  | 'I kø'
  | 'Venter'
  | 'Ikke lest inn'
  | 'Utenfor plattformen'
  | 'Eget endepunkt';

export const statusKeys: Record<DatasetStatus, PlainKey> = {
  Klar: 'datasets.statusReady',
  'Delvis lest inn': 'datasets.statusPartial',
  Feilet: 'datasets.statusIngestionFailed',
  'Innlesing pågår': 'datasets.statusRunning',
  'I kø': 'datasets.statusQueued',
  Venter: 'datasets.statusWaiting',
  'Ikke lest inn': 'datasets.statusNotRead',
  'Utenfor plattformen': 'datasets.statusExternal',
  'Eget endepunkt': 'datasets.statusEndpoint',
};

export const statusColors: Record<
  DatasetStatus,
  'success' | 'warning' | 'danger' | 'info' | 'neutral'
> = {
  Klar: 'success',
  'Delvis lest inn': 'warning',
  Feilet: 'danger',
  'Innlesing pågår': 'info',
  'I kø': 'info',
  Venter: 'info',
  'Ikke lest inn': 'neutral',
  'Utenfor plattformen': 'info',
  'Eget endepunkt': 'info',
};

export const kudosDocumentTypes = [
  'Tildelingsbrev',
  'Årsrapport',
  'Evaluering',
  'Statusrapport',
  'Strategi/plan',
  'Instruks',
  'Melding',
  'Proposisjon til Stortinget',
];
