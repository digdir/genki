import { usageModels, usageServices, zeroUsage } from '../../data/usage';
import { isTrialService, notPriced, serviceLabel } from '../../format';
import type { Format, T } from '../../i18n';
import { modelLabel } from '../../models';
import type {
  EffectiveSetting,
  ModelOption,
  ModelPrice,
  UsageReport,
  UsageTotals,
} from '../../types';

export const quotaSetting = 'usage.monthlyTokens';

export const quotaOf = (settings: Record<string, EffectiveSetting>) => {
  const value = settings[quotaSetting]?.value;
  return typeof value === 'number' && value > 0 ? value : null;
};

/** Months back from the report's current month: 0 is this month. */
export type Period = number;

export const monthsShown = 6;
export type Group = 'service' | 'model';

const monthName = (f: Format, year: number, month: number) =>
  f.month(new Date(Date.UTC(year, month, 15)));

const hues = [
  'var(--ds-color-accent-border-default)',
  'var(--ds-color-brand1-border-default)',
  'var(--ds-color-success-border-default)',
  'var(--ds-color-brand2-border-default)',
  'var(--ds-color-neutral-border-default)',
];

const gap = 'var(--ds-color-neutral-background-default)';

export const COLORS = [
  ...hues,
  ...hues.map((c) => `repeating-linear-gradient(45deg, ${c} 0 5px, ${gap} 5px 7px)`),
  ...hues.map((c) => `repeating-linear-gradient(0deg, ${c} 0 3px, ${gap} 3px 5px)`),
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
export const money = (f: Format, t: T, n: number | null, atLeast = false) => {
  if (n === null) return t('usage.notPriced');
  const value = t('usage.money', { value: n < 10 ? f.decimal(n, 2) : nb(f, n) });
  return atLeast ? t('usage.atLeast', { value }) : value;
};
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
/** The priced part of the cost, null only when nothing in it has a price. */
export const knownCostOf = (u: UsageTotals) =>
  u.costMicroNok === null ? null : u.costMicroNok / 1e6;
export const isLowerBound = (u: UsageTotals) => u.costMicroNok !== null && u.priced === false;
export const costText = (f: Format, t: T, u: UsageTotals) =>
  money(f, t, knownCostOf(u), isLowerBound(u));
const nothing = (u: UsageTotals) => tokensOf(u) === 0 && !u.costMicroNok;
const partCost = (
  a: UsageTotals,
  b: UsageTotals,
  combine: (x: number, y: number) => number,
): number | null => {
  if (nothing(b)) return a.costMicroNok;
  if (nothing(a) || a.costMicroNok === null)
    return b.costMicroNok === null ? null : combine(0, b.costMicroNok);
  return combine(a.costMicroNok, b.costMicroNok ?? 0);
};
export const runsOf = (u: UsageTotals) => u.runs ?? u.requests;
export const add = (a: UsageTotals, b: UsageTotals): UsageTotals => {
  const priced = (nothing(a) || isPriced(a)) && (nothing(b) || isPriced(b));
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    requests: a.requests + b.requests,
    ...(a.runs !== undefined || b.runs !== undefined
      ? { runs: (a.runs ?? 0) + (b.runs ?? 0) }
      : {}),
    costMicroNok: partCost(a, b, (x, y) => x + y),
    ...(priced ? {} : { priced: false }),
  };
};

const unpriced = (u: UsageTotals): UsageTotals => (u.priced === true ? u : { ...u, priced: false });

export const trialRow = 'trial-runs';
export const gatewayRow = 'gateway';
export const ingestionRow = 'ingestion';
export const internalRow = 'internal-services';

const less = (a: UsageTotals, b: UsageTotals): UsageTotals => {
  const priced = (nothing(a) || isPriced(a)) && (nothing(b) || isPriced(b));
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    requests: Math.max(0, a.requests - b.requests),
    costMicroNok: a.costMicroNok === null ? null : partCost(a, b, (x, y) => Math.max(0, x - y)),
    ...(priced ? {} : { priced: false }),
  };
};

const gatewayOf = (u: UsageTotals) => u.bySource?.find((s) => s.source === 'gateway')?.usage;

const nonEmpty = (u: UsageTotals) => tokensOf(u) > 0 || u.requests > 0;

const folded = (
  byService: Record<string, UsageTotals>,
  total: UsageTotals,
  ingestion?: UsageTotals,
  internal?: UsageTotals,
) => {
  const out: Record<string, UsageTotals> = {};
  let trial: UsageTotals | undefined;
  for (const [id, u] of Object.entries(byService)) {
    if (isTrialService(id)) trial = add(trial ?? zeroUsage(), u);
    else out[id] = u;
  }
  const counted = Object.values(byService).reduce((a, u) => add(a, u), zeroUsage());
  const gateway = gatewayOf(total);
  const read = ingestion && nonEmpty(ingestion) ? ingestion : undefined;
  const hidden = internal && nonEmpty(internal) ? internal : undefined;
  const rest = [gateway, read, hidden].reduce<UsageTotals>(
    (left, part) => less(left, part ?? zeroUsage()),
    less(total, counted),
  );
  if (nonEmpty(rest)) trial = add(trial ?? zeroUsage(), { ...rest, runs: 0 });
  if (hidden) out[internalRow] = hidden;
  if (trial) out[trialRow] = trial;
  if (read) out[ingestionRow] = { ...read, runs: 0 };
  if (gateway && nonEmpty(gateway)) out[gatewayRow] = { ...gateway, runs: 0 };
  return out;
};

export const withTrialRows = (report: UsageReport): UsageReport => {
  const daily = report.daily.map((d) =>
    d.byService ? { ...d, byService: folded(d.byService, d.usage, d.ingestion, d.internal) } : d,
  );
  const whole = folded(
    Object.fromEntries(report.byService.map((s) => [s.service, s.usage])),
    report.totals,
    report.ingestion?.usage,
    report.internal?.usage,
  );
  const titles = new Map(report.byService.map((s) => [s.service, s.title]));
  return {
    ...report,
    daily,
    byService: Object.entries(whole).map(([service, usage]) => {
      const title = titles.get(service);
      return { service, usage, ...(title ? { title } : {}) };
    }),
  };
};

/** Tokens the monthly quota counts: ingestion and the AI gateway are outside it. */
export const quotaTokensOf = (day: UsageReport['daily'][number]) =>
  tokensOf(day.usage) -
  tokensOf(day.ingestion ?? zeroUsage()) -
  tokensOf(gatewayOf(day.usage) ?? zeroUsage());

export const monthUsage = (report: UsageReport) => {
  const now = today(report);
  const prefix = `${now.year}-${String(now.month + 1).padStart(2, '0')}-`;
  const days = report.daily.filter((d) => d.date.startsWith(prefix));
  const total = days.reduce((a, d) => add(a, d.usage), zeroUsage());
  const parts: Record<string, UsageTotals> = {};
  for (const d of days)
    for (const [id, u] of Object.entries(d.byService ?? {}))
      parts[id] = add(parts[id] ?? zeroUsage(), u);
  const services = Object.entries(parts)
    .filter(([id]) => id !== trialRow && id !== gatewayRow && id !== ingestionRow)
    .reduce((a, [, u]) => add(a, u), zeroUsage());
  return {
    total,
    quotaTokens: days.reduce((n, d) => n + quotaTokensOf(d), 0),
    services,
    trial: parts[trialRow] ?? zeroUsage(),
    ingestion: parts[ingestionRow] ?? zeroUsage(),
    gateway: parts[gatewayRow] ?? zeroUsage(),
    perService: parts,
    runs: Object.values(parts).reduce((n, u) => n + runsOf(u), 0),
  };
};

export const withPricing = (report: UsageReport): UsageReport =>
  report.priced
    ? report
    : {
        ...report,
        totals: unpriced(report.totals),
        ...(report.ingestion
          ? { ingestion: { ...report.ingestion, usage: unpriced(report.ingestion.usage) } }
          : {}),
        daily: report.daily.map((d) => ({
          ...d,
          usage: unpriced(d.usage),
          ...(d.ingestion ? { ingestion: unpriced(d.ingestion) } : {}),
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
  extra?: boolean;
  price?: ModelPrice | null;
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
  costAtLeast: boolean;
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
        ...(known ? { price: known.price ?? null } : {}),
      };
    });
  }
  const ids = report.byService.map((s) => s.service);
  const extra = [internalRow, trialRow, ingestionRow, gatewayRow];
  const ordered = [
    ...usageServices.filter((s) => ids.includes(s.id)).map((s) => s.id),
    ...ids.filter((id) => !usageServices.some((s) => s.id === id) && !extra.includes(id)),
    ...extra.filter((id) => ids.includes(id)),
  ];
  return ordered.map((id, i) => {
    const color = COLORS[i % COLORS.length] ?? '';
    if (id === trialRow)
      return { id, label: t('usage.trialRuns'), sub: t('usage.trialRunsSub'), color, extra: true };
    if (id === internalRow)
      return {
        id,
        label: t('usage.internalServices'),
        sub: t('usage.internalServicesSub'),
        color,
        extra: true,
      };
    if (id === ingestionRow)
      return {
        id,
        label: t('usageParts.ingestion'),
        sub: t('usageParts.ingestionSub'),
        color,
        extra: true,
      };
    if (id === gatewayRow)
      return {
        id,
        label: t('usage.outsideGenki'),
        sub: t('usage.outsideGenkiSub'),
        color,
        extra: true,
      };
    const info = usageServices.find((s) => s.id === id);
    const model = usageModels.find((m) => m.id === info?.model);
    return {
      id,
      label: info?.name ?? serviceLabel(id, report.byService.find((s) => s.service === id)?.title),
      sub: info ? `${info.does} · ${model?.name ?? info.model}` : '',
      color,
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
          costMicroNok: entry.usage.costMicroNok === null ? null : entry.usage.costMicroNok * share,
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
    cost: knownCostOf(total),
    costAtLeast: isLowerBound(total),
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
  const base = new Date(Date.UTC(now.year, now.month - period, 1));
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  return Array.from({ length: daysIn(y, m) }, (_, i) => {
    const d = i + 1;
    const isToday = period === 0 && d === now.day;
    const future = period === 0 && d > now.day;
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

const monthKey = (year: number, month: number) => `${year}-${String(month + 1).padStart(2, '0')}`;

export const monthOptions = (report: UsageReport, f: Format) => {
  const now = today(report);
  return Array.from({ length: monthsShown }, (_, back) => {
    const date = new Date(Date.UTC(now.year, now.month - back, 1));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    return {
      back,
      value: monthKey(year, month),
      label: capitalise(f.month(new Date(Date.UTC(year, month, 15)), { year: true })),
    };
  });
};

/** The months back for a month in the address; this month when it is missing or out of range. */
export const periodOf = (report: UsageReport, month: string | null): Period => {
  const now = today(report);
  const found = /^(\d{4})-(\d{2})$/.exec(month ?? '');
  if (!found) return 0;
  const back = now.year * 12 + now.month - (Number(found[1]) * 12 + Number(found[2]) - 1);
  return back >= 0 && back < monthsShown ? back : 0;
};

export const periodLabels = (report: UsageReport, f: Format, t: T) => {
  const now = today(report);
  const nameOf = (back: number) => {
    const date = new Date(Date.UTC(now.year, now.month - back, 1));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
  };
  return {
    range: (back: Period) => {
      const { year, month } = nameOf(back);
      return t('usage.range', {
        last: String(back === 0 ? now.day : daysIn(year, month)),
        month: monthName(f, year, month),
        year: String(year),
      });
    },
    month: monthName(f, now.year, now.month),
    monthShort: (back: Period) => {
      const { year, month } = nameOf(back);
      const name = monthName(f, year, month);
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
  const current = series(report, 0, 'service', f, t).filter((b) => !b.future);
  const days = byDate(report);
  const thisMonth = Array.from({ length: now.day }, (_, i) =>
    days.get(isoDate(now.year, now.month, i + 1)),
  );
  const dayTotals = thisMonth.map((d) => d?.usage ?? zeroUsage());
  const counted = thisMonth.map((d) => (d ? quotaTokensOf(d) : 0));
  const countedSum = counted.reduce((n, tokens) => n + tokens, 0);
  const tenantWide = report.project === undefined && report.environment === undefined;
  const used = (tenantWide ? report.quota?.usedTokens : undefined) ?? countedSum;
  const spent = dayTotals.reduce((a, u) => add(a, u), zeroUsage());
  const cost = knownCostOf(spent);
  const costAtLeast = isLowerBound(spent);
  const full = counted.slice(0, -1);
  const average = full.length ? full.reduce((n, tokens) => n + tokens, 0) / full.length : used;
  const remaining = daysIn(now.year, now.month) - now.day;
  const forecast = used + average * remaining;
  const spentTokens = tokensOf(spent);
  const fullSpent = dayTotals.slice(0, -1).reduce((n, u) => n + tokensOf(u), 0);
  const spentAverage = full.length ? fullSpent / full.length : spentTokens;
  const forecastCost =
    cost === null
      ? null
      : spentTokens
        ? (cost * (spentTokens + spentAverage * remaining)) / spentTokens
        : 0;
  const perService = aggregate(current);
  const byModel = aggregate(series(report, 0, 'model', f, t).filter((b) => !b.future));
  const norway = Object.entries(byModel)
    .filter(([id]) => models?.find((m) => m.id === id)?.residency === 'norway')
    .reduce((n, [, u]) => n + tokensOf(u), 0);
  const runs = Object.values(perService).reduce((n, u) => n + runsOf(u), 0);
  return {
    used,
    cost,
    costAtLeast,
    forecast,
    forecastCost,
    runs,
    norwayShare: models && spentTokens ? norway / spentTokens : null,
    perService,
    daysInMonth: daysIn(now.year, now.month),
    quota,
  };
};
