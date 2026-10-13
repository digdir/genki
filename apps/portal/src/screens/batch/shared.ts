import type { BatchRun, BatchSourceDataset } from '../../api/batch-runs';
import type { Format, PlainKey, T } from '../../i18n';

export type Color = 'success' | 'danger' | 'info' | 'warning' | 'neutral';

const fieldLabels: Record<string, PlainKey> = {
  type: 'batch.fieldType',
  concerned_years: 'batch.fieldYear',
  year: 'batch.fieldYear',
  orgs_short: 'batch.fieldOrg',
  orgs_long: 'batch.fieldOrgLong',
  organisation: 'batch.fieldOrg',
};

const yearFields = new Set(['concerned_years', 'year']);

export const shownValues = <V extends { value: string }>(
  field: string,
  values: V[],
  now = new Date(),
): V[] => {
  if (!yearFields.has(field)) return values;
  const latest = now.getFullYear() + 1;
  return values
    .filter((v) => /^\d{4}$/.test(v.value) && Number(v.value) >= 1900 && Number(v.value) <= latest)
    .sort((a, b) => Number(b.value) - Number(a.value));
};

export const fieldLabel = (t: T, field: string) => {
  const key = fieldLabels[field];
  return key ? t(key) : field;
};

export const rangeText = (t: T, low: string, high: string) =>
  low === high ? low : t('batch.between', { low, high });

export const kroner = (t: T, f: Format, micro: number | null | undefined) =>
  micro === null || micro === undefined
    ? t('batch.notPriced')
    : f.currency(micro / 1_000_000, { digits: 2 });

export const reasonError = (t: T, text: string, min = 10) => {
  const length = text.trim().length;
  return length < min ? t('batch.reasonTooShort', { min, length }) : '';
};

export const jobStatus = (run: BatchRun): [PlainKey, Color] => {
  switch (run.status) {
    case 'succeeded':
      return run.counts.failed > 0
        ? ['batch.statusSucceededWithErrors', 'warning']
        : ['batch.statusSucceeded', 'success'];
    case 'failed':
      return ['batch.statusFailed', 'danger'];
    case 'cancelled':
      return ['batch.statusCancelled', 'neutral'];
    case 'stopped':
      return ['batch.statusPaused', 'warning'];
    case 'queued':
      return ['batch.statusQueued', 'neutral'];
    default:
      return ['batch.statusRunning', 'info'];
  }
};

export const itemStatus: Record<
  'succeeded' | 'notFound' | 'failed' | 'running' | 'queued' | 'skipped',
  [PlainKey, Color]
> = {
  succeeded: ['batch.itemSucceeded', 'success'],
  notFound: ['batch.itemNotFound', 'warning'],
  failed: ['batch.itemFailed', 'danger'],
  running: ['batch.itemRunning', 'info'],
  queued: ['batch.itemQueued', 'neutral'],
  skipped: ['batch.itemSkipped', 'neutral'],
};

const failureKeys: Record<string, PlainKey> = {
  limit_exceeded: 'batch.failTooManyEvents',
  budget_exceeded: 'batch.failBudget',
  deadline_exceeded: 'batch.failDeadline',
  restarted: 'batch.failRestarted',
  quota_exhausted: 'batch.failQuota',
  cap_reached: 'batch.failCap',
};

export const failureText = (t: T, errorCode: string | undefined, error: string | undefined) => {
  const key = errorCode ? failureKeys[errorCode] : undefined;
  return key ? t(key) : (error ?? t('batch.unknownError'));
};

export const startedByLabel = (t: T, actor: string | undefined, name?: string) =>
  name
    ? name
    : !actor
      ? t('batch.unknown')
      : actor.includes(':')
        ? t(actor.startsWith('operator:') ? 'batch.actorOperator' : 'batch.actorEmployee')
        : actor;

export const selectionName = (
  t: T,
  run: Pick<BatchRun, 'dataset' | 'filters' | 'prompt'>,
  sources: BatchSourceDataset[],
) => {
  const dataset = sources.find((s) => s.id === run.dataset)?.name ?? run.dataset;
  const values = Object.values(run.filters).flat();
  return values.length
    ? t('batch.selectionFiltered', { dataset, values: values.join(', ') })
    : t('batch.selectionAll', { dataset });
};
