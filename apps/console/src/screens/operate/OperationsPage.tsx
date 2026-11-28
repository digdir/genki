import { useFormat } from '@genai/i18n/react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type Format, type T } from '../../i18n';
import type { Incident } from '../../operator-types';
import { ErrorState, Loading } from '../../states';
import { useTenantNames } from '../../tenant-names';
import type { OperationsOverview } from '../../types';
import { Flash, isMissing, useFlash } from '../../ui';
import {
  Chip,
  clock,
  dayMonth,
  OperateDialog,
  orgHref,
  runHref,
  sameDay,
  useKept,
  type Tone,
} from './parts';
import './operate.css';

const refreshMs = 60_000;
const runComponents = new Set(['Kjøringer', 'Runs']);
const modelPrefix = /^(?:Modeller|Models): /;

const since = (iso: string, f: Format, t: T, now: Date) =>
  t('operating.since', {
    time: sameDay(new Date(iso), now) ? clock(iso, f) : `${dayMonth(iso, f)} ${clock(iso, f)}`,
  });

const durationText = (from: string, to: string, t: T) => {
  const minutes = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return t('operating.minutes', { minutes });
  return minutes % 60
    ? t('operating.hoursMinutes', { hours, minutes: minutes % 60 })
    : t('operating.hours', { hours });
};

const modelStatus: Record<
  string,
  [Tone, 'operating.normal' | 'operating.slow' | 'operating.down']
> = {
  normal: ['success', 'operating.normal'],
  degraded: ['warning', 'operating.slow'],
  down: ['danger', 'operating.down'],
};

const Tabs = ({ current, open }: { current: 'overview' | 'incidents'; open: number }) => {
  const t = useT();
  const tab = (key: 'overview' | 'incidents', href: string, label: string, count?: number) => (
    <li>
      <a
        href={href}
        aria-current={current === key ? 'page' : undefined}
        className={current === key ? 'active' : undefined}
      >
        {label}
        {count ? <Chip tone="warning">{count}</Chip> : null}
      </a>
    </li>
  );
  return (
    <nav aria-label={t('operating.tabs')} className="section-tabs">
      <ul>
        {tab('overview', '#/operations', t('operating.tabOverview'))}
        {tab('incidents', '#/operations?tab=incidents', t('operating.tabIncidents'), open)}
      </ul>
    </nav>
  );
};

const TenantLinks = ({ tenants, name }: { tenants: string[]; name: (org: string) => string }) => {
  const t = useT();
  if (tenants.length === 0) return <>{t('operating.allTenants')}</>;
  return (
    <>
      {tenants.map((org, i) => (
        <span key={org}>
          {i > 0 ? ', ' : null}
          <a href={orgHref(org)}>{name(org)}</a>
        </span>
      ))}
    </>
  );
};

const ResolveDialog = ({
  api,
  incident,
  onClose,
  onDone,
}: {
  api: ApiClient;
  incident: Incident | undefined;
  onClose: () => void;
  onDone: () => void;
}) => {
  const t = useT();
  return (
    <OperateDialog
      open={Boolean(incident)}
      title={incident ? t('operating.resolveTitle', { title: incident.title }) : ''}
      lead={t('operating.resolveText')}
      cta={t('operating.resolveCta')}
      onClose={onClose}
      onConfirm={async (reason) => {
        if (!incident) return;
        await api.resolveIncident(incident.id, reason);
        onDone();
      }}
    />
  );
};

const NewIncidentDialog = ({
  api,
  open,
  onClose,
  onDone,
}: {
  api: ApiClient;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) => {
  const t = useT();
  const id = useId();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [missing, setMissing] = useState<{ title?: boolean; text?: boolean }>({});
  const [tenants] = useAsync((signal) => api.listTenants(signal), [api]);
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setText('');
    setPicked([]);
    setMissing({});
  }, [open]);
  return (
    <OperateDialog
      open={open}
      title={t('operating.newIncident')}
      cta={t('operating.createCta')}
      onClose={onClose}
      validate={() => {
        const next = { title: !title.trim(), text: !text.trim() };
        setMissing(next);
        return !next.title && !next.text;
      }}
      onConfirm={async (reason) => {
        await api.createIncident(
          { title: title.trim(), text: text.trim(), ...(picked.length ? { tenants: picked } : {}) },
          reason,
        );
        onDone();
      }}
    >
      <div className="op-field">
        <label htmlFor={`${id}-title`}>{t('operating.fieldTitle')}</label>
        <input
          id={`${id}-title`}
          className="op-input"
          value={title}
          maxLength={200}
          aria-invalid={missing.title || undefined}
          aria-describedby={missing.title ? `${id}-title-e` : undefined}
          onChange={(e) => setTitle(e.target.value)}
        />
        {missing.title ? (
          <p id={`${id}-title-e`} className="op-error">
            {t('operating.titleMissing')}
          </p>
        ) : null}
      </div>
      <div className="op-field">
        <label htmlFor={`${id}-text`}>{t('operating.fieldText')}</label>
        <textarea
          id={`${id}-text`}
          className="op-input"
          rows={3}
          value={text}
          maxLength={4000}
          aria-invalid={missing.text || undefined}
          aria-describedby={missing.text ? `${id}-text-e` : undefined}
          onChange={(e) => setText(e.target.value)}
        />
        {missing.text ? (
          <p id={`${id}-text-e`} className="op-error">
            {t('operating.textMissing')}
          </p>
        ) : null}
      </div>
      {tenants.status === 'ready' && tenants.data.length > 0 ? (
        <fieldset className="op-tenant-picks" aria-describedby={`${id}-tenants-d`}>
          <legend>{t('operating.fieldTenants')}</legend>
          <span id={`${id}-tenants-d`} className="op-subtle">
            {t('operating.fieldTenantsHint')}
          </span>
          {tenants.data.map((x) => (
            <label key={x.orgNumber} className="op-check">
              <input
                type="checkbox"
                checked={picked.includes(x.orgNumber)}
                onChange={() =>
                  setPicked((p) =>
                    p.includes(x.orgNumber)
                      ? p.filter((o) => o !== x.orgNumber)
                      : [...p, x.orgNumber],
                  )
                }
              />
              {x.name}
            </label>
          ))}
        </fieldset>
      ) : null}
    </OperateDialog>
  );
};

const Models = ({ overview }: { overview: OperationsOverview }) => {
  const t = useT();
  const models = overview.components.filter((c) => modelPrefix.test(c.name));
  return (
    <section aria-labelledby="d-models" className="op-section">
      <h2 id="d-models">{t('operating.modelsTitle')}</h2>
      {models.length === 0 ? (
        <p className="op-subtle">{t('operating.noModels')}</p>
      ) : (
        <div
          tabIndex={0}
          role="region"
          aria-label={t('operating.modelsTitle')}
          className="op-table-wrap"
        >
          <table className="op-table">
            <thead>
              <tr>
                <th scope="col">{t('operating.colModel')}</th>
                <th scope="col">{t('operating.colP95')}</th>
                <th scope="col" className="last">
                  {t('operating.colStatus')}
                </th>
              </tr>
            </thead>
            <tbody>
              {models.map((c) => {
                const [tone, label] = modelStatus[c.status] ?? ['neutral', 'operating.normal'];
                return (
                  <tr key={c.name}>
                    <td>{c.name.replace(modelPrefix, '')}</td>
                    <td>{c.p95 ?? '–'}</td>
                    <td className="last">
                      <Chip tone={tone}>{t(label)}</Chip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

type Component = OperationsOverview['components'][number];

const ComponentAlert = ({ component }: { component: Component }) => {
  const t = useT();
  const down = component.status === 'down';
  const text = [
    component.note,
    component.errorRate ? t('operations.alertErrorRate', { rate: component.errorRate }) : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const id = `d-part-${component.name.replace(/\W+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="op-banner" data-tone={down ? 'danger' : 'warning'}>
      <div>
        <h2 id={id}>
          {t(down ? 'operations.alertDown' : 'operations.alertSlow', { name: component.name })}
        </h2>
        {text ? <span>{text}</span> : null}
      </div>
    </section>
  );
};

const ApiHealth = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.health(signal), [api]);
  if (state.status === 'loading') return <Loading label={t('operations.checkingApi')} />;
  if (state.status === 'error')
    return (
      <p role="alert" className="op-banner" data-tone="danger">
        {t('operations.apiDown')}{' '}
        <button type="button" className="op-btn" onClick={retry}>
          {t('operations.checkAgain')}
        </button>
      </p>
    );
  return (
    <p role="status" className="op-subtle">
      {t('operations.apiUp', { version: state.data.version })}
    </p>
  );
};

const Overview = ({
  api,
  tick,
  changed,
  onChanged,
  after,
}: {
  api: ApiClient;
  tick: number;
  changed: number;
  onChanged: () => void;
  after?: ReactNode;
}) => {
  const t = useT();
  const f = useFormat();
  const name = useTenantNames(api);
  const flash = useFlash();
  const [resolving, setResolving] = useState<Incident | undefined>();
  const [opsState, opsRetry] = useAsync((signal) => api.operations(signal), [api, tick]);
  const [incState] = useAsync((signal) => api.incidents(signal), [api, tick, changed]);
  const [failedState, failedRetry] = useAsync(
    (signal) => api.failedRuns(undefined, signal),
    [api, tick],
  );
  const overview = useKept(opsState);
  const incidents = useKept(incState) ?? [];
  const failed = useKept(failedState);
  const now = new Date();
  const open = incidents.filter((i) => !i.resolvedAt);
  const rate = overview?.components.find((c) => runComponents.has(c.name))?.errorRate;
  return (
    <div className="op-page roomy">
      <div className="op-head baseline">
        <h1>{t('operating.title')}</h1>
        {overview ? (
          <span className="op-subtle">
            {rate ? t('operating.errorRate', { rate }) : t('operating.noRuns')}
          </span>
        ) : null}
      </div>
      <Tabs current="overview" open={open.length} />
      <Flash message={flash.message} />
      {overview?.components
        .filter(
          (c) => !modelPrefix.test(c.name) && (c.status === 'down' || c.status === 'degraded'),
        )
        .sort((a, b) => Number(b.status === 'down') - Number(a.status === 'down'))
        .map((c) => (
          <ComponentAlert key={c.name} component={c} />
        ))}
      {incState.status === 'error' && !incidents.length ? (
        <ErrorState error={incState.error} />
      ) : null}
      {open.map((incident) => (
        <section key={incident.id} aria-labelledby={`d-inc-${incident.id}`} className="op-banner">
          <div>
            <h2 id={`d-inc-${incident.id}`}>
              {t('operating.incidentBanner', { title: incident.title })}
            </h2>
            <span>
              {since(incident.startedAt, f, t, now)} ·{' '}
              {incident.tenants.length === 0
                ? t('operating.allTenants')
                : incident.tenants.map(name).join(', ')}
            </span>
          </div>
          <button type="button" className="op-btn" onClick={() => setResolving(incident)}>
            {t('operating.resolve')}
          </button>
        </section>
      ))}
      <section aria-labelledby="d-fail" className="op-section">
        <h2 id="d-fail">
          {t('operating.failedTitle')}{' '}
          {failed ? (
            <span className="op-light">{t('operating.failedCount', { count: failed.length })}</span>
          ) : null}
        </h2>
        {failed ? (
          failed.length === 0 ? (
            <p className="op-subtle">{t('operating.noFailed')}</p>
          ) : (
            <div
              tabIndex={0}
              role="region"
              aria-label={t('operating.failedLabel')}
              className="op-table-wrap"
            >
              <table className="op-table w760">
                <thead>
                  <tr>
                    <th scope="col">{t('operating.colTime')}</th>
                    <th scope="col">{t('operating.colTenant')}</th>
                    <th scope="col">{t('operating.colService')}</th>
                    <th scope="col">{t('operating.colCause')}</th>
                    <th scope="col" className="last">
                      {t('operating.colRun')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {failed.map((r) => (
                    <tr key={`${r.tenant}/${r.task}`}>
                      <td>{clock(r.at, f)}</td>
                      <td>
                        <a href={orgHref(r.tenant)}>{r.tenantName}</a>
                      </td>
                      <td>{r.serviceName ?? r.service ?? '–'}</td>
                      <td>{r.failure?.reason ?? t('operating.unknownCause')}</td>
                      <td className="last">
                        <a
                          href={runHref(r.tenant, r.task)}
                          aria-label={t('operating.runFor', { task: r.task })}
                        >
                          {r.task}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : failedState.status === 'error' ? (
          <ErrorState error={failedState.error} onRetry={failedRetry} />
        ) : (
          <Loading label={t('operating.loading')} />
        )}
      </section>
      {overview ? (
        <Models overview={overview} />
      ) : opsState.status === 'error' ? (
        isMissing(opsState.error) ? (
          <ApiHealth api={api} />
        ) : (
          <ErrorState error={opsState.error} onRetry={opsRetry} />
        )
      ) : null}
      {after}
      <ResolveDialog
        api={api}
        incident={resolving}
        onClose={() => setResolving(undefined)}
        onDone={() => {
          flash.show(t('operating.resolved'));
          onChanged();
        }}
      />
    </div>
  );
};

const Incidents = ({
  api,
  changed,
  onChanged,
}: {
  api: ApiClient;
  changed: number;
  onChanged: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const name = useTenantNames(api);
  const flash = useFlash();
  const [creating, setCreating] = useState(false);
  const [state, retry] = useAsync((signal) => api.incidents(signal), [api, changed]);
  const incidents = useKept(state);
  const now = new Date();
  const open = incidents?.filter((i) => !i.resolvedAt) ?? [];
  const resolved = incidents?.filter((i) => i.resolvedAt) ?? [];
  return (
    <div className="op-page mid">
      <div className="op-head">
        <h1>{t('operating.title')}</h1>
        <div className="op-actions">
          <button type="button" className="op-btn primary" onClick={() => setCreating(true)}>
            {t('operating.newIncident')}
          </button>
        </div>
      </div>
      <Tabs current="incidents" open={open.length} />
      <Flash message={flash.message} />
      {!incidents ? (
        state.status === 'error' ? (
          <ErrorState error={state.error} onRetry={retry} />
        ) : (
          <Loading label={t('operating.loadingIncidents')} />
        )
      ) : (
        <>
          {open.length === 0 ? <p className="op-subtle">{t('operating.noOpen')}</p> : null}
          {open.map((i) => (
            <section key={i.id} aria-labelledby={`h-open-${i.id}`} className="op-card">
              <div className="op-title-row">
                <h2 id={`h-open-${i.id}`}>{i.title}</h2>
                <Chip tone="info">{t('operating.onStatusPage')}</Chip>
              </div>
              <span className="op-subtle">
                {since(i.startedAt, f, t, now)} · <TenantLinks tenants={i.tenants} name={name} />
              </span>
              <ol className="op-rows">
                <li>
                  <span className="when">{clock(i.startedAt, f)}</span>
                  <span className="what">{i.text}</span>
                </li>
              </ol>
            </section>
          ))}
          <section aria-labelledby="h-old" className="op-section">
            <h2 id="h-old">{t('operating.resolvedTitle')}</h2>
            {resolved.length === 0 ? (
              <p className="op-subtle">{t('operating.noResolved')}</p>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-label={t('operating.resolvedLabel')}
                className="op-table-wrap"
              >
                <table className="op-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('operating.colIncident')}</th>
                      <th scope="col">{t('operating.colLasted')}</th>
                      <th scope="col">{t('operating.colReach')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolved.map((i) => (
                      <tr key={i.id}>
                        <td>{i.title}</td>
                        <td>
                          {t('operating.lasted', {
                            date: dayMonth(i.startedAt, f),
                            duration: durationText(i.startedAt, i.resolvedAt ?? i.startedAt, t),
                          })}
                        </td>
                        <td>
                          {i.tenants.length === 0
                            ? t('operating.reachAll')
                            : t('operating.reachCount', { count: i.tenants.length })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      <NewIncidentDialog
        api={api}
        open={creating}
        onClose={() => setCreating(false)}
        onDone={() => {
          flash.show(t('operating.created'));
          onChanged();
        }}
      />
    </div>
  );
};

export const OperationsPage = ({
  api,
  tab,
  after,
}: {
  api: ApiClient;
  tab?: string | undefined;
  after?: (tick: number) => ReactNode;
}) => {
  const [tick, setTick] = useState(0);
  const [changed, setChanged] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), refreshMs);
    return () => clearInterval(timer);
  }, []);
  const onChanged = () => setChanged((n) => n + 1);
  return tab === 'incidents' ? (
    <Incidents api={api} changed={changed} onChanged={onChanged} />
  ) : (
    <Overview api={api} tick={tick} changed={changed} onChanged={onChanged} after={after?.(tick)} />
  );
};
