import { Alert, Button, Heading, Link, Paragraph, Spinner } from '@digdir/designsystemet-react';
import { localeNames, locales, type Locale } from '@genai/i18n';
import { LanguageChoice, useLocale } from '@genai/i18n/react';
import {
  Assistant,
  browserStorage,
  createGenkiApi,
  profileOf,
  useNotice,
  useStoredColorScheme,
  type AssistantProfile,
} from '@genai/ui-assembly';
import { Markdown } from '@genai/ui-blocks';
import { lookOf, type AssistantLayout } from '@genai/ui-blocks/builder';
import { ArrowLeftIcon, ExternalLinkIcon, FileTextIcon, GlobeIcon } from '@navikt/aksel-icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  inLanguage,
  isPageLink,
  loadHost,
  loadLayout,
  loadPage,
  showIcon,
  textIn,
  type HostView,
  type Page,
} from './host';
import { bffSignIn, type HostSession, type HostSignIn } from './bff';
import type { HostLogin, Login } from './login';
import { useT } from './i18n';

export interface AppProps {
  hostname: string;
  path: string;
  /** Makes the browser login for the client the host route names, used only without the BFF. */
  signIn: (login: HostLogin) => Login;
  fetcher?: typeof fetch;
  bff?: HostSignIn;
  navigate?: (url: string) => void;
}

interface Session {
  name: string;
  organisation?: string | undefined;
  /** What every call to genki carries: the bearer token, or the BFF's CSRF header. */
  headers: Record<string, string>;
}

const withToken = (session: { name: string; token: string }): Session => ({
  name: session.name,
  headers: { authorization: `Bearer ${session.token}` },
});

type Loaded<T> =
  { kind: 'loading' } | { kind: 'missing' } | { kind: 'failed' } | { kind: 'ok'; value: T };

const useLoaded = <T,>(load: () => Promise<T | undefined>, deps: readonly unknown[]) => {
  const [state, setState] = useState<Loaded<T>>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    load().then(
      (value) =>
        live && setState(value === undefined ? { kind: 'missing' } : { kind: 'ok', value }),
      () => live && setState({ kind: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, deps);
  return state;
};

const Header = ({
  host,
  session,
  onSignOut,
}: {
  host: HostView;
  session: Session | undefined;
  onSignOut: () => void;
}) => {
  const t = useT();
  const { locale } = useLocale();
  return (
    <header className="ah-header">
      <a className="ah-name" href="/">
        {textIn(host.name, locale)}
      </a>
      {host.menu.length > 0 ? (
        <nav aria-label={t('host.menu')}>
          <ul className="ah-menu">
            {host.menu.map((item) => (
              <li key={'page' in item ? `page:${item.page}` : `href:${item.href}`}>
                {'page' in item ? (
                  <a href={`/${item.page}`}>{textIn(item.label, locale)}</a>
                ) : (
                  <a href={item.href} target="_blank" rel="noopener noreferrer">
                    {textIn(item.label, locale)}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <LanguageChoice className="ah-language" />
      {session ? (
        <Button variant="tertiary" data-size="sm" onClick={onSignOut}>
          {t('host.signOut')}
        </Button>
      ) : null}
    </header>
  );
};

const PageView = ({ fetcher, host, id }: { fetcher: typeof fetch; host: HostView; id: string }) => {
  const t = useT();
  const { locale } = useLocale();
  const page = useLoaded<Page>(() => loadPage(fetcher, host.hostname, id), [host.hostname, id]);
  const back = (
    <Link href="/" className="ah-page-back">
      <ArrowLeftIcon aria-hidden />
      {t('host.backTo', { name: textIn(host.name, locale) })}
    </Link>
  );
  return (
    <div className="ah-page-frame">
      <main className="ah-page" id="main">
        {back}
        {page.kind === 'loading' ? (
          <Spinner aria-label={t('host.loading')} />
        ) : page.kind === 'ok' ? (
          <article className="ah-page-text">
            <Heading level={1} data-size="lg">
              {textIn(page.value.title, locale)}
            </Heading>
            <Markdown text={textIn(page.value.body, locale)} headingLevel={2} links={isPageLink} />
          </article>
        ) : (
          <Paragraph>{t('host.pageMissing')}</Paragraph>
        )}
        {back}
      </main>
    </div>
  );
};

const drawsReader = (layout: AssistantLayout, session: Session) =>
  lookOf(layout) === 'next' && session.name !== '';

const otherLocale = (locale: Locale): Locale => locales.find((l) => l !== locale) ?? locale;

const profileMenu = (
  host: HostView,
  locale: Locale,
  setPreference: (preference: Locale) => void,
): AssistantProfile['menu'] => {
  const other = otherLocale(locale);
  return {
    extra: [
      ...host.menu.map((item) =>
        'page' in item
          ? {
              id: `page:${item.page}`,
              label: textIn(item.label, locale),
              href: `/${item.page}`,
              icon: <FileTextIcon aria-hidden />,
            }
          : {
              id: `href:${item.href}`,
              label: textIn(item.label, locale),
              href: item.href,
              icon: <ExternalLinkIcon aria-hidden />,
            },
      ),
      ...(other === locale
        ? []
        : [
            {
              id: 'language',
              label: localeNames[other],
              onSelect: () => setPreference(other),
              icon: <GlobeIcon aria-hidden />,
            },
          ]),
    ],
  };
};

const AssistantPane = ({
  fetcher,
  host,
  session,
  header,
  signOut,
}: {
  fetcher: typeof fetch;
  host: HostView;
  session: Session;
  header: ReactNode;
  signOut: { href: string; onSignOut?: () => void };
}) => {
  const t = useT();
  const { locale, setPreference } = useLocale();
  const [colorScheme, setColorScheme] = useStoredColorScheme('assistant.colorScheme');
  const layout = useLoaded<AssistantLayout>(
    () => loadLayout(fetcher, host.service, session.headers),
    [host.service, session],
  );
  const shown = useMemo(
    () => (layout.kind === 'ok' ? inLanguage(layout.value, locale) : undefined),
    [layout, locale],
  );
  const api = useMemo(
    () =>
      shown &&
      createGenkiApi({
        baseUrl: '/api',
        tenant: host.tenant,
        profile: profileOf(shown),
        language: locale,
        headers: () => session.headers,
      }),
    [shown, host.tenant, locale, session],
  );
  const profile = useMemo<AssistantProfile>(
    () => ({
      ...(session.name ? { signedInAs: session.name } : {}),
      ...(session.organisation ? { organisation: session.organisation } : {}),
      menu: profileMenu(host, locale, setPreference),
      signOut,
    }),
    [session, host, locale, setPreference, signOut],
  );
  const [say, notice] = useNotice();
  const storage = useMemo(() => browserStorage(`assistant.${host.service}.`), [host.service]);
  const alone = (content: ReactNode) => (
    <>
      {header}
      <main className="ah-main" id="main">
        {content}
      </main>
    </>
  );
  if (layout.kind === 'loading') return alone(<Spinner aria-label={t('host.loading')} />);
  if (layout.kind === 'failed') return alone(<Alert data-color="danger">{t('host.failed')}</Alert>);
  if (!shown || !api) return alone(<Paragraph>{t('host.noLayout')}</Paragraph>);
  return (
    <>
      {drawsReader(shown, session) ? null : header}
      <div className="ah-assistant">
        <Assistant
          api={api}
          layout={shown}
          service={host.service}
          tenant={host.tenant}
          profile={profile}
          storage={storage}
          colorScheme={colorScheme}
          onColorSchemeChange={setColorScheme}
          onNotice={say}
          onFeedback={api.sendFeedback}
          onRename={api.renameThread}
          onDelete={api.deleteThread}
          mainId="main"
          threadInUrl
          paths={{ home: '/', settings: '/innstillinger' }}
        />
      </div>
      {notice}
    </>
  );
};

const SignIn = ({ onSignIn }: { onSignIn: (() => void) | undefined }) => {
  const t = useT();
  return onSignIn ? (
    <div className="ah-signin">
      <Button onClick={onSignIn}>{t('host.signIn')}</Button>
    </div>
  ) : (
    <Alert data-color="info" className="ah-signin">
      <Heading level={2} data-size="xs">
        {t('host.signInUnavailable')}
      </Heading>
      <Paragraph>{t('host.signInUnavailableDetail')}</Paragraph>
    </Alert>
  );
};

const useLogin = (view: HostView | undefined, signIn: AppProps['signIn']) =>
  useMemo(() => {
    const login = view?.login;
    return login?.issuer ? signIn({ ...login, issuer: login.issuer }) : undefined;
  }, [view, signIn]);

const goTo = (url: string) => window.location.assign(url);

export const App = ({
  hostname,
  path,
  signIn,
  fetcher = fetch,
  bff: givenBff,
  navigate = goTo,
}: AppProps) => {
  const t = useT();
  const bff = useMemo(() => givenBff ?? bffSignIn(fetcher), [givenBff, fetcher]);
  const host = useLoaded<HostView>(() => loadHost(fetcher, hostname), [hostname]);
  const hostFound = host.kind === 'ok';
  const icon = host.kind === 'ok' ? host.value.icon : undefined;
  useEffect(() => showIcon(icon), [icon]);
  const hostSession = useLoaded<HostSession>(
    async () =>
      hostFound ? bff.session().catch((): HostSession => ({ kind: 'unavailable' })) : undefined,
    [bff, hostFound],
  );
  const viaBff = hostSession.kind === 'ok' && hostSession.value.kind !== 'off';
  const login = useLogin(
    host.kind === 'ok' && hostSession.kind === 'ok' && !viaBff ? host.value : undefined,
    signIn,
  );
  const [browserSession, setSession] = useState<Session>();
  const bffSession = useMemo<Session | undefined>(
    () =>
      hostSession.kind === 'ok' && hostSession.value.kind === 'signed-in'
        ? {
            name: hostSession.value.who.name ?? '',
            organisation: hostSession.value.who.organisation ?? undefined,
            headers: bff.headers(),
          }
        : undefined,
    [hostSession, bff],
  );
  const session = viaBff ? bffSession : browserSession;
  const [at, setAt] = useState(path);
  const [signInFailed, setSignInFailed] = useState(false);
  const [completing, setCompleting] = useState(false);
  useEffect(() => {
    if (!login) return;
    if (!login.isCallback()) {
      const current = login.current();
      setSession(current && withToken(current));
      return;
    }
    let live = true;
    setCompleting(true);
    login
      .complete()
      .then(
        ({ session: done, returnTo }) => {
          if (!live) return;
          window.history.replaceState(null, '', returnTo);
          setAt(returnTo);
          setSession(withToken(done));
        },
        () => {
          if (!live) return;
          window.history.replaceState(null, '', '/');
          setAt('/');
          setSignInFailed(true);
        },
      )
      .finally(() => live && setCompleting(false));
    return () => {
      live = false;
    };
  }, [login]);
  const signOutLink = useMemo(
    () =>
      viaBff
        ? { href: bff.signOutUrl }
        : {
            href: '/',
            onSignOut: () => {
              setSession(undefined);
              void login?.signOut();
            },
          },
    [viaBff, bff, login],
  );
  if (host.kind === 'loading' || (hostFound && hostSession.kind !== 'ok') || completing)
    return <Spinner aria-label={t('host.loading')} />;
  if (host.kind === 'failed')
    return (
      <main className="ah-main">
        <Alert data-color="danger">{t('host.failed')}</Alert>
      </main>
    );
  if (host.kind === 'missing')
    return (
      <main className="ah-main">
        <Heading level={1} data-size="md">
          {t('host.notFound')}
        </Heading>
        <Paragraph>{t('host.notFoundDetail')}</Paragraph>
      </main>
    );
  const view = host.value;
  const pageId = at.split('?')[0]?.replace(/^\/+|\/+$/g, '') ?? '';
  const onPage = view.pages.some((p) => p.id === pageId);
  const bffState = hostSession.kind === 'ok' ? hostSession.value.kind : 'off';
  const startSignIn = viaBff
    ? bffState === 'signed-out'
      ? () => navigate(bff.signInUrl(at))
      : undefined
    : login &&
      (() => {
        setSignInFailed(false);
        login.start().catch(() => setSignInFailed(true));
      });
  const signOut = () => {
    if (viaBff) {
      navigate(bff.signOutUrl);
      return;
    }
    setSession(undefined);
    void login?.signOut();
  };
  const header = <Header host={view} session={session} onSignOut={signOut} />;
  if (onPage) return <PageView fetcher={fetcher} host={view} id={pageId} />;
  if (session)
    return (
      <AssistantPane
        fetcher={fetcher}
        host={view}
        session={session}
        header={header}
        signOut={signOutLink}
      />
    );
  return (
    <>
      {header}
      <main className="ah-main" id="main">
        {signInFailed ? <Alert data-color="danger">{t('host.signInFailed')}</Alert> : null}
        <SignIn onSignIn={startSignIn} />
      </main>
    </>
  );
};
