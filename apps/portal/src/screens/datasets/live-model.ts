import { usedByText } from './used-by-count';
import type {
  DatasetSourceKind,
  DatasetView,
  ExecutionStatus,
  ExecutionView,
  Schedule,
  SkipReason,
} from '../../api/datasets';
import { skippedCount } from '../../api/datasets';
import { ApiError } from '../../api/error';
import type { DatasetStatus } from '../../data/datasets';
import type { Format, PlainKey, T } from '../../i18n';
import type { Residency } from '../../types';
import type { DatasetListItem } from './DatasetList';

export const platformEngine = 'platform-pg';

export const maxUploadBytes = 50 * 1024 * 1024;
export const uploadAccept = '.pdf,.docx,.txt,.md,.html';
const uploadPattern = /\.(pdf|docx|txt|md|html?)$/i;

export const skipReasonText: Record<string, PlainKey> = {
  no_text: 'datasets.skipNoText',
  unsupported_type: 'datasets.skipUnsupported',
  conversion_failed: 'datasets.skipConversion',
  outside_access: 'datasets.skipOutsideAccess',
  too_large: 'datasets.skipTooLarge',
  unreachable: 'datasets.skipUnreachable',
};

export const reasonText = (t: T, reason: SkipReason) =>
  t(skipReasonText[reason] ?? 'datasets.skipDefault');

export const sourceText: Record<DatasetSourceKind, PlainKey> = {
  website: 'datasets.sourceWeb',
  upload: 'datasets.sourceUpload',
  kudos: 'datasets.sourceKudos',
  folder: 'datasets.sourceFolder',
  database: 'datasets.sourceDatabase',
  parquet: 'datasets.sourceParquet',
  endpoint: 'datasets.sourceEndpoint',
  none: 'datasets.sourceNone',
};

export const scheduleText: Record<Schedule, PlainKey> = {
  none: 'datasets.scheduleNone',
  daily: 'datasets.scheduleDaily',
  weekly: 'datasets.scheduleWeekly',
};

export const residencyWords: Record<Residency, PlainKey> = {
  norway: 'datasets.residencyNorway',
  eu: 'datasets.residencyEu',
  global: 'datasets.residencyGlobal',
};

export const usableBy = (t: T, residency: Residency | undefined) =>
  t(
    residency === 'norway'
      ? 'datasets.usableNorway'
      : residency === 'eu'
        ? 'datasets.usableEu'
        : residency === 'global'
          ? 'datasets.usableGlobal'
          : 'datasets.usableUnknown',
  );

export const residencyText = (t: T, residency: Residency | undefined) =>
  t(residency ? residencyLabels[residency] : 'datasets.residencyUnknown');

const residencyLabels: Record<Residency, PlainKey> = {
  norway: 'datasets.residencyNorwayLabel',
  eu: 'datasets.residencyEuLabel',
  global: 'datasets.residencyGlobalLabel',
};

const residencyOrder: Residency[] = ['norway', 'eu', 'global'];
export const widest = (...all: Residency[]) =>
  all.reduce((a, b) => (residencyOrder.indexOf(b) > residencyOrder.indexOf(a) ? b : a), 'norway');

export const isForeign = (view: Pick<DatasetView, 'editable' | 'scope'>) =>
  view.editable === false && !!view.scope && view.scope !== 'platform';

const foreignStatus: Partial<Record<NonNullable<DatasetView['state']>, DatasetStatus>> = {
  running: 'Innlesing pågår',
  degraded: 'Delvis lest inn',
  ready: 'Klar',
};

export const isOwnEndpoint = (view: Pick<DatasetView, 'source' | 'editable'>) =>
  view.source === 'endpoint' && view.editable !== false;

const openRunStatus: Partial<Record<ExecutionStatus, DatasetStatus>> = {
  queued: 'I kø',
  running: 'Innlesing pågår',
  waiting: 'Venter',
  failed: 'Feilet',
  cancelled: 'Delvis lest inn',
};

export const runDatasetStatus = (run: {
  status: ExecutionStatus;
  skipped: number | null;
}): DatasetStatus =>
  openRunStatus[run.status] ?? ((run.skipped ?? 0) > 0 ? 'Delvis lest inn' : 'Klar');

export const datasetStatus = (
  view: Pick<DatasetView, 'lastExecution' | 'state' | 'editable' | 'scope' | 'source'>,
): DatasetStatus => {
  if (view.state === 'external')
    return isOwnEndpoint(view) ? 'Eget endepunkt' : 'Utenfor plattformen';
  if (isForeign(view)) return (view.state && foreignStatus[view.state]) ?? 'Ikke lest inn';
  const last = view.lastExecution;
  return last ? runDatasetStatus(last) : 'Ikke lest inn';
};

export const needsSource = (view: Pick<DatasetView, 'source' | 'state'>) =>
  view.state === 'needs-pipeline' || view.source === 'none';

const noteOf = (t: T, view: DatasetView) => {
  if (isForeign(view)) return undefined;
  const last = view.lastExecution;
  if (view.state !== 'external' && !last && needsSource(view)) return t('datasets.sourceNone');
  if (last?.status === 'failed') return t('datasets.noteFailed');
  if (last?.status === 'cancelled') return t('datasets.noteCancelled');
  if (last?.status === 'queued') return t('datasets.noteQueued');
  if (last?.status === 'waiting') return t('datasets.noteWaiting');
  if (last?.status === 'succeeded' && (last.skipped ?? 0) > 0)
    return t('datasets.noteSkipped', { count: last.skipped ?? 0 });
  return undefined;
};

const runStatusText: Partial<
  Record<ExecutionStatus, { key: PlainKey; color: 'info' | 'warning' | 'danger' }>
> = {
  queued: { key: 'datasets.runQueued', color: 'info' },
  running: { key: 'datasets.runRunning', color: 'info' },
  waiting: { key: 'datasets.runWaiting', color: 'warning' },
  failed: { key: 'datasets.statusFailed', color: 'danger' },
  cancelled: { key: 'datasets.runCancelled', color: 'warning' },
};

export const executionStatus = (
  t: T,
  execution: ExecutionView,
): { text: string; color: 'info' | 'success' | 'warning' | 'danger' } => {
  const known = runStatusText[execution.status];
  if (known) return { text: t(known.key), color: known.color };
  return skippedCount(execution) > 0
    ? { text: t('datasets.runDoneNotes'), color: 'warning' }
    : { text: t('datasets.runDone'), color: 'success' };
};

export const lastSucceeded = (runs: ExecutionView[]) => runs.find((r) => r.status === 'succeeded');

export const countText = (t: T, f: Format, n: number | null | undefined) =>
  n === null || n === undefined ? t('datasets.notAvailable') : f.number(n);

export const whenText = (f: Format, iso: string | null | undefined, empty: string) =>
  iso ? f.dateTime(iso) : empty;

export const externalSourceText = (t: T, view: Pick<DatasetView, 'index'>) =>
  t('datasets.sourceExternal', {
    endpoint: view.index?.endpoint ?? '',
    collection: view.index?.collections?.docs ?? '',
  });

export const ownEndpointText = (t: T, host?: string) =>
  host ? t('datasets.sourceOwnEndpointAt', { host }) : t('datasets.sourceOwnEndpoint');

export const sharedSourceText = (
  t: T,
  view: Pick<DatasetView, 'source' | 'editable' | 'state' | 'index'>,
  host?: string,
) =>
  isOwnEndpoint(view)
    ? ownEndpointText(t, host)
    : view.state === 'external'
      ? externalSourceText(t, view)
      : isForeign(view)
        ? t('datasets.sharedByOther')
        : view.editable === false
          ? t('datasets.sourceSharedWithYou', { source: t(sourceText[view.source]) })
          : t(sourceText[view.source]);

export const listItemOf = (t: T, f: Format, view: DatasetView): DatasetListItem => {
  const shared = view.editable === false;
  const foreign = isForeign(view);
  const ownEndpoint = isOwnEndpoint(view);
  const source = ownEndpoint
    ? ownEndpointText(t)
    : view.state === 'external'
      ? externalSourceText(t, view)
      : foreign
        ? t('datasets.unknown')
        : t(sourceText[view.source]);
  const note = noteOf(t, view);
  const status = datasetStatus(view);
  return {
    id: view.fullId,
    name: view.name,
    description: view.description ?? '',
    status,
    shared,
    sourceText: source,
    subText: foreign
      ? t('datasets.sharedByOther')
      : t('datasets.subLine', {
          source,
          owner: t(shared ? 'datasets.filterShared' : 'datasets.filterOwn'),
        }),
    docsText: countText(t, f, view.documents),
    lastText: ownEndpoint
      ? t('datasets.lastEndpoint')
      : view.state === 'external'
        ? t('datasets.lastExternal')
        : foreign
          ? t('datasets.unknown')
          : view.lastExecution
            ? f.dateTime(view.lastExecution.startedAt)
            : t('datasets.notYet'),
    usedByText: usedByText(t, view.usedByCount),
    ...(note ? { note } : {}),
    ...(view.state !== 'external' && !foreign && !view.lastExecution && needsSource(view)
      ? { needsSource: true }
      : {}),
    ...(status === 'Feilet' && !shared ? { canRetry: true } : {}),
  };
};

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'datasett';

export const uniqueId = (name: string, taken: string[]) => {
  const base = slugify(name);
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
};

export const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export const toGlobs = (text: string) =>
  lines(text).flatMap((line) => {
    const path = line.startsWith('/') ? line : `/${line}`;
    if (/[*?]/.test(path)) return [path];
    const bare = path.replace(/\/+$/, '') || '/';
    return bare === '/' ? ['/**'] : [bare, `${bare}/**`];
  });

export const fromGlobs = (globs: string[]) =>
  globs.filter((g) => !(g.endsWith('/**') && globs.includes(g.slice(0, -3)))).join('\n');

export const fileProblem = (t: T, file: { name: string; size: number }) =>
  !uploadPattern.test(file.name)
    ? t('datasets.skipUnsupported')
    : file.size > maxUploadBytes
      ? t('datasets.skipTooLarge')
      : undefined;

export const sizeText = (t: T, f: Format, bytes: number) =>
  bytes >= 1024 * 1024
    ? t('datasets.sizeMb', { value: f.decimal(bytes / 1048576, 1) })
    : t('datasets.sizeKb', { value: f.number(Math.max(1, Math.round(bytes / 1024))) });

/** A refusal's own words: its errors, else its detail, else its title. */
export const refusalText = (t: T, error: unknown) => {
  const problem = error instanceof ApiError ? error.problem : undefined;
  const listed = problem?.errors?.map((e) => e.message).join(' ');
  return listed || problem?.detail || problem?.title || t('datasets.somethingWrong');
};

const fieldKeys: Record<string, PlainKey> = {
  name: 'datasets.name',
  description: 'datasets.description',
  searchScope: 'datasets.whoSearches',
  schedule: 'datasets.howOften',
  'source.sitemap': 'datasets.sitemapLabel',
  'source.include': 'datasets.includeOnly',
  'source.exclude': 'datasets.exclude',
  'source.types': 'datasets.documentTypes',
  'source.since': 'datasets.fromYear',
  'endpointSource.url': 'datasets.endpointUrl',
  'endpointSource.auth.apiKey': 'datasets.apiKey',
  'endpointSource.auth.header': 'datasets.apiKeyHeader',
};

const statusKeys: Record<number, PlainKey> = {
  403: 'datasets.refusedForbidden',
  404: 'datasets.refusedNotFound',
  409: 'datasets.refusedConflict',
  413: 'datasets.skipTooLarge',
  429: 'datasets.refusedBusy',
  503: 'datasets.refusedBusy',
};

/** Our own words for a refusal; the API's validation messages are English and never shown. */
export const failureText = (t: T, error: unknown) => {
  if (!(error instanceof ApiError)) return t('datasets.somethingWrong');
  const paths = (error.problem?.errors ?? []).map((e) => e.path);
  if (error.status === 409 && paths.includes('dataset')) return t('datasets.alreadyRunning');
  if (error.status === 422 && paths.some((p) => p === 'source' || p === 'spec.source'))
    return t('datasets.kudosUnbounded');
  if (error.status === 400 || error.status === 422) {
    const fields = [
      ...new Set(
        (error.problem?.errors ?? []).flatMap((e) => {
          const key = fieldKeys[e.path] ?? fieldKeys[e.path.split('.')[0] ?? ''];
          return key ? [t(key)] : [];
        }),
      ),
    ];
    return fields.length
      ? t('datasets.invalidFields', { fields: fields.join(', ') })
      : t('datasets.invalidRequest');
  }
  const known = statusKeys[error.status];
  return known ? t(known) : t('datasets.somethingWrong');
};
