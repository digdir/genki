import { Alert, Button, Heading, Paragraph, Spinner } from '@digdir/designsystemet-react';
import { LanguageChoice, useLocale } from '@genai/i18n/react';
import { Assistant, createGenkiApi, profileOf } from '@genai/ui-assembly';
import { Markdown } from '@genai/ui-blocks';
import type { AssistantLayout } from '@genai/ui-blocks/builder';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  inLanguage,
  isPageLink,
  loadHost,
  loadLayout,
  loadPage,
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

const PageView = ({
  fetcher,
  hostname,
  id,
}: {
  fetcher: typeof fetch;
  hostname: string;
  id: string;
}) => {
  const t = useT();
  const { locale } = useLocale();
  const page = useLoaded<Page>(() => loadPage(fetcher, hostname, id), [hostname, id]);
  if (page.kind === 'loading') return <Spinner aria-label={t('host.loading')} />;
  if (page.kind !== 'ok') return <Paragraph>{t('host.pageMissing')}</Paragraph>;
  return (
    <article className="ah-page">
      <Heading level={1} data-size="lg">
        {textIn(page.value.title, locale)}
      </Heading>
      <Markdown text={textIn(page.value.body, locale)} headingLevel={2} links={isPageLink} />
    </article>
  );
};

const AssistantPane = ({
  fetcher,
  host,
  session,
}: {
  fetcher: typeof fetch;
  host: HostView;
  session: Session;
}) => {
  const t = useT();
  const { locale } = useLocale();
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
  if (layout.kind === 'loading') return <Spinner aria-label={t('host.loading')} />;
  if (layout.kind === 'failed') return <Alert data-color="danger">{t('host.failed')}</Alert>;
  if (!shown || !api) return <Paragraph>{t('host.noLayout')}</Paragraph>;
  return (
    <Assistant
      api={api}
      layout={shown}
      service={host.service}
      tenant={host.tenant}
      threadInUrl
      paths={{ home: '/', settings: '/innstillinger' }}
    />
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
        ? { name: hostSession.value.who.name ?? '', headers: bff.headers() }
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
  let body: ReactNode;
  if (onPage) body = <PageView fetcher={fetcher} hostname={view.hostname} id={pageId} />;
  else if (session) body = <AssistantPane fetcher={fetcher} host={view} session={session} />;
  else body = <SignIn onSignIn={startSignIn} />;
  return (
    <>
      <Header host={view} session={session} onSignOut={signOut} />
      <main className={!onPage && session ? 'ah-main ah-assistant' : 'ah-main'} id="main">
        {signInFailed ? <Alert data-color="danger">{t('host.signInFailed')}</Alert> : null}
        {body}
      </main>
    </>
  );
};
