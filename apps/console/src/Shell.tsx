import { setting } from './runtime-config';
import { Alert, Dialog, SkipLink } from '@digdir/designsystemet-react';
import { LanguageChoice } from '@genai/i18n/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT, type T } from './i18n';
import { useFlagStates } from './flags';
import { menu, menuItemFor, type MenuItem, type MenuPage } from './menu';
import { SearchDialog, type SearchSource } from './search';
import type { Health, OperatorSession } from './types';

const configuredEnvironment: string | undefined = setting('ENVIRONMENT');

export interface NavBadges {
  queue?: number;
  quotaRequests?: number;
}

interface ShellProps {
  session: OperatorSession;
  onLogout: () => void;
  path: string;
  badges?: NavBadges;
  search: SearchSource;
  health?: (signal?: AbortSignal) => Promise<Health>;
  readOnlyInLockdown?: (signal?: AbortSignal) => Promise<boolean>;
  children: ReactNode;
}

export const environmentLabel = (configured: string | undefined, dev: boolean, t: T) => {
  const name = configured?.toLowerCase();
  if (name === 'test') return t('frame.envTest');
  if (name === 'production' || name === 'prod') return t('shell.envProduction');
  if (configured) return configured;
  return dev ? t('shell.envLocal') : t('shell.envProduction');
};

const isMac = () => /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

const LockdownBanner = ({
  health,
  readOnlyInLockdown,
}: {
  health: (signal?: AbortSignal) => Promise<Health>;
  readOnlyInLockdown: (signal?: AbortSignal) => Promise<boolean>;
}) => {
  const t = useT();
  const [readOnly, setReadOnly] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    health(controller.signal)
      .then(async (found) => {
        if (found.lockdown !== true) return;
        if (await readOnlyInLockdown(controller.signal)) setReadOnly(true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [health, readOnlyInLockdown]);
  return readOnly ? (
    <Alert data-color="warning" data-size="sm" className="lockdown-banner">
      {t('shell.lockdownReadOnly')}
    </Alert>
  ) : null;
};

const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" className="icon">
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </svg>
);

const searchIcon = 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM12 12l4 4';

const SectionTab = ({ page, path }: { page: MenuPage; path: string }) => {
  const t = useT();
  const current = page.path === path;
  return (
    <li>
      <a
        href={`#${page.path}`}
        aria-current={current ? 'page' : undefined}
        className={current ? 'active' : undefined}
      >
        {t(page.label)}
      </a>
    </li>
  );
};

const SectionTabs = ({ item, path }: { item: MenuItem; path: string }) => {
  const t = useT();
  const flags = useFlagStates();
  const pages = (item.pages ?? []).filter(
    (p) => !p.flag || flags.some((f) => f.key === p.flag && f.on),
  );
  if (pages.length < 2 || !pages.some((p) => p.path === path)) return null;
  return (
    <nav className="section-tabs" aria-label={t('frame.sectionPages', { section: t(item.label) })}>
      <ul>
        {pages.map((page) => (
          <SectionTab key={page.path} page={page} path={path} />
        ))}
      </ul>
    </nav>
  );
};

const UserMenu = ({ session, onLogout }: { session: OperatorSession; onLogout: () => void }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const close = useCallback((focus = true) => {
    setOpen(false);
    if (focus) button.current?.focus();
  }, []);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.user')) close(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open, close]);

  const onMenuKey = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') close(false);
  };

  return (
    <div className="user">
      <button
        ref={button}
        type="button"
        className="user-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'user-menu' : undefined}
        aria-label={t('frame.userMenuButton', { name: session.name })}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span className="avatar" aria-hidden="true">
          {initials(session.name)}
        </span>
        <span className="user-name">{session.name}</span>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
      {open ? (
        <ul
          id="user-menu"
          ref={list}
          role="menu"
          aria-label={t('frame.userMenu')}
          className="user-menu"
          onKeyDown={onMenuKey}
        >
          <li role="none" className="user-menu-head">
            {t('frame.userRole')}
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close(false);
                setLanguage(true);
              }}
            >
              {t('frame.language')}
            </button>
          </li>
          <li role="none">
            <a role="menuitem" tabIndex={-1} href="#/schemas" onClick={() => close(false)}>
              {t('frame.schemas')}
            </a>
          </li>
          <li role="none">
            <a
              role="menuitem"
              tabIndex={-1}
              href="#/atlas"
              aria-label={t('frame.atlas')}
              aria-describedby="atlas-language"
              onClick={() => close(false)}
            >
              {t('frame.atlas')}
              <span id="atlas-language" className="user-menu-meta">
                {t('frame.atlasEnglishOnly')}
              </span>
            </a>
          </li>
          <li role="none" className="user-menu-end">
            <button type="button" role="menuitem" tabIndex={-1} onClick={onLogout}>
              {t('shell.logout')}
            </button>
          </li>
        </ul>
      ) : null}
      <Dialog
        open={language}
        closeButton={t('frame.close')}
        aria-label={t('frame.language')}
        onClose={() => {
          setLanguage(false);
          button.current?.focus();
        }}
      >
        {language ? <LanguageChoice /> : null}
      </Dialog>
    </div>
  );
};

export const Shell = ({
  session,
  onLogout,
  path,
  badges = {},
  search,
  health,
  readOnlyInLockdown,
  children,
}: ShellProps) => {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchOpener = useRef<HTMLElement | null>(null);
  const mac = isMac();
  const active = menuItemFor(path);
  const waiting = (badges.queue ?? 0) + (badges.quotaRequests ?? 0);

  useEffect(() => {
    window.scrollTo(0, 0);
    setMenuOpen(false);
  }, [path]);

  const openSearch = useCallback(() => {
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('dialog'))
      searchOpener.current = document.activeElement;
    setSearching(true);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);

  const closeSearch = useCallback(() => {
    setSearching(false);
    const opener = searchOpener.current;
    (opener?.isConnected ? opener : searchButton.current)?.focus();
  }, []);

  const brand = (
    <a className="brand" href="#/queue">
      <span className="brand-owner">{t('frame.brandOwner')}</span>
      <span className="brand-name">{t('frame.brandName')}</span>
    </a>
  );

  return (
    <div className="frame">
      <SkipLink href="#hovedinnhold">{t('shell.skipLink')}</SkipLink>
      <div className="phone-bar">
        {brand}
        <button
          type="button"
          className="menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="konsollmeny"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          {t('frame.openMenu')}
        </button>
      </div>
      <div className={menuOpen ? 'sidebar open' : 'sidebar'}>
        <nav id="konsollmeny" className="sidebar-inner" aria-label={t('shell.menuLabel')}>
          <div className="sidebar-brand">{brand}</div>
          {menu.map((group) => (
            <div key={group.id} className="menu-group">
              <h2 className="group" id={`gruppe-${group.id}`}>
                {t(group.label)}
              </h2>
              <ul aria-labelledby={`gruppe-${group.id}`}>
                {group.items.map((item) => {
                  const current = item === active;
                  const badge = item.id === 'queue' && waiting > 0 ? waiting : undefined;
                  return (
                    <li key={item.id}>
                      <a
                        href={`#${item.path}`}
                        aria-current={current ? 'page' : undefined}
                        className={current ? 'active' : undefined}
                        onClick={() => setMenuOpen(false)}
                      >
                        <Icon d={item.icon} />
                        <span className="item-label">{t(item.label)}</span>
                        {badge ? (
                          <>
                            <span className="count" aria-hidden="true">
                              {badge}
                            </span>
                            <span className="visually-hidden">
                              {`, ${t('frame.badgeQueue', { count: badge })}`}
                            </span>
                          </>
                        ) : null}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className="column">
        <header className="topbar">
          <button
            ref={searchButton}
            type="button"
            className="search-trigger"
            aria-keyshortcuts="Meta+K Control+K"
            aria-haspopup="dialog"
            onClick={openSearch}
          >
            <Icon d={searchIcon} />
            <span className="search-trigger-text">{t('frame.searchOpen')}</span>
            <kbd>{t(mac ? 'frame.shortcutMac' : 'frame.shortcutOther')}</kbd>
          </button>
          <span className="env">
            {environmentLabel(configuredEnvironment, import.meta.env.DEV, t)}
          </span>
          <UserMenu session={session} onLogout={onLogout} />
        </header>
        <main id="hovedinnhold" className="main" tabIndex={-1}>
          {health && readOnlyInLockdown ? (
            <LockdownBanner health={health} readOnlyInLockdown={readOnlyInLockdown} />
          ) : null}
          {active ? <SectionTabs item={active} path={path} /> : null}
          {children}
        </main>
      </div>
      <SearchDialog source={search} open={searching} onClose={closeSearch} />
    </div>
  );
};
