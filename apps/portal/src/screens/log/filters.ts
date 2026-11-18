import type { TaskStatus } from '../../types';
import { dateKey } from './format';

export const periods = ['today', '7', '30', 'custom'] as const;
export type Period = (typeof periods)[number];

export const trialRuns = 'trial';

const taskStatuses: readonly TaskStatus[] = [
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
];

export interface RunFilters {
  q: string;
  service: string;
  environment: string;
  status: TaskStatus | '';
  period: Period;
  from: string;
  to: string;
}

export const noFilters: RunFilters = {
  q: '',
  service: '',
  environment: '',
  status: '',
  period: 'today',
  from: '',
  to: '',
};

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

const periodAliases: Readonly<Record<string, Period>> = { '7d': '7', '30d': '30' };

const periodOf = (value: string | null): Period | undefined =>
  periods.find((p) => p === value) ?? (value ? periodAliases[value] : undefined);

export const parseRunFilters = (query: URLSearchParams): RunFilters => {
  const day = (key: string) => {
    const value = query.get(key) ?? '';
    return dayPattern.test(value) ? value : '';
  };
  const date = query.has('period') ? '' : day('date');
  const period = date ? 'custom' : (periodOf(query.get('period')) ?? 'today');
  return {
    q: query.get('q') ?? '',
    service: query.get('service') ?? '',
    environment: query.get('service') ? (query.get('environment') ?? '') : '',
    status: taskStatuses.find((s) => s === query.get('status')) ?? '',
    period,
    from: date || (period === 'custom' ? day('from') : ''),
    to: date || (period === 'custom' ? day('to') : ''),
  };
};

export const runFiltersQuery = (f: RunFilters) => {
  const query = new URLSearchParams();
  if (f.q) query.set('q', f.q);
  if (f.service) query.set('service', f.service);
  if (f.service && f.environment) query.set('environment', f.environment);
  if (f.status) query.set('status', f.status);
  if (f.period !== 'today') query.set('period', f.period);
  if (f.period === 'custom' && f.from) query.set('from', f.from);
  if (f.period === 'custom' && f.to) query.set('to', f.to);
  return query.toString();
};

export const hasRunFilters = (f: RunFilters) =>
  Boolean(f.q || f.service || f.environment || f.status || f.period !== 'today');

export const addDays = (day: string, days: number) => {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

const osloClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Oslo',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const osloOffset = (ms: number) => {
  const p = Object.fromEntries(
    osloClock.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  const wall = Date.UTC(
    p.year ?? 0,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    p.hour ?? 0,
    p.minute ?? 0,
    p.second ?? 0,
  );
  return wall - Math.floor(ms / 1000) * 1000;
};

export const osloMidnight = (day: string) => {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  return new Date(wall - osloOffset(wall - osloOffset(wall)));
};

export const periodDays = (f: RunFilters, now: Date) => {
  const today = dateKey(now);
  if (f.period === 'custom' && f.from && f.to)
    return f.from <= f.to ? { from: f.from, to: f.to } : { from: f.to, to: f.from };
  const back = f.period === '7' ? 6 : f.period === '30' ? 29 : 0;
  return { from: addDays(today, -back), to: today };
};

export const periodRange = (f: RunFilters, now: Date) => {
  const days = periodDays(f, now);
  return {
    from: osloMidnight(days.from).toISOString(),
    to: new Date(osloMidnight(addDays(days.to, 1)).getTime() - 1).toISOString(),
  };
};

export const runsRequest = (f: RunFilters, now: Date) => ({
  ...(f.status ? { status: f.status } : {}),
  ...(f.service && f.service !== trialRuns ? { service: f.service } : {}),
  ...(f.service && f.service !== trialRuns && f.environment ? { environment: f.environment } : {}),
  ...periodRange(f, now),
});
