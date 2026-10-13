import {
  Alert,
  Avatar,
  Button,
  Heading,
  Skeleton,
  Spinner,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useState, type MouseEvent } from 'react';
import { Icon, icons } from '../components/Icon';
import type { DatasetView } from '../api/datasets';
import {
  ingestIssues,
  recentChanges,
  runningIngestions,
  serviceSummaries,
  startSteps,
  statusColor,
  type IngestIssue,
  type ServiceSummary,
} from '../data/overview';
import { formatOrgNumber } from '../data/organisations';
import { serviceLabel } from '../format';
import { useT, type Format, type PlainKey, type T } from '../i18n';
import { useAsync } from '../hooks';
import type { ScreenProps } from '../screen';
import { needsRight, useRights } from '../Shell';
import { ErrorState, limitOf, Loading, refusalOf } from '../states';
import { LiveChanges } from './changes/LiveChanges';
import type { UsageReport } from '../types';
import { costOf, money, quotaOf, withPricing } from './usage/model';
import './overview.css';

const millions = (t: T, f: Format, n: number) =>
  t('overview.millions', { value: f.decimal(n / 1_000_000, 1) });

const quotaMillions = (f: Format, n: number) =>
  f.number(n / 1_000_000, { maximumFractionDigits: 1 });

const statusKeys: Record<ServiceSummary['status'], PlainKey> = {
  'I bruk': 'serviceList.statusLive',
  Utkast: 'serviceList.statusDraft',
  'I test': 'serviceList.statusTest',
  'Satt på pause': 'serviceList.statusPaused',
};

const summaryFor = (
  id: string,
  name: string,
  version: number | null,
  live: boolean,
): ServiceSummary =>
  (live ? undefined : serviceSummaries.find((s) => s.id === id)) ?? {
    id,
    name,
    status: version ? 'I bruk' : 'Utkast',
    job: '',
    triggerKind: '',
    trigger: '',
    io: '',
    calls: '',
    callsLabel: '',
  };

type IngestRow = Omit<IngestIssue, 'retryText' | 'status'> & {
  status: string;
  retryText?: string;
};

const needsFollowUp = (d: DatasetView) =>
  d.state === 'degraded' ||
  d.lastExecution?.status === 'failed' ||
  d.lastExecution?.status === 'cancelled';

const jump = (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
  event.preventDefault();
  const target = document.getElementById(id);
  target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  target?.focus({ preventScroll: true });
};

const UsageCard = ({
  state,
  retry,
  empty,
  names,
  quota,
}: {
  state: ReturnType<typeof useAsync<UsageReport>>[0];
  retry: () => void;
  empty: boolean;
  names: Map<string, string>;
  quota: number | null;
}) => {
  const t = useT();
  const f = useFormat();
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return (
    <section aria-labelledby="forbruk-h" className="card overview-usage">
      <div className="row-between">
        <Heading level={2} data-size="xs" id="forbruk-h">
          {t('overview.usageHeading', { month: f.month(now) })}
        </Heading>
        <span className="meta">{t('overview.quotaRenews', { month: f.month(next) })}</span>
      </div>
      {state.status === 'loading' ? (
        <div role="status" className="stack-sm">
          <Skeleton variant="text" width="60%" height={32} />
          <Skeleton width="100%" height={14} />
          <Skeleton variant="text" width="80%" />
          <span className="visually-hidden">{t('overview.loadingUsage')}</span>
        </div>
      ) : null}
      {state.status === 'error' && (refusalOf(state.error) || limitOf(state.error)) ? (
        <ErrorState error={state.error} headingLevel={3} />
      ) : null}
      {state.status === 'error' && !refusalOf(state.error) && !limitOf(state.error) ? (
        <Alert data-color="danger">
          <Heading level={3} data-size="2xs">
            {t('overview.usageFailed')}
          </Heading>
          <p className="alert-text">{t('overview.usageFailedText')}</p>
          <Button variant="secondary" data-size="sm" onClick={retry}>
            {t('common.tryAgain')}
          </Button>
        </Alert>
      ) : null}
      {state.status === 'ready' ? (
        <UsageFigures report={state.data} empty={empty} names={names} quota={quota} />
      ) : null}
    </section>
  );
};

const UsageFigures = ({
  report,
  empty,
  names,
  quota,
}: {
  report: UsageReport;
  empty: boolean;
  names: Map<string, string>;
  quota: number | null;
}) => {
  const t = useT();
  const f = useFormat();
  const used = empty ? 0 : report.totals.inputTokens + report.totals.outputTokens;
  const pct = quota === null ? 0 : Math.round((used / quota) * 100);
  const over = pct >= 80;
  const perService = empty
    ? []
    : report.byService
        .map((s) => ({
          name: names.get(s.service) ?? serviceLabel(s.service, s.title),
          tokens: s.usage.inputTokens + s.usage.outputTokens,
        }))
        .filter((s) => s.tokens > 0);
  return (
    <div className="stack-md">
      <div className="stack-xs">
        <div className="usage-figure">
          <span className="usage-used numeric">{millions(t, f, used)}</span>
          <span className="meta-lg">
            {quota === null
              ? t('overview.quotaUnknown')
              : t('overview.ofQuota', { value: quotaMillions(f, quota) })}
          </span>
        </div>
        {quota === null ? null : (
          <>
            <div
              role="progressbar"
              aria-label={t('overview.quotaBar')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-valuetext={t('overview.percentUsed', { pct })}
              className="quota-bar"
            >
              <div
                className={over ? 'quota-fill over' : 'quota-fill'}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
              <div className="quota-mark" />
            </div>
            <div className="row-between meta">
              <span className={over ? 'quota-pct over' : 'quota-pct'}>
                {t('overview.percentUsed', { pct })}
              </span>
              <span>{t('overview.alertAt80')}</span>
            </div>
          </>
        )}
        <p className="meta">{t('usage.counted')}</p>
      </div>
      <dl className="facts">
        <div>
          <dt>{t('overview.costSoFar')}</dt>
          <dd>{empty ? money(f, t, 0) : money(f, t, costOf(report.totals))}</dd>
        </div>
        <div>
          <dt>{t('overview.runsThisMonth')}</dt>
          <dd>{empty ? '0' : f.number(report.totals.runs ?? report.totals.requests)}</dd>
        </div>
      </dl>
      {perService.length > 0 ? (
        <div className="stack-sm">
          <h3 className="overview-h3">{t('overview.perService')}</h3>
          <ul className="plain-list per-service">
            {perService.map((p) => (
              <li key={p.name}>
                <div className="row-between">
                  <span>{p.name}</span>
                  <span className="numeric meta-15">{millions(t, f, p.tokens)}</span>
                </div>
                <div aria-hidden="true" className="mini-bar">
                  <div style={{ width: `${Math.round((p.tokens / Math.max(used, 1)) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="empty-text">{t('overview.noUsage')}</p>
      )}
      <a href="#/usage">{t('overview.seeUsage')}</a>
    </div>
  );
};

export const Overview = ({
  api,
  tenant,
  tenantName,
  live,
  onFailingIngests,
}: ScreenProps & { onFailingIngests?: (count: number) => void }) => {
  const t = useT();
  const f = useFormat();
  const [overview, retryOverview] = useAsync(
    (signal) => api.overview(tenant, signal),
    [api, tenant],
  );
  const [usage, retryUsage] = useAsync(
    async (signal) =>
      withPricing(await api.usage(tenant, Math.max(new Date().getDate(), 1), signal)),
    [api, tenant],
  );
  const [settings] = useAsync(
    (signal) => api.tenantEffectiveSettings(tenant, signal),
    [api, tenant],
  );
  const quota = settings.status === 'ready' ? quotaOf(settings.data) : null;
  const [datasets] = useAsync((signal) => api.datasets.list(tenant, signal), [api, tenant]);
  const [retried, setRetried] = useState<Record<string, boolean>>({});
  const rights = useRights();
  const canCreate = rights.has('manage-services');
  const hasDataset =
    datasets.status === 'ready' &&
    datasets.data.some((d) => d.editable ?? d.fullId.startsWith(`${tenant}/`));
  const own = (d: DatasetView) => d.editable ?? d.fullId.startsWith(`${tenant}/`);
  const ownDatasets = datasets.status === 'ready' ? datasets.data.filter(own) : [];
  const runningCount = live
    ? ownDatasets.filter((d) => d.state === 'running' || d.lastExecution?.status === 'running')
        .length
    : runningIngestions;
  const liveIngest: IngestRow[] = ownDatasets.filter(needsFollowUp).map((d) => {
    const cancelled = d.state !== 'degraded' && d.lastExecution?.status === 'cancelled';
    return {
      id: d.fullId,
      dataset: d.fullId,
      name: d.name,
      status: cancelled ? t('datasets.runCancelled') : t('datasets.statusFailed'),
      color: cancelled ? 'warning' : 'danger',
      meta: d.lastExecution
        ? t('overview.ingestMeta', { when: f.dateTime(d.lastExecution.startedAt) })
        : '',
      message: cancelled ? t('overview.ingestCancelledText') : t('overview.ingestFailedText'),
    };
  });
  const ingest: IngestRow[] = live
    ? liveIngest
    : !hasDataset || overview.status !== 'ready' || overview.data.services.length === 0
      ? []
      : ingestIssues;
  const failing = ingest.filter((j) => !retried[j.id]).length;
  useEffect(() => {
    onFailingIngests?.(failing);
  }, [onFailingIngests, failing]);

  if (overview.status === 'loading') return <Loading label={t('overview.loading')} />;
  if (overview.status === 'error')
    return (
      <>
        <Heading level={1} data-size="lg">
          {t('overview.title')}
        </Heading>
        <ErrorState error={overview.error} onRetry={retryOverview} />
      </>
    );

  const services = overview.data.services.map((s) => {
    const summary = summaryFor(s.id, s.name, s.latestVersion, live);
    if (!live) return summary;
    return {
      ...summary,
      status: s.status === 'paused' ? ('Satt på pause' as const) : summary.status,
      ...(s.runsThisWeek === undefined
        ? {}
        : {
            calls: f.number(s.runsThisWeek),
            callsLabel: t('serviceList.perWeek', { unit: t('servicesScreen.runsUnit') }),
          }),
    };
  });
  const names = new Map(services.map((s) => [s.id, s.name]));
  const empty = services.length === 0;
  const noDatasets =
    empty || (datasets.status === 'ready' && (live ? datasets.data.length === 0 : !hasDataset));
  const doneSteps: Record<string, boolean> = { dataset: hasDataset };
  const used =
    usage.status === 'ready' && !empty
      ? usage.data.totals.inputTokens + usage.data.totals.outputTokens
      : 0;
  const quotaAlert = quota !== null && used / quota > 0.9;
  const counts = (['I bruk', 'Utkast', 'I test', 'Satt på pause'] as const)
    .map((status) => ({ status, n: services.filter((s) => s.status === status).length }))
    .filter((c) => c.n > 0);

  return (
    <div className="stack overview">
      <div className="page-head">
        <div className="stack-xs">
          <Heading level={1} data-size="lg">
            {t('overview.title')}
          </Heading>
          <p className="lead">
            {t('overview.orgLine', { name: tenantName, orgNr: formatOrgNumber(tenant) })}
          </p>
        </div>
        {empty || !canCreate ? null : (
          <a className="ds-button" data-variant="primary" href="#/services/new">
            <Icon d={icons.plus} />
            {t('overview.newService')}
          </a>
        )}
      </div>

      <div aria-live="polite" className="stack-sm">
        {quotaAlert ? (
          <Alert data-color="danger">
            <Heading level={2} data-size="2xs">
              {t('overview.quotaAlertTitle')}
            </Heading>
            <p className="alert-text">
              {t('overview.quotaAlertText', {
                pct: Math.round((used / (quota ?? 1)) * 100),
                quota: quotaMillions(f, quota ?? 0),
                month: f.month(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)),
              })}
            </p>
            <div className="actions">
              <Button variant="primary" data-size="sm">
                {t('overview.requestQuota')}
              </Button>
              <a className="ds-button" data-variant="secondary" data-size="sm" href="#/usage">
                {t('overview.seeUsagePerService')}
              </a>
            </div>
          </Alert>
        ) : null}
        {failing > 0 ? (
          <Alert data-color="warning">
            <p className="alert-text">
              <strong>{t('overview.ingestAttention', { count: failing })}</strong>{' '}
              {t('overview.ingestKept')}{' '}
              <a href="#innlesinger" onClick={jump('innlesinger')}>
                {t('overview.goToIngests')}
              </a>
            </p>
          </Alert>
        ) : null}
      </div>

      {empty ? (
        <section aria-labelledby="kom-i-gang" className="get-started">
          <div className="stack-xs get-started-intro">
            <Heading level={2} data-size="sm" id="kom-i-gang">
              {t('overview.getStarted')}
            </Heading>
            <p className="body-lg">{t('overview.noServicesIntro', { name: tenantName })}</p>
          </div>
          <ol className="plain-list start-steps-grid">
            {startSteps.map((s, i) => (
              <li key={s.id} className={doneSteps[s.id] ? 'step-done' : undefined}>
                <span className="step-label">{t('overview.stepLabel', { n: i + 1 })}</span>
                <span className="step-title">{t(s.title)}</span>
                <span className="step-body">{t(s.body)}</span>
                {doneSteps[s.id] ? (
                  <span className="row-wrap">
                    <Tag data-color="success" data-size="sm">
                      {t('overview.stepDone')}
                    </Tag>
                    <a href="#/datasets">{t('overview.seeDatasets')}</a>
                  </span>
                ) : s.right && !rights.has(s.right) ? (
                  <span className="meta">{needsRight(s.right, t)}</span>
                ) : (
                  <a className="ds-button" data-variant={s.variant} data-size="sm" href={s.href}>
                    {t(s.cta)}
                  </a>
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="overview-grid">
        <div className="stack">
          <section aria-labelledby="tjenester-h" className="card">
            <div className="card-head">
              <Heading level={2} data-size="xs" id="tjenester-h">
                {t('overview.services')}
              </Heading>
              {empty ? null : (
                <ul aria-label={t('overview.countPerStatus')} className="plain-list tag-row">
                  {counts.map((c) => (
                    <li
                      key={c.status}
                      className="ds-tag"
                      data-color={statusColor[c.status]}
                      data-size="sm"
                    >
                      {t('overview.countLabel', {
                        n: c.n,
                        status: t(statusKeys[c.status]).toLowerCase(),
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {empty ? (
              <div className="card-empty">
                <span className="empty-title">{t('overview.noServices')}</span>
                <span className="empty-text">{t('overview.noServicesText')}</span>
                {canCreate ? (
                  <a
                    className="ds-button"
                    data-variant="secondary"
                    data-size="sm"
                    href="#/services/new"
                  >
                    {t('overview.createService')}
                  </a>
                ) : (
                  <span className="meta">{needsRight('manage-services', t)}</span>
                )}
              </div>
            ) : (
              <>
                <ul className="plain-list card-rows">
                  {services.map((s) => (
                    <li key={s.id} className="service-row">
                      <div className="service-main">
                        <div className="tag-row">
                          <a
                            href={`#/services/${encodeURIComponent(s.id)}`}
                            className="service-name"
                          >
                            {s.name}
                          </a>
                          <Tag data-color={statusColor[s.status]} data-size="sm">
                            {t(statusKeys[s.status])}
                          </Tag>
                        </div>
                        {s.job ? <span className="service-job">{s.job}</span> : null}
                        {s.trigger || s.io || s.shared ? (
                          <dl className="kv">
                            {s.trigger ? (
                              <>
                                <dt>{t('overview.startedBy')}</dt>
                                <dd className="tag-row">
                                  <Tag data-size="sm" data-color="neutral">
                                    {s.triggerKind}
                                  </Tag>
                                  <span>{s.trigger}</span>
                                </dd>
                              </>
                            ) : null}
                            {s.io ? (
                              <>
                                <dt>{t('overview.inOut')}</dt>
                                <dd>{s.io}</dd>
                              </>
                            ) : null}
                            {s.shared ? (
                              <>
                                <dt>{t('overview.builtOn')}</dt>
                                <dd>{s.shared}</dd>
                              </>
                            ) : null}
                          </dl>
                        ) : null}
                        {s.note ? <span className="service-note">{s.note}</span> : null}
                      </div>
                      {s.calls ? (
                        <div className="service-calls">
                          <span className="calls numeric">{s.calls}</span>
                          <span className="meta">{s.callsLabel}</span>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <div className="card-foot">
                  <a href="#/services">{t('overview.seeAllServices')}</a>
                </div>
              </>
            )}
          </section>

          <section
            id="innlesinger"
            tabIndex={-1}
            aria-labelledby="innlesinger-h"
            className="card ingest-card"
          >
            <div className="card-head">
              <Heading level={2} data-size="xs" id="innlesinger-h">
                {t('overview.ingestHeading')}
              </Heading>
              {empty || !hasDataset || runningCount === 0 ? null : (
                <span className="running meta">
                  <Spinner data-size="xs" aria-hidden="true" />
                  {t('overview.ingestRunning', { count: runningCount })}
                </span>
              )}
            </div>
            {ingest.length > 0 ? (
              <ul aria-live="polite" className="plain-list card-rows">
                {ingest.map((j) => {
                  const queued = retried[j.id];
                  return (
                    <li key={j.id} className="ingest-row">
                      <div className="tag-row">
                        <a
                          href={`#/datasets/${encodeURIComponent(j.dataset)}`}
                          className="service-name"
                        >
                          {j.name}
                        </a>
                        <Tag data-color={queued ? 'info' : j.color} data-size="sm">
                          {queued ? t('overview.queued') : j.status}
                        </Tag>
                      </div>
                      <span className="meta-15">{j.meta}</span>
                      <span className="body">{queued ? t('overview.restarting') : j.message}</span>
                      {queued ? null : (
                        <div className="actions">
                          {j.retryText ? (
                            <Button
                              variant="secondary"
                              data-size="sm"
                              aria-label={t('overview.retryFor', {
                                action: j.retryText,
                                name: j.name,
                              })}
                              onClick={() => setRetried((r) => ({ ...r, [j.id]: true }))}
                            >
                              {j.retryText}
                            </Button>
                          ) : null}
                          <a
                            className="ds-button"
                            data-variant="tertiary"
                            data-size="sm"
                            aria-label={t('overview.detailsFor', { name: j.name })}
                            href={`#/datasets/${encodeURIComponent(j.dataset)}`}
                          >
                            {t('overview.details')}
                          </a>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="card-empty">
                <span className="empty-title">
                  {noDatasets ? t('overview.noDatasets') : t('overview.allOk')}
                </span>
                <span className="empty-text">
                  {noDatasets ? t('overview.noDatasetsText') : t('overview.noneFailed')}
                </span>
              </div>
            )}
          </section>
        </div>

        <div className="stack">
          <UsageCard state={usage} retry={retryUsage} empty={empty} names={names} quota={quota} />

          <section aria-labelledby="endringer-h" className="card">
            <div className="card-head">
              <Heading level={2} data-size="xs" id="endringer-h">
                {t('overview.changes')}
              </Heading>
            </div>
            {live ? (
              <LiveChanges api={api} tenant={tenant} />
            ) : empty ? (
              <div className="card-empty">
                <span className="empty-title">{t('overview.noChanges')}</span>
                <span className="empty-text">{t('overview.noChangesText')}</span>
              </div>
            ) : (
              <>
                <ol className="plain-list card-rows">
                  {recentChanges.map(([ini, who, what, when, color]) => (
                    <li key={`${who}-${when}`} className="change-row">
                      <Avatar data-size="xs" data-color={color} aria-hidden="true">
                        {ini}
                      </Avatar>
                      <div className="change-text">
                        <span>
                          <strong>{who}</strong> {what}
                        </span>
                        <time className="meta">{when}</time>
                      </div>
                    </li>
                  ))}
                </ol>
                <div className="card-foot">
                  <a href="#/log?tab=changes">{t('overview.seeLog')}</a>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
