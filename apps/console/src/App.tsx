import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { resolveLocale } from '@genai/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient } from './api';
import { useT } from './i18n';
import { LoginError, operatorRole, type AuthClient } from './auth';
import { splitRoute, useHashRoute } from './hooks';
import { Audit } from './screens/Audit';
import { Catalog } from './screens/Catalog';
import { BuildingBlocks } from './screens/BuildingBlocks';
import { Diagnostics } from './screens/Diagnostics';
import { Models } from './screens/Models';
import { Onboarding } from './screens/Onboarding';
import { Operations } from './screens/Operations';
import { PlatformDefaults } from './screens/PlatformDefaults';
import { Policies } from './screens/Policies';
import { pendingCount, Queue } from './screens/Queue';
import { Quality } from './screens/Quality';
import { QualityMatrix } from './screens/QualityMatrix';
import { Settings } from './screens/Settings';
import { SharedServices } from './screens/SharedServices';
import { SupportAccess } from './screens/SupportAccess';
import { TenantServices } from './screens/TenantServices';
import { Tenants } from './screens/Tenants';
import { SearchEngines } from './screens/SearchEngines';
import { Schemas } from './screens/Schemas';
import { Tracing } from './screens/Tracing';
import { allPages, Shell, type NavBadges } from './Shell';
import { EmptyState, Loading } from './states';
import { SupportProvider } from './support';
import type { OperatorSession } from './types';

interface Props {
  auth: AuthClient;
  fetch: typeof fetch;
  baseUrl?: string;
  live?: boolean;
}

export const App = ({ auth, fetch: send, baseUrl = '/api', live = false }: Props) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [session, setSession] = useState<OperatorSession | undefined>(auth.current());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();
  const [completing, setCompleting] = useState(
    () => Boolean(auth.completeLogin) && window.location.pathname === '/callback',
  );
  const callback = useRef<Promise<OperatorSession> | undefined>(undefined);
  const [badges, setBadges] = useState<NavBadges>({});
  const [queued, setQueued] = useState<number | undefined>();
  const [decided, setDecided] = useState(0);
  const [expired, setExpired] = useState(false);
  const hash = useHashRoute();
  const api = useMemo(() => {
    const watched: typeof fetch = async (input, init) => {
      const response = await send(input, init);
      if (response.status === 401 && auth.current()) {
        auth.expire();
        setExpired(true);
        setSession(undefined);
      }
      return response;
    };
    return createApiClient({
      baseUrl,
      fetch: watched,
      token: () => auth.current()?.token,
      actorName: () => auth.current()?.name,
      locale: () => resolveLocale(document.documentElement.lang),
      settingsGrid: !live,
    });
  }, [auth, send, baseUrl, live]);
  const authorized = Boolean(session?.roles.includes(operatorRole));

  useEffect(() => {
    if (!completing || !auth.completeLogin) return;
    callback.current ??= auth.completeLogin(new URL(window.location.href));
    let active = true;
    callback.current.then(
      (next) => {
        if (!active) return;
        window.history.replaceState(null, '', '/#/tenants');
        setSession(next);
        setCompleting(false);
      },
      (error: unknown) => {
        if (!active) return;
        window.history.replaceState(null, '', '/');
        setFailed(error instanceof LoginError ? error.message : tRef.current('api.loginFailed'));
        setCompleting(false);
      },
    );
    return () => {
      active = false;
    };
  }, [auth, completing]);

  useEffect(() => {
    if (!authorized) return;
    const controller = new AbortController();
    api.operations(controller.signal).then(
      (operations) => {
        if (!controller.signal.aborted) setBadges({ operations: operations.triggers.length });
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [api, authorized]);

  useEffect(() => {
    if (!authorized) return;
    const controller = new AbortController();
    void pendingCount(api, controller.signal).then((n) => {
      if (!controller.signal.aborted) setQueued(n);
    });
    return () => controller.abort();
  }, [api, authorized, decided]);

  const login = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(undefined);
    try {
      setSession(await auth.login());
      setExpired(false);
    } catch {
      setFailed(tRef.current('api.loginFailed'));
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    void auth.logout().then(() => setSession(undefined));
  };

  if (completing)
    return (
      <main className="login" id="hovedinnhold">
        <Loading label={t('shell.completingLogin')} />
      </main>
    );

  if (!session && expired)
    return (
      <main className="login" id="hovedinnhold">
        <img src="/emblem-felleslosning.svg" alt="" width={48} height={48} />
        <Heading level={1} data-size="lg">
          {t('shell.loggedOutTitle')}
        </Heading>
        <Paragraph>{t('shell.loggedOutText')}</Paragraph>
        {failed ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {t('shell.retryAfterFailure', { message: failed })}
          </Alert>
        ) : null}
        <Button onClick={login} loading={busy} aria-disabled={busy || undefined}>
          {t('shell.login')}
        </Button>
      </main>
    );

  if (!session)
    return (
      <main className="login" id="hovedinnhold">
        <img src="/emblem-felleslosning.svg" alt="" width={48} height={48} />
        <Heading level={1} data-size="lg">
          {t('shell.title')}
        </Heading>
        <Paragraph>{t('shell.loginIntro')}</Paragraph>
        {failed ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {t('shell.retryAfterFailure', { message: failed })}
          </Alert>
        ) : null}
        <Button onClick={login} loading={busy} aria-disabled={busy || undefined}>
          {t('shell.loginWithAccount')}
        </Button>
      </main>
    );

  if (!authorized)
    return (
      <main className="refusal" id="hovedinnhold">
        <img src="/emblem-felleslosning.svg" alt="" width={48} height={48} />
        <div className="refusal-text">
          <Heading level={1} data-size="lg">
            {t('shell.refusedTitle')}
          </Heading>
          <Paragraph data-size="lg">{t('shell.refusedText', { name: session.name })}</Paragraph>
        </div>
        <Paragraph>{t('shell.refusedHelp')}</Paragraph>
        <Button variant="secondary" className="align-start" onClick={logout}>
          {t('shell.logout')}
        </Button>
      </main>
    );

  const { path, params } = splitRoute(hash);
  const current = path === '/' ? '/tenants' : path;
  const page = allPages.find((p) => p.path === current);
  const screens: Record<string, () => React.ReactNode> = {
    '/tenants': () => <Tenants api={api} />,
    '/queue': () => (
      <Queue
        api={api}
        tab={params.get('tab') ?? undefined}
        onDecided={() => setDecided((n) => n + 1)}
      />
    ),
    '/tenants/services': () => (
      <TenantServices
        api={api}
        tenant={params.get('tenant') ?? undefined}
        kind={params.get('kind') === 'step-flow' ? 'StepFlow' : 'Service'}
        id={params.get('id') ?? undefined}
      />
    ),
    '/onboarding': () => <Onboarding api={api} live={live} />,
    '/models': () => <Models api={api} />,
    '/catalog': () => <Catalog api={api} tab={params.get('tab') ?? undefined} />,
    '/policies': () => <Policies api={api} tab={params.get('tab') ?? undefined} />,
    '/building-blocks': () => (
      <BuildingBlocks api={api} initial={params.get('block') ?? undefined} live={live} />
    ),
    '/shared-services': () => <SharedServices api={api} />,
    '/settings': () => <Settings api={api} />,
    '/quality': () => <Quality api={api} />,
    '/search-engines': () => <SearchEngines api={api} />,
    '/quality-matrix': () => (
      <QualityMatrix api={api} tab={params.get('tab') ?? 'matrix'} live={live} />
    ),
    '/tracing': () => <Tracing api={api} />,
    '/operations': () => <Operations api={api} />,
    '/diagnostics': () => (
      <Diagnostics
        api={api}
        tenant={params.get('tenant') ?? undefined}
        kind={params.get('kind') === 'service' ? 'service' : 'run'}
      />
    ),
    '/support-access': () => <SupportAccess api={api} tenant={params.get('tenant') ?? undefined} />,
    '/audit': () => <Audit api={api} />,
    '/platform-defaults': () => <PlatformDefaults />,
    '/schemas': () => <Schemas api={api} initial={params.get('kind') ?? undefined} />,
  };
  const render = Object.hasOwn(screens, current) ? screens[current] : undefined;
  return (
    <SupportProvider api={api}>
      <Shell
        session={session}
        path={current}
        badges={queued === undefined ? badges : { ...badges, queue: queued }}
        onLogout={logout}
      >
        {render ? (
          render()
        ) : (
          <EmptyState title={page ? t(page.label) : t('shell.notFound')}>
            <Paragraph>{t('shell.notFoundHelp')}</Paragraph>
          </EmptyState>
        )}
      </Shell>
    </SupportProvider>
  );
};
