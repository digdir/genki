import { useFormat } from '@genai/i18n/react';
import { useId, useState } from 'react';
import type { ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT, type Format, type PlainKey, type T } from '../i18n';
import { EmptyState, ErrorState, Loading } from '../states';
import type { Tenant, TenantStatus } from '../types';
import { Chip, inboxTypeLabel, orgHref, shortMonth, type Tone } from './operate/parts';
import './operate/operate.css';
import { PageTabs } from '../page-tabs';

export const formatOrgNumber = (n: string) => n.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3');

export const quotaRequestsHref = (tenant?: string) =>
  tenant ? `#/quota-requests?${new URLSearchParams({ tenant }).toString()}` : '#/quota-requests';

const hotPercent = 90;

const statusChip: Record<TenantStatus, [Tone, PlainKey]> = {
  active: ['success', 'orgList.active'],
  onboarding: ['info', 'orgList.onboarding'],
  paused: ['neutral', 'orgList.paused'],
};

type Filter = 'all' | TenantStatus;

const filterLabel = {
  all: 'orgList.statusAll',
  active: 'orgList.statusActiveCount',
  onboarding: 'orgList.statusOnboardingCount',
  paused: 'orgList.statusPausedCount',
} as const satisfies Record<Filter, string>;

const percentOf = (x: Tenant) =>
  x.tokensMillions !== undefined && x.quotaMillions
    ? Math.round((x.tokensMillions / x.quotaMillions) * 100)
    : x.quotaUsedPercent;

const queueHref = (x: Tenant) => {
  const type = x.waiting?.types[0];
  return type ? `#/queue?${new URLSearchParams({ type }).toString()}` : '#/queue';
};

const costText = (cost: number | null | undefined, t: T, f: Format) =>
  cost === undefined
    ? t('tenants.notAvailable')
    : cost === null
      ? t('tenants.notPriced')
      : t('orgList.cost', {
          amount: cost === 0 || cost >= 10 ? f.number(Math.round(cost)) : f.decimal(cost, 2),
        });

export const Tenants = ({ api, now = () => new Date() }: { api: ApiClient; now?: () => Date }) => {
  const t = useT();
  const f = useFormat();
  const id = useId();
  const [state, retry] = useAsync((signal) => api.listTenants(signal, { usage: true }), [api]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [onlyWaiting, setOnlyWaiting] = useState(false);

  const header = (
    <>
      <div className="op-head">
        <h1>{t('orgList.title')}</h1>
        <a href="#/onboarding" className="op-btn wide">
          {t('orgList.register')}
        </a>
      </div>
      <PageTabs />
    </>
  );
  if (state.status === 'loading')
    return (
      <div className="op-page">
        {header}
        <Loading label={t('orgList.loading')} />
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="op-page">
        {header}
        <ErrorState error={state.error} onRetry={retry} />
      </div>
    );
  const all = state.data;
  if (all.length === 0)
    return (
      <div className="op-page">
        {header}
        <EmptyState title={t('orgList.emptyTitle')} />
      </div>
    );

  const count = (status: Filter) =>
    status === 'all' ? all.length : all.filter((x) => x.status === status).length;
  const needle = query.trim().toLowerCase().replace(/\s/g, '');
  const rows = all
    .filter(
      (x) =>
        (filter === 'all' || x.status === filter) &&
        (!onlyWaiting || Boolean(x.waiting?.count)) &&
        (!needle || `${x.name.toLowerCase().replace(/\s/g, '')}${x.orgNumber}`.includes(needle)),
    )
    .sort((a, b) => (percentOf(b) ?? -1) - (percentOf(a) ?? -1) || a.name.localeCompare(b.name));
  const month = shortMonth(now(), f);

  return (
    <div className="op-page">
      {header}
      <div className="op-filters">
        <div className="op-field grow">
          <label htmlFor={`${id}-q`}>{t('orgList.search')}</label>
          <input
            id={`${id}-q`}
            className="op-input"
            type="search"
            placeholder={t('orgList.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="op-field">
          <label htmlFor={`${id}-s`}>{t('orgList.status')}</label>
          <select
            id={`${id}-s`}
            className="op-input"
            value={filter === 'all' ? '' : filter}
            onChange={(e) => setFilter((e.target.value || 'all') as Filter)}
          >
            {(['all', 'active', 'onboarding', 'paused'] as const).map((s) => (
              <option key={s} value={s === 'all' ? '' : s}>
                {t(filterLabel[s], { count: count(s) })}
              </option>
            ))}
          </select>
        </div>
        <label className="op-check">
          <input type="checkbox" checked={onlyWaiting} onChange={() => setOnlyWaiting((v) => !v)} />
          {t('orgList.onlyWaiting')}
        </label>
      </div>
      {rows.length === 0 ? (
        <p>
          {t('orgList.noMatch')}{' '}
          <button
            type="button"
            className="op-btn"
            onClick={() => {
              setQuery('');
              setFilter('all');
              setOnlyWaiting(false);
            }}
          >
            {t('orgList.reset')}
          </button>
        </p>
      ) : (
        <div tabIndex={0} role="region" aria-label={t('orgList.title')} className="op-table-wrap">
          <table className="op-table w820">
            <thead>
              <tr>
                <th scope="col">{t('orgList.colTenant')}</th>
                <th scope="col">{t('orgList.colOrgNumber')}</th>
                <th scope="col">{t('orgList.status')}</th>
                <th scope="col" aria-sort="descending">
                  {t('orgList.colQuota')} <span aria-hidden="true">↓</span>
                </th>
                <th scope="col" className="num">
                  {t('orgList.colCost', { month })}
                </th>
                <th scope="col" className="last">
                  {t('orgList.colWaiting')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const percent = percentOf(x);
                const hot = percent !== undefined && percent >= hotPercent;
                const [tone, label] = statusChip[x.status];
                const waiting = x.waiting;
                const href = queueHref(x);
                const what = waiting?.types
                  .map((type) => (inboxTypeLabel[type] ? t(inboxTypeLabel[type]) : type))
                  .join(', ');
                return (
                  <tr key={x.orgNumber}>
                    <td>
                      <a href={orgHref(x.orgNumber)} className="strong">
                        {x.name}
                      </a>
                    </td>
                    <td className="op-subtle nowrap">{formatOrgNumber(x.orgNumber)}</td>
                    <td>
                      <Chip tone={tone}>{t(label)}</Chip>
                    </td>
                    <td>
                      <div className="op-quota">
                        <span className="op-bar" aria-hidden="true">
                          <span
                            className={hot ? 'hot' : undefined}
                            style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
                          />
                        </span>
                        <span className={hot ? 'op-hot' : undefined}>
                          {x.status === 'onboarding'
                            ? t('orgList.notInUse')
                            : percent === undefined
                              ? t('tenants.notAvailable')
                              : t('orgList.percent', { percent })}
                        </span>
                      </div>
                    </td>
                    <td className="num">{costText(x.costNok, t, f)}</td>
                    <td className="last">
                      {what ? (
                        <a
                          href={href}
                          className="op-chip"
                          data-tone={waiting?.blocks ? 'warning' : undefined}
                          aria-label={t('orgList.waitingFor', { name: x.name, what })}
                        >
                          {what}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
