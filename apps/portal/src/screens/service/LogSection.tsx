import {
  Button,
  Field,
  Heading,
  Label,
  Link,
  Paragraph,
  Search,
  Select,
  Table,
  Tag,
} from '@digdir/designsystemet-react';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api';
import { BackLink } from '../../components/BackLink';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import { productionEnvironment } from '../../api/environments';
import type { PlainKey, T } from '../../i18n';
import type { TaskRow } from '../../types';
import { EmptyState, ErrorState, Loading } from '../../states';
import { RunDetail } from '../log/RunDetail';
import { actorText } from '../log/format';
import { clockSeconds, sameDay, shortWhen } from './dev-format';
import { servicePath } from './sections';
import '../log.css';
import './sections.css';

const dayMs = 86_400_000;
const pageSizes = [25, 50, 100];
const searchDelayMs = 300;

type Period = 'today' | 'week' | 'month' | 'all';

const periods: [Period, PlainKey][] = [
  ['today', 'serviceDev.periodToday'],
  ['week', 'serviceDev.periodWeek'],
  ['month', 'serviceDev.periodMonth'],
  ['all', 'serviceDev.periodAll'],
];

const statuses: [string, PlainKey][] = [
  ['', 'serviceDev.statusAll'],
  ['completed', 'taskStatus.completed'],
  ['failed', 'taskStatus.failed'],
  ['running', 'taskStatus.running'],
  ['queued', 'taskStatus.queued'],
  ['interrupted', 'taskStatus.interrupted'],
  ['cancelled', 'taskStatus.cancelled'],
];

const fromOf = (period: Period, now: Date) => {
  if (period === 'all') return undefined;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const back = period === 'today' ? 0 : period === 'week' ? 6 : 29;
  return new Date(start.getTime() - back * dayMs).toISOString();
};

const meActor = 'me';

const byText = (r: TaskRow, t: T) =>
  r.actor?.kind === 'api-key' && r.channel !== 'interface' && r.actor.name
    ? t('serviceDev.byKey', { name: r.actor.name })
    : r.actor?.kind === 'person' && r.environment && r.environment !== productionEnvironment
      ? t('serviceDev.byPersonIn', { name: actorText(r.actor, t), environment: r.environment })
      : actorText(r.actor, t);

const pageKeys = {
  today: 'serviceDev.pageToday',
  week: 'serviceDev.pageWeek',
  month: 'serviceDev.pageMonth',
  all: 'serviceDev.pageAllRuns',
} as const;

const initialQuery = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');

export const LogSection = ({
  api,
  tenant,
  id,
  runId,
  live,
  now = () => new Date(),
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  runId: string | undefined;
  live: boolean;
  now?: () => Date;
}) => {
  const { t, f, kroner, status: statusText } = usePortalFormat();
  const [start] = useState(initialQuery);
  const [period, setPeriod] = useState<Period>(() => {
    const p = start.get('period');
    return periods.some(([v]) => v === p) ? (p as Period) : 'today';
  });
  const [status, setStatus] = useState(() => {
    const s = start.get('status') ?? '';
    return statuses.some(([v]) => v === s) ? s : '';
  });
  const [environment, setEnvironment] = useState('');
  const [actor, setActor] = useState('');
  const seen = useRef(new Map<string, string>());
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [size, setSize] = useState(25);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(typed.trim());
      setOffset(0);
    }, searchDelayMs);
    return () => clearTimeout(timer);
  }, [typed]);

  const [environments] = useAsync(
    async (signal) =>
      (await api.environments.list(tenant, id, signal).catch(() => undefined))?.environments.map(
        (e) => e.name,
      ) ?? [],
    [api, tenant, id],
  );
  const names = environments.status === 'ready' ? environments.data : [];
  const from = fromOf(period, now());
  const [state, retry, pending] = useAsync(
    (signal) =>
      api.serviceTabs.taskPage(
        tenant,
        { service: id, status, environment, actor, from, q, limit: size, offset },
        signal,
      ),
    [api, tenant, id, status, environment, actor, from, q, size, offset],
    { keepPreviousFor: id },
  );
  const [failed] = useAsync(
    async (signal) =>
      status
        ? undefined
        : (
            await api.serviceTabs.taskPage(
              tenant,
              { service: id, status: 'failed', environment, actor, from, q, limit: 1, offset: 0 },
              signal,
            )
          ).total,
    [api, tenant, id, status, environment, actor, from, q],
  );
  const href = (run: string) => `#${servicePath(id, 'log', `/${encodeURIComponent(run)}`)}`;

  if (runId)
    return (
      <div className="stack log">
        <BackLink label={t('serviceLog.all')} href={`#${servicePath(id, 'log')}`} />
        <RunDetail key={runId} api={api} tenant={tenant} runId={runId} live={live} />
      </div>
    );

  const reset = () => {
    setPeriod('all');
    setStatus('');
    setEnvironment('');
    setActor('');
    setTyped('');
    setQ('');
    setOffset(0);
  };
  const active = [
    period !== 'all' ? t(periods.find(([v]) => v === period)?.[1] ?? 'serviceDev.periodAll') : '',
    status ? statusText(status).text : '',
    environment,
    actor === meActor ? t('serviceDev.fromMe') : actor ? (seen.current.get(actor) ?? actor) : '',
    q ? `«${q}»` : '',
  ].filter(Boolean);
  const page = state.status === 'ready' ? state.data : undefined;
  const rows = page?.data.filter((r) => r.service === id) ?? [];
  for (const r of rows)
    if (r.actor?.id && !seen.current.has(r.actor.id))
      seen.current.set(r.actor.id, byText({ ...r, environment: null }, t));
  const at = page && Number.isFinite(page.offset) ? page.offset : offset;
  const failedCount =
    status === 'failed' ? page?.total : failed.status === 'ready' ? failed.data : undefined;
  const started = (iso: string) => (sameDay(iso, now()) ? clockSeconds(iso) : shortWhen(iso, f));
  const duration = (createdAt: string, endedAt: string | null) =>
    endedAt
      ? t('common.seconds', {
          value: f.number((Date.parse(endedAt) - Date.parse(createdAt)) / 1000, {
            maximumFractionDigits: 1,
          }),
        })
      : '–';

  return (
    <section aria-labelledby="svc-log-h" className="stack">
      <div className="stack-xs">
        <Heading level={2} data-size="md" id="svc-log-h">
          {t('service.sectionLog')}
        </Heading>
        <Paragraph className="meta dv-lead">{t('serviceLog.intro')}</Paragraph>
      </div>
      <div role="search" className="dv-filters">
        <Field className="dv-filter-search">
          <Label htmlFor="svc-log-q">{t('serviceDev.searchLabel')}</Label>
          <Search>
            <Search.Input
              id="svc-log-q"
              placeholder={t('serviceDev.searchPlaceholder')}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </Search>
        </Field>
        <Field>
          <Label htmlFor="svc-log-period">{t('serviceDev.period')}</Label>
          <Select
            id="svc-log-period"
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value as Period);
              setOffset(0);
            }}
          >
            {periods.map(([value, key]) => (
              <Select.Option key={value} value={value}>
                {t(key)}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Field>
          <Label htmlFor="svc-log-status">{t('serviceLog.colStatus')}</Label>
          <Select
            id="svc-log-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            {statuses.map(([value, key]) => (
              <Select.Option key={value} value={value}>
                {t(key)}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Field>
          <Label htmlFor="svc-log-from">{t('serviceDev.fromLabel')}</Label>
          <Select
            id="svc-log-from"
            value={actor}
            onChange={(e) => {
              setActor(e.target.value);
              setOffset(0);
            }}
          >
            <Select.Option value="">{t('serviceDev.fromAll')}</Select.Option>
            <Select.Option value={meActor}>{t('serviceDev.fromMe')}</Select.Option>
            {[...seen.current].map(([value, label]) => (
              <Select.Option key={value} value={value}>
                {label}
              </Select.Option>
            ))}
          </Select>
        </Field>
        {names.length ? (
          <Field>
            <Label htmlFor="svc-log-env">{t('serviceLog.environment')}</Label>
            <Select
              id="svc-log-env"
              value={environment}
              onChange={(e) => {
                setEnvironment(e.target.value);
                setOffset(0);
              }}
            >
              <Select.Option value="">{t('serviceLog.allEnvironments')}</Select.Option>
              {names.map((name) => (
                <Select.Option key={name} value={name}>
                  {name}
                </Select.Option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
      {active.length ? (
        <div className="tag-row">
          <span className="meta">{t('serviceDev.filters')}</span>
          {active.map((a) => (
            <Tag key={a} data-size="sm" data-color="neutral">
              {a}
            </Tag>
          ))}
          <Button variant="tertiary" data-size="sm" onClick={reset}>
            {t('serviceDev.reset')}
          </Button>
        </div>
      ) : null}
      {state.status === 'loading' && !page ? (
        <Loading
          label={t('serviceLog.loading')}
          shape="table"
          columns={[
            t('serviceLog.colStarted'),
            t('serviceDev.colQuestion'),
            t('serviceLog.colBy'),
            t('serviceLog.colStatus'),
          ]}
          onRetry={retry}
        />
      ) : null}
      {state.status === 'error' ? <ErrorState error={state.error} onRetry={retry} /> : null}
      {page && rows.length === 0 ? (
        active.length ? (
          <Paragraph data-size="sm">{t('serviceDev.noMatch')}</Paragraph>
        ) : (
          <EmptyState title={t('serviceLog.emptyTitle')}>
            <p className="body-sm">{t('serviceLog.emptyBody')}</p>
          </EmptyState>
        )
      ) : null}
      {page && rows.length ? (
        <>
          <div tabIndex={0} role="region" aria-labelledby="svc-log-h" className="scroll-x">
            <Table data-size="sm" className="dv-log-table" aria-busy={pending || undefined}>
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell scope="col">{t('serviceLog.colStarted')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('serviceDev.colQuestion')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('serviceLog.colBy')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('serviceLog.colEnvironment')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('serviceLog.colStatus')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col" className="right">
                    {t('serviceDev.colDuration')}
                  </Table.HeaderCell>
                  <Table.HeaderCell scope="col" className="right">
                    {t('serviceLog.colTokens')}
                  </Table.HeaderCell>
                  <Table.HeaderCell scope="col" className="right">
                    {t('serviceLog.colCost')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {rows.map((r) => {
                  const s = statusText(r.status);
                  return (
                    <Table.Row key={r.id}>
                      <Table.Cell className="nowrap numeric">{started(r.createdAt)}</Table.Cell>
                      <Table.Cell className="dv-log-question">
                        <Link href={href(r.id)}>{r.excerpt || r.serviceName || r.id}</Link>
                        {r.failure ? (
                          <div className="meta danger-text">{r.failure.reason}</div>
                        ) : null}
                      </Table.Cell>
                      <Table.Cell>{byText(r, t)}</Table.Cell>
                      <Table.Cell>{r.environment ?? '–'}</Table.Cell>
                      <Table.Cell>
                        <Tag data-size="sm" data-color={s.color}>
                          {s.text}
                        </Tag>
                      </Table.Cell>
                      <Table.Cell className="right numeric">
                        {duration(r.createdAt, r.endedAt)}
                      </Table.Cell>
                      <Table.Cell className="right numeric">
                        {r.usage ? f.number(r.usage.inputTokens + r.usage.outputTokens) : '–'}
                      </Table.Cell>
                      <Table.Cell className="right numeric">
                        {r.usage ? kroner(r.usage.costMicroNok) : '–'}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
          <nav aria-label={t('qualityTabs.pages')} className="row-between">
            <span className="meta">
              {t(pageKeys[period], {
                from: f.number(at + 1),
                to: f.number(at + page.data.length),
                total: f.number(page.total),
              })}
              {failedCount ? ` ${t('serviceDev.failedCount', { count: failedCount })}` : ''}
              {page.q && page.searched !== undefined
                ? ` ${t('serviceDev.searched', { count: page.searched })}`
                : ''}
            </span>
            <span className="row-wrap align-end">
              <Field data-size="sm" className="dv-inline-field">
                <Label htmlFor="svc-log-size">{t('serviceDev.perPage')}</Label>
                <Select
                  id="svc-log-size"
                  value={String(size)}
                  onChange={(e) => {
                    setSize(Number(e.target.value));
                    setOffset(0);
                  }}
                >
                  {pageSizes.map((n) => (
                    <Select.Option key={n} value={String(n)}>
                      {n}
                    </Select.Option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="secondary"
                data-size="sm"
                aria-disabled={offset === 0 || undefined}
                onClick={() => offset > 0 && setOffset(Math.max(0, offset - size))}
              >
                {t('qualityTabs.previous')}
              </Button>
              <Button
                variant="secondary"
                data-size="sm"
                aria-disabled={offset + size >= page.total || undefined}
                onClick={() => offset + size < page.total && setOffset(offset + size)}
              >
                {t('qualityTabs.next')}
              </Button>
            </span>
          </nav>
        </>
      ) : null}
    </section>
  );
};
