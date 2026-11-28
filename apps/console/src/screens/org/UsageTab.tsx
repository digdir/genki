import type { Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useId, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import type { UsageNumbers } from '../../operator-types';
import { ErrorState, Loading } from '../../states';
import { capitalised, kroner, millions, shortDay } from './parts';

type Period = 'month' | 'last30' | 'chosen';

const tokensOf = (u: UsageNumbers) => u.inputTokens + u.outputTokens;

const sumCost = (items: UsageNumbers[]) =>
  items.some((u) => u.costMicroNok !== null)
    ? items.reduce((n, u) => n + (u.costMicroNok ?? 0), 0)
    : null;

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const daysFor = (period: Period, from: string, now: Date) => {
  if (period === 'month') return now.getDate();
  if (period === 'last30') return 30;
  const start = new Date(`${from}T00:00:00`);
  const days = Math.floor((now.getTime() - start.getTime()) / 86_400_000) + 1;
  return Number.isFinite(days) ? Math.min(366, Math.max(1, days)) : 30;
};

const Row = ({
  label,
  usage,
  total,
  f,
  t,
  className,
}: {
  label: ReactNode;
  usage: { tokens: number; cost: number | null };
  total: number;
  f: Format;
  t: T;
  className?: string;
}) => (
  <tr className={className}>
    <td>{label}</td>
    <td className="num">{t('org.millions', { amount: millions(usage.tokens, f, 1) })}</td>
    <td className="num">{f.number(total ? Math.round((usage.tokens / total) * 100) : 0)} %</td>
    <td className="num end">{kroner(usage.cost, f, t)}</td>
  </tr>
);

export const UsageTab = ({ api, tenant }: { api: ApiClient; tenant: string; name: string }) => {
  const t = useT();
  const f = useFormat();
  const id = useId();
  const now = new Date();
  const [period, setPeriod] = useState<Period>('month');
  const [from, setFrom] = useState(() => isoDay(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [others, setOthers] = useState(false);
  const days = daysFor(period, from, now);
  const [state, retry] = useAsync(
    (signal) => api.tenantUsage(tenant, days, signal),
    [api, tenant, days],
  );
  const periods: [Period, string][] = [
    ['month', capitalised(f.month(now))],
    ['last30', t('org.periodLast30')],
    ['chosen', t('org.periodChosen')],
  ];

  const body = () => {
    if (state.status === 'loading')
      return <Loading label={t('org.loading')} shape="table" onRetry={retry} />;
    if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
    const usage = state.data;
    const services = [...usage.byService]
      .map((s) => ({
        name: s.title ?? s.service,
        tokens: tokensOf(s.usage),
        cost: s.usage.costMicroNok,
      }))
      .sort((a, b) => b.tokens - a.tokens);
    const top = others ? services : services.slice(0, 3);
    const rest = services.slice(3);
    const group = (items: { tokens: number; cost: number | null }[]) => ({
      tokens: items.reduce((n, x) => n + x.tokens, 0),
      cost: items.some((x) => x.cost !== null)
        ? items.reduce((n, x) => n + (x.cost ?? 0), 0)
        : null,
    });
    const servicesTotal = group(services);
    const testing = {
      tokens: tokensOf(usage.testing.usage),
      cost: usage.testing.usage.costMicroNok,
    };
    const ingestion = {
      tokens: tokensOf(usage.ingestion.usage),
      cost: usage.ingestion.usage.costMicroNok,
    };
    const total = group([servicesTotal, testing, ingestion]);
    const max = Math.max(1, ...usage.daily.map((d) => tokensOf(d.usage)));
    const today = isoDay(now);
    const first = usage.daily[0];
    const last = usage.daily.at(-1);
    return (
      <>
        <section aria-labelledby={`${id}-day`} className="org-section" style={{ gap: 10 }}>
          <h2 id={`${id}-day`}>{t('org.perDay')}</h2>
          {first && last ? (
            <>
              <div
                className="org-chart"
                role="img"
                aria-label={t('org.perDayChart', {
                  from: shortDay(first.date, f),
                  to: shortDay(last.date, f),
                  max: millions(max, f, 1),
                })}
              >
                {usage.daily.map((d) => (
                  <div
                    key={d.date}
                    className={d.date === today ? 'partial' : undefined}
                    style={{ height: `${Math.round((tokensOf(d.usage) / max) * 160)}px` }}
                  />
                ))}
              </div>
              <div aria-hidden="true" className="org-axis">
                <span>{shortDay(first.date, f)}</span>
                <span>{shortDay(last.date, f)}</span>
              </div>
            </>
          ) : (
            <p className="org-subtle">{t('org.noUsage')}</p>
          )}
        </section>
        <section aria-labelledby={`${id}-src`} className="org-section">
          <h2 id={`${id}-src`}>{t('org.bySource')}</h2>
          <div className="org-table-wrap">
            <table className="org-table">
              <thead>
                <tr>
                  <th scope="col">{t('org.colSource')}</th>
                  <th scope="col" className="num">
                    {t('org.colTokens')}
                  </th>
                  <th scope="col" className="num">
                    {t('org.colShare')}
                  </th>
                  <th scope="col" className="num end">
                    {t('org.colCost')}
                  </th>
                </tr>
              </thead>
              <tbody>
                <Row
                  className="grp"
                  label={t('org.sourceServices')}
                  usage={servicesTotal}
                  total={total.tokens}
                  f={f}
                  t={t}
                />
                {top.map((s) => (
                  <Row
                    key={s.name}
                    className="ind"
                    label={<a href={`#/support-access?tenant=${tenant}&tab=services`}>{s.name}</a>}
                    usage={s}
                    total={total.tokens}
                    f={f}
                    t={t}
                  />
                ))}
                {rest.length > 0 && !others ? (
                  <Row
                    className="ind"
                    label={
                      <button
                        type="button"
                        className="org-link-btn"
                        style={{ padding: 0, minHeight: 0, fontWeight: 400 }}
                        aria-expanded={false}
                        onClick={() => setOthers(true)}
                      >
                        {t('org.sourceOthers', { count: rest.length })}
                      </button>
                    }
                    usage={group(rest)}
                    total={total.tokens}
                    f={f}
                    t={t}
                  />
                ) : null}
                <Row
                  className="grp"
                  label={t('org.sourceTesting')}
                  usage={testing}
                  total={total.tokens}
                  f={f}
                  t={t}
                />
                <Row
                  className="grp"
                  label={t('org.sourceIngestion')}
                  usage={ingestion}
                  total={total.tokens}
                  f={f}
                  t={t}
                />
                <Row
                  className="tot"
                  label={t('org.total')}
                  usage={total}
                  total={total.tokens}
                  f={f}
                  t={t}
                />
              </tbody>
            </table>
          </div>
        </section>
        <section aria-labelledby={`${id}-model`} className="org-section">
          <h2 id={`${id}-model`}>{t('org.byModel')}</h2>
          <div className="org-table-wrap">
            <table className="org-table">
              <thead>
                <tr>
                  <th scope="col">{t('org.colModel')}</th>
                  <th scope="col" className="num">
                    {t('org.colTokens')}
                  </th>
                  <th scope="col" className="num end">
                    {t('org.colCost')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.byModel.map((m) => (
                  <tr key={m.model}>
                    <td>{m.model}</td>
                    <td className="num">
                      {t('org.millions', { amount: millions(tokensOf(m.usage), f, 1) })}
                    </td>
                    <td className="num end">{kroner(m.usage.costMicroNok, f, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </>
    );
  };

  const summary =
    state.status === 'ready'
      ? t('org.usageSummary', {
          tokens: millions(tokensOf(state.data.totals), f, 1),
          cost: kroner(sumCost([state.data.totals]), f, t),
        })
      : undefined;
  return (
    <>
      <div className="org-toolbar">
        <div className="org-filters">
          <div role="group" aria-label={t('org.periodLabel')} className="org-segments">
            {periods.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={period === key}
                onClick={() => setPeriod(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {period === 'chosen' ? (
            <div className="org-field">
              <label htmlFor={`${id}-from`}>{t('org.periodFrom')}</label>
              <input
                id={`${id}-from`}
                className="org-input"
                type="date"
                value={from}
                max={isoDay(now)}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
          ) : null}
        </div>
        {summary ? <span className="org-subtle">{summary}</span> : null}
      </div>
      {body()}
    </>
  );
};
