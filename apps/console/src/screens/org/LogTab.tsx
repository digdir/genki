import type { Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useId, useState } from 'react';
import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import type { AuditFilter, FailedRun } from '../../operator-types';
import { ErrorState, Loading } from '../../states';
import type { AuditEntry } from '../../types';
import { auditLine, fromDigdir } from './audit-line';
import { Chip, shortDay } from './parts';

type Show = 'all' | 'changes' | 'runs' | 'digdir';

const shows: [Show, PlainKey][] = [
  ['all', 'org.showEverything'],
  ['changes', 'org.showChanges'],
  ['runs', 'org.showRuns'],
  ['digdir', 'org.showDigdir'],
];

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const when = (iso: string, f: Format, t: T, now: Date) =>
  new Date(iso).toDateString() === now.toDateString()
    ? t('org.todayAt', { time: f.time(iso) })
    : shortDay(iso, f);

type Entry = { at: string; audit: AuditEntry } | { at: string; run: FailedRun };

export const LogTab = ({ api, tenant }: { api: ApiClient; tenant: string; name: string }) => {
  const t = useT();
  const f = useFormat();
  const id = useId();
  const now = new Date();
  const [show, setShow] = useState<Show>('all');
  const [chosen, setChosen] = useState(false);
  const [from, setFrom] = useState(() => isoDay(new Date(now.getTime() - 29 * 86_400_000)));
  const [to, setTo] = useState(() => isoDay(now));
  const period = chosen
    ? { from, to }
    : { from: isoDay(new Date(now.getTime() - 29 * 86_400_000)) };
  const [state, retry] = useAsync(
    async (signal): Promise<Entry[]> => {
      const filter: AuditFilter = { ...period, ...(show === 'digdir' ? { by: 'operator' } : {}) };
      const [audit, runs] = await Promise.all([
        show === 'runs' ? [] : api.tenantAudit(tenant, filter, signal),
        period.from && (show === 'all' || show === 'runs')
          ? api.failedRuns(period.from, signal).then(
              (all) =>
                all.filter(
                  (r) => r.tenant === tenant && (!period.to || r.at.slice(0, 10) <= period.to),
                ),
              () => [],
            )
          : [],
      ]);
      return [
        ...audit.map((a) => ({ at: a.at, audit: a })),
        ...runs.map((r) => ({ at: r.at, run: r })),
      ].sort((a, b) => b.at.localeCompare(a.at));
    },
    [api, tenant, show, period.from, period.to],
  );

  const list = () => {
    if (state.status === 'loading') return <Loading label={t('org.loading')} />;
    if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
    if (state.data.length === 0) return <p className="org-subtle">{t('org.noEntries')}</p>;
    return (
      <ol className="org-rows">
        {state.data.map((e) => {
          if ('run' in e) {
            const r = e.run;
            return (
              <li key={`run/${r.task}`}>
                <span className="when wide">{when(r.at, f, t, now)}</span>
                <span className="what">
                  <span>
                    {t('org.runFailed', {
                      task: r.task,
                      service: r.serviceName ?? r.service ?? '',
                    })}
                  </span>
                  {r.failure ? <span className="reason">{r.failure.reason}</span> : null}
                </span>
                <a
                  href={`#/diagnostics?${new URLSearchParams({ tenant }).toString()}`}
                  aria-label={t('org.seeContentFor', { task: r.task })}
                >
                  {t('org.seeContent')}
                </a>
              </li>
            );
          }
          const a = e.audit;
          const line = auditLine(a, t);
          return (
            <li key={a.task}>
              <span className="when wide">{when(a.at, f, t, now)}</span>
              <span className="what">
                <span>
                  {line.sentence}{' '}
                  {fromDigdir(a) ? <Chip tone="info">{t('org.fromDigdir')}</Chip> : null}
                </span>
                {line.reason || line.who ? (
                  <span className="reason">
                    {[line.who, line.reason ? `«${line.reason}»` : undefined]
                      .filter(Boolean)
                      .join(': ')}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    );
  };

  return (
    <>
      <div className="org-filters">
        <div className="org-field">
          <label htmlFor={`${id}-show`}>{t('org.showLabel')}</label>
          <select
            id={`${id}-show`}
            className="org-input"
            value={show}
            onChange={(e) => setShow(e.target.value as Show)}
          >
            {shows.map(([key, label]) => (
              <option key={key} value={key}>
                {t(label)}
              </option>
            ))}
          </select>
        </div>
        <div className="org-field">
          <label htmlFor={`${id}-period`}>{t('org.periodLabel')}</label>
          <select
            id={`${id}-period`}
            className="org-input"
            value={chosen ? 'chosen' : 'last30'}
            onChange={(e) => setChosen(e.target.value === 'chosen')}
          >
            <option value="last30">{t('org.periodLast30')}</option>
            <option value="chosen">{t('org.periodChosen')}</option>
          </select>
        </div>
        {chosen ? (
          <>
            <div className="org-field">
              <label htmlFor={`${id}-from`}>{t('org.periodFrom')}</label>
              <input
                id={`${id}-from`}
                type="date"
                className="org-input"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="org-field">
              <label htmlFor={`${id}-to`}>{t('org.periodTo')}</label>
              <input
                id={`${id}-to`}
                type="date"
                className="org-input"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </>
        ) : null}
        <a className="push" href="#/audit">
          {t('org.openInLog')}
        </a>
      </div>
      {list()}
    </>
  );
};
