import { Heading, Link, Paragraph, Skeleton, Table, Tag } from '@digdir/designsystemet-react';
import { intlLocale } from '@genai/i18n';
import type { ReactNode } from 'react';
import type { ApiClient } from '../../api';
import type { DatasetView } from '../../api/datasets';
import { productionEnvironment } from '../../api/environments';
import { asServiceDefinition, type ServiceDefinition } from '../../data/service-definition';
import { datasetsOf } from '../../data/service-form';
import { mediaKind } from '../../data/unmasked-input';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import type { PlainKey, T } from '../../i18n';
import { rightLabel } from '../../Shell';
import type { ModelOption, PublishedDefinition, TaskRow } from '../../types';
import { gateStopReason, gateStops } from '../quality/QualityOverview';
import { draftChanges } from '../services/setup-diff';
import type { VersionItem } from '../services/VersionsTab';
import {
  completedRuns,
  dayMs,
  monthCost,
  qualityTrend,
  runShare,
  runsTrend,
  serviceDays,
  unusedDays,
} from './overview-model';
import { PausedBanner } from './PausedBanner';
import { servicePath } from './sections';
import './overview.css';

const residencyKeys: Record<string, PlainKey> = {
  norway: 'serviceHealth.residencyNorway',
  eu: 'serviceHealth.residencyEu',
  global: 'serviceHealth.residencyGlobal',
};

const unusedAfterDays = 60;
const barDays = 14;
const shownSources = 2;

const settled = <T,>(r: PromiseSettledResult<T>) =>
  r.status === 'fulfilled' ? r.value : undefined;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const refusedGates = (message: string) => {
  const open = message.indexOf('(');
  const close = message.indexOf(')', open);
  if (open < 0 || close < 0) return [];
  return message
    .slice(open + 1, close)
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
};

const matchDataset = (
  datasets: (DatasetView & { aliases?: string[] })[] | undefined,
  tenant: string,
  ref: string,
) =>
  datasets?.find(
    (d) =>
      d.fullId === ref ||
      d.fullId === `${tenant}/${ref}` ||
      d.id === ref ||
      d.aliases?.includes(ref) === true,
  );

export const channelText = (
  run: Pick<TaskRow, 'channel' | 'actor' | 'frontend'>,
  t: T,
  frontendName?: (id: string) => string | undefined,
) => {
  switch (run.channel) {
    case 'interface':
      return (
        (run.frontend ? frontendName?.(run.frontend) : undefined) ??
        (run.actor?.kind === 'api-key' ? run.actor.name : undefined) ??
        t('serviceHealth.channelInterface')
      );
    case 'api-key':
      return run.actor?.name
        ? t('serviceHealth.channelApiKey', { name: run.actor.name })
        : t('serviceHealth.channelApiKeyUnnamed');
    case 'api':
      return t('serviceHealth.channelApi');
    case 'playground':
      return t('serviceHealth.channelPlayground');
    case 'batch':
      return t('serviceHealth.channelBatch');
    default:
      return t('serviceHealth.channelTrigger');
  }
};

type Tone = 'danger' | 'warning' | 'success' | 'neutral';

interface Need {
  key: string;
  tone: Tone;
  title: string;
  text: string;
  link: { href: string; label: string };
}

const Bars = ({ values, tone }: { values: number[] | undefined; tone: Tone | 'accent' }) => {
  if (!values)
    return (
      <span className="ov-bars ov-bars-flat" aria-hidden="true">
        {Array.from({ length: barDays }, (_, i) => (
          <span key={i} />
        ))}
      </span>
    );
  const max = Math.max(...values, 0) || 1;
  return (
    <span className={`ov-bars ov-bars-${tone}`} aria-hidden="true">
      {values.map((v, i) => (
        <span key={i} style={{ height: `${Math.max(4, Math.round((v / max) * 100))}%` }} />
      ))}
    </span>
  );
};

const Tile = ({
  label,
  href,
  loading,
  value,
  sub,
  tone = 'neutral',
  bars,
}: {
  label: string;
  href: string;
  loading: boolean;
  value?: string | undefined;
  sub?: string | undefined;
  tone?: Tone;
  bars?: ReactNode;
}) => (
  <a className="ov-tile" href={href}>
    <span className="ov-tile-label">{label}</span>
    {loading ? (
      <>
        <Skeleton variant="rectangle" width="60%" height={30} />
        <Skeleton variant="text" width="85%" />
        <Skeleton variant="rectangle" width="100%" height={28} className="ov-tile-foot" />
      </>
    ) : (
      <>
        <span className="ov-tile-value">{value}</span>
        <span className={`ov-tile-sub ov-tone-${tone}`}>{sub}</span>
        <span className="ov-tile-foot">{bars}</span>
      </>
    )}
  </a>
);

const SideCard = ({
  id,
  title,
  action,
  loading,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  loading: boolean;
  children: ReactNode;
}) => (
  <section aria-labelledby={id} aria-busy={loading || undefined} className="ov-card">
    <div className="ov-card-head">
      <Heading level={2} data-size="2xs" id={id}>
        {title}
      </Heading>
      {action}
    </div>
    {loading ? (
      <div className="stack-sm">
        <Skeleton variant="text" width="80%" />
        <Skeleton variant="text" width="65%" />
        <Skeleton variant="text" width="72%" />
      </div>
    ) : (
      children
    )}
  </section>
);

const StepMark = ({ done, label }: { done: boolean; label: string }) =>
  done ? (
    <svg width="18" height="18" viewBox="0 0 18 18" role="img" aria-label={label}>
      <circle cx="9" cy="9" r="8" className="ov-step-done" />
      <path
        d="M5 9.2l2.6 2.6L13 6.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="ov-step-check"
      />
    </svg>
  ) : (
    <span className="ov-step-open" role="img" aria-label={label} />
  );

export const OverviewSection = ({
  api,
  tenant,
  id,
  definition: d,
  published,
  tenantName,
  now = () => new Date(),
}: {
  api: ApiClient;
  tenant: string;
  tenantName?: string;
  id: string;
  definition: ServiceDefinition;
  versions?: VersionItem[];
  published?: PublishedDefinition;
  now?: () => Date;
}) => {
  const { t, f, actor, status } = usePortalFormat();
  const today = startOfDay(now());
  const dayOfMonth = today.getDate();
  const periodStart = new Date(today.getTime() - (barDays - 1) * dayMs).toISOString();
  const href = (section: Parameters<typeof servicePath>[1], rest = '') =>
    `#${servicePath(id, section, rest)}`;
  const name = d.metadata.name || id;
  const org = tenantName || tenant;
  const dates = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(intlLocale(f.locale), { timeZone: 'Europe/Oslo', ...options });
  const dayMonth = (iso: string) => dates({ day: 'numeric', month: 'long' }).format(new Date(iso));
  const shortDay = (iso: string) =>
    dates({ day: 'numeric', month: 'short' }).format(new Date(iso)).replace(/\.$/, '');

  const [usage] = useAsync(
    async (signal) => serviceDays(await api.usage(tenant, dayOfMonth + 31, signal), id),
    [api, tenant, id, dayOfMonth],
  );
  const [failures] = useAsync(
    async (signal) =>
      (await api.serviceTabs.failures(tenant, today.toISOString(), signal)).find(
        (s) => s.service === id,
      ),
    [api, tenant, id, today.getTime()],
  );
  const [recent] = useAsync(
    (signal) => api.tasks(tenant, { service: id, limit: 6 }, signal),
    [api, tenant, id],
  );
  const [quality] = useAsync(
    async (signal) => {
      const [sets, runs] = await Promise.all([
        api.quality.testSets(tenant, id, signal),
        api.quality.runs(tenant, id, signal),
      ]);
      return { sets, runs, trend: qualityTrend(runs, sets) };
    },
    [api, tenant, id],
  );
  const [draft] = useAsync(
    async (signal) => {
      const [summary, checks, saved] = await Promise.allSettled([
        api.quality.drafts(tenant, signal),
        api.serviceTabs.draftChecks(tenant, id, signal),
        api.quality.draft(tenant, id, signal),
      ]);
      const stopping = settled(checks)?.problems.some((p) => p.path.startsWith('spec.evaluation'));
      const gates = stopping
        ? await api
            .configList(`/tenants/${encodeURIComponent(tenant)}/gates`, signal)
            .then((r) => r.data)
            .catch(() => [])
        : [];
      return {
        summary: settled(summary)?.find((s) => s.id === id && s.latestVersion !== null),
        checks: settled(checks),
        gates,
        definition: settled(saved)?.definition,
      };
    },
    [api, tenant, id],
  );
  const [who] = useAsync(
    async (signal) => {
      const [shared, access, listed] = await Promise.allSettled([
        api.serviceTabs.sharedWith(tenant, id, signal),
        api.accessPeople.services(tenant, signal),
        api.listServiceKeys(tenant, id, signal),
      ]);
      const sharedWith = settled(shared);
      const keys = settled(listed)?.filter((k) => !k.revokedAt);
      const count = async (by: { actor?: string; frontend?: string } = {}) =>
        (
          await api.serviceTabs.taskPage(
            tenant,
            { service: id, from: periodStart, ...by, limit: 1, offset: 0 },
            signal,
          )
        ).total;
      const keyIds = keys?.map((k) => k.id) ?? [];
      const browserIds =
        sharedWith?.frontends.filter((fe) => fe.kind !== 'server').map((fe) => fe.id) ?? [];
      const counted = await Promise.allSettled([
        count(),
        ...keyIds.map((k) => count({ actor: `api-key:${k}` })),
        ...browserIds.map((fe) => count({ frontend: fe })),
      ]);
      const total = settled(counted[0] as PromiseSettledResult<number>);
      const byKey = new Map(
        keyIds.map((k, i) => [k, settled(counted[i + 1] as PromiseSettledResult<number>)]),
      );
      const byFrontend = new Map(
        browserIds.map((fe, i) => [
          fe,
          settled(counted[i + 1 + keyIds.length] as PromiseSettledResult<number>),
        ]),
      );
      return {
        shared: sharedWith,
        keys,
        total,
        byKey,
        byFrontend,
        selected: settled(access)?.find((s) => s.id === id && s.mode === 'selected'),
      };
    },
    [api, tenant, id, periodStart],
  );
  const [running] = useAsync(
    async (signal) => {
      const [history, environments, datasets, models, services] = await Promise.allSettled([
        api.getDefinition(tenant, 'Service', id, signal),
        api.environments.list(tenant, id, signal),
        api.datasets.list(tenant, signal),
        api.listModels({}, signal),
        api.services(tenant, signal),
      ]);
      return {
        history: settled(history),
        environments: settled(environments)?.environments,
        datasets: settled(datasets),
        models: settled(models),
        dataLocation: settled(services)?.data.find((s) => s.id === id)?.dataLocation,
      };
    },
    [api, tenant, id],
  );

  const days = usage.status === 'ready' ? usage.data : [];
  const shown = days.slice(-barDays);
  const dayToday = days.at(-1);
  const quietToday = !dayToday?.runs;
  const lastRunDay = days.findLast((x) => x.runs > 0);
  const lastTimedDay = days.findLast((x) => x.latency);
  const dayName = (date: string) => shortDay(`${date}T12:00:00Z`);
  const recentRuns =
    recent.status === 'ready' ? (recent.data.data ?? []).filter((r) => r.service === id) : [];
  const fresh = recent.status === 'ready' && recent.data.total === 0;
  const failed = failures.status === 'ready' ? failures.data : undefined;
  const topCause = failed?.causes[0];
  const notAvailable = t('serviceOverview.notAvailable');

  const when = (iso: string) => {
    const day = startOfDay(new Date(iso)).getTime();
    if (day === today.getTime()) return t('serviceHealth.todayAt', { time: f.time(iso) });
    if (day === today.getTime() - dayMs)
      return t('serviceHealth.yesterdayAt', { time: f.time(iso) });
    return `${shortDay(iso)} ${f.time(iso)}`;
  };
  const recentDay = (iso: string) => {
    const day = startOfDay(new Date(iso)).getTime();
    return day === today.getTime() || day === today.getTime() - dayMs ? when(iso) : shortDay(iso);
  };
  const clock = (iso: string) => {
    const day = startOfDay(new Date(iso)).getTime();
    if (day === today.getTime()) return f.time(iso);
    if (day === today.getTime() - dayMs)
      return t('serviceHealth.yesterdayAtInline', { time: f.time(iso) });
    return when(iso);
  };
  const percentChange = (change: number | undefined) =>
    change === undefined ? undefined : `${change >= 0 ? '+' : ''}${f.percent(change, 0)}`;
  const seconds = (ms: number) =>
    t('common.seconds', { value: f.number(ms / 1000, { maximumFractionDigits: 1 }) });

  const runsTile = (() => {
    if (usage.status === 'error') return { value: notAvailable, sub: '' };
    if (fresh) return { value: f.number(0), sub: t('serviceHealth.noRunsYet') };
    const change = runsTrend(days);
    return {
      value: f.number(dayToday?.runs ?? 0),
      sub:
        change === undefined
          ? t('serviceHealth.runsToday')
          : t('serviceHealth.runsTrend', { change: percentChange(change) ?? '' }),
      tone: (change !== undefined && change >= 0 ? 'success' : 'neutral') as Tone,
    };
  })();

  const failTile = (() => {
    if (usage.status === 'error') return { value: notAvailable, sub: '', tone: 'neutral' as Tone };
    const runs = dayToday?.runs ?? 0;
    const count = dayToday?.failed ?? 0;
    if (fresh)
      return {
        value: t('serviceHealth.noData'),
        sub: t('serviceHealth.comesWithRuns'),
        tone: 'neutral' as Tone,
      };
    if (runs === 0)
      return lastRunDay
        ? {
            value: f.percent(lastRunDay.failed / lastRunDay.runs, 1),
            sub: t('serviceHealth.failedOn', {
              day: dayName(lastRunDay.date),
              failed: lastRunDay.failed,
              runs: lastRunDay.runs,
            }),
            tone: 'neutral' as Tone,
          }
        : {
            value: t('serviceHealth.noData'),
            sub: t('serviceHealth.noRunsToday'),
            tone: 'neutral' as Tone,
          };
    return {
      value: f.percent(count / runs, 1),
      sub: topCause
        ? t('serviceHealth.failedOfCause', { failed: count, runs, cause: topCause.reason })
        : t('serviceHealth.failedOf', { failed: count, runs }),
      tone: (count > 0 ? 'danger' : 'neutral') as Tone,
    };
  })();

  const latency = dayToday?.latency ?? null;
  const earlierLatency = quietToday ? lastTimedDay : undefined;
  const latencyTile =
    usage.status === 'error'
      ? { value: notAvailable, sub: '' }
      : fresh
        ? { value: t('serviceHealth.noData'), sub: t('serviceHealth.comesWithRuns') }
        : latency
          ? {
              value: seconds(latency.p50Ms),
              sub: t('serviceHealth.latencySub', { p95: seconds(latency.p95Ms) }),
            }
          : earlierLatency?.latency
            ? {
                value: seconds(earlierLatency.latency.p50Ms),
                sub: t('serviceHealth.latencyOn', {
                  day: dayName(earlierLatency.date),
                  p95: seconds(earlierLatency.latency.p95Ms),
                }),
              }
            : {
                value: t('serviceHealth.noData'),
                sub: t(quietToday ? 'serviceHealth.noRunsToday' : 'serviceHealth.comesWithRuns'),
              };

  const month = monthCost(days);
  const monthName = (date: Date) =>
    new Intl.DateTimeFormat(intlLocale(f.locale), {
      month: 'long',
      timeZone: 'Europe/Oslo',
    }).format(date);
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const tileKroner = (microNok: number) =>
    f.currency(microNok / 1_000_000, {
      digits: microNok === 0 || microNok >= 100_000_000 ? 0 : 2,
    });
  const costTile =
    usage.status === 'error' || (!month && !fresh)
      ? { value: notAvailable, sub: '' }
      : fresh || !month
        ? { value: tileKroner(month?.spent ?? 0), sub: t('serviceHealth.costTrials') }
        : {
            value: month.priced
              ? tileKroner(month.spent)
              : t('serviceOverview.costAtLeast', { cost: tileKroner(month.spent) }),
            sub:
              month.change === undefined
                ? t('serviceHealth.costForecast', { forecast: tileKroner(month.forecast) })
                : t('serviceHealth.costTrend', {
                    change: percentChange(month.change) ?? '',
                    month: monthName(lastMonth),
                    forecast: tileKroner(month.forecast),
                  }),
            tone: (month.change !== undefined && month.change > 0 ? 'warning' : 'neutral') as Tone,
          };

  const trend = quality.status === 'ready' ? quality.data.trend : undefined;
  const qualityTile =
    quality.status === 'error'
      ? { value: notAvailable, sub: '', tone: 'neutral' as Tone }
      : !trend
        ? {
            value: t('serviceHealth.notMeasured'),
            sub:
              quality.status === 'ready' && quality.data.sets.length
                ? t('serviceHealth.setsNotRun', { count: quality.data.sets.length })
                : t('serviceHealth.makeTestSet'),
            tone: 'warning' as Tone,
          }
        : {
            value: f.percent(trend.latest.score ?? 0, 0),
            sub: [
              t('serviceHealth.qualitySet', {
                version:
                  typeof trend.latest.version === 'number'
                    ? t('serviceHealth.versionN', { n: trend.latest.version })
                    : t('serviceHealth.draft'),
              }),
              trend.previous && typeof trend.previous.version === 'number'
                ? t(
                    (trend.latest.score ?? 0) > (trend.previous.score ?? 0)
                      ? 'serviceHealth.qualityUpFrom'
                      : (trend.latest.score ?? 0) < (trend.previous.score ?? 0)
                        ? 'serviceHealth.qualityDownFrom'
                        : 'serviceHealth.qualityFrom',
                    {
                      score: f.percent(trend.previous.score ?? 0, 0),
                      version: trend.previous.version,
                    },
                  )
                : '',
            ]
              .filter(Boolean)
              .join(' '),
            tone: ((trend.latest.score ?? 0) >= (trend.previous?.score ?? 0)
              ? 'success'
              : 'warning') as Tone,
          };

  const lastDraftRun = (() => {
    if (quality.status !== 'ready') return undefined;
    return completedRuns(quality.data.runs).find((r) => r.version === 'draft' && r.endedAt);
  })();

  const publishedVersion =
    running.status === 'ready' ? running.data.history?.latest?.version : undefined;
  const needs = (): { items: Need[]; pending: number } => {
    const items: Need[] = [];
    let pending = 0;
    if (failures.status === 'loading') pending += 1;
    else if (failed && failed.failed > 0)
      items.push({
        key: 'failed',
        tone: 'danger',
        title: t('serviceHealth.needFailed', { count: failed.failed }),
        text: topCause
          ? t('serviceHealth.needFailedCause', {
              cause: topCause.reason,
              count: topCause.count,
              of: failed.failed,
            })
          : '',
        link: {
          href: href('log', '?status=failed&period=today'),
          label: t('serviceHealth.seeFailed'),
        },
      });
    if (draft.status === 'loading' || quality.status === 'loading') pending += 1;
    else if (draft.status === 'ready' && draft.data.summary) {
      const { summary } = draft.data;
      const stale = !lastDraftRun || lastDraftRun.draftRevision !== summary.revision;
      const stops = draft.data.checks?.problems.filter((p) => p.path.startsWith('spec.evaluation'));
      const refused = [...new Set(stops?.flatMap((p) => refusedGates(p.message)) ?? [])];
      const stopping =
        quality.status === 'ready'
          ? draft.data.gates.filter(
              (g) => refused.includes(g.id) && gateStops(g, quality.data.runs, publishedVersion),
            )
          : [];
      const stoppedBy = stopping.length === 1 ? stopping[0] : undefined;
      const stopCount = stopping.length || refused.length || (stops?.length ?? 0);
      if (stale || stops?.length)
        items.push({
          key: 'draft',
          tone: 'warning',
          title: !lastDraftRun
            ? t('serviceHealth.needDraftUntested')
            : stale
              ? t('serviceHealth.needDraftChanged')
              : t('serviceHealth.needDraftStopped'),
          text: [
            lastDraftRun?.endedAt
              ? t('serviceHealth.testedChanged', {
                  tested: clock(lastDraftRun.endedAt),
                  changed: clock(summary.at),
                })
              : t('serviceHealth.changedAt', { changed: clock(summary.at) }),
            stoppedBy && quality.status === 'ready'
              ? t('serviceHealth.gateStops', {
                  reason: gateStopReason(t, f, stoppedBy, quality.data.runs, publishedVersion),
                })
              : stops?.length
                ? t('serviceHealth.gatesStop', { count: stopCount })
                : '',
          ]
            .filter(Boolean)
            .join(' '),
          link: { href: href('quality'), label: t('serviceHealth.testDraft') },
        });
    }
    if (who.status === 'loading') pending += 1;
    else if (who.status === 'ready' && who.data.keys) {
      const idle = who.data.keys
        .map((k) => ({ k, days: unusedDays(k.lastUsedAt ?? k.createdAt, now()) }))
        .filter((x) => x.days !== undefined && x.days >= unusedAfterDays)
        .sort((a, b) => (b.days ?? 0) - (a.days ?? 0))[0];
      if (idle)
        items.push({
          key: 'key',
          tone: 'neutral',
          title: t('serviceHealth.needKey', { days: idle.days ?? 0 }),
          text: t('serviceHealth.needKeyText', { name: idle.k.name }),
          link: { href: href('channels'), label: t('serviceHealth.seeKeys') },
        });
    }
    return { items, pending };
  };
  const { items, pending } = needs();

  const history = running.status === 'ready' ? running.data.history : undefined;
  const latest = history?.latest;
  const environments = running.status === 'ready' ? running.data.environments : undefined;
  const primary = d.spec.model.primary;
  const known = running.status === 'ready' ? running.data : undefined;
  const model = known?.models?.find((m) => m.id === primary) as ModelOption | undefined;
  const sources = datasetsOf(d.spec);
  const sourceDatasets = sources.flatMap((ref) => {
    const found = matchDataset(known?.datasets, tenant, ref.dataset);
    return found ? [found] : [];
  });
  const residencyKey = known?.dataLocation ? residencyKeys[known.dataLocation] : undefined;
  const consent = (published?.definition as ServiceDefinition | undefined)?.spec?.riskConfirmation;

  const changeCount = (() => {
    if (draft.status !== 'ready' || !draft.data.definition || !latest) return undefined;
    return draftChanges(
      asServiceDefinition(latest.definition),
      asServiceDefinition(draft.data.definition),
    ).length;
  })();

  const shared = who.status === 'ready' ? who.data.shared : undefined;
  const serviceKeys = who.status === 'ready' ? who.data.keys : undefined;
  const sharedText =
    !shared || (Array.isArray(shared.tenants) && shared.tenants.length === 0)
      ? t('serviceHealth.notShared')
      : shared.tenants === '*'
        ? t('serviceHealth.sharedAll')
        : t('serviceHealth.sharedWith', { count: shared.tenants.length });
  const total = who.status === 'ready' ? who.data.total : undefined;
  const keyRuns = (keyId: string) =>
    who.status === 'ready' ? who.data.byKey.get(keyId) : undefined;
  const frontendShare = (frontendId: string, kind: string) => {
    if (kind !== 'server') {
      const runs = who.status === 'ready' ? who.data.byFrontend.get(frontendId) : undefined;
      return runs === undefined ? undefined : runShare(runs, total);
    }
    const bound = serviceKeys?.filter((k) => k.client === frontendId) ?? [];
    if (!bound.length) return undefined;
    const counts = bound.map((k) => keyRuns(k.id));
    if (counts.some((c) => c === undefined)) return undefined;
    return runShare(
      counts.reduce((sum: number, c) => sum + (c ?? 0), 0),
      total,
    );
  };
  const keyLine = (k: { id: string; name: string }) => {
    const runs = keyRuns(k.id);
    if (runs === 0) return t('serviceHealth.keyUnused', { name: k.name });
    const share = runShare(runs, total);
    return share === undefined
      ? k.name
      : t('serviceHealth.keyShare', { name: k.name, share: f.percent(share, 0) });
  };

  const versionsNewest = history ? [...history.versions].reverse() : [];
  const sets = quality.status === 'ready' ? quality.data.sets.length : 0;
  const reachable = (shared?.frontends.length ?? 0) + (serviceKeys?.length ?? 0);
  const ownKeys = serviceKeys?.filter((k) => !k.client) ?? [];
  const frontendName = (frontendId: string) =>
    shared?.frontends.find((fe) => fe.id === frontendId)?.name;
  const stepLabel = (done: boolean) =>
    done ? t('serviceHealth.stepDone') : t('serviceHealth.stepOpen');

  const sourceLinks = (() => {
    const shownRefs = sources.slice(0, shownSources);
    const rest = sources.length - shownRefs.length;
    const parts = shownRefs.map((ref) => {
      const found = matchDataset(known?.datasets, tenant, ref.dataset);
      return found ? (
        <Link key={ref.dataset} href={`#/datasets/${encodeURIComponent(found.id)}`}>
          {found.name}
        </Link>
      ) : (
        <span key={ref.dataset}>{t('serviceHealth.unknownDataset', { id: ref.dataset })}</span>
      );
    });
    const joined: ReactNode[] = [];
    parts.forEach((p, i) => {
      if (i > 0)
        joined.push(i === parts.length - 1 && rest === 0 ? ` ${t('serviceHealth.and')} ` : ', ');
      joined.push(p);
    });
    if (rest > 0) joined.push(` ${t('serviceHealth.andMore', { count: rest })}`);
    return joined;
  })();

  const runsLoading = usage.status === 'loading' || recent.status === 'loading';
  const oldestShown = Math.min(
    ...recentRuns.map((r) => startOfDay(new Date(r.createdAt)).getTime()),
  );
  const daysBack = recentRuns.length ? Math.round((today.getTime() - oldestShown) / dayMs) : 0;
  const logPeriod = `?period=${daysBack === 0 ? 'today' : daysBack <= 6 ? 'week' : daysBack <= 29 ? 'month' : 'all'}`;
  const tileBars = (values: number[]) => (fresh ? undefined : values);

  return (
    <div className="service-overview stack">
      <PausedBanner
        api={api}
        tenant={tenant}
        id={id}
        name={name}
        published={published}
        datasets={sourceDatasets}
      />

      {fresh && latest ? (
        <section aria-labelledby="ov-start" className="ov-start">
          <div className="stack-xs">
            <Heading level={2} data-size="xs" id="ov-start">
              {t('serviceHealth.startTitle', { version: latest.version })}
            </Heading>
            <Paragraph>{t('serviceHealth.startLead')}</Paragraph>
          </div>
          <ol className="plain-list ov-steps">
            <li className="ov-step">
              <span className="ov-step-title">
                <StepMark done label={stepLabel(true)} />
                <strong>{t('serviceHealth.stepPublished')}</strong>
              </span>
              <span className="meta">
                {t('serviceHealth.stepPublishedBy', {
                  when: when(latest.publishedAt),
                  who: actor(latest.publishedBy, latest.publishedByName),
                })}
              </span>
            </li>
            <li className="ov-step">
              <span className="ov-step-title">
                <StepMark done={sets > 0} label={stepLabel(sets > 0)} />
                <strong>{t('serviceHealth.stepTestSet')}</strong>
              </span>
              <span className="meta">{t('serviceHealth.stepTestSetText')}</span>
              <Link href={href('quality')}>{t('serviceHealth.stepTestSetLink')}</Link>
            </li>
            <li className="ov-step">
              <span className="ov-step-title">
                <StepMark done={reachable > 0} label={stepLabel(reachable > 0)} />
                <strong>{t('serviceHealth.stepReach')}</strong>
              </span>
              <span className="meta">{t('serviceHealth.stepReachText')}</span>
              <Link href={href('channels')}>{t('service.sectionChannels')}</Link>
            </li>
            <li className="ov-step">
              <span className="ov-step-title">
                <StepMark done={false} label={stepLabel(false)} />
                <strong>{t('serviceHealth.stepAccess')}</strong>
              </span>
              <span className="meta">
                {t('serviceHealth.stepAccessText', {
                  org,
                  right: rightLabel(t, 'use-services'),
                })}
              </span>
              <Link href={`#/access/services?open=${encodeURIComponent(id)}`}>
                {t('serviceHealth.access')}
              </Link>
            </li>
          </ol>
        </section>
      ) : fresh || pending > 0 ? null : (
        <section aria-labelledby="ov-next" className="stack-sm">
          <Heading level={2} data-size="xs" id="ov-next">
            {t('serviceHealth.needsYou')}
          </Heading>
          {items.length ? (
            <ul className="plain-list ov-needs">
              {items.map((n) => (
                <li key={n.key} className={`ov-need ov-need-${n.tone}`}>
                  <strong>{n.title}</strong>
                  {n.text ? <span>{n.text}</span> : null}
                  <Link href={n.link.href}>{n.link.label}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <Paragraph data-size="sm">{t('serviceHealth.nothingNeeded')}</Paragraph>
          )}
        </section>
      )}

      <section
        aria-labelledby="ov-health"
        aria-busy={usage.status === 'loading' || undefined}
        className="stack-sm"
      >
        <div className="row-wrap spread">
          <Heading level={2} data-size="xs" id="ov-health">
            {t('serviceHealth.title')}
          </Heading>
          <span className="meta">
            {runsLoading
              ? t('serviceHealth.loading', { name })
              : fresh
                ? t('serviceHealth.noRunsYet')
                : t('serviceHealth.barsNote', { days: barDays })}
          </span>
        </div>
        <div className="ov-tiles">
          <Tile
            label={t('serviceHealth.runsToday')}
            href={href('log', '?period=today')}
            loading={runsLoading}
            {...runsTile}
            bars={<Bars values={tileBars(shown.map((x) => x.runs))} tone="accent" />}
          />
          <Tile
            label={
              fresh || quietToday ? t('serviceHealth.failShareNew') : t('serviceHealth.failShare')
            }
            href={href('log', '?status=failed&period=today')}
            loading={runsLoading || failures.status === 'loading'}
            {...failTile}
            bars={<Bars values={tileBars(shown.map((x) => x.failed))} tone="danger" />}
          />
          <Tile
            label={t('serviceHealth.latency')}
            href={href('log')}
            loading={runsLoading}
            {...latencyTile}
            bars={<Bars values={tileBars(shown.map((x) => x.latency?.p50Ms ?? 0))} tone="accent" />}
          />
          <Tile
            label={t('serviceHealth.costIn', { month: monthName(today) })}
            href="#/statistics"
            loading={runsLoading}
            {...costTile}
            bars={<Bars values={tileBars(shown.map((x) => x.costMicroNok))} tone="accent" />}
          />
          <Tile
            label={t('serviceHealth.quality')}
            href={href('quality')}
            loading={quality.status === 'loading'}
            {...qualityTile}
            bars={
              <Bars values={trend ? trend.points.map(([, s]) => s) : undefined} tone="success" />
            }
          />
        </div>
      </section>

      <div className="ov-columns">
        <section aria-labelledby="ov-runs" className="stack-sm ov-runs">
          <div className="row-wrap spread">
            <Heading level={2} data-size="xs" id="ov-runs">
              {t('serviceOverview.lastRuns')}
            </Heading>
            <Link href={href('log', logPeriod)}>{t('serviceHealth.wholeLog')}</Link>
          </div>
          {recent.status === 'loading' ? (
            <div
              className="ov-run-skeleton"
              role="status"
              aria-label={t('serviceHealth.loadingRuns')}
            >
              {['100%', '60%', '100%', '70%', '55%', '100%'].map((w, i) => (
                <div key={i}>
                  <Skeleton variant="text" width={90} />
                  <Skeleton variant="text" width={w} />
                  <Skeleton variant="rectangle" width={64} height={20} />
                </div>
              ))}
            </div>
          ) : recent.status === 'error' ? (
            <Paragraph data-size="sm">{notAvailable}</Paragraph>
          ) : recentRuns.length ? (
            <div tabIndex={0} role="region" aria-labelledby="ov-runs" className="scroll-x">
              <Table data-size="sm" className="ov-run-table">
                <Table.Head>
                  <Table.Row>
                    <Table.HeaderCell scope="col">{t('serviceOverview.colTime')}</Table.HeaderCell>
                    <Table.HeaderCell scope="col">
                      {t('serviceOverview.colQuestion')}
                    </Table.HeaderCell>
                    <Table.HeaderCell scope="col">{t('serviceHealth.colChannel')}</Table.HeaderCell>
                    <Table.HeaderCell scope="col">
                      {t('serviceOverview.colStatus')}
                    </Table.HeaderCell>
                    <Table.HeaderCell scope="col" className="right">
                      {t('serviceOverview.colDuration')}
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Head>
                <Table.Body>
                  {recentRuns.map((r: TaskRow) => {
                    const s = status(r.status);
                    return (
                      <Table.Row key={r.id}>
                        <Table.Cell className="numeric">{when(r.createdAt)}</Table.Cell>
                        <Table.Cell>
                          <Link href={href('log', `/${encodeURIComponent(r.id)}`)}>
                            {r.excerpt || t('serviceOverview.openRun')}
                          </Link>
                        </Table.Cell>
                        <Table.Cell className="meta">{channelText(r, t, frontendName)}</Table.Cell>
                        <Table.Cell>
                          <Tag data-size="sm" data-color={s.color}>
                            {s.text}
                          </Tag>
                        </Table.Cell>
                        <Table.Cell className="right numeric">
                          {r.endedAt
                            ? seconds(Date.parse(r.endedAt) - Date.parse(r.createdAt))
                            : '–'}
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table>
            </div>
          ) : (
            <div className="ov-empty">
              <strong>{t('serviceHealth.noRunsTitle')}</strong>
              <span className="meta">{t('serviceHealth.noRunsText')}</span>
              <Link href={href('test')}>{t('serviceLifecycle.tryService')}</Link>
            </div>
          )}
        </section>

        <div className="ov-side">
          <SideCard
            id="ov-live"
            title={t('serviceHealth.live')}
            loading={running.status === 'loading'}
          >
            <dl className="kv ov-kv">
              <dt>{t('serviceHealth.version')}</dt>
              <dd>
                {latest
                  ? t('serviceHealth.versionPublishedBy', {
                      version: latest.version,
                      name: actor(latest.publishedBy, latest.publishedByName),
                      when:
                        startOfDay(new Date(latest.publishedAt)).getTime() ===
                        today.getTime() - dayMs
                          ? t('serviceHealth.yesterday')
                          : startOfDay(new Date(latest.publishedAt)).getTime() === today.getTime()
                            ? t('serviceHealth.today')
                            : dayMonth(latest.publishedAt),
                    })
                  : notAvailable}
              </dd>
              <dt>{t('service.sectionEnvironments')}</dt>
              <dd className="tag-row">
                {(
                  environments ??
                  (latest ? [{ name: productionEnvironment, version: latest.version }] : [])
                ).map((e) => (
                  <span key={e.name} className="ov-chip">
                    {t('serviceHealth.environmentVersion', {
                      name: e.name,
                      version: e.version ?? '',
                    })}
                  </span>
                ))}
              </dd>
              <dt>{t('serviceOverview.model')}</dt>
              <dd className="ov-model">
                <span>
                  <strong>{model?.name ?? primary}</strong>
                  {residencyKey ? (
                    <span className="meta">
                      {' '}
                      {t('serviceHealth.dataIn', { where: t(residencyKey) })}
                    </span>
                  ) : null}
                </span>
                <Link href={href('setup', '/model')}>{t('serviceHealth.changeModel')}</Link>
              </dd>
              <dt>{t('serviceOverview.sources')}</dt>
              <dd>{sources.length ? sourceLinks : t('serviceOverview.noDatasets')}</dd>
              {consent?.unmaskedInput?.length ? (
                <>
                  <dt>{t('unmaskedInput.overviewLabel')}</dt>
                  <dd>
                    <ul className="plain-list">
                      {consent.unmaskedInput.map((u) => (
                        <li key={u.mediaType}>
                          {t('unmaskedInput.overviewLine', {
                            kind: mediaKind(t, u.mediaType),
                            mediaType: u.mediaType,
                            reason: u.reason,
                          })}
                        </li>
                      ))}
                    </ul>
                    {consent.by && published ? (
                      <span className="meta">
                        {t('unmaskedInput.overviewBy', {
                          who: actor(
                            consent.by,
                            consent.by === published.publishedBy
                              ? published.publishedByName
                              : undefined,
                          ),
                          when: consent.at ? dayMonth(consent.at) : '',
                        })}
                      </span>
                    ) : null}
                  </dd>
                </>
              ) : null}
            </dl>
          </SideCard>

          <SideCard id="ov-who" title={t('serviceHealth.who')} loading={who.status === 'loading'}>
            <ul className="plain-list ov-who">
              {shared?.frontends.length ? (
                shared.frontends.map((fe, i) => {
                  const share = frontendShare(fe.id, fe.kind);
                  return (
                    <li key={fe.id}>
                      <span className="stack-xs">
                        <strong>{fe.name ?? fe.id}</strong>
                        <span className="meta">
                          {share === undefined
                            ? t('serviceHealth.frontend')
                            : t(
                                i === 0
                                  ? 'serviceHealth.frontendShareOfRuns'
                                  : 'serviceHealth.frontendShare',
                                { share: f.percent(share, 0) },
                              )}
                        </span>
                      </span>
                      <Link href={href('channels')}>{t('serviceHealth.open')}</Link>
                    </li>
                  );
                })
              ) : shared ? (
                <li>
                  <span className="stack-xs">
                    <strong>{t('serviceHealth.noFrontends')}</strong>
                    <span className="meta">{t('serviceHealth.noFrontendsText')}</span>
                  </span>
                  <Link href={href('channels')}>{t('serviceHealth.add')}</Link>
                </li>
              ) : null}
              {serviceKeys ? (
                <li>
                  <span className="stack-xs">
                    <strong>
                      {ownKeys.length
                        ? t('serviceHealth.keys', { count: ownKeys.length })
                        : t('serviceHealth.noKeys')}
                    </strong>
                    <span className="meta">
                      {ownKeys.length
                        ? ownKeys.map(keyLine).join(', ')
                        : t('serviceHealth.noKeysText')}
                    </span>
                  </span>
                  <Link href={href('channels')}>
                    {ownKeys.length ? t('serviceHealth.keysLink') : t('serviceHealth.makeKey')}
                  </Link>
                </li>
              ) : (
                <li className="meta">{notAvailable}</li>
              )}
              <li>
                <span className="stack-xs">
                  <strong>
                    {who.status === 'ready' && who.data.selected
                      ? t('serviceOverview.selectedOnly', {
                          count: who.data.selected.members.length,
                        })
                      : t('serviceHealth.everyone', { org })}
                  </strong>
                  <span className="meta">
                    {t('serviceHealth.accessText', {
                      right: rightLabel(t, 'use-services'),
                      shared: sharedText,
                    })}
                  </span>
                </span>
                <Link href={`#/access/services?open=${encodeURIComponent(id)}`}>
                  {t('serviceHealth.access')}
                </Link>
              </li>
            </ul>
          </SideCard>

          <SideCard
            id="ov-changes"
            title={t('serviceHealth.changes')}
            loading={running.status === 'loading' || draft.status === 'loading'}
            action={<Link href={href('versions')}>{t('serviceHealth.allVersions')}</Link>}
          >
            <ol className="plain-list ov-changes">
              {draft.status === 'ready' && draft.data.summary ? (
                <li data-kind="draft">
                  <strong>
                    {changeCount === undefined
                      ? t('serviceHealth.draftEntry')
                      : t('serviceHealth.draftEntryCount', { count: changeCount })}
                  </strong>
                  <span className="meta">
                    {t('serviceHealth.draftMeta', {
                      when: when(draft.data.summary.at),
                      who: actor(draft.data.summary.by, draft.data.summary.byName),
                    })}
                  </span>
                </li>
              ) : null}
              {versionsNewest.slice(0, fresh ? 1 : 2).map((v, i) => (
                <li key={v.version} data-kind={i === 0 ? 'live' : 'earlier'}>
                  <strong>{t('serviceHealth.versionEntry', { version: v.version })}</strong>
                  <span className="meta">
                    {v.reason
                      ? t('serviceHealth.versionMetaReason', {
                          when: recentDay(v.publishedAt),
                          who: actor(v.publishedBy, v.publishedByName),
                          reason: v.reason,
                        })
                      : t('serviceHealth.versionMeta', {
                          when: recentDay(v.publishedAt),
                          who: actor(v.publishedBy, v.publishedByName),
                        })}
                  </span>
                </li>
              ))}
            </ol>
          </SideCard>
        </div>
      </div>
    </div>
  );
};
