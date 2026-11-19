import { Alert, Button, Heading, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api';
import type { ComponentStatus, TenantStatus } from '../../api/platform-status';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import { Loading } from '../../states';

type Component = TenantStatus['components'][number] & {
  how?: string;
  degradedBy?: 'latency' | 'errors';
};

type Status = TenantStatus & {
  components: Component[];
  pastIncidents?: { date: string; title: string; text: string }[];
};

export const pollMs = 60_000;

export const shortVersion = (version: string) =>
  /^[0-9a-f]{8,40}$/i.test(version) ? version.slice(0, 7) : version;

const statusLabels: Record<ComponentStatus, PlainKey> = {
  normal: 'platformStatus.statusNormal',
  degraded: 'platformStatus.statusDegraded',
  down: 'platformStatus.statusDown',
};

const statusColors: Record<ComponentStatus, 'success' | 'warning' | 'danger'> = {
  normal: 'success',
  degraded: 'warning',
  down: 'danger',
};

const queueLabels: Record<TenantStatus['queue'][number]['status'], PlainKey> = {
  running: 'platformStatus.queueRunning',
  waiting: 'platformStatus.queueWaiting',
  failed: 'platformStatus.queueFailed',
};

const serverComponents = (status: Status): Component[] =>
  status.components.filter((c) => c.name !== 'API');

export const overallStatus = (status: Status): ComponentStatus => {
  const states = serverComponents(status).map((c) => c.status);
  if (states.includes('down')) return 'down';
  if (states.includes('degraded') || status.incidents.length > 0) return 'degraded';
  return 'normal';
};

const statusLabel = (c: Component): PlainKey =>
  c.status === 'degraded' && c.degradedBy === 'latency' ? 'devStatus.slow' : statusLabels[c.status];

const Summary = ({ status }: { status: Status }) => {
  const t = useT();
  const overall = overallStatus(status);
  const slowOnly =
    overall === 'degraded' &&
    status.incidents.length === 0 &&
    serverComponents(status)
      .filter((c) => c.status !== 'normal')
      .every((c) => c.degradedBy === 'latency');
  const affected = serverComponents(status)
    .filter((c) => c.status !== 'normal')
    .map((c) => c.name);
  return (
    <div role="status" className={`dev-status-summary ${overall}`}>
      <strong>
        {overall === 'normal'
          ? t('platformStatus.allWorks')
          : overall === 'down'
            ? t('platformStatus.somethingDown')
            : slowOnly
              ? t('devStatus.somethingSlow')
              : t('platformStatus.somethingDegraded')}
      </strong>
      <span>
        {overall === 'normal'
          ? t('platformStatus.allWorksText')
          : affected.length > 0
            ? t('platformStatus.affects', { names: affected.join(', ') })
            : t('platformStatus.incidentOpen')}
      </span>
    </div>
  );
};

export const DevStatus = ({
  api,
  tenant,
  now = () => new Date(),
}: {
  api: Pick<ApiClient, 'getHealth' | 'cache' | 'platformStatus'>;
  tenant: string;
  now?: () => Date;
}) => {
  const t = useT();
  const f = useFormat();
  const [health, retry] = useAsync(
    async (signal) => {
      const started = performance.now();
      const result: { environment?: string } & Awaited<ReturnType<ApiClient['getHealth']>> =
        await api.getHealth(signal);
      return { ...result, ms: Math.round(performance.now() - started), at: now() };
    },
    [api],
    { keepPreviousFor: tenant },
  );
  const [status, retryStatus] = useAsync(
    async (signal): Promise<Status> => api.platformStatus.tenant(tenant, signal),
    [api, tenant],
    { keepPreviousFor: tenant },
  );
  const [lastKnown, setLastKnown] = useState<{ ok: boolean; at: Date }>();
  useEffect(() => {
    if (status.status === 'ready' && health.status === 'ready')
      setLastKnown({ ok: overallStatus(status.data) === 'normal', at: health.data.at });
  }, [status, health]);
  const loading = health.status === 'loading' || status.status === 'loading';
  const checkNow = () => {
    api.cache.invalidate();
    retry();
    retryStatus();
  };
  const checkRef = useRef(checkNow);
  checkRef.current = checkNow;
  useEffect(() => {
    const timer = setInterval(() => checkRef.current(), pollMs);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="stack-md">
      <div className="int-intro">
        <Paragraph className="meta int-intro-text">
          {health.status === 'ready'
            ? t('devStatus.checked', { time: f.time(health.data.at) })
            : t('app.statusIntro')}
        </Paragraph>
        <Button
          variant="secondary"
          aria-disabled={loading || undefined}
          onClick={() => !loading && checkNow()}
        >
          {loading ? t('devStatus.checking') : t('devTools.statusCheckNow')}
        </Button>
      </div>
      {loading ? (
        <Loading label={t('app.statusChecking')} shape="list" onRetry={retry} />
      ) : health.status === 'error' ? (
        <Alert data-color="danger">
          <Heading level={3} data-size="xs">
            {t('devTools.statusNoContact')}
          </Heading>
          <Paragraph>{t('devTools.statusNoContactText')}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={checkNow}>
            {t('app.statusCheckAgain')}
          </Button>
        </Alert>
      ) : health.status === 'ready' ? (
        <>
          {status.status === 'error' ? (
            <Alert data-color="warning">
              <Heading level={3} data-size="xs">
                {t('platformStatus.noContact')}
              </Heading>
              <Paragraph>
                {t('platformStatus.noContactText')}
                {lastKnown
                  ? ` ${t(lastKnown.ok ? 'devStatus.lastKnownOk' : 'devStatus.lastKnownNotOk', {
                      time: f.time(lastKnown.at),
                    })}`
                  : null}
              </Paragraph>
              <Button variant="secondary" data-size="sm" onClick={checkNow}>
                {t('common.tryAgain')}
              </Button>
            </Alert>
          ) : status.status === 'ready' ? (
            <Summary status={status.data} />
          ) : null}
          {status.status === 'ready' && status.data.incidents.length > 0 ? (
            <section aria-labelledby="ds-incidents" className="stack-sm">
              <Heading level={3} data-size="2xs" id="ds-incidents">
                {t('platformStatus.incidents')}
              </Heading>
              <ul className="plain-list stack-sm">
                {status.data.incidents.map((incident, i) => (
                  <li key={`${incident.title}-${i}`} className="dev-status-incident">
                    <strong>{incident.title}</strong>
                    <span>{incident.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="ds-checks" className="stack-sm">
            <Heading level={3} data-size="2xs" id="ds-checks">
              {t('devTools.statusWhatWeCheck')}
            </Heading>
            <ul className="plain-list dev-status-checks">
              <li>
                <span className="stack-xs">
                  <strong>{t('devTools.statusApiCheck')}</strong>
                  <span className="meta">{t('devStatus.apiHow')}</span>
                </span>
                <Tag data-size="sm" data-color="success">
                  {t('platformStatus.statusNormal')}
                </Tag>
                <span className="meta">
                  {t('devTools.statusAnsweredIn', { ms: health.data.ms })}
                </span>
              </li>
              {status.status === 'ready'
                ? serverComponents(status.data).map((c) => (
                    <li key={c.name}>
                      <span className="stack-xs">
                        <strong>{c.name}</strong>
                        {c.how ? <span className="meta">{c.how}</span> : null}
                      </span>
                      <Tag data-size="sm" data-color={statusColors[c.status]}>
                        {t(statusLabel(c))}
                      </Tag>
                      <span className="meta">
                        {c.note ??
                          (c.errorRate
                            ? t('platformStatus.failedShare', { rate: c.errorRate })
                            : '')}
                      </span>
                    </li>
                  ))
                : null}
            </ul>
          </section>
          {status.status === 'ready' && status.data.queue.length > 0 ? (
            <section aria-labelledby="ds-queue" className="stack-sm">
              <Heading level={3} data-size="2xs" id="ds-queue">
                {t('platformStatus.queue')}
              </Heading>
              <ul className="plain-list dev-status-checks">
                {status.data.queue.map((q) => (
                  <li key={`${q.what}-${q.at}`}>
                    <span className="stack-xs">
                      <strong>{q.what}</strong>
                      <span className="meta">{q.type}</span>
                    </span>
                    <Tag data-size="sm" data-color={q.status === 'failed' ? 'danger' : 'info'}>
                      {t(queueLabels[q.status])}
                    </Tag>
                    <span className="meta">{t('platformStatus.queueAge', { age: q.age })}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {status.status === 'ready' && status.data.triggers.length > 0 ? (
            <section aria-labelledby="ds-schedules" className="stack-sm">
              <Heading level={3} data-size="2xs" id="ds-schedules">
                {t('platformStatus.failingSchedules')}
              </Heading>
              <ul className="plain-list dev-status-checks">
                {status.data.triggers.map((s) => (
                  <li key={`${s.what}-${s.failedAt}`}>
                    <span className="stack-xs">
                      <strong>{s.what}</strong>
                      <span className="meta">{s.error}</span>
                    </span>
                    <Tag data-size="sm" data-color="danger">
                      {t('platformStatus.statusDown')}
                    </Tag>
                    <span className="meta">
                      {t('platformStatus.failedAt', { when: f.dateTime(s.failedAt) })}
                      {' · '}
                      {s.lastSuccess
                        ? t('platformStatus.lastSuccess', { when: f.dateTime(s.lastSuccess) })
                        : t('platformStatus.noLastSuccess')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <dl className="kv">
            <dt>{t('app.statusVersion')}</dt>
            <dd>
              {health.data.builtAt ? (
                <>
                  {f.date(health.data.builtAt)}
                  {' · '}
                </>
              ) : null}
              <code>{shortVersion(health.data.version)}</code>
            </dd>
            {health.data.environment ? (
              <>
                <dt>{t('devStatus.environment')}</dt>
                <dd>{health.data.environment}</dd>
              </>
            ) : null}
            {health.data.lockdown === undefined ? null : (
              <>
                <dt>{t('devTools.statusLockdown')}</dt>
                <dd>
                  {health.data.lockdown
                    ? t('devTools.statusLockdownOn')
                    : t('devTools.statusLockdownOff')}
                </dd>
              </>
            )}
          </dl>
          {status.status === 'ready' && status.data.pastIncidents?.length ? (
            <section aria-labelledby="ds-past" className="stack-sm">
              <Heading level={3} data-size="2xs" id="ds-past">
                {t('devStatus.pastIncidents')}
              </Heading>
              <ul className="plain-list stack-sm">
                {status.data.pastIncidents.map((incident) => (
                  <li key={`${incident.date}-${incident.title}`} className="dev-status-incident">
                    <strong>{f.date(incident.date)}</strong>
                    <span>
                      {incident.title}. {incident.text}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
};
