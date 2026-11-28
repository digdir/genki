import { useFormat } from '@genai/i18n/react';
import { useCallback, useState } from 'react';
import type { ApiClient } from '../../api';
import { navigate, useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { inboxTypes, type InboxItem, type InboxType } from '../../operator-types';
import { EmptyState, ErrorState, Loading } from '../../states';
import { Chip, millions, orgHref, shortDay } from '../org/parts';
import { ageOf, hrefOf, isQuotaLimit, itemText, typeLabels, verbOf } from './items';
import { QuotaPanel, type QuotaDone } from './QuotaPanel';
import '../org/org.css';
import { PageTabs } from '../../page-tabs';

const isType = (value: string | undefined): value is InboxType =>
  (inboxTypes as readonly string[]).includes(value ?? '');

const params = (next: { type?: InboxType | undefined; request?: string | undefined }) => {
  const out: Record<string, string> = {};
  if (next.type) out.type = next.type;
  if (next.request) out.request = next.request;
  return out;
};

const Tenant = ({ item }: { item: InboxItem }) => {
  const t = useT();
  if (item.type === 'access') return <>{item.what}</>;
  if (item.tenant) return <a href={orgHref(item.tenant)}>{item.tenantName ?? item.tenant}</a>;
  if (item.type === 'incident')
    return (
      <a href="#/operations">
        {item.tenants?.length
          ? t('inbox.manyTenants', { count: item.tenants.length })
          : t('inbox.allTenants')}
      </a>
    );
  return null;
};

export const Inbox = ({
  api,
  type: typeParam,
  request,
  onDecided,
}: {
  api: ApiClient;
  type?: string | undefined;
  request?: string | undefined;
  onDecided?: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const now = new Date();
  const type = isType(typeParam) ? typeParam : undefined;
  const [state, retry, refreshing] = useAsync((signal) => api.inbox(signal), [api]);
  const [done, setDone] = useState<QuotaDone | undefined>();
  const choose = (next: InboxType | undefined) => {
    setDone(undefined);
    navigate('/queue', params({ type: next }));
  };
  const close = useCallback(() => navigate('/queue', params({ type })), [type]);
  const [panelTenant, panelId] = (() => {
    const at = request?.indexOf('/') ?? -1;
    return request && at > 0 ? [request.slice(0, at), request.slice(at + 1)] : [];
  })();

  const items = state.status === 'ready' ? state.data : [];
  const countOf = (key: InboxType | undefined) =>
    state.status === 'ready'
      ? String(key ? items.filter((i) => i.type === key).length : items.length)
      : '';
  const shown = items.filter((i) => !type || i.type === type);
  const blocking = items.filter((i) => i.blocks).length;
  const pills: [InboxType | undefined, string][] = [
    [undefined, t('inbox.typeAll')],
    ...inboxTypes.map((key): [InboxType, string] => [key, t(typeLabels[key])]),
  ];

  const doneText = (d: QuotaDone) =>
    d.verb === 'approved'
      ? t('inbox.approved', {
          tenant: d.tenantName,
          amount: millions(d.amount ?? 0, f),
          name: api.actor() ?? '',
          reason: d.reason,
        })
      : d.verb === 'rejected'
        ? t('inbox.rejected', { tenant: d.tenantName })
        : t('inbox.postponed', { tenant: d.tenantName, date: shortDay(d.until ?? '', f) });

  return (
    <div className="org-page tight">
      <div className="inbox-head">
        <h1>{t('inbox.title')}</h1>
        {state.status === 'ready' ? (
          <span className="org-subtle">{t('inbox.blocking', { count: blocking })}</span>
        ) : null}
      </div>
      <PageTabs />
      <div aria-live="polite">
        {done ? (
          <p role="status" className="org-status">
            {doneText(done)}{' '}
            {done.verb === 'approved' ? (
              <a href={orgHref(done.tenant, 'limits')}>{t('inbox.seeLimits')}</a>
            ) : null}
          </p>
        ) : null}
      </div>
      <div role="group" aria-label={t('inbox.typeLabel')} className="org-pills">
        {pills.map(([key, label]) => (
          <button
            key={key ?? 'all'}
            type="button"
            className="org-pill"
            aria-pressed={type === key}
            onClick={() => choose(key)}
          >
            {label} <span className="count">{countOf(key)}</span>
          </button>
        ))}
      </div>
      {state.status === 'loading' ? (
        <Loading label={t('inbox.loading')} shape="table" onRetry={retry} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : shown.length === 0 ? (
        <EmptyState title={t('inbox.emptyTitle')}>
          {type ? <p>{t('inbox.emptyType')}</p> : null}
        </EmptyState>
      ) : (
        <div tabIndex={0} role="region" aria-label={t('inbox.table')} className="org-table-wrap">
          <table className="org-table wide" aria-busy={refreshing || undefined}>
            <thead>
              <tr>
                <th scope="col">{t('inbox.colType')}</th>
                <th scope="col">{t('inbox.colTenant')}</th>
                <th scope="col">{t('inbox.colWhat')}</th>
                <th scope="col">{t('inbox.colFrom')}</th>
                <th scope="col" aria-sort="descending">
                  {t('inbox.colWaiting')}
                </th>
                <th scope="col">
                  <span className="visually-hidden">{t('inbox.colAction')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => {
                const what = itemText(item, t, f);
                const age = ageOf(item, t, now);
                const verb = t(verbOf(item));
                const tenantName =
                  item.tenantName ??
                  (item.tenants?.length
                    ? t('inbox.manyTenants', { count: item.tenants.length })
                    : t('inbox.allTenants'));
                return (
                  <tr key={`${item.type}/${item.id}`}>
                    <td>
                      <Chip>{t(typeLabels[item.type])}</Chip>
                    </td>
                    <td>
                      <Tenant item={item} />
                    </td>
                    <td>
                      {what}
                      {item.blocks ? (
                        <>
                          {' '}
                          <span style={{ marginLeft: 6 }}>
                            <Chip tone="warning">{t('inbox.blocks')}</Chip>
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td className="subtle">
                      {item.from ?? (item.type === 'incident' ? t('inbox.monitoring') : '')}
                    </td>
                    <td>
                      <Chip tone={age.tone}>{age.text}</Chip>
                    </td>
                    <td className="end">
                      <a
                        className="org-strong-link"
                        href={
                          item.type === 'quota' && !isQuotaLimit(item)
                            ? `#/queue?${new URLSearchParams(params({ type, request: `${item.tenant ?? ''}/${item.id}` })).toString()}`
                            : hrefOf(item)
                        }
                        aria-label={t('inbox.verbLabel', { verb, tenant: tenantName, what })}
                        onClick={() => setDone(undefined)}
                      >
                        {verb}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {panelTenant && panelId ? (
        <QuotaPanel
          key={request}
          api={api}
          tenant={panelTenant}
          id={panelId}
          onClose={close}
          onDone={(d) => {
            setDone(d);
            close();
            retry();
            onDecided?.();
          }}
        />
      ) : null}
    </div>
  );
};
