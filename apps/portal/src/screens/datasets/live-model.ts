import type {
  DatasetSourceKind,
  DatasetView,
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
  no_chunks: 'datasets.skipNoChunks',
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

export const datasetStatus = (
  view: Pick<DatasetView, 'lastExecution' | 'state'>,
): DatasetStatus => {
  if (view.state === 'external') return 'Utenfor plattformen';
  const last = view.lastExecution;
  if (!last) return 'Ikke lest inn';
  if (last.status === 'running') return 'Innlesing pågår';
  if (last.status === 'failed') return 'Feilet';
  if (last.status === 'cancelled') return 'Delvis lest inn';
  return 'Klar';
};

export const executionStatus = (
  t: T,
  execution: ExecutionView,
): { text: string; color: 'info' | 'success' | 'warning' | 'danger' } => {
  if (execution.status === 'running') return { text: t('datasets.runRunning'), color: 'info' };
  if (execution.status === 'failed') return { text: t('datasets.statusFailed'), color: 'danger' };
  if (execution.status === 'cancelled')
    return { text: t('datasets.runCancelled'), color: 'warning' };
  return skippedCount(execution) > 0
    ? { text: t('datasets.runDoneNotes'), color: 'warning' }
    : { text: t('datasets.runDone'), color: 'success' };
};

export const countText = (t: T, f: Format, n: number | null | undefined) =>
  n === null || n === undefined ? t('datasets.notAvailable') : f.number(n);

export const whenText = (f: Format, iso: string | null | undefined, empty: string) =>
  iso ? f.dateTime(iso) : empty;

export const externalSourceText = (t: T, view: Pick<DatasetView, 'index'>) =>
  t('datasets.sourceExternal', {
    endpoint: view.index?.endpoint ?? '',
    collection: view.index?.collections?.docs ?? '',
  });

export const sharedSourceText = (
  t: T,
  view: Pick<DatasetView, 'source' | 'editable' | 'state' | 'index'>,
) =>
  view.state === 'external'
    ? externalSourceText(t, view)
    : view.editable === false
      ? t('datasets.sourceSharedWithYou', { source: t(sourceText[view.source]) })
      : t(sourceText[view.source]);

export const listItemOf = (t: T, f: Format, view: DatasetView): DatasetListItem => ({
  id: view.fullId,
  name: view.name,
  description: view.description ?? '',
  status: datasetStatus(view),
  sourceText: sharedSourceText(t, view),
  docsText: countText(t, f, view.documents),
  lastText:
    view.state === 'external'
      ? t('datasets.lastExternal')
      : view.lastExecution
        ? f.dateTime(view.lastExecution.startedAt)
        : t('datasets.notYet'),
});

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

export const failureText = (t: T, error: unknown) => {
  const listed =
    error instanceof ApiError ? error.problem?.errors?.map((e) => e.message).join(' ') : '';
  return listed || t('datasets.somethingWrong');
};
