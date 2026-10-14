import { setting } from './runtime-config';
import { Alert, Badge, Button, Popover, SkipLink } from '@digdir/designsystemet-react';
import { LanguageChoice } from '@genai/i18n/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useT, type PlainKey, type T } from './i18n';
import { useSupport } from './support';
import { SupportDialog } from './support-dialog';
import { minutesLeft } from './ui';
import type { Health, OperatorSession } from './types';

const configuredEnvironment: string | undefined = setting('ENVIRONMENT');

interface NavGroup {
  id: string;
  group: PlainKey;
  items: NavItem[];
}

interface NavItem {
  path: string;
  label: PlainKey;
  external?: boolean;
  note?: PlainKey;
}

export const navigation: NavGroup[] = [
  {
    id: 'customers',
    group: 'shell.groupCustomers',
    items: [
      { path: '/queue', label: 'shell.pageQueue' },
      { path: '/tenants', label: 'shell.pageTenants' },
      { path: '/onboarding', label: 'shell.pageOnboarding' },
    ],
  },
  {
    id: 'platform',
    group: 'shell.groupPlatform',
    items: [
      { path: '/models', label: 'shell.pageModels' },
      { path: '/catalog', label: 'shell.pageCatalog' },
      { path: '/building-blocks', label: 'shell.pageBuildingBlocks' },
      { path: '/search-engines', label: 'shell.pageSearchEngines' },
      { path: '/shared-services', label: 'shell.pageSharedServices' },
      { path: '/settings', label: 'shell.pageSettings' },
      { path: '/quality', label: 'shell.pageQuality' },
      { path: '/quality-matrix', label: 'shell.pageQualityMatrix' },
      { path: '/policies', label: 'shell.pagePolicies' },
      { path: '/tracing', label: 'shell.pageTracing' },
    ],
  },
  {
    id: 'support',
    group: 'shell.groupSupport',
    items: [
      { path: '/operations', label: 'shell.pageOperations' },
      { path: '/diagnostics', label: 'shell.pageDiagnostics' },
      { path: '/support-access', label: 'shell.pageSupportAccess' },
      { path: '/audit', label: 'shell.pageAudit' },
      { path: '/schemas', label: 'schemas.page' },
      {
        path: '/system-atlas.html',
        label: 'shell.pageAtlas',
        external: true,
        note: 'shell.atlasEnglishOnly',
      },
    ],
  },
];

const extensionMinutes = 15;

export const allPages = navigation.flatMap((g) => g.items);

export interface NavBadges {
  queue?: number;
  operations?: number;
}

interface ShellProps {
  session: OperatorSession;
  onLogout: () => void;
  path: string;
  badges?: NavBadges;
  health?: (signal?: AbortSignal) => Promise<Health>;
  children: ReactNode;
}

const badgeFor = (path: string, badges: NavBadges, t: T) => {
  if (path === '/queue' && badges.queue)
    return {
      count: badges.queue,
      color: 'danger' as const,
      label: t('shell.badgeQueue', { count: badges.queue }),
    };
  if (path === '/operations' && badges.operations)
    return {
      count: badges.operations,
      color: 'danger' as const,
      label: t('shell.badgeOperations', { count: badges.operations }),
    };
  return undefined;
};

const isCurrent = (item: NavItem, path: string) =>
  path === item.path || path.startsWith(`${item.path}/`);

const LockdownBanner = ({ health }: { health: (signal?: AbortSignal) => Promise<Health> }) => {
  const t = useT();
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    health(controller.signal).then(
      (found) => setLocked(found.lockdown === true),
      () => undefined,
    );
    return () => controller.abort();
  }, [health]);
  return locked ? (
    <Alert data-color="warning" data-size="sm" className="lockdown-banner">
      {t('shell.lockdown')}
    </Alert>
  ) : null;
};

export const Shell = ({ session, onLogout, path, badges = {}, health, children }: ShellProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [extending, setExtending] = useState(false);
  const t = useT();
  const support = useSupport();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);
  const shellRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const top = topRef.current;
    if (!shell || !top) return;
    const measure = () => shell.style.setProperty('--top-height', `${top.offsetHeight}px`);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(top);
    return () => observer.disconnect();
  }, []);
  const environmentLabel =
    configuredEnvironment ?? (import.meta.env.DEV ? t('shell.envLocal') : t('shell.envProduction'));
  const active = support.session;
  return (
    <div className="shell" ref={shellRef}>
      <SkipLink href="#hovedinnhold">{t('shell.skipLink')}</SkipLink>
      <div className="top" ref={topRef}>
        <header className="header">
          <button
            type="button"
            className="menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="konsollmeny"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
            {t('shell.menu')}
          </button>
          <a className="brand" href="#/tenants">
            <span className="brand-mark" aria-hidden="true">
              <img src="/emblem-felleslosning.svg" alt="" width={26} height={26} />
            </span>
            <span className="brand-text">
              <span className="brand-owner">{t('shell.owner')}</span>
              <span className="brand-name">{t('shell.title')}</span>
            </span>
          </a>
          <span className="spacer" />
          <span className="env">{environmentLabel}</span>
          <span className="who">
            <span className="who-name">{session.name}</span>
            <span>{t('shell.account')}</span>
          </span>
          <Popover.TriggerContext>
            <Popover.Trigger
              variant="tertiary"
              data-size="sm"
              data-color="neutral"
              className="header-action"
            >
              {t('shell.language')}
            </Popover.Trigger>
            <Popover placement="bottom-end" data-size="sm">
              <LanguageChoice />
            </Popover>
          </Popover.TriggerContext>
          <Button
            variant="tertiary"
            data-size="sm"
            data-color="neutral"
            className="logout"
            onClick={onLogout}
          >
            {t('shell.logout')}
          </Button>
        </header>
        <div className="strip" role="note">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18z M12 11v5 M12 8h.01" />
          </svg>
          <span>
            <strong>{t('shell.stripLead')}</strong>{' '}
            {t.rich('shell.stripRest', { link: (c) => <a href="#/audit">{c}</a> })}
          </span>
        </div>
        {active ? (
          <div className="support-strip" role="status">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 1 0 6a3 3 0 0 1 0-6z" />
            </svg>
            <span className="support-text">
              <strong>{t('shell.supportActive', { tenant: active.tenantName })}</strong>
              {t('shell.supportActiveRest', { minutes: minutesLeft(active.expiresAt) })}
            </span>
            <span className="actions-row">
              <Button variant="secondary" data-size="sm" onClick={() => setExtending(true)}>
                {t('shell.extend')}
              </Button>
              {path === '/support-access' ? null : (
                <Button
                  variant="secondary"
                  data-size="sm"
                  onClick={() => {
                    window.location.hash = '/support-access';
                  }}
                >
                  {t('shell.showPortal')}
                </Button>
              )}
              <Button data-size="sm" onClick={() => void support.end()}>
                {t('shell.endSession')}
              </Button>
            </span>
            <SupportDialog
              open={extending}
              title={t('shell.extendTitle')}
              lead={t('shell.extendLead', { minutes: extensionMinutes })}
              hint={t('shell.extendHint')}
              sees={t('shell.extendSees', { tenant: active.tenantName })}
              cta={t('shell.extendCta', { minutes: extensionMinutes })}
              api={{
                method: 'POST',
                path: `/operator/support-sessions/${active.id}/extend`,
                body: () => ({ minutes: extensionMinutes }),
              }}
              onClose={() => setExtending(false)}
              onConfirm={(reason) => support.extend(extensionMinutes, reason)}
            />
          </div>
        ) : null}
      </div>
      <div className="body">
        <nav
          id="konsollmeny"
          className={menuOpen ? 'sidebar open' : 'sidebar'}
          aria-label={t('shell.menuLabel')}
        >
          <div className="sidebar-inner">
            {navigation.map((group) => (
              <div key={group.id}>
                <h2 className="group" id={`gruppe-${group.id}`}>
                  {t(group.group)}
                </h2>
                <ul aria-labelledby={`gruppe-${group.id}`}>
                  {group.items.map((item) => {
                    if (item.external)
                      return (
                        <li key={item.label}>
                          <a href={item.path} target="_blank" rel="noopener noreferrer">
                            {t(item.label)}
                            <span className="visually-hidden">{t('shell.opensInNewTab')}</span>
                          </a>
                          {item.note ? <span className="nav-note">{t(item.note)}</span> : null}
                        </li>
                      );
                    const current = isCurrent(item, path);
                    const badge = badgeFor(item.path, badges, t);
                    return (
                      <li key={item.label}>
                        <a
                          href={`#${item.path}`}
                          aria-current={current ? 'page' : undefined}
                          className={current ? 'active' : undefined}
                          onClick={() => setMenuOpen(false)}
                        >
                          {t(item.label)}
                          {badge ? (
                            <>
                              <Badge
                                count={badge.count}
                                data-color={badge.color}
                                aria-hidden="true"
                              />
                              <span className="visually-hidden"> ({badge.label})</span>
                            </>
                          ) : null}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <main id="hovedinnhold" className="main" tabIndex={-1}>
          <div className="content">
            {health ? <LockdownBanner health={health} /> : null}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};
