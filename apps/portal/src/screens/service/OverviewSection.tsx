import { Heading, Link, Paragraph, Skeleton, Table, Tag } from '@digdir/designsystemet-react';
import { intlLocale } from '@genai/i18n';
import type { ReactNode } from 'react';
import type { ApiClient } from '../../api';
import type { DatasetView } from '../../api/datasets';
import { productionEnvironment } from '../../api/environments';
import type { ServiceDefinition } from '../../data/service-definition';
import { datasetsOf } from '../../data/service-form';
import { mediaKind } from '../../data/unmasked-input';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import type { PlainKey } from '../../i18n';
import { rightLabel } from '../../Shell';
import type { ModelOption, PublishedDefinition, TaskRow } from '../../types';
import { actorText } from '../log/format';
import type { VersionItem } from '../services/VersionsTab';
import {
  dayMs,
  monthCost,
  qualityTrend,
  runsTrend,
  serviceDays,
  unusedDays,
} from './overview-model';
import { PausedBanner } from './PausedBanner';
import { servicePath } from './sections';
import './overview.css';

const residencyKeys: Record<string, PlainKey> = {
  norway: 'serviceOverview.residencyNorway',
  eu: 'serviceOverview.residencyEu',
  global: 'serviceOverview.residencyGlobal',
};

const unusedAfterDays = 60;
const barDays = 14;

const settled = <T,>(r: PromiseSettledResult<T>) =>
  r.status === 'fulfilled' ? r.value : undefined;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const matchDataset = (datasets: DatasetView[] | undefined, tenant: string, ref: string) =>
  datasets?.find((d) => d.fullId === ref || d.fullId === `${tenant}/${ref}` || d.id === ref);

type Tone = 'danger' | 'warning' | 'success' | 'neutral';

interface Need {
  key: string;
  tone: Tone;
  title: string;
  text: string;
  link: { href: string; label: string };
}

const Bars = ({ values, tone }: { values: number[]; tone: Tone | 'accent' }) => {
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
  const { t, f, dateTime, kroner, actor, status } = usePortalFormat();
  const today = startOfDay(now());
  const dayOfMonth = today.getDate();
  const href = (section: Parameters<typeof servicePath>[1], rest = '') =>
    `#${servicePath(id, section, rest)}`;
  const name = d.metadata.name || id;

  const [usage] = useAsync(
    async (signal) => {
      const [period, day] = await Promise.all([
        api.usage(tenant, dayOfMonth + 31, signal),
        api.usage(tenant, 1, signal),
      ]);
      return {
        days: serviceDays(period, id),
        latency: day.byService.find((s) => s.service === id)?.latency ?? null,
      };
    },
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
      const [summary, checks] = await Promise.allSettled([
        api.quality.drafts(tenant, signal),
        api.serviceTabs.draftChecks(tenant, id, signal),
      ]);
      return {
        summary: settled(summary)?.find((s) => s.id === id && s.latestVersion !== null),
        checks: settled(checks),
      };
    },
    [api, tenant, id],
  );
  const [keys] = useAsync(
    async (signal) => (await api.listServiceKeys(tenant, id, signal)).filter((k) => !k.revokedAt),
    [api, tenant, id],
  );
  const [who] = useAsync(
    async (signal) => {
      const [shared, access] = await Promise.allSettled([
        api.serviceTabs.sharedWith(tenant, id, signal),
        api.accessPeople.services(tenant, signal),
      ]);
      return {
        shared: settled(shared),
        selected: settled(access)?.find((s) => s.id === id && s.mode === 'selected'),
        accessKnown: access.status === 'fulfilled',
      };
    },
    [api, tenant, id],
  );
  const [running] = useAsync(
    async (signal) => {
      const [history, environments, datasets, models] = await Promise.allSettled([
        api.getDefinition(tenant, 'Service', id, signal),
        api.environments.list(tenant, id, signal),
        api.datasets.list(tenant, signal),
        api.listModels({}, signal),
      ]);
      return {
        history: settled(history),
        environments: settled(environments)?.environments,
        datasets: settled(datasets),
        models: settled(models),
      };
    },
    [api, tenant, id],
  );

  const days = usage.status === 'ready' ? usage.data.days : [];
  const shown = days.slice(-barDays);
  const dayToday = days.at(-1);
  const recentRuns =
    recent.status === 'ready' ? (recent.data.data ?? []).filter((r) => r.service === id) : [];
  const fresh = recent.status === 'ready' && recent.data.total === 0;
  const failed = failures.status === 'ready' ? failures.data : undefined;
  const topCause = failed?.causes[0];
  const notAvailable = t('serviceOverview.notAvailable');

  const when = (iso: string) => {
    const day = startOfDay(new Date(iso)).getTime();
    if (day === today.getTime()) return t('serviceOverview.todayAt', { time: f.time(iso) });
    if (day === today.getTime() - dayMs)
      return t('serviceOverview.yesterdayAt', { time: f.time(iso) });
    return dateTime(iso);
  };
  const percentChange = (change: number | undefined) =>
    change === undefined ? undefined : `${change >= 0 ? '+' : ''}${f.percent(change, 0)}`;
  const seconds = (ms: number) =>
    t('common.seconds', { value: f.number(ms / 1000, { maximumFractionDigits: 1 }) });

  const runsTile = (() => {
    if (usage.status === 'error') return { value: notAvailable, sub: '' };
    if (fresh) return { value: f.number(0), sub: t('serviceHealth.noRunsYet') };
    const change = percentChange(runsTrend(days));
    return {
      value: f.number(dayToday?.runs ?? 0),
      sub: change ? t('serviceHealth.runsTrend', { change }) : t('serviceHealth.runsToday'),
    };
  })();

  const failTile = (() => {
    if (usage.status === 'error') return { value: notAvailable, sub: '', tone: 'neutral' as Tone };
    const runs = dayToday?.runs ?? 0;
    const count = dayToday?.failed ?? 0;
    if (runs === 0)
      return {
        value: t('serviceHealth.noData'),
        sub: t('serviceHealth.comesWithRuns'),
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

  const latency = usage.status === 'ready' ? usage.data.latency : null;
  const latencyTile =
    usage.status === 'error'
      ? { value: notAvailable, sub: '' }
      : latency
        ? {
            value: seconds(latency.p50Ms),
            sub: t('serviceHealth.latencySub', { p95: seconds(latency.p95Ms) }),
          }
        : { value: t('serviceHealth.noData'), sub: t('serviceHealth.comesWithRuns') };

  const month = monthCost(days);
  const monthName = new Intl.DateTimeFormat(intlLocale(f.locale), {
    month: 'long',
    timeZone: 'Europe/Oslo',
  }).format(today);
  const costTile =
    usage.status === 'error' || !month
      ? { value: notAvailable, sub: '' }
      : {
          value: month.priced
            ? kroner(month.spent)
            : t('serviceOverview.costAtLeast', { cost: kroner(month.spent) }),
          sub:
            month.change === undefined
              ? t('serviceHealth.costForecast', { forecast: kroner(month.forecast) })
              : t('serviceHealth.costTrend', {
                  change: percentChange(month.change) ?? '',
                  forecast: kroner(month.forecast),
                }),
        };

  const trend = quality.status === 'ready' ? quality.data.trend : undefined;
  const qualityTile =
    quality.status === 'error'
      ? { value: notAvailable, sub: '', tone: 'neutral' as Tone }
      : !trend
        ? {
            value: t('serviceHealth.notMeasured'),
            sub: t('serviceHealth.makeTestSet'),
            tone: 'warning' as Tone,
          }
        : {
            value: f.percent(trend.latest.score ?? 0, 0),
            sub: [
              t('serviceHealth.qualitySet', {
                set: trend.set?.name ?? trend.latest.testSet,
                version:
                  typeof trend.latest.version === 'number'
                    ? t('serviceHealth.versionN', { n: trend.latest.version })
                    : t('serviceHealth.draft'),
              }),
              trend.previous && typeof trend.previous.version === 'number'
                ? t('serviceHealth.qualityFrom', {
                    score: f.percent(trend.previous.score ?? 0, 0),
                    version: trend.previous.version,
                  })
                : '',
            ]
              .filter(Boolean)
              .join(' '),
            tone: ((trend.latest.score ?? 0) >= (trend.previous?.score ?? 0)
              ? 'success'
              : 'warning') as Tone,
          };

  const testedAt = (() => {
    if (quality.status !== 'ready') return undefined;
    const tests = quality.data.runs
      .filter((r) => r.version === 'draft' && r.endedAt)
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
    return tests[0]?.endedAt ?? undefined;
  })();

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
      const changed = draft.data.summary.at;
      const stale = !testedAt || testedAt < changed;
      const stopped = draft.data.checks?.problems.some((p) => p.path.startsWith('spec.evaluation'));
      if (stale || stopped)
        items.push({
          key: 'draft',
          tone: 'warning',
          title: testedAt
            ? t('serviceHealth.needDraftChanged')
            : t('serviceHealth.needDraftUntested'),
          text: [
            testedAt
              ? t('serviceHealth.testedChanged', { tested: when(testedAt), changed: when(changed) })
              : t('serviceHealth.changedAt', { changed: when(changed) }),
            stopped ? t('serviceHealth.gateStops') : '',
          ]
            .filter(Boolean)
            .join(' '),
          link: { href: href('quality'), label: t('serviceHealth.testDraft') },
        });
    }
    if (keys.status === 'loading') pending += 1;
    else if (keys.status === 'ready') {
      const idle = keys.data
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
  const residency = known ? (model?.residency ?? d.spec.model.residency) : undefined;
  const residencyKey = residency ? residencyKeys[residency] : undefined;
  const sources = datasetsOf(d.spec);
  const consent = (published?.definition as ServiceDefinition | undefined)?.spec?.riskConfirmation;

  const shared = who.status === 'ready' ? who.data.shared : undefined;
  const sharedText =
    !shared || (Array.isArray(shared.tenants) && shared.tenants.length === 0)
      ? t('serviceHealth.notShared')
      : shared.tenants === '*'
        ? t('serviceHealth.sharedAll')
        : t('serviceHealth.sharedWith', { count: shared.tenants.length });

  const versionsNewest = history ? [...history.versions].reverse() : [];
  const firstVersion = versionsNewest.at(-1);
  const sets = quality.status === 'ready' ? quality.data.sets.length : 0;
  const stepState = (done: boolean) => (
    <span className="visually-hidden">
      {done ? t('serviceHealth.stepDone') : t('serviceHealth.stepOpen')}
    </span>
  );
  const reachable = (shared?.frontends.length ?? 0) + (shared?.apiKeys.length ?? 0);

  return (
    <div className="service-overview stack">
      <PausedBanner
        api={api}
        tenant={tenant}
        id={id}
        name={name}
        published={published}
        datasets={sources.flatMap((ref) => {
          const found = matchDataset(known?.datasets, tenant, ref.dataset);
          return found ? [found] : [];
        })}
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
            <li className="ov-step" data-done="true">
              {stepState(true)}
              <strong>{t('serviceHealth.stepPublished')}</strong>
              <span className="meta">
                {t('serviceHealth.stepPublishedBy', {
                  when: when(latest.publishedAt),
                  who: actor(latest.publishedBy, latest.publishedByName),
                })}
              </span>
            </li>
            <li className="ov-step" data-done={sets > 0 || undefined}>
              {stepState(sets > 0)}
              <strong>{t('serviceHealth.stepTestSet')}</strong>
              <span className="meta">{t('serviceHealth.stepTestSetText')}</span>
              <Link href={href('quality')}>{t('serviceHealth.stepTestSetLink')}</Link>
            </li>
            <li className="ov-step" data-done={reachable > 0 || undefined}>
              {stepState(reachable > 0)}
              <strong>{t('serviceHealth.stepReach')}</strong>
              <span className="meta">{t('serviceHealth.stepReachText')}</span>
              <Link href={href('channels')}>{t('service.sectionChannels')}</Link>
            </li>
            <li className="ov-step">
              {stepState(false)}
              <strong>{t('serviceHealth.stepAccess')}</strong>
              <span className="meta">
                {t('serviceHealth.stepAccessText', {
                  org: tenantName || tenant,
                  right: rightLabel(t, 'use-services'),
                })}
              </span>
              <Link href={`#/access/services?open=${encodeURIComponent(id)}`}>
                {t('serviceHealth.access')}
              </Link>
            </li>
          </ol>
        </section>
      ) : fresh ? null : (
        <section
          aria-labelledby="ov-next"
          aria-busy={pending > 0 || undefined}
          className="stack-sm"
        >
          <Heading level={2} data-size="xs" id="ov-next">
            {t('serviceOverview.needsYou')}
          </Heading>
          {items.length || pending ? (
            <ul className="plain-list ov-needs">
              {items.map((n) => (
                <li key={n.key} className={`ov-need ov-need-${n.tone}`}>
                  <strong>{n.title}</strong>
                  {n.text ? <span>{n.text}</span> : null}
                  <Link href={n.link.href}>{n.link.label}</Link>
                </li>
              ))}
              {Array.from({ length: pending }, (_, i) => (
                <li key={`pending-${i}`} className="ov-need">
                  <Skeleton variant="text" width="70%" />
                  <Skeleton variant="text" width="90%" />
                  <Skeleton variant="text" width="40%" />
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
            {usage.status === 'loading'
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
            loading={usage.status === 'loading' || recent.status === 'loading'}
            {...runsTile}
            bars={<Bars values={shown.map((x) => x.runs)} tone="accent" />}
          />
          <Tile
            label={t('serviceHealth.failShare')}
            href={href('log', '?status=failed&period=today')}
            loading={usage.status === 'loading' || failures.status === 'loading'}
            {...failTile}
            bars={<Bars values={shown.map((x) => x.failed)} tone="danger" />}
          />
          <Tile
            label={t('serviceHealth.latency')}
            href={href('log')}
            loading={usage.status === 'loading'}
            {...latencyTile}
          />
          <Tile
            label={t('serviceHealth.costIn', { month: monthName })}
            href="#/statistics"
            loading={usage.status === 'loading'}
            {...costTile}
            bars={<Bars values={shown.map((x) => x.costMicroNok)} tone="accent" />}
          />
          <Tile
            label={t('serviceHealth.quality')}
            href={href('quality')}
            loading={quality.status === 'loading'}
            {...qualityTile}
            bars={trend ? <Bars values={trend.points.map(([, s]) => s)} tone="success" /> : null}
          />
        </div>
      </section>

      <div className="ov-columns">
        <section aria-labelledby="ov-runs" className="stack-sm">
          <div className="row-wrap spread">
            <Heading level={2} data-size="xs" id="ov-runs">
              {t('serviceOverview.lastRuns')}
            </Heading>
            <Link href={href('log')}>{t('serviceHealth.wholeLog')}</Link>
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
              <Table data-size="sm">
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
                        <Table.Cell className="nowrap">{when(r.createdAt)}</Table.Cell>
                        <Table.Cell>
                          <Link href={href('log', `/${encodeURIComponent(r.id)}`)}>
                            {r.excerpt || t('serviceOverview.openRun')}
                          </Link>
                        </Table.Cell>
                        <Table.Cell className="meta nowrap">{actorText(r.actor, t)}</Table.Cell>
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
                  ? t('serviceHealth.versionPublished', {
                      version: latest.version,
                      when: when(latest.publishedAt),
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
              <dd>
                <strong>{model?.name ?? primary}</strong>
                {residencyKey ? (
                  <span className="meta">
                    {' '}
                    {t('serviceHealth.dataIn', { where: t(residencyKey) })}
                  </span>
                ) : null}{' '}
                <Link href={href('setup', '/model')}>{t('serviceHealth.changeModel')}</Link>
              </dd>
              <dt>{t('serviceOverview.sources')}</dt>
              <dd>
                {sources.length
                  ? sources.map((ref, i) => {
                      const found = matchDataset(known?.datasets, tenant, ref.dataset);
                      return (
                        <span key={ref.dataset}>
                          {i > 0 ? ', ' : ''}
                          {found ? (
                            <Link href={`#/datasets/${encodeURIComponent(found.id)}`}>
                              {found.name}
                            </Link>
                          ) : (
                            ref.dataset
                          )}
                        </span>
                      );
                    })
                  : t('serviceOverview.noDatasets')}
              </dd>
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
                          when: consent.at ? dateTime(consent.at) : '',
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
                shared.frontends.map((fe) => (
                  <li key={fe.id}>
                    <span className="stack-xs">
                      <strong>{fe.name ?? fe.id}</strong>
                      <span className="meta">{t('serviceHealth.frontend')}</span>
                    </span>
                    <Link href={href('channels')}>{t('serviceHealth.open')}</Link>
                  </li>
                ))
              ) : shared ? (
                <li>
                  <span className="stack-xs">
                    <strong>{t('serviceHealth.noFrontends')}</strong>
                    <span className="meta">{t('serviceHealth.noFrontendsText')}</span>
                  </span>
                  <Link href={href('channels')}>{t('serviceHealth.add')}</Link>
                </li>
              ) : null}
              {shared ? (
                <li>
                  <span className="stack-xs">
                    <strong>
                      {shared.apiKeys.length
                        ? t('serviceHealth.keys', { count: shared.apiKeys.length })
                        : t('serviceHealth.noKeys')}
                    </strong>
                    <span className="meta">
                      {shared.apiKeys.length
                        ? shared.apiKeys.map((k) => k.name).join(', ')
                        : t('serviceHealth.noKeysText')}
                    </span>
                  </span>
                  <Link href={href('channels')}>
                    {shared.apiKeys.length
                      ? t('serviceHealth.keysLink')
                      : t('serviceHealth.makeKey')}
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
                      : t('serviceHealth.everyone', { org: tenantName || tenant })}
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
                  <strong>{t('serviceHealth.draftEntry')}</strong>
                  <span className="meta">
                    {t('serviceHealth.draftMeta', {
                      when: when(draft.data.summary.at),
                      who: actor(draft.data.summary.by, draft.data.summary.byName),
                    })}
                  </span>
                </li>
              ) : null}
              {versionsNewest.slice(0, firstVersion && fresh ? 1 : 2).map((v, i) => (
                <li key={v.version} data-kind={i === 0 ? 'live' : 'earlier'}>
                  <strong>{t('serviceHealth.versionEntry', { version: v.version })}</strong>
                  <span className="meta">
                    {v.reason
                      ? t('serviceHealth.versionMetaReason', {
                          when: when(v.publishedAt),
                          who: actor(v.publishedBy, v.publishedByName),
                          reason: v.reason,
                        })
                      : t('serviceHealth.versionMeta', {
                          when: when(v.publishedAt),
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
