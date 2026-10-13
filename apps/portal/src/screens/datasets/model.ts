import {
  datasetDetails,
  type DatasetDetails,
  type DatasetStatus,
  type IngestionRun,
} from '../../data/datasets';
import type { Format, T } from '../../i18n';
import type { DatasetSummary } from '../../types';

export const count = (f: Format, n: number) => f.number(Math.round(n));

const apiStatus: Record<string, DatasetStatus> = {
  ready: 'Klar',
  ingesting: 'Innlesing pågår',
  running: 'Innlesing pågår',
  partial: 'Delvis lest inn',
  failed: 'Feilet',
};

export const fromSummary = (s: DatasetSummary, live: boolean, t: T): DatasetDetails => {
  const design = live ? undefined : datasetDetails.find((d) => d.id === s.id);
  if (design) return structuredClone(design);
  return {
    id: s.id,
    name: s.name,
    source: 'unknown',
    docs: 0,
    chunks: '–',
    last: t('common.unknown'),
    lastOk: t('common.unknown'),
    next: t('common.unknown'),
    status: apiStatus[s.status] ?? 'Klar',
    usedBy: [],
    description: s.description,
    settings: [],
    runs: [],
    facets: [],
  };
};

export const datasetHref = (id: string, query = '') =>
  `#/datasets/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;

export const nowLabel = (t: T, f: Format) => t('datasets.today', { time: f.time(new Date()) });

export interface RunOutcome {
  added: number;
  changed: number;
  removed: number;
  docs?: number;
  duration?: string;
  flash: string;
}

export const startRun = (
  dataset: DatasetDetails,
  how: string,
  total: number,
  t: T,
  f: Format,
): { dataset: DatasetDetails; run: IngestionRun } => {
  const run: IngestionRun = {
    id: `r${Date.now()}${Math.round(Math.random() * 1000)}`,
    when: nowLabel(t, f),
    how,
    duration: '',
    status: 'Pågår',
    added: 0,
    changed: 0,
    removed: 0,
    errors: [],
    progress: 0,
    total,
  };
  return { dataset: { ...dataset, status: 'Innlesing pågår', runs: [run, ...dataset.runs] }, run };
};

export const outcomeFor = (
  dataset: DatasetDetails,
  t: T,
): { total: number; outcome: RunOutcome } => {
  if (dataset.id === '999888777/tilsynsrapporter-2025')
    return {
      total: 12,
      outcome: {
        added: 12,
        changed: 0,
        removed: 0,
        docs: 148,
        flash: t('datasets.outcomeScanned'),
      },
    };
  if (dataset.id === '999888777/nettsider')
    return {
      total: 2104,
      outcome: {
        added: 9,
        changed: 41,
        removed: 2,
        duration: t('datasets.minutesShort', { count: 13 }),
        flash: t('datasets.outcomeWebsite'),
      },
    };
  return {
    total: dataset.docs,
    outcome: { added: 0, changed: 3, removed: 0, flash: t('datasets.outcomeDone') },
  };
};
