import { usageModels, usageServices, zeroUsage } from '../../data/usage';
import { notPriced, serviceLabel } from '../../format';
import type { Format, T } from '../../i18n';
import { modelLabel } from '../../models';
import type { EffectiveSetting, ModelOption, UsageReport, UsageTotals } from '../../types';

export const quotaSetting = 'usage.monthlyTokens';

export const quotaOf = (settings: Record<string, EffectiveSetting>) => {
  const value = settings[quotaSetting]?.value;
  return typeof value === 'number' && value > 0 ? value : null;
};

export type Period = 'current' | 'previous' | 'six';
export type Group = 'service' | 'model';

const monthName = (f: Format, year: number, month: number) =>
  f.month(new Date(Date.UTC(year, month, 15)));

export const COLORS = [
  'var(--ds-color-accent-base-default)',
  'var(--ds-color-brand1-base-default)',
  'var(--ds-color-brand2-base-default)',
  'var(--ds-color-brand3-base-default)',
  'var(--ds-color-success-base-default)',
  'var(--ds-color-neutral-base-default)',
];

export const nb = (f: Format, n: number) => f.number(Math.round(n)).replace(/[\u00a0\u202f]/g, ' ');
export const short = (f: Format, t: T, n: number) =>
  n >= 1e6
    ? t('usage.millions', { value: f.decimal(n / 1e6, n >= 1e7 ? 0 : 1) })
    : n >= 1e3
      ? t('usage.thousands', { value: f.number(Math.round(n / 1e3)) })
      : f.number(Math.round(n));
export const kr = (n: number | null) =>
  n === null ? notPriced : n < 10 ? `${n.toFixed(2).replace('.', ',')} kr` : `${nbPlain(n)} kr`;
const nbPlain = (n: number) =>
  new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 })
    .format(Math.round(n))
    .replace(/\u00a0/g, ' ');
export const money = (f: Format, t: T, n: number | null) =>
  n === null
    ? t('usage.notPriced')
    : t('usage.money', { value: n < 10 ? f.decimal(n, 2) : nb(f, n) });
export const percentText = (f: Format, value: number) =>
  f.percent(value).replace(/[\u00a0\u202f]/g, ' ');
export const decimalText = (f: Format, n: number) =>
  f.locale === 'en' ? String(n) : String(n).replace('.', ',');
export const capitalise = (s: string) => (s ? (s[0]?.toUpperCase() ?? '') + s.slice(1) : s);

export const tokensOf = (u: UsageTotals) => u.inputTokens + u.outputTokens;
export const tokensIn = (values: Record<string, UsageTotals>, id: string) => {
  const u = values[id];
  return u ? tokensOf(u) : 0;
};
export const isPriced = (u: UsageTotals) => u.costMicroNok !== null && u.priced !== false;
export const costOf = (u: UsageTotals) => (isPriced(u) ? (u.costMicroNok ?? 0) / 1e6 : null);
export const runsOf = (u: UsageTotals) => u.runs ?? u.requests;
export const add = (a: UsageTotals, b: UsageTotals): UsageTotals => {
  const priced = isPriced(a) && isPriced(b);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    requests: a.requests + b.requests,
    ...(a.runs !== undefined || b.runs !== undefined
      ? { runs: (a.runs ?? 0) + (b.runs ?? 0) }
      : {}),
    costMicroNok: priced ? (a.costMicroNok ?? 0) + (b.costMicroNok ?? 0) : null,
    ...(priced ? {} : { priced: false }),
  };
};

const unpriced = (u: UsageTotals): UsageTotals => ({ ...u, costMicroNok: null, priced: false });

export const withPricing = (report: UsageReport): UsageReport =>
  report.priced
    ? report
    : {
        ...report,
        totals: unpriced(report.totals),
        daily: report.daily.map((d) => ({
          ...d,
          usage: unpriced(d.usage),
          ...(d.byService
            ? {
                byService: Object.fromEntries(
                  Object.entries(d.byService).map(([k, u]) => [k, unpriced(u)]),
                ),
              }
            : {}),
          ...(d.byModel
            ? {
                byModel: Object.fromEntries(
                  Object.entries(d.byModel).map(([k, u]) => [k, unpriced(u)]),
                ),
              }
            : {}),
        })),
        byService: report.byService.map((s) => ({ ...s, usage: unpriced(s.usage) })),
        byModel: report.byModel.map((m) => ({ ...m, usage: unpriced(m.usage) })),
        ...(report.byProject
          ? { byProject: report.byProject.map((p) => ({ ...p, usage: unpriced(p.usage) })) }
          : {}),
      };

export interface Category {
  id: string;
  label: string;
  sub: string;
  color: string;
  location?: string;
  norway?: boolean;
}

export interface Bar {
  key: string;
  label: string;
  full: string;
  today: boolean;
  future: boolean;
  values: Record<string, UsageTotals>;
  total: number;
  cost: number | null;
}

export const today = (report: UsageReport) => {
  const parsed = new Date(report.to);
  const d = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
};

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

const residencyKey = {
  norway: 'usage.residencyNorway',
  eu: 'usage.residencyEu',
  global: 'usage.residencyGlobal',
  unknown: 'usage.residencyUnknown',
} as const;

export const categories = (
  report: UsageReport,
  group: Group,
  models: ModelOption[],
  t: T,
): Category[] => {
  if (group === 'model') {
    const ids = report.byModel.map((m) => m.model);
    const ordered = [
      ...usageModels.filter((m) => ids.includes(m.id)).map((m) => m.id),
      ...ids.filter((id) => !usageModels.some((m) => m.id === id)),
    ];
    return ordered.map((id, i) => {
      const info = usageModels.find((m) => m.id === id);
      const known = models.find((m) => m.id === id);
      return {
        id,
        label: info?.name ?? modelLabel(id, models),
        sub: info ? t('usage.via', { via: info.via }) : '',
        color: COLORS[i % COLORS.length] ?? '',
        location: known
          ? t(residencyKey[known.residency ?? 'unknown'])
          : (info?.location ?? t('usage.residencyUnknown')),
        ...(known?.residency === 'norway' || info?.location === 'Norge' ? { norway: true } : {}),
      };
    });
  }
  const ids = report.byService.map((s) => s.service);
  const ordered = [
    ...usageServices.filter((s) => ids.includes(s.id)).map((s) => s.id),
    ...ids.filter((id) => !usageServices.some((s) => s.id === id)),
  ];
  return ordered.map((id, i) => {
    const info = usageServices.find((s) => s.id === id);
    const model = usageModels.find((m) => m.id === info?.model);
    return {
      id,
      label: info?.name ?? serviceLabel(id, report.byService.find((s) => s.service === id)?.title),
      sub: info ? `${info.does} · ${model?.name ?? info.model}` : '',
      color: COLORS[i % COLORS.length] ?? '',
    };
  });
};

const breakdown = (
  report: UsageReport,
  entry: UsageReport['daily'][number],
  group: Group,
): Record<string, UsageTotals> => {
  const exact = group === 'model' ? entry.byModel : entry.byService;
  if (exact) return exact;
  const overall =
    group === 'model'
      ? report.byModel.map((m) => [m.model, m.usage] as const)
      : report.byService.map((s) => [s.service, s.usage] as const);
  const all = overall.reduce((n, [, u]) => n + tokensOf(u), 0) || 1;
  return Object.fromEntries(
    overall.map(([id, u]) => {
      const share = tokensOf(u) / all;
      return [
        id,
        {
          inputTokens: entry.usage.inputTokens * share,
          outputTokens: entry.usage.outputTokens * share,
          requests: entry.usage.requests * share,
          costMicroNok: isPriced(entry.usage) ? (entry.usage.costMicroNok ?? 0) * share : null,
          ...(isPriced(entry.usage) ? {} : { priced: false }),
        },
      ];
    }),
  );
};

const sumValues = (values: Record<string, UsageTotals>) =>
  Object.values(values).reduce((a, u) => add(a, u), zeroUsage());

const toBar = (
  key: string,
  label: string,
  full: string,
  values: Record<string, UsageTotals> | null,
  isToday = false,
): Bar => {
  const total = values ? sumValues(values) : zeroUsage();
  return {
    key,
    label,
    full,
    today: isToday,
    future: values === null,
    values: values ?? {},
    total: tokensOf(total),
    cost: costOf(total),
  };
};

const byDate = (report: UsageReport) => new Map(report.daily.map((d) => [d.date, d]));

const isoDate = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);

export const series = (
  report: UsageReport,
  period: Period,
  group: Group,
  f: Format,
  t: T,
): Bar[] => {
  const now = today(report);
  const days = byDate(report);
  if (period === 'six') {
    return Array.from({ length: 6 }, (_, i) => {
      const date = new Date(Date.UTC(now.year, now.month - 5 + i, 1));
      const y = date.getUTCFullYear();
      const m = date.getUTCMonth();
      const values: Record<string, UsageTotals> = {};
      for (let d = 1; d <= daysIn(y, m); d += 1) {
        const entry = days.get(isoDate(y, m, d));
        if (!entry) continue;
        Object.entries(breakdown(report, entry, group)).forEach(([id, u]) => {
          values[id] = add(values[id] ?? zeroUsage(), u);
        });
      }
      const name = monthName(f, y, m);
      const current = m === now.month && y === now.year;
      return toBar(
        `m${y}-${m}`,
        capitalise(name.slice(0, 3)),
        current ? t('usage.monthToDate', { month: name }) : name,
        values,
      );
    });
  }
  const base = new Date(Date.UTC(now.year, now.month - (period === 'previous' ? 1 : 0), 1));
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  return Array.from({ length: daysIn(y, m) }, (_, i) => {
    const d = i + 1;
    const isToday = period === 'current' && d === now.day;
    const future = period === 'current' && d > now.day;
    const entry = days.get(isoDate(y, m, d));
    const values = future ? null : entry ? breakdown(report, entry, group) : {};
    return toBar(
      `d${d}`,
      String(d),
      t(isToday ? 'usage.todayToDate' : 'usage.dayLabel', {
        day: String(d),
        month: monthName(f, y, m),
      }),
      values,
      isToday,
    );
  });
};

export const periodLabels = (report: UsageReport, f: Format, t: T) => {
  const now = today(report);
  const prev = new Date(Date.UTC(now.year, now.month - 1, 1));
  const first = new Date(Date.UTC(now.year, now.month - 5, 1));
  const cur = monthName(f, now.year, now.month);
  const pm = monthName(f, prev.getUTCFullYear(), prev.getUTCMonth());
  const range = (month: string, last: number, year: number) =>
    t('usage.range', { last: String(last), month, year: String(year) });
  return {
    options: {
      current: t('usage.periodCurrent', { month: capitalise(cur), year: String(now.year) }),
      previous: t('usage.periodPrevious', {
        month: capitalise(pm),
        year: String(prev.getUTCFullYear()),
      }),
      six: t('usage.periodSix'),
    } satisfies Record<Period, string>,
    ranges: {
      current: range(cur, now.day, now.year),
      previous: range(pm, daysIn(prev.getUTCFullYear(), prev.getUTCMonth()), prev.getUTCFullYear()),
      six: t('usage.rangeSix', {
        from: capitalise(monthName(f, first.getUTCFullYear(), first.getUTCMonth())),
        month: cur,
        year: String(now.year),
      }),
    } satisfies Record<Period, string>,
    month: cur,
    monthShort: (current: boolean) => {
      const name = current ? cur : pm;
      return f.locale === 'en' ? capitalise(name.slice(0, 3)) : name.slice(0, 3).toLowerCase();
    },
  };
};

export const aggregate = (bars: Bar[]) => {
  const out: Record<string, UsageTotals> = {};
  bars.forEach((b) =>
    Object.entries(b.values).forEach(([id, u]) => {
      out[id] = add(out[id] ?? zeroUsage(), u);
    }),
  );
  return out;
};

export const monthStatus = (
  report: UsageReport,
  quota: number | null,
  models: ModelOption[] | null,
  f: Format,
  t: T,
) => {
  const now = today(report);
  const current = series(report, 'current', 'service', f, t).filter((b) => !b.future);
  const days = byDate(report);
  const dayTotals = Array.from(
    { length: now.day },
    (_, i) => days.get(isoDate(now.year, now.month, i + 1))?.usage ?? zeroUsage(),
  );
  const used = dayTotals.reduce((n, u) => n + tokensOf(u), 0);
  const cost = dayTotals.reduce<number | null>((n, u) => {
    const c = costOf(u);
    return n === null || c === null ? null : n + c;
  }, 0);
  const full = dayTotals.slice(0, -1);
  const average = full.length ? full.reduce((n, u) => n + tokensOf(u), 0) / full.length : used;
  const remaining = daysIn(now.year, now.month) - now.day;
  const forecast = used + average * remaining;
  const perService = aggregate(current);
  const byModel = aggregate(series(report, 'current', 'model', f, t).filter((b) => !b.future));
  const norway = Object.entries(byModel)
    .filter(([id]) => models?.find((m) => m.id === id)?.residency === 'norway')
    .reduce((n, [, u]) => n + tokensOf(u), 0);
  const runs = Object.values(perService).reduce((n, u) => n + runsOf(u), 0);
  return {
    used,
    cost,
    forecast,
    runs,
    norwayShare: models && used ? norway / used : null,
    perService,
    daysInMonth: daysIn(now.year, now.month),
    quota,
  };
};
