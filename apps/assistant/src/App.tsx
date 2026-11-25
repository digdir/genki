import {
  Alert,
  Button,
  Card,
  Heading,
  Link,
  Paragraph,
  Spinner,
} from '@digdir/designsystemet-react';
import type { Locale } from '@genai/i18n';
import { LocaleProvider, useLocale } from '@genai/i18n/react';
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
import { ArrowLeftIcon, ExternalLinkIcon, FileTextIcon } from '@navikt/aksel-icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  choosesLanguage,
  inLanguage,
  isPageLink,
  loadHost,
  redirectAddress,
  loadLayout,
  type ShownInterface,
  loadPage,
  lockedLanguage,
  showIcon,
  textIn,
  type HostView,
  type Page,
} from './host';
import { bffSignIn, type HostSession, type HostSignIn, type SignedIn } from './bff';
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

/** The chosen organisation by its name where the login gave one, else its number. */
const organisationOf = (who: SignedIn) =>
  who.organisations.find((o) => o.orgNumber === who.organisation)?.name ??
  who.organisation ??
  undefined;

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

/** The service's name in the corner, a way home and nothing else: the choices are the assistant's. */
const ServiceName = ({ host }: { host: HostView }) => {
  const { locale } = useLocale();
  return (
    <header className="ah-top">
      <a className="ah-name" href="/">
        {textIn(host.name, locale)}
      </a>
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

const profileMenu = (host: HostView, locale: Locale): AssistantProfile['menu'] => ({
  extra: host.menu.map((item) =>
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
});

const AssistantPane = ({
  fetcher,
  host,
  session,
  signOut,
  onSignOut,
  files,
}: {
  fetcher: typeof fetch;
  host: HostView;
  session: Session;
  signOut: { href: string; onSignOut?: () => void };
  onSignOut: () => void;
  files: boolean;
}) => {
  const t = useT();
  const { locale, setPreference } = useLocale();
  const [colorScheme, setColorScheme] = useStoredColorScheme('assistant.colorScheme');
  const layout = useLoaded<ShownInterface>(
    () => loadLayout(fetcher, host.service, session.headers),
    [host.service, session],
  );
  const shown = useMemo(
    () => (layout.kind === 'ok' ? inLanguage(layout.value.layout, locale) : undefined),
    [layout, locale],
  );
  const refBlocks = layout.kind === 'ok' ? layout.value.blocks : undefined;
  const api = useMemo(
    () =>
      shown &&
      createGenkiApi({
        baseUrl: '/api',
        tenant: host.tenant,
        profile: profileOf(shown, undefined, locale),
        language: locale,
        headers: () => session.headers,
      }),
    [shown, host.tenant, locale, session],
  );
  const profile = useMemo<AssistantProfile>(
    () => ({
      signedInAs: session.name || session.organisation || t('host.signedIn'),
      ...(session.name && session.organisation ? { organisation: session.organisation } : {}),
      menu: profileMenu(host, locale),
      signOut,
      ...(files && api ? { documentFile: api.documentFile } : {}),
    }),
    [session, host, locale, signOut, files, api, t],
  );
  const [say, notice] = useNotice();
  const storage = useMemo(() => browserStorage(`assistant.${host.service}.`), [host.service]);
  const alone = (content: ReactNode) => (
    <>
      <ServiceName host={host} />
      <main className="ah-main" id="main">
        {content}
      </main>
    </>
  );
  if (layout.kind === 'loading') return alone(<Spinner aria-label={t('host.loading')} />);
  // The one way out when the assistant cannot load, since its own «Logg ut» is in it.
  if (layout.kind === 'failed')
    return alone(
      <Alert data-color="danger" className="ah-failed">
        <Paragraph>{t('host.failed')}</Paragraph>
        <Button variant="secondary" data-size="sm" onClick={onSignOut}>
          {t('host.signOut')}
        </Button>
      </Alert>,
    );
  if (!shown || !api) return alone(<Paragraph>{t('host.noLayout')}</Paragraph>);
  return (
    <>
      <div className="ah-assistant">
        <Assistant
          api={api}
          layout={shown}
          refBlocks={refBlocks}
          service={host.service}
          tenant={host.tenant}
          profile={profile}
          storage={storage}
          colorScheme={colorScheme}
          onColorSchemeChange={setColorScheme}
          language={locale}
          {...(choosesLanguage(host) ? { onLanguageChange: setPreference } : {})}
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

/** The service's own pages and links, under the sign-in, since nothing else shows them before it. */
const HostMenu = ({ host }: { host: HostView }) => {
  const t = useT();
  const { locale } = useLocale();
  if (host.menu.length === 0) return null;
  return (
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
  );
};

/** The login page: one card in the middle, genki's mascot, a heading, and the one way in. */
const SignIn = ({
  host,
  onSignIn,
  failed,
}: {
  host: HostView;
  onSignIn: (() => void) | undefined;
  failed: boolean;
}) => {
  const t = useT();
  const { locale } = useLocale();
  return (
    <div className="ah-signin">
      <Card className="ah-signin-card" data-color="neutral">
        <img className="ah-signin-mascot" src="/genki-mascot.png" alt="" width={96} height={88} />
        <Heading level={1} data-size="md">
          {t('host.signInTitle')}
        </Heading>
        {onSignIn ? (
          <>
            <Paragraph>{t('host.signInLead', { name: textIn(host.name, locale) })}</Paragraph>
            {failed ? <Alert data-color="danger">{t('host.signInFailed')}</Alert> : null}
            <Button className="ah-signin-button" data-color="accent" onClick={onSignIn}>
              {t('host.signIn')}
            </Button>
          </>
        ) : (
          <Alert data-color="info">
            <Heading level={2} data-size="xs">
              {t('host.signInUnavailable')}
            </Heading>
            {host.menu.length > 0 ? (
              <Paragraph>{t('host.signInUnavailableDetail')}</Paragraph>
            ) : null}
          </Alert>
        )}
      </Card>
      <HostMenu host={host} />
    </div>
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
  const { locale } = useLocale();
  const bff = useMemo(() => givenBff ?? bffSignIn(fetcher), [givenBff, fetcher]);
  const host = useLoaded<HostView>(async () => {
    const answer = await loadHost(fetcher, hostname);
    if (!answer || !('redirectTo' in answer)) return answer;
    const away = redirectAddress(answer, path);
    if (away) navigate(away);
    return undefined;
  }, [hostname]);
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
            organisation: organisationOf(hostSession.value.who),
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
  const locked = lockedLanguage(view, locale);
  const shown = onPage ? (
    <PageView fetcher={fetcher} host={view} id={pageId} />
  ) : session ? (
    <AssistantPane
      fetcher={fetcher}
      host={view}
      session={session}
      signOut={signOutLink}
      onSignOut={signOut}
      files={viaBff}
    />
  ) : (
    <div className="ah-signin-page">
      <ServiceName host={view} />
      <main className="ah-main ah-signin-main" id="main">
        <SignIn host={view} onSignIn={startSignIn} failed={signInFailed} />
      </main>
    </div>
  );
  return locked ? <LocaleProvider preference={locked}>{shown}</LocaleProvider> : shown;
};
