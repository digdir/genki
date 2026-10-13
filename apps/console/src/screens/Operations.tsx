import {
  Alert,
  Button,
  Heading,
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api';
import { useT, type Format, type PlainKey, type T } from '../i18n';
import { useTenantNames } from '../tenant-names';
import { useAsync } from '../hooks';
import { useReason } from '../reason';
import { EmptyState, ErrorState, Loading } from '../states';
import type { OperationsOverview, QuarantinedDefinition, RunningTask } from '../types';
import { formatWhen, isMissing, PageHeader, TableRegion } from '../ui';

const endpointStatus = {
  normal: ['operations.endpointOk', 'success'],
  degraded: ['operations.endpointDegraded', 'warning'],
  down: ['operations.endpointDown', 'danger'],
} as const satisfies Record<string, readonly [PlainKey, string]>;

const rateStatus = {
  normal: ['operations.rateOk', 'success'],
  degraded: ['operations.rateDegraded', 'warning'],
  down: ['operations.endpointDown', 'danger'],
} as const satisfies Record<string, readonly [PlainKey, string]>;

const queueStatus = {
  running: ['operations.queueRunning', 'info'],
  waiting: ['operations.queueWaiting', 'neutral'],
  failed: ['operations.queueFailed', 'danger'],
} as const satisfies Record<string, readonly [PlainKey, string]>;

const statusLabel: Record<string, PlainKey> = {
  running: 'operations.taskRunning',
  queued: 'operations.taskQueued',
};

const rateComponents = ['Kjøringer', 'Innlesing'];

const formatLastSuccess = (value: string, f: Format, t: T) =>
  Number.isNaN(Date.parse(value)) ? value : formatWhen(value, f, t);

type Component = OperationsOverview['components'][number];

const alertOf = (c: Component, t: T) => {
  const down = c.status === 'down';
  const title = t(down ? 'operations.alertDown' : 'operations.alertSlow', { name: c.name });
  const text = [
    c.note,
    c.errorRate ? t('operations.alertErrorRate', { rate: c.errorRate }) : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return { color: down ? ('danger' as const) : ('warning' as const), title, text };
};

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

const Overview = ({ data, fetchedAt }: { data: OperationsOverview; fetchedAt: Date }) => {
  const t = useT();
  const f = useFormat();
  const troubled = [
    ...data.components.filter((c) => c.status === 'down'),
    ...data.components.filter((c) => c.status === 'degraded'),
  ];
  const endpoints = data.components.filter(
    (c) => c.name !== 'API' && !rateComponents.includes(c.name),
  );
  const rates = data.components.filter((c) => rateComponents.includes(c.name));
  const [queueHead, ...queueRest] = data.queueStats;
  return (
    <>
      {troubled.map((c) => {
        const a = alertOf(c, t);
        return (
          <Alert key={c.name} data-color={a.color}>
            <Heading level={2} data-size="2xs">
              {a.title}
            </Heading>
            {a.text ? <Paragraph>{a.text}</Paragraph> : null}
          </Alert>
        );
      })}
      <Paragraph data-size="sm" className="meta">
        {t('operations.fetched', { when: lowerFirst(formatWhen(fetchedAt.toISOString(), f, t)) })}
      </Paragraph>
      <div className="card-grid ops-grid">
        <section className="card stack" aria-labelledby="ep-h">
          <Heading level={2} data-size="2xs" id="ep-h">
            {t('operations.endpointsTitle')}
          </Heading>
          <ul className="plain ops-list">
            {endpoints.map((c) => (
              <li key={c.name}>
                <span className="two-line">
                  <span className="label-strong">{c.name}</span>
                  {c.note || c.p95 ? (
                    <span className="meta">
                      {[
                        c.note,
                        c.p95 && c.p95 !== '–'
                          ? t('operations.responseTime', { value: c.p95 })
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  ) : null}
                </span>
                <Tag data-size="sm" data-color={endpointStatus[c.status][1]}>
                  {t(endpointStatus[c.status][0])}
                </Tag>
              </li>
            ))}
          </ul>
        </section>
        <section className="card stack" aria-labelledby="fr-h">
          <Heading level={2} data-size="2xs" id="fr-h">
            {t('operations.errorRateTitle')}
          </Heading>
          {rates.length === 0 ? (
            <Paragraph data-size="sm">{t('operations.noErrorRate')}</Paragraph>
          ) : (
            <dl className="kpis">
              {rates.map((c) => (
                <div key={c.name}>
                  <dt>{c.name}</dt>
                  <dd>{c.errorRate ?? '–'}</dd>
                  <dd className="ops-rate">
                    <Tag data-size="sm" data-color={rateStatus[c.status][1]}>
                      {t(rateStatus[c.status][0])}
                    </Tag>
                    {c.note ? <span className="meta">{c.note}</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
        <section className="card stack" aria-labelledby="ik-h">
          <Heading level={2} data-size="2xs" id="ik-h">
            {t('operations.ingestQueue')}
          </Heading>
          {queueHead ? (
            <>
              <p className="ops-number">{queueHead.value}</p>
              <Paragraph data-size="sm">{queueHead.label}</Paragraph>
              {queueRest.length ? (
                <ul className="plain meta">
                  {queueRest.map((k) => (
                    <li key={k.label}>
                      {k.label}: {k.value}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <Paragraph data-size="sm">{t('operations.noQueue')}</Paragraph>
          )}
          {data.queue.length ? (
            <ul className="plain ops-list">
              {data.queue.map((q) => (
                <li key={`${q.status}/${q.what}/${q.age}`}>
                  <span className="two-line">
                    <span>{q.what}</span>
                    <span className="meta">
                      {[q.type, q.progress, q.age].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <Tag data-size="sm" data-color={queueStatus[q.status][1]}>
                    {t(queueStatus[q.status][0])}
                  </Tag>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section className="card stack" aria-labelledby="pl-h">
          <Heading level={2} data-size="2xs" id="pl-h">
            {t('operations.failedTriggers')}
          </Heading>
          {data.triggers.length === 0 ? (
            <Paragraph data-size="sm">{t('operations.noFailedTriggers')}</Paragraph>
          ) : (
            <ul className="plain ops-list">
              {data.triggers.map((trigger) => (
                <li key={`${trigger.tenant}/${trigger.what}`} className="two-line">
                  <span className="label-strong">{trigger.what}</span>
                  <span>{trigger.error}</span>
                  <span className="meta">
                    {[
                      trigger.tenant,
                      trigger.failedAt
                        ? t('operations.failedAt', { when: formatWhen(trigger.failedAt, f, t) })
                        : undefined,
                      t('operations.lastSuccess', {
                        when: trigger.lastSuccess
                          ? formatLastSuccess(trigger.lastSuccess, f, t)
                          : t('operations.never'),
                      }),
                      trigger.waiting,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card stack" aria-labelledby="he-h">
          <Heading level={2} data-size="2xs" id="he-h">
            {t('operations.incidents')}
          </Heading>
          {data.incidents.length === 0 ? (
            <Paragraph data-size="sm">{t('operations.noIncidents')}</Paragraph>
          ) : (
            <ul className="plain ops-list">
              {data.incidents.map((i) => (
                <li key={i.title} className="two-line">
                  <Heading level={3} data-size="2xs">
                    {i.title}
                  </Heading>
                  <span>{i.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
};

const HealthOnly = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.health(signal), [api]);
  if (state.status === 'loading') return <Loading label={t('operations.checkingApi')} />;
  if (state.status === 'error')
    return (
      <Alert data-color="danger" role="alert">
        {t('operations.apiDown')}{' '}
        <Button variant="tertiary" data-size="sm" onClick={retry}>
          {t('operations.checkAgain')}
        </Button>
      </Alert>
    );
  return (
    <section className="stack" aria-labelledby="helse-h">
      <Heading level={2} data-size="xs" id="helse-h">
        {t('operations.partsTitle')}
      </Heading>
      <Alert data-color="success" role="status" data-size="sm">
        {t('operations.apiUp', { version: state.data.version })}
      </Alert>
      <Paragraph data-size="sm" className="meta">
        {t('operations.partsNote')}
      </Paragraph>
    </section>
  );
};

const Running = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const tenantName = useTenantNames(api);
  const [tenant, setTenant] = useState('');
  const [service, setService] = useState('');
  const [state, retry] = useAsync(
    (signal) => api.runningTasks({ tenant: tenant.trim(), service: service.trim() }, signal),
    [api, tenant, service],
  );
  const [tasks, setTasks] = useState<RunningTask[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const reason = useReason();

  useEffect(() => {
    if (state.status === 'ready') setTasks(state.data);
  }, [state]);

  const cancel = async (task: RunningTask) => {
    const why = reason.require();
    if (!why) return;
    setMessage(undefined);
    try {
      await api.cancelTask(task.task, why);
      setTasks((all) => all.filter((x) => x.task !== task.task));
      setMessage({ ok: true, text: tRef.current('operations.taskCancelled', { task: task.task }) });
    } catch {
      setMessage({
        ok: false,
        text: tRef.current('operations.taskCancelFailed', { task: task.task }),
      });
    }
  };

  return (
    <section className="stack" aria-labelledby="kjor-h">
      <Heading level={2} data-size="xs" id="kjor-h">
        {t('operations.runningTitle')}
      </Heading>
      <div className="filters">
        <Textfield
          label={t('operations.tenant')}
          description={t('operations.orgNumber')}
          value={tenant}
          onChange={(e) => setTenant(e.target.value)}
        />
        <Textfield
          label={t('operations.service')}
          value={service}
          onChange={(e) => setService(e.target.value)}
        />
      </div>
      {reason.field(t('operations.cancelReasonHint'))}
      {message ? (
        <Alert
          data-color={message.ok ? 'success' : 'danger'}
          data-size="sm"
          role={message.ok ? 'status' : 'alert'}
        >
          {message.text}
        </Alert>
      ) : null}
      {state.status === 'loading' ? (
        <Loading label={t('operations.loadingRunning')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : tasks.length === 0 ? (
        <EmptyState title={t('operations.noRunningTitle')}>
          <Paragraph>
            {tenant || service ? t('operations.noMatch') : t('operations.allDone')}
          </Paragraph>
        </EmptyState>
      ) : (
        <TableRegion label={t('operations.runningLabel')}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('operations.colRun')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('operations.tenant')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('operations.service')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('operations.colStatus')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('operations.colChanged')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('operations.colAction')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.task}>
                  <TableCell>
                    <code>{task.task}</code>
                  </TableCell>
                  <TableCell>{tenantName(task.tenant)}</TableCell>
                  <TableCell>
                    {task.service ?? <span className="meta">{t('operations.unknown')}</span>}
                  </TableCell>
                  <TableCell>
                    <Tag data-size="sm" data-color={task.status === 'running' ? 'info' : 'neutral'}>
                      {statusLabel[task.status]
                        ? t(statusLabel[task.status] as PlainKey)
                        : task.status}
                    </Tag>
                  </TableCell>
                  <TableCell>{f.dateTime(task.at, 'short')}</TableCell>
                  <TableCell>
                    <Button
                      variant="secondary"
                      data-size="sm"
                      onClick={() => void cancel(task)}
                      aria-label={t('operations.cancelRun', { task: task.task })}
                    >
                      {t('operations.cancel')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableRegion>
      )}
    </section>
  );
};

const errorText = (e: QuarantinedDefinition['errors'][number]) =>
  typeof e === 'string' ? e : e.path ? `${e.path}: ${e.message}` : e.message;

const kindLabel: Record<string, PlainKey> = {
  Service: 'operations.kindService',
  StepFlow: 'operations.kindStepFlow',
  Skill: 'operations.kindSkill',
};

const Quarantine = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.quarantinedDefinitions(signal), [api]);
  const tenantName = useTenantNames(api);
  return (
    <section className="stack" aria-labelledby="karantene-h">
      <Heading level={2} data-size="xs" id="karantene-h">
        {t('operations.quarantineTitle')}
      </Heading>
      <Paragraph data-size="sm">{t('operations.quarantineText')}</Paragraph>
      {state.status === 'loading' ? (
        <Loading label={t('operations.loadingQuarantine')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : state.data.length === 0 ? (
        <Paragraph>{t('operations.noQuarantine')}</Paragraph>
      ) : (
        <TableRegion label={t('operations.quarantineLabel')}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('operations.colDefinition')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('operations.tenant')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('operations.colError')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('operations.colQuarantined')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {state.data.map((d) => (
                <TableRow key={`${d.tenant}/${d.kind}/${d.id}/${d.version ?? ''}`}>
                  <TableCell>
                    <span className="two-line">
                      <span className="label-strong">{d.id}</span>
                      <span className="meta">
                        {kindLabel[d.kind] ? t(kindLabel[d.kind] as PlainKey) : d.kind}
                        {d.version === undefined
                          ? ''
                          : t('operations.version', { version: d.version })}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>{tenantName(d.tenant)}</TableCell>
                  <TableCell className="sm">
                    <ul className="plain">
                      {d.errors.map((e) => (
                        <li key={errorText(e)}>{errorText(e)}</li>
                      ))}
                    </ul>
                  </TableCell>
                  <TableCell className="sm nowrap">{formatWhen(d.at, f, t)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableRegion>
      )}
    </section>
  );
};

const refreshMs = 60_000;

export const Operations = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const [tick, setTick] = useState(0);
  const [state, retry] = useAsync((signal) => api.operations(signal), [api, tick]);
  const [shown, setShown] = useState<{ data: OperationsOverview; at: Date } | undefined>();
  useEffect(() => {
    if (state.status === 'ready') setShown({ data: state.data, at: new Date() });
  }, [state]);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), refreshMs);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <PageHeader
        eyebrow={t('operations.eyebrow')}
        title={t('operations.title')}
        intro={t('operations.intro')}
      />
      {shown ? (
        <Overview data={shown.data} fetchedAt={shown.at} />
      ) : state.status === 'loading' ? (
        <Loading label={t('operations.loading')} />
      ) : state.status === 'error' ? (
        isMissing(state.error) ? (
          <HealthOnly api={api} />
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )
      ) : null}
      <Running api={api} />
      <Quarantine api={api} />
    </>
  );
};
