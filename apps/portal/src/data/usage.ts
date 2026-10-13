import type { UsageReport, UsageTotals } from '../types';

export const quotaTokensPerMonth = 50_000_000;

export interface UsageServiceInfo {
  id: string;
  name: string;
  does: string;
  model: string;
  limit: number | null;
  limitNote?: string;
}

export interface UsageModelInfo {
  id: string;
  name: string;
  via: string;
  location: string;
  pricePer1000Ore: number;
}

export const usageModels: UsageModelInfo[] = [
  {
    id: 'aivar/borealis-27b',
    name: 'Borealis-27B',
    via: 'AIVAR',
    location: 'Norge',
    pricePer1000Ore: 0.5,
  },
  {
    id: 'aivar/qwen3.8-27b',
    name: 'Qwen3.8-27B',
    via: 'AIVAR',
    location: 'Norge',
    pricePer1000Ore: 0.6,
  },
  {
    id: 'foundry-openai/gpt-4.1',
    name: 'GPT-4.1',
    via: 'Azure OpenAI',
    location: 'EU (Sverige)',
    pricePer1000Ore: 1.5,
  },
  {
    id: 'foundry-openai/gpt-4.1-mini',
    name: 'GPT-4.1 mini',
    via: 'Azure OpenAI',
    location: 'EU (Sverige)',
    pricePer1000Ore: 0.3,
  },
];

export const usageServices: UsageServiceInfo[] = [
  {
    id: 'rapportassistenten',
    name: 'Rapportassistenten',
    does: 'Svarer',
    model: 'aivar/borealis-27b',
    limit: null,
  },
  {
    id: 'vedtaksutkast',
    name: 'Vedtaksutkast',
    does: 'Lager utkast',
    model: 'foundry-openai/gpt-4.1',
    limit: 12e6,
  },
  {
    id: 'soknadsuttrekk',
    name: 'Søknadsuttrekk',
    does: 'Henter ut data',
    model: 'aivar/qwen3.8-27b',
    limit: null,
  },
  {
    id: 'nettsider-nynorsk',
    name: 'Nettsider på nynorsk',
    does: 'Omskriver',
    model: 'aivar/borealis-27b',
    limit: 8e6,
  },
  {
    id: 'horingsoppsummering',
    name: 'Høringsoppsummering',
    does: 'Oppsummerer',
    model: 'aivar/borealis-27b',
    limit: 1e6,
    limitNote:
      'En samlet jobb med 214 høringssvar kjører nå og trenger omtrent 0,3 mill. til. Når grensen er nådd, stopper jobben, og resten av høringssvarene venter til grensen økes eller ny måned starter.',
  },
  {
    id: 'motereferat',
    name: 'Møtereferat',
    does: 'Transkriberer',
    model: 'aivar/qwen3.8-27b',
    limit: null,
  },
];

const shape: Record<string, { base: number; weekend: number; inputShare: number; perRun: number }> =
  {
    rapportassistenten: { base: 520000, weekend: 0.12, inputShare: 0.92, perRun: 4500 },
    vedtaksutkast: { base: 430000, weekend: 0, inputShare: 0.88, perRun: 20000 },
    soknadsuttrekk: { base: 240000, weekend: 0.05, inputShare: 0.95, perRun: 3100 },
    'nettsider-nynorsk': { base: 260000, weekend: 1, inputShare: 0.5, perRun: 7000 },
    horingsoppsummering: { base: 0, weekend: 0, inputShare: 0.93, perRun: 3000 },
    motereferat: { base: 70000, weekend: 0, inputShare: 0.8, perRun: 25000 },
  };

const modelInputShare: Record<string, number> = {
  'aivar/borealis-27b': 0.85,
  'aivar/qwen3.8-27b': 0.92,
  'foundry-openai/gpt-4.1': 0.88,
  'foundry-openai/gpt-4.1-mini': 0.9,
};

const modelPerRun: Record<string, number> = {
  'aivar/borealis-27b': 4200,
  'aivar/qwen3.8-27b': 4200,
  'foundry-openai/gpt-4.1': 20000,
  'foundry-openai/gpt-4.1-mini': 4000,
};

const MINI = 'foundry-openai/gpt-4.1-mini';
const growth: Record<number, number> = {
  2: 0.5,
  3: 0.5,
  4: 0.55,
  5: 0.66,
  6: 0.34,
  7: 0.82,
  8: 1,
  9: 1,
};
const random = (i: number) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};
const priceOf = (model: string) => usageModels.find((m) => m.id === model)?.pricePer1000Ore ?? 0.5;
const fallbackShare = (service: string) => (service === 'vedtaksutkast' ? 0 : 0.03);

const totals = (
  tokens: number,
  inputShare: number,
  perRun: number,
  costKr: number,
): UsageTotals => {
  const inputTokens = Math.round(tokens * inputShare);
  return {
    inputTokens,
    outputTokens: Math.round(tokens) - inputTokens,
    requests: Math.round(tokens / perRun),
    costMicroNok: Math.round(costKr * 1e6),
  };
};

const add = (a: UsageTotals, b: UsageTotals): UsageTotals => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  requests: a.requests + b.requests,
  costMicroNok: (a.costMicroNok ?? 0) + (b.costMicroNok ?? 0),
});

export const zeroUsage = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  requests: 0,
  costMicroNok: 0,
});

const tokensFor = (
  service: string,
  month: number,
  day: number,
  weekday: number,
  partial: boolean,
  index: number,
) => {
  const s = shape[service] ?? { base: 0, weekend: 0, inputShare: 0.9, perRun: 4000 };
  const weekend = weekday === 0 || weekday === 6;
  let t =
    s.base *
    (weekend ? s.weekend : 1) *
    (0.8 + random(month * 100 + day * 7 + index) * 0.4) *
    (growth[month] ?? 1);
  if (service === 'horingsoppsummering')
    t =
      month === 9 && day === 5
        ? 310000
        : month === 9 && day === 6
          ? 590000
          : month === 8 && (day === 22 || day === 23)
            ? 40000
            : 0;
  if (partial && service !== 'horingsoppsummering') t *= 0.45;
  return t;
};

export const exampleProjects = [
  { id: 'horinger-2026', name: 'Høringsrunde 2026', services: ['horingsoppsummering'] },
];

export const buildExampleUsage = (
  to = '2026-10-06T10:00:00.000Z',
  days = 190,
  project?: string,
): UsageReport => {
  const only = project
    ? (exampleProjects.find((p) => p.id === project)?.services ?? [])
    : undefined;
  const end = new Date(to);
  const daily: UsageReport['daily'] = [];
  const byService: Record<string, UsageTotals> = {};
  const byModel: Record<string, UsageTotals> = {};
  let sum = zeroUsage();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - i));
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    const partial = i === 0;
    const services: Record<string, UsageTotals> = {};
    const models: Record<string, UsageTotals> = {};
    let dayTotal = zeroUsage();
    usageServices.forEach((s, index) => {
      if (only && !only.includes(s.id)) return;
      const t = tokensFor(s.id, month, day, date.getUTCDay(), partial, index);
      const fb = fallbackShare(s.id);
      const cost = ((t / 1000) * (priceOf(s.model) * (1 - fb) + priceOf(MINI) * fb)) / 100;
      const shp = shape[s.id] ?? { inputShare: 0.9, perRun: 4000 };
      const u = totals(t, shp.inputShare, shp.perRun, cost);
      services[s.id] = u;
      byService[s.id] = add(byService[s.id] ?? zeroUsage(), u);
      dayTotal = add(dayTotal, u);
      [
        [s.model, t * (1 - fb)],
        [MINI, t * fb],
      ].forEach(([model, tokens]) => {
        const m = model as string;
        const mt = tokens as number;
        const mu = totals(
          mt,
          modelInputShare[m] ?? 0.9,
          modelPerRun[m] ?? 4000,
          ((mt / 1000) * priceOf(m)) / 100,
        );
        models[m] = add(models[m] ?? zeroUsage(), mu);
        byModel[m] = add(byModel[m] ?? zeroUsage(), mu);
      });
    });
    sum = add(sum, dayTotal);
    daily.push({
      date: date.toISOString().slice(0, 10),
      usage: dayTotal,
      byService: services,
      byModel: models,
    });
  }
  const first = daily[0]?.date ?? to.slice(0, 10);
  return {
    from: `${first}T00:00:00.000Z`,
    to,
    priced: true,
    totals: sum,
    daily,
    byService: Object.entries(byService).map(([service, usage]) => ({ service, usage })),
    byModel: Object.entries(byModel).map(([model, usage]) => ({ model, usage })),
    byProject: (project ? exampleProjects.filter((p) => p.id === project) : exampleProjects).map(
      (p) => ({
        project: p.id,
        name: p.name,
        usage: p.services.reduce((u, s) => add(u, byService[s] ?? zeroUsage()), zeroUsage()),
      }),
    ),
    ...(project ? { project } : {}),
  };
};
