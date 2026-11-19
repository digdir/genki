import type { EvalRun, ServiceTestSet } from '../../api/quality';
import type { UsageReport } from '../../types';

export const dayMs = 86_400_000;

export interface DayFigures {
  date: string;
  runs: number;
  failed: number;
  costMicroNok: number;
  priced: boolean;
  latency: { p50Ms: number; p95Ms: number; runs: number } | null;
}

export const serviceDays = (report: UsageReport, service: string): DayFigures[] =>
  (report.daily ?? []).map((d) => {
    const u = d.byService?.[service];
    return {
      date: d.date,
      runs: u?.runs ?? u?.requests ?? 0,
      failed: u?.failedRequests ?? 0,
      costMicroNok: u?.costMicroNok ?? 0,
      priced: u?.priced !== false && u?.costMicroNok !== null,
      latency: u?.latency ?? null,
    };
  });

export const changeFrom = (now: number, before: number) =>
  before > 0 ? (now - before) / before : undefined;

export const runsTrend = (days: DayFigures[]) => {
  const today = days.at(-1);
  const earlier = days.slice(-15, -1);
  if (!today || earlier.length === 0) return undefined;
  const mean = earlier.reduce((sum, d) => sum + d.runs, 0) / earlier.length;
  return changeFrom(today.runs, mean);
};

const monthOf = (date: string) => date.slice(0, 7);

const previousMonth = (date: string) => {
  const [y, m] = date.split('-').map(Number);
  const year = (m ?? 1) === 1 ? (y ?? 0) - 1 : (y ?? 0);
  const month = (m ?? 1) === 1 ? 12 : (m ?? 1) - 1;
  return `${year}-${String(month).padStart(2, '0')}`;
};

export const monthCost = (days: DayFigures[]) => {
  const today = days.at(-1);
  if (!today) return undefined;
  const day = Number(today.date.slice(8, 10));
  const month = monthOf(today.date);
  const before = previousMonth(today.date);
  const current = days.filter((d) => monthOf(d.date) === month);
  const earlier = days.filter(
    (d) => monthOf(d.date) === before && Number(d.date.slice(8, 10)) <= day,
  );
  const sum = (list: DayFigures[]) => list.reduce((total, d) => total + d.costMicroNok, 0);
  const [y, m] = today.date.split('-').map(Number);
  const length = new Date(y ?? 0, m ?? 1, 0).getDate();
  const spent = sum(current);
  return {
    spent,
    priced: current.every((d) => d.priced),
    change: earlier.length >= day ? changeFrom(spent, sum(earlier)) : undefined,
    forecast: day > 0 ? Math.round((spent / day) * length) : spent,
  };
};

const ended = (run: EvalRun) => run.endedAt ?? run.startedAt;

export const completedRuns = (runs: EvalRun[]) =>
  runs
    .filter((r) => r.status === 'completed' && typeof r.score === 'number')
    .sort((a, b) => ended(b).localeCompare(ended(a)));

export const qualityTrend = (runs: EvalRun[], sets: ServiceTestSet[]) => {
  const done = completedRuns(runs);
  const latest = done.find((r) => typeof r.version === 'number') ?? done[0];
  if (!latest) return undefined;
  const same = done.filter((r) => r.testSet === latest.testSet && typeof r.version === 'number');
  const perVersion = new Map<number, number>();
  for (const r of [...same].reverse()) perVersion.set(r.version as number, r.score ?? 0);
  const points = [...perVersion].sort((a, b) => a[0] - b[0]).slice(-7);
  const previous =
    typeof latest.version === 'number'
      ? same.find((r) => typeof r.version === 'number' && r.version < (latest.version as number))
      : undefined;
  return {
    latest,
    set: sets.find((s) => s.id === latest.testSet),
    previous,
    points,
  };
};

export const unusedDays = (lastUsedAt: string | null | undefined, now: Date) =>
  lastUsedAt ? Math.floor((now.getTime() - Date.parse(lastUsedAt)) / dayMs) : undefined;

export const testedRevision = (runs: EvalRun[]) =>
  runs
    .filter((r) => r.version === 'draft' && typeof r.draftRevision === 'number')
    .sort((a, b) => ended(b).localeCompare(ended(a)))[0];

export const runShare = (part: number | undefined, total: number | undefined) =>
  part === undefined || !total ? undefined : part / total;
