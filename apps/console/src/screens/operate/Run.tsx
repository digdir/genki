import { useFormat } from '@genai/i18n/react';
import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import type { RunTimeline } from '../../operator-types';
import { ErrorState, Loading } from '../../states';
import { useTenantNames } from '../../tenant-names';
import { Chip, clock, dayMonth, orgHref, sameDay, type Tone } from './parts';
import './operate.css';

const runStatus: Record<RunTimeline['status'], [Tone, PlainKey]> = {
  failed: ['danger', 'run.statusFailed'],
  completed: ['success', 'run.statusCompleted'],
  running: ['info', 'run.statusRunning'],
  interrupted: ['warning', 'run.statusInterrupted'],
  cancelled: ['neutral', 'run.statusCancelled'],
};

const osloDate = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });

const failedStep = (step: RunTimeline['steps'][number]) =>
  step.state === 'failed' || step.type === 'error';

const EyeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
    <path
      d="M1.5 9S4.5 3.5 9 3.5 16.5 9 16.5 9 13.5 14.5 9 14.5 1.5 9 1.5 9zM9 11.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
  </svg>
);

const useContentReason = (api: ApiClient, tenant: string, ready: boolean) => {
  const [state] = useAsync(
    async (signal) => {
      if (!ready) return undefined;
      const known = api.knownContentReason(tenant);
      if (known) return known;
      const me = api.actor();
      if (!me) return undefined;
      const page = await api
        .auditPage(
          {
            tenant,
            action: 'platform.content.reason',
            by: 'operator',
            from: osloDate(new Date()),
            limit: 50,
          },
          signal,
        )
        .catch(() => undefined);
      const today = osloDate(new Date());
      return page?.data.find(
        (e) =>
          e.actorName === me &&
          e.action === 'platform.content.reason' &&
          e.tenant === tenant &&
          osloDate(new Date(e.at)) === today,
      )?.reason;
    },
    [api, tenant, ready],
  );
  return state.status === 'ready' ? state.data : undefined;
};

export const Run = ({ api, tenant, task }: { api: ApiClient; tenant: string; task: string }) => {
  const t = useT();
  const f = useFormat();
  const name = useTenantNames(api);
  const [state, retry] = useAsync(
    (signal) => api.timeline(tenant, task, signal) as Promise<RunTimeline>,
    [api, tenant, task],
  );
  const reason = useContentReason(api, tenant, state.status === 'ready');
  const crumbs = (
    <nav aria-label={t('run.crumbs')} className="op-crumbs">
      <a href="#/tenants">{t('run.crumbTenants')}</a> <span aria-hidden="true">›</span>{' '}
      <a href={orgHref(tenant)}>{name(tenant)}</a> <span aria-hidden="true">›</span>{' '}
      <a href={orgHref(tenant, 'log')}>{t('run.crumbLog')}</a> <span aria-hidden="true">›</span>{' '}
      <span aria-current="page">{task}</span>
    </nav>
  );
  if (state.status !== 'ready')
    return (
      <div className="op-page mid">
        {crumbs}
        <h1>{t('run.title', { task })}</h1>
        {state.status === 'loading' ? (
          <Loading label={t('run.loading')} shape="detail" onRetry={retry} />
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )}
      </div>
    );
  const run = state.data;
  const [tone, label] = runStatus[run.status];
  const model = run.steps.find((s) => s.model)?.model ?? run.stats?.byModel?.[0]?.model;
  const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  const started = sameDay(new Date(run.startedAt), new Date())
    ? t('run.todayAt', { time: clock(run.startedAt, f) })
    : `${dayMonth(run.startedAt, f)} ${clock(run.startedAt, f)}`;
  const blocks = run.steps.flatMap((s) => s.blocks.map((b) => ({ step: s, block: b })));
  const input = blocks.find((b) => b.step.type === 'trigger' && b.block.kind === 'quote')?.block
    .text;
  const output = blocks.findLast((b) => b.block.kind === 'answer')?.block.text;
  const service = run.serviceName ?? run.service;
  return (
    <div className="op-page mid">
      {crumbs}
      <div className="op-run-head">
        <div className="op-title-row">
          <h1>{t('run.title', { task: run.id })}</h1>
          <Chip tone={tone}>{t(label)}</Chip>
        </div>
        {reason ? (
          <p className="op-run-reason">
            <EyeIcon />
            {t('run.reason', { reason })}
          </p>
        ) : null}
      </div>
      <dl className="op-facts">
        <div>
          <dt>{t('run.service')}</dt>
          <dd>
            {run.version === undefined
              ? service
              : t('run.serviceEdition', { service, version: run.version })}
          </dd>
        </div>
        <div>
          <dt>{t('run.started')}</dt>
          <dd>{started}</dd>
        </div>
        <div>
          <dt>{t('run.duration')}</dt>
          <dd>{t('run.seconds', { seconds: f.decimal(run.durationSeconds, 1) })}</dd>
        </div>
        {model ? (
          <div>
            <dt>{t('run.model')}</dt>
            <dd>{model}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t('run.tokens')}</dt>
          <dd>{f.number(tokens)}</dd>
        </div>
      </dl>
      <section aria-labelledby="k-steps" className="op-section">
        <h2 id="k-steps">{t('run.steps')}</h2>
        <ol className="op-rows steps">
          {run.steps.map((s) => (
            <li key={s.id}>
              <span className="when">{t('run.seconds', { seconds: f.decimal(s.at, 1) })}</span>
              <span className="what">{s.title}</span>
              {failedStep(s) && s.summary ? <Chip tone="danger">{s.summary}</Chip> : null}
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="k-in" className="op-section">
        <h2 id="k-in">{t('run.input')}</h2>
        <p className={input ? 'op-box' : 'op-box empty'}>{input ?? t('run.noInput')}</p>
      </section>
      <section aria-labelledby="k-out" className="op-section">
        <h2 id="k-out">{t('run.output')}</h2>
        <p className={output ? 'op-box' : 'op-box empty'}>
          {output ?? (run.status === 'failed' ? t('run.noOutputFailed') : t('run.noOutput'))}
        </p>
      </section>
    </div>
  );
};
