import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ApiClient } from '../../api';
import { navigate, useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import type { InboxItem, TenantOverview } from '../../operator-types';
import { ErrorState, Loading } from '../../states';
import { Flash, useFlash } from '../../ui';
import { formatOrgNumber } from '../Tenants';
import { SettingsTab } from '../OrgSettings';
import { hrefOf, isQuotaLimit, itemText, verbOf } from '../inbox/items';
import { AccessTab } from './AccessTab';
import { FlagsTab } from './FlagsTab';
import { LimitsTab } from './LimitsTab';
import { LogTab } from './LogTab';
import { OverviewTab } from './OverviewTab';
import { Chip, daysBetween, millions, orgHref, statusLabels } from './parts';
import { ServicesTab } from './ServicesTab';
import { UsageTab } from './UsageTab';
import './org.css';

export const orgTabs = [
  ['overview', 'org.tabOverview'],
  ['limits', 'org.tabLimits'],
  ['usage', 'org.tabUsage'],
  ['services', 'org.tabServices'],
  ['access', 'org.tabAccess'],
  ['flags', 'org.tabFlags'],
  ['log', 'org.tabLog'],
] as const satisfies readonly (readonly [string, PlainKey])[];

export type OrgTab = (typeof orgTabs)[number][0] | 'settings';

const formerTabs: Record<string, OrgTab> = { keys: 'access', drafts: 'services' };

export const tabOf = (param: string | undefined): OrgTab => {
  if (!param) return 'overview';
  if (param === 'settings') return 'settings';
  const former = formerTabs[param];
  if (former) return former;
  return orgTabs.some(([key]) => key === param) ? (param as OrgTab) : 'overview';
};

const MoreMenu = ({ tenant }: { tenant: string }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('a')?.focus();
    const away = (e: MouseEvent) => {
      if (!menu.current?.parentElement?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const move = (e: KeyboardEvent<HTMLUListElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('a') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  };
  const query = new URLSearchParams({ tenant }).toString();
  return (
    <div className="org-more">
      <button
        ref={button}
        type="button"
        className="org-btn neutral"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {t('org.more')}
      </button>
      {open ? (
        <ul ref={menu} role="menu" className="org-more-menu" onKeyDown={move}>
          <li role="none">
            <a role="menuitem" href={orgHref(tenant, 'settings')} onClick={() => setOpen(false)}>
              {t('org.moreSettings')}
            </a>
          </li>
          <li role="none">
            <a role="menuitem" href={`#/quota-requests?${query}`} onClick={() => setOpen(false)}>
              {t('org.moreQuotaRequests')}
            </a>
          </li>
          <li role="none">
            <a role="menuitem" href={`#/tenants/services?${query}`} onClick={() => setOpen(false)}>
              {t('org.moreServices')}
            </a>
          </li>
        </ul>
      ) : null}
    </div>
  );
};

const NeedsAction = ({ items, tenant }: { items: InboxItem[]; tenant: string }) => {
  const t = useT();
  const f = useFormat();
  const now = new Date();
  if (items.length === 0) return null;
  const text = (item: InboxItem) => {
    if (isQuotaLimit(item)) {
      const d = item.detail ?? {};
      const percent =
        d.usedTokens !== undefined && d.currentMonthlyTokens
          ? Math.round((d.usedTokens / d.currentMonthlyTokens) * 100)
          : 0;
      return t('org.needQuotaLimit', { percent, month: f.month(now) });
    }
    if (item.type === 'quota')
      return t('org.needQuotaRequest', { amount: millions(item.detail?.monthlyTokens ?? 0, f) });
    return itemText(item, t, f);
  };
  return (
    <section aria-labelledby="org-needs" className="org-needs">
      <h2 id="org-needs">{t('org.needsTitle', { count: items.length })}</h2>
      <ul>
        {items.map((item) => {
          const days = daysBetween(item.waitingSince, now);
          return (
            <li key={`${item.type}/${item.id}`}>
              <span>
                {text(item)}
                {item.from && days >= 1 ? (
                  <span className="waiting"> {t('org.waitingDays', { days })}</span>
                ) : null}
              </span>
              <a
                className="org-strong-link"
                href={isQuotaLimit(item) ? orgHref(tenant, 'limits') : hrefOf(item)}
              >
                {isQuotaLimit(item) ? t('org.changeLimit') : t(verbOf(item))}
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

const Header = ({ overview, tab }: { overview: TenantOverview; tab: OrgTab }) => {
  const t = useT();
  const [statusKey, tone] = statusLabels[overview.status] ?? statusLabels.active;
  const org = formatOrgNumber(overview.orgNumber);
  return (
    <div className="org-head">
      <nav aria-label={t('org.breadcrumb')} className="org-crumbs">
        <a href="#/tenants">{t('org.crumbTenants')}</a> <span aria-hidden="true">›</span>{' '}
        {overview.name}
      </nav>
      <div className="org-title-row">
        <div className="org-title">
          <div className="org-title-line">
            <h1>{overview.name}</h1>
            <Chip tone={tone}>{t(statusKey)}</Chip>
          </div>
          <span className="org-subtle">
            {overview.admin
              ? t('org.orgLineAdmin', { org, admin: overview.admin })
              : t('org.orgLine', { org })}
          </span>
        </div>
        <MoreMenu tenant={overview.orgNumber} />
      </div>
      {tab === 'overview' ? (
        <NeedsAction items={overview.needsAction} tenant={overview.orgNumber} />
      ) : null}
      <nav aria-label={t('org.tabsLabel')} className="org-tabs">
        {orgTabs.map(([key, label]) => (
          <a
            key={key}
            href={orgHref(overview.orgNumber, key)}
            aria-current={key === tab ? 'page' : undefined}
          >
            {t(label)}
          </a>
        ))}
      </nav>
    </div>
  );
};

export const OrgPage = ({
  api,
  tenant,
  tab: tabParam,
  setting,
}: {
  api: ApiClient;
  tenant?: string | undefined;
  tab?: string | undefined;
  setting?: string | undefined;
}) => {
  const t = useT();
  const tab = tabOf(tabParam);
  const flash = useFlash();
  const [state, retry] = useAsync(
    (signal) => (tenant ? api.tenantOverview(tenant, signal) : Promise.resolve(undefined)),
    [api, tenant],
  );
  const shown = useRef<TenantOverview | undefined>(undefined);
  if (state.status === 'ready') shown.current = state.data;
  else if (shown.current?.orgNumber !== tenant) shown.current = undefined;
  useEffect(() => {
    if (!tenant) navigate('/tenants');
  }, [tenant]);
  if (!tenant) return null;
  if (state.status === 'loading' && !shown.current) return <Loading label={t('org.loading')} />;
  if (state.status === 'error' && !shown.current)
    return <ErrorState error={state.error} onRetry={retry} />;
  const overview = shown.current;
  if (!overview) return null;
  const org = { tenant: overview.orgNumber, name: overview.name };
  const props = { api, tenant: overview.orgNumber, name: overview.name };
  const tight = tab !== 'overview' && tab !== 'access';
  return (
    <div className={tight ? 'org-page tight' : 'org-page'}>
      <Header overview={overview} tab={tab} />
      {tab === 'overview' ? <OverviewTab overview={overview} /> : null}
      {tab === 'limits' ? <LimitsTab {...props} overview={overview} onChanged={retry} /> : null}
      {tab === 'usage' ? <UsageTab {...props} /> : null}
      {tab === 'services' ? <ServicesTab {...props} /> : null}
      {tab === 'access' ? <AccessTab {...props} /> : null}
      {tab === 'flags' ? <FlagsTab {...props} /> : null}
      {tab === 'log' ? <LogTab {...props} /> : null}
      {tab === 'settings' ? (
        <>
          <Flash message={flash.message} />
          <SettingsTab
            api={api}
            org={org}
            focus={setting}
            onSaved={(text) => {
              flash.show(text);
              retry();
            }}
          />
        </>
      ) : null}
    </div>
  );
};
