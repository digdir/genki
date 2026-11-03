import { Alert, Button, Dropdown, Heading, SkipLink } from '@digdir/designsystemet-react';
import { links } from '@genai/docs-content';
import {
  configureRouting,
  DocsPage,
  DocsSiteRoot,
  href,
  parseHash,
  SearchDialog,
  useSearchShortcut,
  type Route as DocsRoute,
  type Scheme,
} from '@genai/docs-site';
import docsStyles from '@genai/docs-site/styles.css?inline';
import { useLocale } from '@genai/i18n/react';
import { MagnifyingGlassIcon, MenuElipsisHorizontalIcon, XMarkIcon } from '@navikt/aksel-icons';
import {
  useEffect,
  useInsertionEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { appTitle } from '../../app-title';
import { Icon, icons } from '../../components/Icon';
import type { Route } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import { Contact } from '../FooterPages';
import { useBelow } from '../Startside';
import aboutStyles from './about.css?inline';
import { DataHandlingPage } from './DataHandlingPage';
import { PricePage } from './PricePage';
import { PublicErrorBoundary } from './PublicErrorBoundary';
import { priceSegment, siteName, useDocumentTitle } from './public-pages';
import { PublicStart } from './PublicStart';
import '../startside.css';

configureRouting({
  prefix: '#/about',
  segments: {
    malbilde: 'target-picture',
    byggeklosser: 'building-blocks',
    tjenester: 'flows',
    sok: 'search',
    typer: 'service-types',
    status: 'status',
    'kom-i-gang': 'developers',
  },
  query: { part: 'part', step: 'step', use: 'use', setup: 'setup' },
  liveModels: false,
  siteName,
});

const movedPages: Record<string, DocsRoute> = { 'get-started': { page: 'kom-i-gang' } };

const styleId = 'genki-public-site';

const useStyles = () =>
  useInsertionEffect(() => {
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `${docsStyles}\n${aboutStyles}`;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

const schemeKey = 'genki:public-scheme';

const initialScheme = (): Scheme => {
  try {
    const stored = window.localStorage.getItem(schemeKey);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    return 'light';
  }
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
};

const useScheme = () => {
  const [scheme, setScheme] = useState<Scheme>(initialScheme);
  useEffect(() => {
    const root = document.documentElement;
    const before = root.getAttribute('data-color-scheme');
    root.setAttribute('data-color-scheme', scheme);
    return () => {
      if (before === null) root.removeAttribute('data-color-scheme');
      else root.setAttribute('data-color-scheme', before);
    };
  }, [scheme]);
  const toggle = () =>
    setScheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(schemeKey, next);
      } catch {
        return next;
      }
      return next;
    });
  return [scheme, toggle] as const;
};

const useRestoreTitle = () => {
  const { locale } = useLocale();
  const current = useRef(locale);
  current.current = locale;
  useEffect(
    () => () => {
      document.title = appTitle[current.current];
    },
    [],
  );
};

const sections = [
  [{ page: 'malbilde' }, 'about.navTargetPicture'],
  [{ page: 'byggeklosser' }, 'about.navBlocks'],
  [{ page: 'typer' }, 'about.navServiceTypes'],
  [{ page: 'tjenester' }, 'about.navFlows'],
] as const satisfies readonly (readonly [DocsRoute, PlainKey])[];

const exploreLinks = [
  [href({ page: 'kom-i-gang' }), 'about.navDevelopers'],
  [links.api, 'about.apiDocs'],
] as const satisfies readonly (readonly [string, PlainKey])[];

const githubLinks = [
  [links.repo, 'about.sourceCode'],
  [links.adr, 'about.adrs'],
] as const satisfies readonly (readonly [string, PlainKey])[];

type Settings = { scheme: Scheme; toggleScheme: () => void; switchLanguage: () => void };

const More = ({ scheme, toggleScheme, switchLanguage }: Settings) => {
  const t = useT();
  const { locale } = useLocale();
  const linkGroup = (heading: PlainKey, items: readonly (readonly [string, PlainKey])[]) => (
    <>
      <Dropdown.Heading>{t(heading)}</Dropdown.Heading>
      <Dropdown.List>
        {items.map(([to, label]) => (
          <Dropdown.Item key={to}>
            <Dropdown.Button asChild>
              <a href={to}>{t(label)}</a>
            </Dropdown.Button>
          </Dropdown.Item>
        ))}
      </Dropdown.List>
    </>
  );
  return (
    <Dropdown.TriggerContext>
      <Dropdown.Trigger
        variant="tertiary"
        data-color="accent"
        data-size="sm"
        icon
        aria-label={t('about.more')}
        title={t('about.more')}
      >
        <MenuElipsisHorizontalIcon aria-hidden />
      </Dropdown.Trigger>
      <Dropdown placement="bottom-end" data-size="sm" className="about-more">
        {linkGroup('about.explore', exploreLinks)}
        {linkGroup('about.onGitHub', githubLinks)}
        <Dropdown.Heading>{t('about.display')}</Dropdown.Heading>
        <Dropdown.List>
          <Dropdown.Item>
            <Dropdown.Button onClick={toggleScheme}>
              {scheme === 'dark' ? t('about.toLight') : t('about.toDark')}
            </Dropdown.Button>
          </Dropdown.Item>
          <Dropdown.Item>
            <Dropdown.Button lang={locale === 'nb' ? 'en' : 'nb'} onClick={switchLanguage}>
              {t('about.language')}
            </Dropdown.Button>
          </Dropdown.Item>
        </Dropdown.List>
      </Dropdown>
    </Dropdown.TriggerContext>
  );
};

const MenuPanel = ({
  nav,
  onSearch,
  scheme,
  toggleScheme,
  switchLanguage,
}: Settings & { nav: ReactNode; onSearch: () => void }) => {
  const t = useT();
  const { locale } = useLocale();
  const group = (heading: PlainKey, rows: ReactNode) => (
    <div className="about-menu-group">
      <p className="about-menu-heading">{t(heading)}</p>
      <ul className="about-menu-list">{rows}</ul>
    </div>
  );
  const linkRows = (items: readonly (readonly [string, PlainKey])[]) =>
    items.map(([to, label]) => (
      <li key={to}>
        <a className="about-menu-row" href={to}>
          {t(label)}
        </a>
      </li>
    ));
  return (
    <div id="sidemeny" className="about-menu">
      {nav}
      {group(
        'about.explore',
        <>
          <li>
            <button type="button" className="about-menu-row" onClick={onSearch}>
              {t('about.searchShort')}
            </button>
          </li>
          {linkRows(exploreLinks)}
        </>,
      )}
      {group('about.onGitHub', linkRows(githubLinks))}
      {group(
        'about.display',
        <>
          <li>
            <button type="button" className="about-menu-row" onClick={toggleScheme}>
              {scheme === 'dark' ? t('about.toLight') : t('about.toDark')}
            </button>
          </li>
          <li>
            <button
              type="button"
              className="about-menu-row"
              lang={locale === 'nb' ? 'en' : 'nb'}
              onClick={switchLanguage}
            >
              {t('about.language')}
            </button>
          </li>
        </>,
      )}
    </div>
  );
};

const ContactPage = () => {
  const t = useT();
  useDocumentTitle(t('shell.contact'));
  return (
    <div className="about-prose">
      <Heading level={1} data-size="lg">
        {t('shell.contact')}
      </Heading>
      <Contact />
    </div>
  );
};

const Moved = ({ to }: { to: DocsRoute }) => {
  useEffect(() => {
    window.location.replace(href(to));
  }, [to]);
  return null;
};

const publicPage = (route: Route) => {
  const [area, sub] = route.segments;
  if (area === 'data-handling') return 'data-handling';
  if (area === 'contact') return 'contact';
  if (area === 'about' && sub === priceSegment) return 'price';
  if (area === 'about' && sub && Object.hasOwn(movedPages, sub)) return 'moved';
  return 'docs';
};

export const PublicSite = ({
  route,
  preview,
  onLogin,
  busy,
  failed,
}: {
  route: Route;
  preview: ReactNode;
  onLogin: () => void;
  busy: boolean;
  failed: boolean;
}) => {
  useStyles();
  useRestoreTitle();
  const t = useT();
  const { locale, setPreference } = useLocale();
  const narrow = useBelow(1120);
  const short = useBelow(760);
  const tiny = useBelow(360);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useSearchShortcut();
  const [scheme, toggleScheme] = useScheme();
  const main = useRef<HTMLElement>(null);
  const kind = publicPage(route);
  const page = parseHash(window.location.hash);
  const onStart = kind === 'docs' && page.page === 'oversikt';
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);
  useEffect(() => {
    setMenuOpen(false);
    window.scrollTo?.(0, 0);
  }, [route.path]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const settings: Settings = {
    scheme,
    toggleScheme,
    switchLanguage: () => setPreference(locale === 'nb' ? 'en' : 'nb'),
  };

  const skipToMain = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    main.current?.focus();
    main.current?.scrollIntoView?.({ block: 'start' });
  };

  const nav = (className: string) => (
    <nav aria-label={t('about.navLabel')} className={className}>
      {sections.map(([to, label]) => (
        <a
          key={to.page}
          href={href(to)}
          aria-current={kind === 'docs' && page.page === to.page ? 'page' : undefined}
        >
          {t(label)}
        </a>
      ))}
    </nav>
  );

  const content = () => {
    switch (kind) {
      case 'price':
        return <PricePage />;
      case 'data-handling':
        return <DataHandlingPage />;
      case 'contact':
        return <ContactPage />;
      case 'moved': {
        const to = movedPages[route.segments[1] ?? ''];
        return to ? <Moved to={to} /> : null;
      }
      default:
        return onStart ? <PublicStart onLogin={onLogin} /> : <DocsPage route={page} />;
    }
  };

  const nbOnlyNote =
    locale !== 'nb' &&
    kind === 'docs' &&
    !onStart &&
    page.page !== 'kom-i-gang' &&
    page.page !== 'ikke-funnet';

  return (
    <div className="startside about-site" data-color="neutral" data-color-scheme={scheme}>
      <SkipLink href="#hovedinnhold" onClick={skipToMain}>
        {t('shell.skipToContent')}
      </SkipLink>
      <header className="start-header about-header">
        {preview}
        <div className="about-bar">
          <a className="brand about-brand" href="#/">
            <img src="/emblem-felleslosning.svg" alt="" width={32} height={32} />
            <span className="brand-text">
              <span className="brand-owner">{t('shell.owner')}</span>
              <span className="brand-name">
                {short ? t('shell.brandShort') : t('shell.brandFull')}
              </span>
            </span>
          </a>
          {narrow ? <div className="header-spacer" /> : nav('about-nav')}
          <div className="about-tools">
            {narrow ? (
              <Button
                variant="tertiary"
                data-color="accent"
                data-size="sm"
                icon={tiny}
                className="about-menu-button"
                aria-label={tiny ? t('shell.menu') : undefined}
                aria-expanded={menuOpen}
                aria-controls="sidemeny"
                onClick={() => setMenuOpen((o) => !o)}
              >
                {menuOpen ? <XMarkIcon aria-hidden /> : <Icon d={icons.menu} />}
                {tiny ? null : t('shell.menu')}
              </Button>
            ) : (
              <>
                <Button
                  variant="tertiary"
                  data-color="accent"
                  data-size="sm"
                  icon
                  aria-label={t('about.search')}
                  title={t('about.search')}
                  onClick={() => setSearchOpen(true)}
                >
                  <MagnifyingGlassIcon aria-hidden />
                </Button>
                <More {...settings} />
              </>
            )}
            <Button
              variant="secondary"
              data-color="accent"
              data-size="sm"
              className="about-login"
              onClick={onLogin}
              loading={busy}
            >
              {t('start.login')}
            </Button>
          </div>
        </div>
        {narrow && menuOpen ? (
          <MenuPanel
            {...settings}
            nav={nav('about-menu-nav')}
            onSearch={() => {
              setMenuOpen(false);
              setSearchOpen(true);
            }}
          />
        ) : null}
      </header>
      {narrow && menuOpen ? (
        <div
          className="about-menu-backdrop"
          aria-hidden="true"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      <DocsSiteRoot scheme={scheme} className="about-root">
        <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
        <main id="hovedinnhold" ref={main} tabIndex={-1} className="about-main">
          {failed ? (
            <Alert data-color="danger" role="alert" className="about-alert">
              {t('start.loginFailed')}
            </Alert>
          ) : null}
          <PublicErrorBoundary key={route.path}>
            <div key={kind === 'docs' ? page.page : kind} className="about-page">
              {content()}
            </div>
          </PublicErrorBoundary>
        </main>
      </DocsSiteRoot>
      <footer className="start-footer about-footer">
        <div className="about-footer-bar">
          <span className="row-wrap">
            <img src="/emblem-felleslosning.svg" alt="" width={24} height={24} />
            {t('start.operatedBy')}
          </span>
          <nav aria-label={t('start.footer')} className="about-footer-links">
            <a href="#/contact">{t('start.contact')}</a>
          </nav>
        </div>
        <p className="about-footer-note">
          {t('about.footerSource')}
          {nbOnlyNote ? ` ${t('about.nbOnly')}` : null}
        </p>
      </footer>
    </div>
  );
};
