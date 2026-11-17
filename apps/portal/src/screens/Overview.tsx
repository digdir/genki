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
import type { DatasetView } from '../api/datasets';
import { Icon } from '../components/Icon';
import { useT, type Format, type T } from '../i18n';
import { useAsync, type AsyncState } from '../hooks';
import type { ScreenProps } from '../screen';
import { useRights } from '../Shell';
import { failureText } from './datasets/live-model';
import { ErrorState, Loading, limitOf, refusalOf } from '../states';
import type { Overview as OverviewData, UsageReport } from '../types';
import { LiveChanges } from './changes/LiveChanges';
import { allDone, doneCount, ownDataset, startProgress, StartSteps } from './start-progress';
import {
  costOf,
  money,
  monthUsage,
  quotaOf,
  tokensOf,
  withPricing,
  withTrialRows,
} from './usage/model';
import './overview.css';

const pollMs = 5000;

const millions = (f: Format, n: number) => f.number(n / 1_000_000, { maximumFractionDigits: 1 });

const failedRecently = (d: DatasetView) =>
  d.state === 'degraded' ||
  d.lastExecution?.status === 'failed' ||
  d.lastExecution?.status === 'cancelled';

const isRunning = (d: DatasetView) =>
  d.state === 'running' || d.lastExecution?.status === 'running';

export const monthLabel = (f: Format, date: Date) => {
  const name = f.month(date, { year: true });
  return name.charAt(0).toUpperCase() + name.slice(1);
};

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
}: {
  state: AsyncState<UsageReport>;
  retry: () => void;
  quota: number | null;
  month: string;
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
      {state.status === 'ready' ? <UsageFigures report={state.data} quota={quota} /> : null}
    </section>
  );
};

const UsageFigures = ({ report, quota }: { report: UsageReport; quota: number | null }) => {
  const t = useT();
  const f = useFormat();
  const usage = monthUsage(report);
  const used = tokensOf(usage.total);
  const pct = quota === null ? 0 : Math.round((used / quota) * 100);
  const parts = [
    { key: 'services', label: t('overview.partServices'), tokens: tokensOf(usage.services) },
    { key: 'trial', label: t('overview.partTrial'), tokens: tokensOf(usage.trial) },
    { key: 'outside', label: t('overview.partOutside'), tokens: tokensOf(usage.gateway) },
  ].filter((p) => p.key !== 'outside' || p.tokens > 0);
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
            className={pct >= 80 ? 'quota-fill over' : 'quota-fill'}
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
          <dd className="numeric">{money(f, t, costOf(usage.total))}</dd>
        </div>
        <div>
          <dt>{t('overview.runs')}</dt>
          <dd className="numeric">{f.number(usage.runs)}</dd>
        </div>
      </dl>
      <a href="#/statistics">{t('overview.seeUsagePerService')}</a>
    </>
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
        <Loading label={t('overview.checking')} />
      ) : (
        <p className="attention-none">
          {t('overview.nothing', { time: checkedAt ? f.time(checkedAt) : '' })}
        </p>
      )}
    </section>
  );
};

const TopServices = ({ services }: { services: OverviewData['services'] }) => {
  const t = useT();
  const f = useFormat();
  const top = [...services]
    .sort((a, b) => (b.runsThisWeek ?? 0) - (a.runsThisWeek ?? 0))
    .slice(0, 5);
  return (
    <section aria-labelledby="top-h" className="stack-sm overview-top">
      <div className="row-between">
        <Heading level={2} data-size="sm" id="top-h">
          {t('overview.topServices')}
        </Heading>
        <a href="#/services">{t('overview.allServices', { count: services.length })}</a>
      </div>
      <div className="table-scroll">
        <Table className="overview-table">
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">{t('overview.colService')}</TableHeaderCell>
              <TableHeaderCell scope="col" className="num">
                {t('overview.colRuns')}
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {top.map((s) => (
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
                        {t('serviceList.statusPaused')}
                      </Tag>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell className="num numeric">
                  {s.runsThisWeek === undefined ? '' : f.number(s.runsThisWeek)}
                </TableCell>
              </TableRow>
            ))}
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
      withTrialRows(withPricing(await api.usage(tenant, Math.max(now.getUTCDate(), 1), signal))),
    [api, tenant, now],
    { keepPreviousFor: tenant },
  );
  const [settings] = useAsync(
    (signal) => api.tenantEffectiveSettings(tenant, signal),
    [api, tenant],
  );
  const [datasets, retryDatasets] = useAsync(
    (signal) => api.datasets.list(tenant, signal),
    [api, tenant],
    { keepPreviousFor: tenant },
  );
  const { started, retry } = useIngestRetry(api, tenant, retryDatasets);
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
        <Loading label={t('overview.loading')} />
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
  const failedRuns = overview.data.review.failedTasksLastDay;
  if (failedRuns > 0)
    items.push({
      key: 'runs',
      badge: t('overview.badgeErrors'),
      color: 'danger',
      text: t('overview.runsFailed', { count: failedRuns }),
      action: <a href="#/log?status=failed">{t('overview.seeRuns')}</a>,
    });
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
  if (report && quota !== null) {
    const used = tokensOf(monthUsage(report).total);
    const pct = Math.round((used / quota) * 100);
    const next = f.month(new Date(now.getFullYear(), now.getMonth() + 1, 1));
    if (pct >= 80)
      items.push({
        key: 'quota',
        badge: t('overview.badgeQuota', { pct }),
        color: pct >= 100 ? 'danger' : 'warning',
        text: t(pct >= 100 ? 'overview.quotaUsedUp' : 'overview.quotaText', {
          used: millions(f, used),
          quota: millions(f, quota),
          month: f.month(now),
          next,
        }),
        action: <a href="#/statistics">{t('overview.seeUsagePerService')}</a>,
      });
  }
  const names = new Map(services.map((s) => [s.id, s.name]));
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
    datasets.status === 'loading' || usage.status === 'loading' || settings.status === 'loading';

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
        <AttentionList
          items={checking ? [] : items.slice(0, 4)}
          checking={checking}
          checkedAt={checkedAt}
        />
      ) : null}

      {services.length > 0 ? (
        <div className="overview-grid">
          <TopServices services={services} />
          <aside
            className="stack overview-aside"
            aria-label={t('overview.usageHeading', { month })}
          >
            <UsageCard state={usage} retry={retryUsage} quota={quota} month={f.month(now)} />
            <section aria-labelledby="changes-h" className="stack-sm overview-changes">
              <Heading level={2} data-size="xs" id="changes-h">
                {t('overview.changes')}
              </Heading>
              <LiveChanges api={api} tenant={tenant} limit={3} />
              <a href="#/log?tab=changes">{t('overview.seeLog')}</a>
            </section>
          </aside>
        </div>
      ) : null}
    </div>
  );
};
