import {
  Button,
  Heading,
  Link,
  Paragraph,
  Skeleton,
  Table,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { blockHref } from '../../api/building-blocks';
import type { DatasetView } from '../../api/datasets';
import type { ServiceDefinition } from '../../data/service-definition';
import { datasetsOf } from '../../data/service-form';
import { mediaKind } from '../../data/unmasked-input';
import { actorLabel, formatDateTime, formatSeconds, notPriced, statusOf } from '../../format';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import { runsOf } from '../usage/model';
import type { ModelOption, PublishedDefinition, TaskRow, UsageTotals } from '../../types';
import type { VersionItem } from '../services/VersionsTab';
import { rightLabel } from '../../Shell';
import { PausedBanner } from './PausedBanner';
import { BatchDialog } from '../batch/BatchDialog';

const dayMs = 86_400_000;

const residencyKeys: Record<string, PlainKey> = {
  norway: 'serviceOverview.residencyNorway',
  eu: 'serviceOverview.residencyEu',
  global: 'serviceOverview.residencyGlobal',
};

interface Activity {
  runs: number | undefined;
  failed: number | undefined;
  today: number | undefined;
  failedToday: number | undefined;
  latestFailure:
    (TaskRow & { failure?: { code?: string; reason?: string; detail?: string } }) | undefined;
  recent: TaskRow[];
}

const settled = <T,>(r: PromiseSettledResult<T>) =>
  r.status === 'fulfilled' ? r.value : undefined;

const startOfHour = (d: Date) => Math.floor(d.getTime() / 3_600_000) * 3_600_000;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const matchDataset = (datasets: DatasetView[] | undefined, tenant: string, ref: string) =>
  datasets?.find((d) => d.fullId === ref || d.fullId === `${tenant}/${ref}` || d.id === ref);

export const OverviewSection = ({
  api,
  tenant,
  id,
  definition: d,
  published,
  tenantName,
  canBatch = false,
  now = () => new Date(),
}: {
  api: ApiClient;
  tenant: string;
  tenantName?: string;
  canBatch?: boolean;
  id: string;
  definition: ServiceDefinition;
  versions?: VersionItem[];
  published?: PublishedDefinition;
  now?: () => Date;
}) => {
  const t = useT();
  const f = useFormat();
  const kr = (micro: number | null | undefined) =>
    micro === null || micro === undefined
      ? notPriced
      : f.currency(micro / 1_000_000, { digits: 2 });
  const today = startOfDay(now());
  const [batchOpen, setBatchOpen] = useState(false);

  const [usageState] = useAsync(
    async (signal) => {
      const usage = await api.usage(tenant, 30, signal);
      return usage.byService.find((x) => x.service === id)?.usage as
        (UsageTotals & { failedRequests?: number }) | undefined;
    },
    [api, tenant, id],
  );
  const [state] = useAsync(
    async (signal): Promise<Activity> => {
      const from = new Date(startOfHour(now()) - 30 * dayMs).toISOString();
      const since = startOfDay(now()).toISOString();
      const count = (filter: { status?: string; from: string }) =>
        api.tasks(tenant, { service: id, limit: 1, ...filter }, signal);
      const [recent, runs, failed, todayRuns, failedToday] = await Promise.allSettled([
        api.tasks(tenant, { service: id, limit: 5 }, signal),
        count({ from }),
        count({ status: 'failed', from }),
        count({ from: since }),
        count({ status: 'failed', from: since }),
      ]);
      return {
        runs: settled(runs)?.total,
        failed: settled(failed)?.total,
        today: settled(todayRuns)?.total,
        failedToday: settled(failedToday)?.total,
        latestFailure: settled(failedToday)?.data[0],
        recent: (settled(recent)?.data ?? []).filter((r) => r.service === id).slice(0, 5),
      };
    },
    [api, tenant, id],
  );
  const latestFailure = state.status === 'ready' ? state.data.latestFailure : undefined;
  const [causeState] = useAsync(
    async (signal) => {
      if (!latestFailure) return undefined;
      const lower = (text: string) => text.charAt(0).toLocaleLowerCase('nb') + text.slice(1);
      const failure = latestFailure.failure;
      const detail = failure?.detail?.trim();
      if (detail) return lower(detail);
      const reason = failure?.reason?.trim();
      if (reason && failure?.code !== 'strategy_error') return lower(reason);
      const timeline = await api
        .getTaskTimeline(tenant, latestFailure.id, signal)
        .catch(() => undefined);
      const summary = timeline?.steps.find((s) => s.type === 'error')?.summary.trim();
      return summary ? lower(summary) : reason ? lower(reason) : undefined;
    },
    [api, tenant, latestFailure?.id],
  );
  const cause = causeState.status === 'ready' ? causeState.data : undefined;
  const [lookups] = useAsync(
    async (signal) => {
      const [datasets, models] = await Promise.allSettled([
        api.datasets.list(tenant, signal),
        api.listModels({}, signal),
      ]);
      return { datasets: settled(datasets), models: settled(models) };
    },
    [api, tenant],
  );
  const known = lookups.status === 'ready' ? lookups.data : undefined;
  const [accessState] = useAsync(
    async (signal) =>
      (await api.accessPeople.services(tenant, signal)).find(
        (s) => s.id === id && s.mode === 'selected',
      ),
    [api, tenant, id],
  );

  const primary = d.spec.model.primary;
  const model = known?.models?.find((m) => m.id === primary) as
    (ModelOption & { operator?: { name: string; region?: string } }) | undefined;
  const operator = model?.operator;
  const runsAt = operator
    ? [operator.name.replace(/^Microsoft /, ''), operator.region].filter(Boolean).join(' ')
    : undefined;
  const residency = known ? (model?.residency ?? d.spec.model.residency) : undefined;
  const residencyKey = residency ? residencyKeys[residency] : undefined;
  const sources = datasetsOf(d.spec);
  const consent = (published?.definition as ServiceDefinition | undefined)?.spec?.riskConfirmation;
  const consentBy =
    consent?.by && published
      ? actorLabel(
          consent.by,
          t,
          consent.by === published.publishedBy ? published.publishedByName : undefined,
        )
      : undefined;

  const when = (iso: string) => {
    const day = startOfDay(new Date(iso)).getTime();
    if (day === today.getTime()) return t('serviceOverview.todayAt', { time: f.time(iso) });
    if (day === today.getTime() - dayMs)
      return t('serviceOverview.yesterdayAt', { time: f.time(iso) });
    return formatDateTime(iso, f);
  };
  const duration = (r: TaskRow) =>
    r.endedAt ? formatSeconds((Date.parse(r.endedAt) - Date.parse(r.createdAt)) / 1000, f, t) : '–';
  const counted = state.status === 'ready' ? state.data : undefined;
  const causePending = Boolean(counted?.latestFailure) && causeState.status === 'loading';
  const activity = causePending ? undefined : counted;
  const failedToday = activity?.failedToday ?? 0;
  const serviceUsage = usageState.status === 'ready' ? usageState.data : undefined;
  const usageFailed = usageState.status === 'error';
  const waiting = <Skeleton variant="text" width="4em" />;
  const logHref = (query: string) => `#/log?${query}`;
  const notAvailable = t('serviceOverview.notAvailable');

  return (
    <div className="service-overview stack">
      <PausedBanner
        api={api}
        tenant={tenant}
        id={id}
        name={d.metadata.name || id}
        published={published}
        datasets={sources.flatMap((ref) => {
          const found = matchDataset(known?.datasets, tenant, ref.dataset);
          return found ? [found] : [];
        })}
      />

      <section aria-labelledby="ov-what" className="stack-sm">
        <Heading level={2} data-size="xs" id="ov-what">
          {t('serviceOverview.what')}
        </Heading>
        <Paragraph>{d.spec.purpose || t('serviceOverview.noPurpose')}</Paragraph>
        <dl className="kv service-facts">
          <dt>{t('serviceOverview.sources')}</dt>
          <dd>
            {!known && sources.length
              ? waiting
              : sources.length
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
          <dt>{t('serviceOverview.model')}</dt>
          <dd>
            {known ? (
              <>
                <Link href={blockHref({ kind: 'model', id: primary })}>
                  {model?.name ?? primary}
                </Link>
                {residencyKey
                  ? runsAt
                    ? t('serviceOverview.modelWhereAt', { where: t(residencyKey), at: runsAt })
                    : t('serviceOverview.modelWhere', { where: t(residencyKey) })
                  : ''}
              </>
            ) : (
              waiting
            )}
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
                {consentBy ? (
                  <span className="meta">
                    {t('unmaskedInput.overviewBy', {
                      who: consentBy,
                      when: consent.at ? formatDateTime(consent.at, f) : '',
                    })}
                  </span>
                ) : null}
              </dd>
            </>
          ) : null}
          <dt>{t('serviceOverview.whoCanUse')}</dt>
          <dd>
            {accessState.status === 'loading' ? (
              waiting
            ) : accessState.status === 'error' ? (
              notAvailable
            ) : accessState.data ? (
              <Link href={`#/access/services?open=${encodeURIComponent(id)}`}>
                {t('serviceOverview.selectedOnly', { count: accessState.data.members.length })}
              </Link>
            ) : (
              t('serviceOverview.everyoneWith', {
                org: tenantName || tenant,
                right: rightLabel(t, 'use-services'),
              })
            )}
          </dd>
        </dl>
      </section>

      <section aria-labelledby="ov-use" className="stack-sm">
        <Heading level={2} data-size="xs" id="ov-use">
          {t('serviceOverview.usage')}
        </Heading>
        <dl
          className="facts"
          aria-busy={state.status === 'loading' || usageState.status === 'loading' || undefined}
        >
          <div>
            <dt>{t('serviceOverview.runs')}</dt>
            <dd>
              {serviceUsage
                ? f.number(runsOf(serviceUsage))
                : usageFailed
                  ? notAvailable
                  : usageState.status === 'ready'
                    ? f.number(0)
                    : waiting}
            </dd>
          </div>
          <div>
            <dt>{t('serviceOverview.errorShare')}</dt>
            <dd>
              {serviceUsage?.failedRequests !== undefined
                ? f.percent(
                    serviceUsage.requests ? serviceUsage.failedRequests / serviceUsage.requests : 0,
                    1,
                  )
                : counted
                  ? counted.runs !== undefined && counted.failed !== undefined
                    ? f.percent(counted.runs ? counted.failed / counted.runs : 0, 1)
                    : notAvailable
                  : waiting}
            </dd>
          </div>
          <div>
            <dt>{t('serviceOverview.cost')}</dt>
            <dd>
              {usageState.status === 'ready'
                ? serviceUsage &&
                  serviceUsage.priced === false &&
                  serviceUsage.costMicroNok !== null
                  ? t('serviceOverview.costAtLeast', { cost: kr(serviceUsage.costMicroNok) })
                  : kr(serviceUsage ? serviceUsage.costMicroNok : 0)
                : usageFailed
                  ? notAvailable
                  : waiting}
            </dd>
          </div>
        </dl>
        <Link href="#/statistics">{t('serviceOverview.seeStatistics')}</Link>
      </section>

      {failedToday > 0 && activity ? (
        <section aria-labelledby="ov-attn" className="stack-sm">
          <Heading level={2} data-size="xs" id="ov-attn">
            {t('serviceOverview.needsYou')}
          </Heading>
          <div className="service-attention">
            <Tag data-size="sm" data-color="danger">
              {t('serviceOverview.failedTag')}
            </Tag>
            <span>
              {cause
                ? t('serviceOverview.failedTodayCause', {
                    count: failedToday,
                    cause,
                  })
                : t('serviceOverview.failedToday', { count: failedToday })}
              {activity.today !== undefined
                ? ` ${t('serviceOverview.othersToday', { count: activity.today - failedToday })}`
                : ''}
            </span>
            <Link href={logHref(`service=${encodeURIComponent(id)}&status=failed&period=today`)}>
              {t('serviceOverview.seeFailed', { count: failedToday })}
            </Link>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="ov-runs" className="stack-sm">
        <div className="row-wrap spread">
          <Heading level={2} data-size="xs" id="ov-runs">
            {t('serviceOverview.lastRuns')}
          </Heading>
          <Link href={logHref(`service=${encodeURIComponent(id)}`)}>
            {t('serviceOverview.seeAll')}
          </Link>
        </div>
        {activity?.recent.length ? (
          <div tabIndex={0} role="region" aria-labelledby="ov-runs" className="scroll-x">
            <Table data-size="sm">
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell scope="col">{t('serviceOverview.colTime')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">
                    {t('serviceOverview.colQuestion')}
                  </Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('serviceOverview.colStatus')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col" className="right">
                    {t('serviceOverview.colDuration')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {activity.recent.map((r) => {
                  const s = statusOf(r.status, t);
                  return (
                    <Table.Row key={r.id}>
                      <Table.Cell>{when(r.createdAt)}</Table.Cell>
                      <Table.Cell>
                        <Link href={`#/log/${encodeURIComponent(r.id)}`}>
                          {r.excerpt || t('serviceOverview.openRun')}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        <Tag data-size="sm" data-color={s.color}>
                          {s.text}
                        </Tag>
                      </Table.Cell>
                      <Table.Cell className="right numeric">{duration(r)}</Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        ) : state.status === 'loading' || causePending ? (
          <Skeleton variant="rectangle" height="12rem" />
        ) : (
          <p className="body-sm">{t('serviceOverview.noRuns')}</p>
        )}
      </section>

      {canBatch ? (
        <section aria-labelledby="ov-batch" className="service-batch-offer">
          <div className="stack-xs">
            <Heading level={2} data-size="xs" id="ov-batch">
              {t('serviceOverview.batchTitle')}
            </Heading>
            <Paragraph data-size="sm">{t('serviceOverview.batchLead')}</Paragraph>
          </div>
          <Button variant="secondary" data-size="sm" onClick={() => setBatchOpen(true)}>
            {t('serviceOverview.batchTitle')}
          </Button>
          {batchOpen ? (
            <BatchDialog api={api} tenant={tenant} id={id} onClose={() => setBatchOpen(false)} />
          ) : null}
        </section>
      ) : null}
    </div>
  );
};
