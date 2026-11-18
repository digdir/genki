import { daysThisMonth, failedRunsRequest } from '../usage-window';
import { PlusIcon } from '@navikt/aksel-icons';
import {
  Alert,
  Button,
  Heading,
  Paragraph,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiClient } from '../api';
import { isOpen, type DatasetView } from '../api/datasets';
import { Icon } from '../components/Icon';
import { isTrialService } from '../format';
import { listedServiceCount } from '../listed-services';
import { useT, type Format, type T } from '../i18n';
import { useAsync, type AsyncState } from '../hooks';
import type { ScreenProps } from '../screen';
import { useRights } from '../Shell';
import { failureText } from './datasets/live-model';
import { datasetTabPath } from './datasets/model';
import { ErrorState, limitOf, refusalOf } from '../states';
import type { ModelOption, Overview as OverviewData, TaskRow, UsageReport } from '../types';
import { LiveChanges } from './changes/LiveChanges';
import { allDone, doneCount, ownDataset, startProgress, StartSteps } from './start-progress';
import { modelLabel } from '../models';
import {
  costText,
  isLowerBound,
  monthStatus,
  monthUsage,
  quotaOf,
  tokensOf,
  withPricing,
  withTrialRows,
} from './usage/model';
import { quotaFacts } from './quota/model';
import { QuotaRequestAction } from './quota/QuotaRequest';
import './overview.css';

const pollMs = 5000;

const millions = (f: Format, n: number) => f.number(n / 1_000_000, { maximumFractionDigits: 1 });

const failedRecently = (d: DatasetView) =>
  d.state === 'degraded' ||
  d.lastExecution?.status === 'failed' ||
  d.lastExecution?.status === 'cancelled';

const isRunning = (d: DatasetView) => d.state === 'running' || isOpen(d.lastExecution);

export const monthLabel = (f: Format, date: Date) => f.month(date, { year: true });

export const startOfDay = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface FailedToday {
  id: string;
  name: string;
  count: number;
  reason?: string;
}

export interface FailedRuns {
  today: FailedToday[];
  week: Map<string, number>;
  complete: boolean;
}

export const countFailedRuns = (rows: TaskRow[], total: number, now: Date): FailedRuns => {
  const since = startOfDay(now).getTime();
  const today = new Map<string, FailedToday>();
  const reasons = new Map<string, Map<string, number>>();
  const week = new Map<string, number>();
  for (const row of rows) {
    if (isTrialService(row.service)) continue;
    week.set(row.service, (week.get(row.service) ?? 0) + 1);
    if (Date.parse(row.createdAt) < since) continue;
    const entry = today.get(row.service) ?? {
      id: row.service,
      name: row.serviceName ?? row.service,
      count: 0,
    };
    entry.count += 1;
    today.set(row.service, entry);
    const reason = row.failure?.reason;
    if (!reason) continue;
    const counts = reasons.get(row.service) ?? new Map<string, number>();
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    reasons.set(row.service, counts);
  }
  for (const [service, counts] of reasons) {
    const entry = today.get(service);
    const [reason] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (entry && reason) entry.reason = reason;
  }
  return {
    today: [...today.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    week,
    complete: rows.length >= total,
  };
};

export const failedRunsToday = (service: string, now: Date) =>
  `#/log/runs?status=failed&service=${encodeURIComponent(service)}&date=${localDate(now)}`;

const partlyRead = (d: DatasetView) =>
  d.lastExecution !== null &&
  !failedRecently(d) &&
  !isRunning(d) &&
  d.lastExecution.status !== 'cancelled' &&
  (d.lastExecution.skipped ?? 0) > 0;

type Started = Record<string, 'starting' | 'started' | { error: string }>;

interface Item {
  key: string;
  badge: string;
  color: 'danger' | 'warning' | 'info' | 'success' | 'neutral';
  text: ReactNode;
  action?: ReactNode;
  alert?: boolean;
}

const startError = (t: T, error: unknown) =>
  t('overview.ingestStartFailed', {
    reason: refusalOf(error, t) ?? failureText(t, error),
  });

const useIngestRetry = (api: ApiClient, tenant: string, onStarted: () => void) => {
  const t = useT();
  const [started, setStarted] = useState<Started>({});
  const retry = async (d: DatasetView) => {
    setStarted((s) => ({ ...s, [d.fullId]: 'starting' }));
    try {
      const pipeline = (await api.datasets.pipelines(tenant, d.id))[0];
      if (!pipeline) {
        setStarted((s) => ({ ...s, [d.fullId]: { error: t('overview.ingestNoPipeline') } }));
        return;
      }
      await api.datasets.execute(tenant, d.id, pipeline.id, 'Ny innlesing fra Oversikt');
      setStarted((s) => ({ ...s, [d.fullId]: 'started' }));
      onStarted();
    } catch (error) {
      setStarted((s) => ({ ...s, [d.fullId]: { error: startError(t, error) } }));
    }
  };
  return { started, retry };
};

const UsageCard = ({
  state,
  retry,
  quota,
  month,
  models,
}: {
  state: AsyncState<UsageReport>;
  retry: () => void;
  quota: number | null;
  month: string;
  models: ModelOption[];
}) => {
  const t = useT();
  return (
    <section aria-labelledby="usage-h" className="stack-sm overview-usage">
      <Heading level={2} data-size="xs" id="usage-h">
        {t('overview.usageHeading', { month })}
      </Heading>
      {state.status === 'loading' ? (
        <div role="status" className="stack-sm">
          <Skeleton variant="text" width="60%" height={32} />
          <Skeleton width="100%" height={8} />
          <span className="visually-hidden">{t('overview.loadingUsage')}</span>
        </div>
      ) : null}
      {state.status === 'error' && (refusalOf(state.error) || limitOf(state.error)) ? (
        <ErrorState error={state.error} headingLevel={3} />
      ) : null}
      {state.status === 'error' && !refusalOf(state.error) && !limitOf(state.error) ? (
        <Alert data-color="danger">
          <Paragraph>{t('overview.usageFailed')}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={retry}>
            {t('common.tryAgain')}
          </Button>
        </Alert>
      ) : null}
      {state.status === 'ready' ? (
        <UsageFigures report={state.data} quota={quota} models={models} />
      ) : null}
    </section>
  );
};

const UsageFigures = ({
  report,
  quota,
  models,
}: {
  report: UsageReport;
  quota: number | null;
  models: ModelOption[];
}) => {
  const t = useT();
  const f = useFormat();
  const usage = monthUsage(report);
  const missing = report.totals.unpricedModels ?? [];
  const used = tokensOf(usage.total);
  const pct = quota === null ? 0 : Math.round((used / quota) * 100);
  const parts = [
    { key: 'services', label: t('overview.partServices'), tokens: tokensOf(usage.services) },
    { key: 'trial', label: t('overview.partTrial'), tokens: tokensOf(usage.trial) },
    { key: 'ingestion', label: t('usageParts.ingestion'), tokens: tokensOf(usage.ingestion) },
    { key: 'outside', label: t('overview.partOutside'), tokens: tokensOf(usage.gateway) },
  ].filter((p) => (p.key !== 'outside' && p.key !== 'ingestion') || p.tokens > 0);
  return (
    <>
      <p className="usage-figure">
        <span className="usage-used numeric">
          {t('overview.millions', { value: millions(f, used) })}
        </span>{' '}
        <span className="meta-lg">
          {quota === null
            ? t('overview.quotaUnknown')
            : t('overview.ofQuota', { value: millions(f, quota) })}
        </span>
      </p>
      {quota === null ? null : (
        <div
          role="progressbar"
          aria-label={t('overview.quotaBar')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(pct, 100)}
          aria-valuetext={t('overview.percentUsed', { pct })}
          className="quota-bar"
        >
          <div
            className={
              pct >= 100 ? 'quota-fill full' : pct >= 80 ? 'quota-fill high' : 'quota-fill'
            }
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      )}
      <dl className="usage-parts">
        {parts.map((p) => (
          <div key={p.key}>
            <dt>{p.label}</dt>
            <dd className="numeric">{t('overview.millions', { value: millions(f, p.tokens) })}</dd>
          </div>
        ))}
      </dl>
      <dl className="usage-facts">
        <div>
          <dt>{t('overview.cost')}</dt>
          <dd className="numeric">{costText(f, t, usage.total)}</dd>
        </div>
        <div>
          <dt>{t('overview.runs')}</dt>
          <dd className="numeric">{f.number(usage.runs)}</dd>
        </div>
      </dl>
      {isLowerBound(usage.total) ? (
        <p className="meta">
          {missing.length > 0
            ? t('overview.priceMissing', {
                count: missing.length,
                models: f.list(missing.map((id) => modelLabel(id, models))),
              })
            : t('overview.priceMissingUnnamed')}
        </p>
      ) : null}
      <a href="#/statistics">{t('overview.seeUsagePerService')}</a>
    </>
  );
};

const AttentionChecking = ({ label }: { label: string }) => (
  <div role="status" aria-label={label} className="attention-list">
    {['70%', '55%'].map((width) => (
      <div key={width} className="attention-row">
        <Skeleton variant="text" width={width} />
      </div>
    ))}
  </div>
);

const OverviewSkeleton = ({ label }: { label: string }) => {
  const t = useT();
  return (
    <div role="status" aria-label={label} className="stack">
      <section className="stack-sm">
        <Heading level={2} data-size="sm">
          {t('overview.attention')}
        </Heading>
        <AttentionChecking label={t('overview.checking')} />
      </section>
      <div className="overview-grid">
        <div className="stack-sm overview-top">
          <Skeleton variant="text" width="40%" height={28} />
          {[0, 1, 2, 3, 4].map((row) => (
            <Skeleton key={row} variant="text" width="100%" height={36} />
          ))}
        </div>
        <div className="stack-sm overview-aside">
          <Skeleton variant="text" width="60%" height={28} />
          <Skeleton variant="text" width="60%" height={32} />
          <Skeleton width="100%" height={8} />
        </div>
      </div>
    </div>
  );
};

const AttentionList = ({
  items,
  checking,
  checkedAt,
}: {
  items: Item[];
  checking: boolean;
  checkedAt: Date | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  return (
    <section aria-labelledby="attention-h" className="stack-sm">
      <Heading level={2} data-size="sm" id="attention-h">
        {t('overview.attention')}
      </Heading>
      {items.length > 0 ? (
        <ul className="plain-list attention-list" aria-live="polite">
          {items.map((item) => (
            <li key={item.key} className="attention-row" role={item.alert ? 'alert' : undefined}>
              <Tag data-size="sm" data-color={item.color}>
                {item.badge}
              </Tag>
              <span className="attention-text">{item.text}</span>
              {item.action ? <span className="attention-action">{item.action}</span> : null}
            </li>
          ))}
        </ul>
      ) : checking ? (
        <AttentionChecking label={t('overview.checking')} />
      ) : (
        <p className="attention-none">
          {t('overview.nothing', { time: checkedAt ? f.time(checkedAt) : '' })}
        </p>
      )}
    </section>
  );
};

const TopServices = ({
  services,
  failed,
  listed,
}: {
  services: OverviewData['services'];
  failed: FailedRuns | undefined;
  listed: number | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  const top = [...services]
    .sort((a, b) => (b.runsThisWeek ?? 0) - (a.runsThisWeek ?? 0))
    .slice(0, 5);
  const failedCell = (id: string) => {
    if (!failed) return '';
    const count = failed.week.get(id) ?? 0;
    return failed.complete || count === 0
      ? f.number(count)
      : t('overview.atLeast', { value: f.number(count) });
  };
  return (
    <section aria-labelledby="top-h" className="stack-sm overview-top">
      <div className="row-between">
        <Heading level={2} data-size="sm" id="top-h">
          {t('overview.topServices')}
        </Heading>
        <a href="#/services">
          {listed === undefined
            ? t('overview.allServicesPlain')
            : t('overview.allServices', { count: listed })}
        </a>
      </div>
      <div className="overview-table-wrap">
        <Table className="overview-table">
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">{t('overview.colService')}</TableHeaderCell>
              <TableHeaderCell scope="col" className="num">
                {t('overview.colRuns')}
              </TableHeaderCell>
              <TableHeaderCell scope="col" className="num">
                {t('overview.colFailed')}
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {top.map((s) => {
              const failures = failed?.week.get(s.id) ?? 0;
              return (
                <TableRow key={s.id}>
                  <TableCell>
                    <span className="tag-row">
                      <a href={`#/services/${encodeURIComponent(s.id)}`}>{s.name}</a>
                      {s.latestVersion === null ? (
                        <Tag data-size="sm" data-color="neutral">
                          {t('serviceList.statusDraft')}
                        </Tag>
                      ) : s.status === 'paused' ? (
                        <Tag data-size="sm" data-color="warning">
                          {t('overview.tagPaused')}
                        </Tag>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="num numeric">
                    {s.runsThisWeek === undefined ? '' : f.number(s.runsThisWeek)}
                  </TableCell>
                  <TableCell className={failures > 0 ? 'num numeric has-failures' : 'num numeric'}>
                    {failedCell(s.id)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
};

export const Overview = ({
  api,
  tenant,
  tenantName,
  onFailingIngests,
}: ScreenProps & { onFailingIngests?: (count: number) => void }) => {
  const t = useT();
  const f = useFormat();
  const rights = useRights();
  const now = useMemo(() => new Date(), []);
  const month = monthLabel(f, now);
  const [overview, retryOverview] = useAsync(
    (signal) => api.overview(tenant, signal),
    [api, tenant],
  );
  const [usage, retryUsage] = useAsync(
    async (signal) =>
      withTrialRows(withPricing(await api.usage(tenant, daysThisMonth(now), signal))),
    [api, tenant, now],
    { keepPreviousFor: tenant },
  );
  const [settings] = useAsync(
    (signal) => api.tenantEffectiveSettings(tenant, signal),
    [api, tenant],
  );
  const unpricedModels =
    usage.status === 'ready' ? (usage.data.totals.unpricedModels?.length ?? 0) > 0 : false;
  const [models] = useAsync(
    async (signal) => (unpricedModels ? api.listModels({}, signal) : []),
    [api, unpricedModels],
  );
  const [datasets, retryDatasets] = useAsync(
    (signal) => api.datasets.list(tenant, signal),
    [api, tenant],
    { keepPreviousFor: tenant },
  );
  const { started, retry } = useIngestRetry(api, tenant, retryDatasets);
  const hasServices = overview.status === 'ready' && overview.data.services.length > 0;
  const [failedRuns, retryFailedRuns] = useAsync(
    async (signal) => {
      if (!hasServices) return undefined;
      const result = await api.tasks(tenant, failedRunsRequest(now), signal);
      return countFailedRuns(result.data, result.total, now);
    },
    [api, tenant, now, hasServices],
  );
  const failed = failedRuns.status === 'ready' ? failedRuns.data : undefined;
  const [listed] = useAsync(
    async (signal) => {
      const [all, drafts] = await Promise.all([
        api.services(tenant, signal),
        api.quality.drafts(tenant, signal),
      ]);
      return listedServiceCount(all.data, drafts);
    },
    [api, tenant],
  );
  const quota = settings.status === 'ready' ? quotaOf(settings.data) : null;

  const own = datasets.status === 'ready' ? datasets.data.filter(ownDataset(tenant)) : [];
  const watched = own.filter((d) => started[d.fullId] !== undefined || failedRecently(d));
  const anyRunning = watched.some((d) => started[d.fullId] === 'started' && isRunning(d));
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(retryDatasets, pollMs);
    return () => clearInterval(timer);
  }, [anyRunning, retryDatasets]);
  const failing = own.filter((d) => failedRecently(d) && !isRunning(d)).length;
  useEffect(() => {
    onFailingIngests?.(failing);
  }, [onFailingIngests, failing]);

  const checkedAt = useMemo(
    () => (datasets.status === 'ready' || usage.status === 'ready' ? new Date() : undefined),
    [datasets, usage],
  );

  const header = (canCreate: boolean) => (
    <div className="page-head">
      <div className="stack-xs">
        <Heading level={1} data-size="lg">
          {t('overview.title')}
        </Heading>
        <p className="lead">{t('overview.lead', { name: tenantName, month })}</p>
      </div>
      {canCreate ? (
        <a className="ds-button" data-variant="primary" href="#/services/new">
          <Icon icon={PlusIcon} />
          {t('overview.newService')}
        </a>
      ) : null}
    </div>
  );
  const canCreate = rights.has('manage-services');

  if (overview.status === 'loading')
    return (
      <div className="stack overview">
        {header(canCreate)}
        <OverviewSkeleton label={t('overview.loading')} />
      </div>
    );
  if (overview.status === 'error')
    return (
      <div className="stack overview">
        {header(canCreate)}
        <ErrorState error={overview.error} onRetry={retryOverview} />
      </div>
    );

  const services = overview.data.services;
  const report = usage.status === 'ready' ? usage.data : undefined;
  const progress =
    datasets.status === 'ready'
      ? startProgress(tenant, {
          datasets: datasets.data,
          services,
          trialTokens: report ? tokensOf(monthUsage(report).trial) : 0,
        })
      : undefined;
  const showStart = services.length === 0 || (progress !== undefined && !allDone(progress));

  const names = new Map(services.map((s) => [s.id, s.name]));
  const items: Item[] = [];
  if (datasets.status === 'error')
    items.push({
      key: 'datasets',
      badge: t('overview.badgeUnknown'),
      color: 'neutral',
      alert: true,
      text: t('overview.datasetsUnknown'),
      action: (
        <Button variant="tertiary" data-size="sm" onClick={retryDatasets}>
          {t('overview.retryCheck')}
        </Button>
      ),
    });
  for (const d of watched) {
    const state = started[d.fullId];
    const running = isRunning(d);
    const name = <a href={`#/datasets/${encodeURIComponent(d.id)}`}>{d.name}</a>;
    const when = d.lastExecution ? f.dateTime(d.lastExecution.startedAt) : '';
    const canRetry = rights.has('manage-datasets') && d.editable !== false;
    if (state === 'starting' || (state === 'started' && running) || running) {
      items.push({
        key: d.fullId,
        badge: t('overview.badgeRunning'),
        color: 'info',
        text: (
          <>
            {name} {t('overview.ingestRunning')}
          </>
        ),
      });
      continue;
    }
    if (state === 'started' && !failedRecently(d)) {
      items.push({
        key: d.fullId,
        badge: t('overview.badgeReady'),
        color: 'success',
        text: (
          <>
            {name} {t('overview.ingestReady')}
          </>
        ),
        action: <a href={`#/datasets/${encodeURIComponent(d.id)}`}>{t('overview.seeIngestion')}</a>,
      });
      continue;
    }
    const cancelled = d.state !== 'degraded' && d.lastExecution?.status === 'cancelled';
    const error = typeof state === 'object' ? state.error : undefined;
    items.push({
      key: d.fullId,
      badge: t(cancelled ? 'overview.badgeCancelled' : 'overview.badgeFailed'),
      color: cancelled ? 'warning' : 'danger',
      text: (
        <>
          {name} {t(cancelled ? 'overview.ingestCancelled' : 'overview.ingestFailed', { when })}
          {error ? <span className="attention-error">{error}</span> : null}
        </>
      ),
      action: canRetry ? (
        <Button
          variant="tertiary"
          data-size="sm"
          aria-label={t('overview.ingestRetryFor', { name: d.name })}
          onClick={() => void retry(d)}
        >
          {t('overview.ingestRetry')}
        </Button>
      ) : (
        <a href={`#/datasets/${encodeURIComponent(d.id)}`}>{t('overview.seeDataset')}</a>
      ),
    });
  }
  if (failedRuns.status === 'error')
    items.push({
      key: 'runs-unknown',
      badge: t('overview.badgeUnknown'),
      color: 'neutral',
      alert: true,
      text: t('overview.runsUnknown'),
      action: (
        <Button variant="tertiary" data-size="sm" onClick={retryFailedRuns}>
          {t('overview.retryCheck')}
        </Button>
      ),
    });
  for (const run of failed?.today ?? []) {
    const name = names.get(run.id) ?? run.name;
    items.push({
      key: `runs-${run.id}`,
      badge: t('overview.badgeErrorsToday'),
      color: 'danger',
      text: (
        <>
          <a href={`#/services/${encodeURIComponent(run.id)}`}>{name}</a>
          {t('overview.failedToday', { count: run.count })}
          {run.reason ? ` ${run.reason}` : null}
        </>
      ),
      action: (
        <a
          href={failedRunsToday(run.id, now)}
          aria-label={t('overview.seeRunsFor', { service: name })}
        >
          {t('overview.seeRuns')}
        </a>
      ),
    });
  }
  for (const d of own.filter(partlyRead)) {
    const last = d.lastExecution;
    if (!last) continue;
    items.push({
      key: `partial-${d.fullId}`,
      badge: t('overview.badgePartial'),
      color: 'warning',
      text: (
        <>
          <a href={`#/datasets/${encodeURIComponent(d.id)}`}>{d.name}</a>
          {t('overview.partialText', {
            count: last.stored ?? 0,
            skipped: f.number(last.skipped ?? 0),
            total: f.number((last.stored ?? 0) + (last.skipped ?? 0)),
          })}
        </>
      ),
      action: (
        <a
          href={`#${datasetTabPath(d.id, 'ingestions')}`}
          aria-label={t('overview.seeFilesFor', { name: d.name })}
        >
          {t('overview.seeFiles')}
        </a>
      ),
    });
  }
  if (usage.status === 'error' && !refusalOf(usage.error))
    items.push({
      key: 'quota-unknown',
      badge: t('overview.badgeUnknown'),
      color: 'neutral',
      alert: true,
      text: t('overview.quotaUnknownCheck'),
      action: (
        <Button variant="tertiary" data-size="sm" onClick={retryUsage}>
          {t('overview.retryCheck')}
        </Button>
      ),
    });
  const facts = report ? quotaFacts(report, quota, tokensOf(monthUsage(report).total)) : undefined;
  if (report && facts?.alert) {
    const { pct } = facts;
    const next = f.month(new Date(now.getFullYear(), now.getMonth() + 1, 1));
    const forecast = monthStatus(report, facts.quota, null, f, t).forecast;
    const values = {
      used: millions(f, facts.used),
      quota: millions(f, facts.quota),
      month: f.month(now),
      next,
    };
    items.push({
      key: 'quota',
      badge: t('overview.badgeQuota', { pct }),
      color: pct >= 100 ? 'danger' : 'warning',
      text:
        pct >= 100
          ? t('overview.quotaUsedUp', values)
          : t('quotaRequest.overviewText', { ...values, forecast: millions(f, forecast) }),
      action: (
        <QuotaRequestAction
          api={api}
          tenant={tenant}
          facts={facts}
          forecast={forecast}
          month={f.month(now)}
          canRequest={rights.has('manage-services')}
          fallback={<a href="#/statistics">{t('overview.seeUsagePerService')}</a>}
        />
      ),
    });
  }
  for (const w of overview.data.qualityWarnings)
    items.push({
      key: `quality-${w.service}-${w.message}`,
      badge: t('overview.badgeQuality'),
      color: 'warning',
      text: t('overview.qualityWarning', {
        service: names.get(w.service) ?? w.service,
        message: w.message,
      }),
      action: (
        <a href={`#/services/${encodeURIComponent(w.service)}`}>{t('overview.seeService')}</a>
      ),
    });
  const checking =
    datasets.status === 'loading' ||
    usage.status === 'loading' ||
    settings.status === 'loading' ||
    failedRuns.status === 'loading';

  return (
    <div className="stack overview">
      {header(canCreate)}

      {showStart ? (
        <section aria-labelledby="start-h" className="stack-sm overview-start">
          <div className="row-between">
            <Heading level={2} data-size="sm" id="start-h">
              {t('overview.startTitle', { name: tenantName })}
            </Heading>
            {progress ? (
              <span className="meta">{t('overview.progress', { done: doneCount(progress) })}</span>
            ) : null}
          </div>
          {datasets.status === 'error' ? (
            <Alert data-color="warning">
              <Heading level={3} data-size="2xs">
                {t('overview.startFailed')}
              </Heading>
              <Paragraph>{t('overview.startFailedText')}</Paragraph>
              <Button variant="secondary" data-size="sm" onClick={retryDatasets}>
                {t('common.tryAgain')}
              </Button>
            </Alert>
          ) : null}
          <StartSteps progress={progress} headingLevel={3} />
          <p className="meta">
            {t.rich('overview.startHint', { link: (c) => <a href="#/onboarding">{c}</a> })}
          </p>
        </section>
      ) : null}

      {services.length > 0 ? (
        <AttentionList items={checking ? [] : items} checking={checking} checkedAt={checkedAt} />
      ) : null}

      {services.length > 0 ? (
        <div className="overview-grid">
          <TopServices
            services={services}
            failed={failed}
            listed={listed.status === 'ready' ? listed.data : undefined}
          />
          <aside
            className="stack overview-aside"
            aria-label={t('overview.usageHeading', { month })}
          >
            <UsageCard
              state={usage}
              retry={retryUsage}
              quota={quota}
              month={f.month(now)}
              models={models.status === 'ready' ? models.data : []}
            />
            <section aria-labelledby="changes-h" className="stack-sm overview-changes">
              <Heading level={2} data-size="xs" id="changes-h">
                {t('overview.changes')}
              </Heading>
              <LiveChanges api={api} tenant={tenant} limit={3} />
              <a href="#/log/changes">{t('overview.seeLog')}</a>
            </section>
          </aside>
        </div>
      ) : null}
    </div>
  );
};
