import {
  Alert,
  Button,
  Chip,
  Field,
  Fieldset,
  Heading,
  Input,
  Label,
  Paragraph,
  Select,
  Table,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api';
import { serviceNames } from '../../data/log';
import { formatKroner, isTrialService, serviceLabel, statusOf } from '../../format';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { Loading } from '../../states';
import type { TaskRow, TaskStatus } from '../../types';
import { DateRange } from './DateRange';
import {
  addDays,
  hasRunFilters,
  noFilters,
  parseRunFilters,
  periodDays,
  periods,
  runFiltersQuery,
  runsRequest,
  trialRuns,
  type Period,
  type RunFilters,
} from './filters';
import { actorText, dateKey, durationBetween, formatDuration, relativeTime } from './format';

const statusChips: [PlainKey, TaskStatus | ''][] = [
  ['logRuns.allStatuses', ''],
  ['taskStatus.completed', 'completed'],
  ['taskStatus.failed', 'failed'],
  ['taskStatus.running', 'running'],
];

const periodKeys: Record<Period, PlainKey> = {
  today: 'logRuns.periodToday',
  '7': 'logRuns.period7',
  '30': 'logRuns.period30',
  custom: 'logRuns.periodCustom',
};

export const logHash = (f: RunFilters, runId?: string) => {
  const query = runFiltersQuery(f);
  return `#/log${runId ? `/${encodeURIComponent(runId)}` : ''}${query ? `?${query}` : ''}`;
};

export const trialLabel = (row: Pick<TaskRow, 'capability'>, t: T) =>
  row.capability.includes('/playground/')
    ? t('logRuns.playground')
    : row.capability.startsWith('platform/operation-try/')
      ? t('logRuns.operationTry')
      : t('usage.trialRuns');

export const useServiceNames = (api: ApiClient, tenant: string, live: boolean) => {
  const [services] = useAsync(
    async (signal) =>
      live
        ? Object.fromEntries((await api.services(tenant, signal)).data.map((s) => [s.id, s.name]))
        : serviceNames,
    [api, tenant, live],
  );
  return services.status === 'ready' ? services.data : {};
};

const byNewest = (a: TaskRow, b: TaskRow) => b.createdAt.localeCompare(a.createdAt);

type ListedRun = TaskRow & { failure?: { reason: string } };

const failureOf = (row: TaskRow) =>
  row.status === 'failed' ? (row as ListedRun).failure?.reason : undefined;

export const RunsTab = ({
  api,
  tenant,
  live = false,
  query,
}: {
  api: ApiClient;
  tenant: string;
  live?: boolean;
  query: URLSearchParams;
}) => {
  const t = useT();
  const f = useFormat();
  const filters = parseRunFilters(query);
  const asked = runFiltersQuery({ ...filters, q: '' });
  const [typed, setTyped] = useState(filters.q);
  useEffect(() => setTyped(filters.q), [filters.q]);
  const now = useMemo(() => new Date(), [asked]);
  const today = dateKey(now);
  const names = useServiceNames(api, tenant, live);
  const nameOf = (row: TaskRow) =>
    isTrialService(row.service)
      ? trialLabel(row, t)
      : (names[row.service] ?? row.serviceName ?? serviceLabel(row.service));

  const go = (patch: Partial<RunFilters>) =>
    window.location.replace(logHash({ ...filters, q: typed, ...patch }));

  const trialOnly = filters.service === trialRuns;
  const oneService = Boolean(filters.service) && !trialOnly;
  const [environments] = useAsync(
    async (signal) =>
      live && oneService
        ? ((
            await api.environments.list(tenant, filters.service, signal).catch(() => undefined)
          )?.environments.map((e) => e.name) ?? [])
        : [],
    [api, tenant, live, oneService, filters.service],
  );
  const environmentNames = environments.status === 'ready' ? environments.data : [];
  const request = runsRequest(filters, now);
  const [state, retry, pending] = useAsync(
    async (signal) => {
      const [runs, playground] = await Promise.all([
        api.tasks(tenant, request, signal),
        oneService ? undefined : api.tasks(tenant, { ...request, origin: 'playground' }, signal),
      ]);
      const trials = [
        ...(playground?.data ?? []),
        ...runs.data.filter((r) => isTrialService(r.service)),
      ].sort(byNewest);
      const served = runs.data.filter((r) => !isTrialService(r.service));
      const trialTotal = (playground?.total ?? 0) + (runs.data.length - served.length);
      const never =
        asked === '' && runs.total === 0 && trialTotal === 0
          ? (
              await Promise.all([
                api.tasks(tenant, { limit: 1 }, signal),
                api.tasks(tenant, { origin: 'playground', limit: 1 }, signal),
              ])
            ).every((r) => r.total === 0)
          : false;
      return trialOnly
        ? { rows: trials, total: trialTotal, trials: [], trialTotal: 0, never }
        : {
            rows: served,
            total: runs.total - (runs.data.length - served.length),
            trials,
            trialTotal,
            never,
          };
    },
    [api, tenant, asked],
    { keepPreviousFor: tenant },
  );

  const q = typed.trim().toLowerCase();
  const matches = (row: TaskRow) =>
    !q ||
    row.id.toLowerCase().includes(q) ||
    nameOf(row).toLowerCase().includes(q) ||
    (row.excerpt ?? '').toLowerCase().includes(q);
  const data = state.status === 'ready' ? state.data : undefined;
  const rows = data?.rows.filter(matches) ?? [];
  const trials = data?.trials.filter(matches) ?? [];
  const total = data ? (q ? data.rows.length : data.total) : 0;

  const title = (row: TaskRow) =>
    row.excerpt && !row.erasure ? `${nameOf(row)}: ${row.excerpt}` : nameOf(row);
  const duration = (row: TaskRow) => {
    const seconds =
      durationBetween(row.createdAt, row.endedAt) ??
      (row.status === 'running' ? (now.getTime() - Date.parse(row.createdAt)) / 1000 : undefined);
    return seconds === undefined ? '' : formatDuration(Math.max(seconds, 0), f, t);
  };
  const cost = (row: TaskRow) =>
    row.status === 'running'
      ? t('taskStatus.running')
      : row.usage
        ? formatKroner(row.usage.costMicroNok, f, t)
        : '';
  const href = (row: TaskRow) => logHash({ ...filters, q: typed }, row.id);
  const reset = () => {
    setTyped('');
    window.location.replace(logHash(noFilters));
  };
  const days = periodDays(filters, now);
  const filtered = hasRunFilters({ ...filters, q: typed });
  const never = data?.never === true && !filtered;

  return (
    <div className="stack log-runs-page">
      {never ? null : (
        <form role="search" className="log-filters" onSubmit={(e) => e.preventDefault()}>
          <div className="log-filter-row">
            <Field className="log-filter-q" data-size="sm">
              <Label htmlFor="lg-q">{t('logRuns.query')}</Label>
              <Input
                id="lg-q"
                type="search"
                placeholder={t('logRuns.queryPlaceholder')}
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  window.location.replace(logHash({ ...filters, q: e.target.value }));
                }}
              />
            </Field>
            <Field className="log-filter-select" data-size="sm">
              <Label htmlFor="lg-svc">{t('logRuns.service')}</Label>
              <Select
                id="lg-svc"
                value={filters.service}
                onChange={(e) => go({ service: e.target.value, environment: '' })}
              >
                <Select.Option value="">{t('logRuns.allServices')}</Select.Option>
                {Object.entries(names).map(([id, name]) => (
                  <Select.Option key={id} value={id}>
                    {name}
                  </Select.Option>
                ))}
                {filters.service && filters.service !== trialRuns && !(filters.service in names) ? (
                  <Select.Option value={filters.service}>
                    {serviceLabel(filters.service)}
                  </Select.Option>
                ) : null}
                <Select.Option value={trialRuns}>{t('logRuns.trialOption')}</Select.Option>
              </Select>
            </Field>
            {environmentNames.length > 1 ? (
              <Field className="log-filter-select" data-size="sm">
                <Label htmlFor="lg-env">{t('logRuns.environment')}</Label>
                <Select
                  id="lg-env"
                  value={filters.environment}
                  onChange={(e) => go({ environment: e.target.value })}
                >
                  <Select.Option value="">{t('logRuns.allEnvironments')}</Select.Option>
                  {environmentNames.map((name) => (
                    <Select.Option key={name} value={name}>
                      {name}
                    </Select.Option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field className="log-filter-select" data-size="sm">
              <Label htmlFor="lg-per">{t('logRuns.period')}</Label>
              <Select
                id="lg-per"
                value={filters.period}
                onChange={(e) => {
                  const period = periods.find((p) => p === e.target.value) ?? 'today';
                  go(
                    period === 'custom'
                      ? { period, from: addDays(today, -7), to: today }
                      : { period, from: '', to: '' },
                  );
                }}
              >
                {periods.map((p) => (
                  <Select.Option key={p} value={p}>
                    {t(periodKeys[p])}
                  </Select.Option>
                ))}
              </Select>
            </Field>
          </div>
          {filters.period === 'custom' ? (
            <DateRange
              from={days.from}
              to={days.to}
              today={today}
              onChange={(from, to) => go({ from, to })}
            />
          ) : null}
          <Fieldset className="log-status-chips" data-size="sm">
            <Fieldset.Legend>{t('logRuns.status')}</Fieldset.Legend>
            <div className="tag-row">
              {statusChips.map(([label, value]) => (
                <Chip.Radio
                  key={label}
                  name="lg-status"
                  checked={filters.status === value}
                  onChange={() => go({ status: value })}
                >
                  {t(label)}
                </Chip.Radio>
              ))}
            </div>
          </Fieldset>
        </form>
      )}

      {state.status === 'error' ? (
        <Alert data-color="danger" className="log-alert">
          <Heading level={2} data-size="xs">
            {t('logRuns.errorTitle')}
          </Heading>
          <Paragraph>{t('logRuns.errorText')}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={retry}>
            {t('common.tryAgain')}
          </Button>
        </Alert>
      ) : null}

      {never ? null : (
        <div className="log-count">
          <p role="status">
            {data ? t('logRuns.showing', { shown: rows.length, count: total }) : ''}
          </p>
          {filtered ? (
            <Button variant="tertiary" data-size="sm" onClick={reset}>
              {t('logRuns.reset')}
            </Button>
          ) : null}
        </div>
      )}

      {state.status === 'loading' ? <Loading label={t('logRuns.loading')} /> : null}

      {never ? (
        <div className="log-empty">
          <Heading level={2} data-size="xs">
            {t('logRuns.noneTitle')}
          </Heading>
          <Paragraph>{t('logRuns.noneText')}</Paragraph>
          <a href="#/playground" className="log-self-start">
            {t('logRuns.openPlayground')}
          </a>
        </div>
      ) : null}

      {data && !never && rows.length === 0 && trials.length === 0 ? (
        <div className="log-empty">
          <Heading level={2} data-size="xs">
            {t('logRuns.noMatchTitle')}
          </Heading>
          <Paragraph>{t('logRuns.noMatchText')}</Paragraph>
          {filtered ? (
            <Button variant="secondary" data-size="sm" className="log-self-start" onClick={reset}>
              {t('logRuns.resetFilters')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="log-table-wrap">
          <Table
            aria-label={t('logRuns.table')}
            className="log-table"
            aria-busy={pending || undefined}
          >
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell scope="col">{t('logRuns.colTime')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('logRuns.colRun')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('logRuns.colStatus')}</Table.HeaderCell>
                <Table.HeaderCell scope="col" className="num">
                  {t('logRuns.colDuration')}
                </Table.HeaderCell>
                <Table.HeaderCell scope="col" className="num">
                  {t('logRuns.colCost')}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {rows.map((row) => {
                const status = statusOf(row.status, t);
                return (
                  <Table.Row key={row.id}>
                    <Table.Cell className="log-when">
                      {relativeTime(row.createdAt, t, f, now)}
                    </Table.Cell>
                    <Table.Cell>
                      <a href={href(row)} className="log-run-link">
                        {title(row)}
                      </a>
                      {failureOf(row) ? <div className="meta">{failureOf(row)}</div> : null}
                      {row.erasure ? (
                        <div>
                          <Tag data-size="sm" data-color="neutral">
                            {t('logRuns.erased')}
                          </Tag>
                        </div>
                      ) : null}
                    </Table.Cell>
                    <Table.Cell>
                      <Tag data-size="sm" data-color={status.color}>
                        {status.text}
                      </Tag>
                    </Table.Cell>
                    <Table.Cell className="num">{duration(row)}</Table.Cell>
                    <Table.Cell className="num">{cost(row)}</Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
      ) : null}

      {!trialOnly && trials.length > 0 ? (
        <details className="log-trials">
          <summary>
            {t('logRuns.trialSummary', { count: data?.trialTotal ?? trials.length })}
          </summary>
          <ul className="plain-list">
            {trials.slice(0, 5).map((row) => (
              <li key={row.id}>
                <span className="meta">{relativeTime(row.createdAt, t, f, now)}</span>
                <a href={href(row)}>{title(row)}</a>
                <span className="meta">
                  {[
                    row.actor ? actorText(row.actor, t) : '',
                    row.status === 'completed' ? '' : statusOf(row.status, t).text,
                    duration(row),
                    cost(row),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
          <a href={logHash({ ...filters, q: typed, service: trialRuns })}>
            {t('logRuns.trialAll')}
          </a>
        </details>
      ) : null}
    </div>
  );
};
