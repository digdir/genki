import { schedule, type Clock, type ScheduledJob } from '@genai/jobs';
import { EgressGuard } from '@genai/providers-mcp-client';
import { appendVersion, platformScope, type ConfigEntryStore } from './config-store.js';

/** Norges Bank's official daily USD/NOK rate (ADR 0040: kroner for a judge's reported cost). */
export const norgesBankUsdNok =
  'https://data.norges-bank.no/api/data/EXR/B.USD.NOK.SP?format=sdmx-json&lastNObservations=1';

export const exchangeRateKind = 'exchange-rate';
const usdNokId = 'USD-NOK';

export interface UsdNok {
  /** Kroner per US dollar. */
  rate: number;
  /** The day Norges Bank set it. */
  date: string;
}

/** What the platform's egress guard offers: one request to an allowed host. */
export interface GuardedRequest {
  request(
    allow: { host: string; port?: number }[],
    url: string,
    init: { method: 'GET'; headers?: Record<string, string> },
  ): Promise<{ status: number; body: string }>;
}

interface SdmxAnswer {
  data?: {
    dataSets?: { series?: Record<string, { observations?: Record<string, unknown[]> }> }[];
    structure?: { dimensions?: { observation?: { values?: { id?: string }[] }[] } };
  };
}

/** The guard the rate is read through: public HTTPS hosts only, as every egress call. */
export const exchangeRateGuard = (): GuardedRequest => new EgressGuard({});

/** Reads the latest rate, through the guard and to Norges Bank only. */
export const readUsdNok = async (guard: GuardedRequest): Promise<UsdNok> => {
  const response = await guard.request(
    [{ host: 'data.norges-bank.no', port: 443 }],
    norgesBankUsdNok,
    {
      method: 'GET',
      headers: { accept: 'application/json' },
    },
  );
  if (response.status !== 200) throw new Error(`Norges Bank answered HTTP ${response.status}`);
  const answer = JSON.parse(response.body) as SdmxAnswer;
  const series = Object.values(answer.data?.dataSets?.[0]?.series ?? {})[0];
  const rate = Number(Object.values(series?.observations ?? {})[0]?.[0]);
  const date = answer.data?.structure?.dimensions?.observation?.[0]?.values?.at(-1)?.id;
  if (!Number.isFinite(rate) || rate <= 0 || !date)
    throw new Error('Norges Bank answered without a USD/NOK rate');
  return { rate, date };
};

/** The latest rate the worker read; none until it has read one. */
export const latestUsdNok = async (
  configEntries: ConfigEntryStore,
): Promise<UsdNok | undefined> => {
  const entry = (await configEntries.latest({ kind: exchangeRateKind, scope: platformScope })).find(
    (e) => e.id === usdNokId && !e.deleted,
  );
  return entry ? (entry.spec as UsdNok) : undefined;
};

export const saveUsdNok = async (configEntries: ConfigEntryStore, rate: UsdNok, at: Date) => {
  const current = await latestUsdNok(configEntries);
  if (current?.rate === rate.rate && current.date === rate.date) return;
  await appendVersion<UsdNok>(configEntries, {
    kind: exchangeRateKind,
    scope: platformScope,
    id: usdNokId,
    spec: rate,
    deleted: false,
    by: 'worker',
    reason: `Norges Bank's USD/NOK rate for ${rate.date}`,
    at: at.toISOString(),
  });
};

/** Once a day, after Norges Bank publishes (about 16:00 Oslo time on working days). */
export const scheduleUsdNok = (deps: {
  configEntries: ConfigEntryStore;
  guard: GuardedRequest;
  clock?: Clock;
  cron?: string;
  active?: () => Promise<boolean>;
  onRead?: (rate: UsdNok) => void;
  onError?: (error: unknown) => void;
}): ScheduledJob =>
  schedule(
    deps.cron ?? '20 17 * * *',
    async (at) => {
      if (deps.active && !(await deps.active())) return;
      const rate = await readUsdNok(deps.guard);
      await saveUsdNok(deps.configEntries, rate, at);
      deps.onRead?.(rate);
    },
    {
      timeZone: 'Europe/Oslo',
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.onError ? { onError: deps.onError } : {}),
    },
  );
