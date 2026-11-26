import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { resolveLocale } from '@genai/i18n';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient } from './api';
import { useT } from './i18n';
import { LoginError, operatorRole, type AuthClient } from './auth';
import { navigate, splitRoute, useHashRoute } from './hooks';
import { Audit } from './screens/Audit';
import { Catalog } from './screens/Catalog';
import { BuildingBlocks } from './screens/BuildingBlocks';
import { Diagnostics } from './screens/Diagnostics';
import { Forward, Models } from './screens/Models';
import { BlockReviews } from './screens/BlockReviews';
import { Onboarding } from './screens/Onboarding';
import { Operations } from './screens/Operations';
import { PlatformDefaults } from './screens/PlatformDefaults';
import { PlatformSecrets } from './screens/PlatformSecrets';
import { FlagsProvider, WhenFlag } from './flags';
import { Policies } from './screens/Policies';
import { pendingCount, Queue } from './screens/Queue';
import { QuotaRequests } from './screens/QuotaRequests';
import { Quality } from './screens/Quality';
import { Settings } from './screens/Settings';
import { SharedServices } from './screens/SharedServices';
import { SupportAccess } from './screens/SupportAccess';
import { StateRegister } from './screens/StateRegister';
import { TenantServices } from './screens/TenantServices';
import { Tenants } from './screens/Tenants';
import { SearchEngines } from './screens/SearchEngines';
import { Schemas } from './screens/Schemas';
import { Tracing } from './screens/Tracing';
import { Shell } from './Shell';
import { EmptyState, Loading } from './states';
import { ContentReasonProvider } from './content-reason';
import { definitionKindOfParam } from './definition-kinds';
import { useSessionRenewal } from './session-renewal';
import {
  forgetUnsavedInput,
  pendingInputHash,
  restoreUnsavedInput,
  saveUnsavedInput,
} from './unsaved-input';

const apisTab = { tab: 'apis' };

const Atlas = lazy(() => import('./screens/Atlas').then((m) => ({ default: m.Atlas })));
const QualityMatrix = lazy(() =>
  import('./screens/QualityMatrix').then((m) => ({ default: m.QualityMatrix })),
);
const Demos = lazy(() => import('./screens/Demos').then((m) => ({ default: m.Demos })));
const Flags = lazy(() => import('./screens/Flags').then((m) => ({ default: m.Flags })));
import type { OperatorSession } from './types';

const inputStore = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => {
  try {
    return window.sessionStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  }
};

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
  const [restoring, setRestoring] = useState(() => Boolean(auth.restore));
  const restored = useRef<Promise<OperatorSession | undefined> | undefined>(undefined);
  const [notOperator] = useState(
    () => new URLSearchParams(window.location.search).get('signin') === 'not-operator',
  );
  const [queued, setQueued] = useState<number | undefined>();
  const [decided, setDecided] = useState(0);
  const [quotaPending, setQuotaPending] = useState<number | undefined>();
  const [quotaDecided, setQuotaDecided] = useState(0);
  const [expired, setExpired] = useState(false);
  const hash = useHashRoute();
  const endSession = useCallback(() => {
    saveUnsavedInput(inputStore());
    auth.expire();
    setExpired(true);
    setSession(undefined);
  }, [auth]);
  const api = useMemo(() => {
    const watched: typeof fetch = async (input, init) => {
      const response = await send(input, init);
      if (response.status === 401 && auth.current()) endSession();
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
  }, [auth, send, baseUrl, live, endSession]);
  const search = useMemo(
    () => ({ tenants: api.listTenants, services: api.tenantDefinitions }),
    [api],
  );
  const authorized = Boolean(session?.roles.includes(operatorRole));
  const signedIn = Boolean(session);
  useSessionRenewal(auth, session, setSession, endSession);

  useEffect(() => {
    if (!signedIn) return;
    const store = inputStore();
    const saved = pendingInputHash(store);
    if (saved === undefined) return;
    if (saved && saved !== window.location.hash) navigate(saved.replace(/^#/, ''));
    return restoreUnsavedInput(store);
  }, [signedIn]);

  useEffect(() => {
    if (!notOperator) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('signin');
    window.history.replaceState(null, '', url);
  }, [notOperator]);

  useEffect(() => {
    if (!restoring || !auth.restore) return;
    restored.current ??= auth.restore();
    let active = true;
    restored.current.then(
      (next) => {
        if (!active) return;
        setSession(next);
        setRestoring(false);
      },
      (error: unknown) => {
        if (!active) return;
        setFailed(error instanceof LoginError ? error.message : tRef.current('api.loginFailed'));
        setRestoring(false);
      },
    );
    return () => {
      active = false;
    };
  }, [auth, restoring]);

  useEffect(() => {
    if (!authorized) return;
    const controller = new AbortController();
    void pendingCount(api, controller.signal).then((n) => {
      if (!controller.signal.aborted) setQueued(n);
    });
    return () => controller.abort();
  }, [api, authorized, decided]);

  useEffect(() => {
    if (!authorized) return;
    const controller = new AbortController();
    api.quotaRequests(controller.signal, 'pending').then(
      (rows) => {
        if (!controller.signal.aborted) setQuotaPending(rows.length);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [api, authorized, quotaDecided]);

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
    forgetUnsavedInput(inputStore());
    void auth.logout().then(() => setSession(undefined));
  };

  if (restoring)
    return (
      <main className="login" id="hovedinnhold">
        <Loading label={t('shell.checkingLogin')} />
      </main>
    );

  const refusal = (text: string) => (
    <main className="refusal" id="hovedinnhold">
      <img src="/emblem-felleslosning.svg" alt="" width={48} height={48} />
      <div className="refusal-text">
        <Heading level={1} data-size="lg">
          {t('shell.refusedTitle')}
        </Heading>
        <Paragraph data-size="lg">{text}</Paragraph>
      </div>
      <Paragraph>{t('shell.refusedHelp')}</Paragraph>
      <Button variant="secondary" className="align-start" onClick={logout}>
        {t('shell.logout')}
      </Button>
    </main>
  );

  if (!session && notOperator) return refusal(t('shell.refusedNotOperator'));

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

  if (!authorized) return refusal(t('shell.refusedText', { name: session.name }));

  const { path, params } = splitRoute(hash);
  const current = path === '/' ? '/tenants' : path;
  if (current === '/atlas')
    return (
      <Suspense fallback={null}>
        <Atlas api={api} />
      </Suspense>
    );
  const notFound = (
    <EmptyState title={t('shell.notFound')}>
      <Paragraph>{t('shell.notFoundHelp')}</Paragraph>
    </EmptyState>
  );
  const screens: Record<string, () => React.ReactNode> = {
    '/tenants': () => <Tenants api={api} />,
    '/queue': () => (
      <Queue
        api={api}
        tab={params.get('tab') ?? undefined}
        onDecided={() => setDecided((n) => n + 1)}
      />
    ),
    '/quota-requests': () => (
      <QuotaRequests
        api={api}
        tenant={params.get('tenant') ?? undefined}
        onDecided={() => setQuotaDecided((n) => n + 1)}
      />
    ),
    '/tenants/services': () => (
      <TenantServices
        api={api}
        tenant={params.get('tenant') ?? undefined}
        kind={definitionKindOfParam(params.get('kind'))}
        id={params.get('id') ?? undefined}
      />
    ),
    '/onboarding': () => <Onboarding api={api} live={live} />,
    '/models': () => <Models api={api} params={params} />,
    '/platform-secrets': () => <PlatformSecrets api={api} />,
    '/flags': () => (
      <Suspense fallback={null}>
        <Flags api={api} />
      </Suspense>
    ),
    '/model-operations': () => <Forward to="/models" params={apisTab} />,
    '/catalog': () => <Catalog api={api} tab={params.get('tab') ?? undefined} />,
    '/policies': () => <Policies api={api} tab={params.get('tab') ?? undefined} />,
    '/building-blocks': () => (
      <BuildingBlocks api={api} initial={params.get('block') ?? undefined} live={live} />
    ),
    '/block-reviews': () => (
      <WhenFlag flag="blockStudio" otherwise={notFound}>
        <BlockReviews api={api} />
      </WhenFlag>
    ),
    '/shared-services': () => <SharedServices api={api} />,
    '/demos': () => (
      <Suspense fallback={null}>
        <Demos api={api} params={params} />
      </Suspense>
    ),
    '/settings': () => <Settings api={api} />,
    '/quality': () => <Quality api={api} />,
    '/search-engines': () => <SearchEngines api={api} />,
    '/state-register': () => <StateRegister api={api} />,
    '/quality-matrix': () => (
      <Suspense fallback={null}>
        <QualityMatrix api={api} tab={params.get('tab') ?? 'matrix'} live={live} />
      </Suspense>
    ),
    '/tracing': () => <Tracing api={api} live={live} />,
    '/operations': () => <Operations api={api} />,
    '/diagnostics': () => (
      <Diagnostics
        api={api}
        tenant={params.get('tenant') ?? undefined}
        kind={params.get('kind') === 'service' ? 'service' : 'run'}
      />
    ),
    '/support-access': () => (
      <SupportAccess
        api={api}
        tenant={params.get('tenant') ?? undefined}
        tab={params.get('tab') ?? undefined}
        setting={params.get('setting') ?? undefined}
      />
    ),
    '/audit': () => <Audit api={api} />,
    '/platform-defaults': () => <PlatformDefaults />,
    '/schemas': () => <Schemas api={api} initial={params.get('kind') ?? undefined} />,
  };
  const render = Object.hasOwn(screens, current) ? screens[current] : undefined;
  return (
    <ContentReasonProvider api={api}>
      <FlagsProvider load={api.myFlags}>
        <Shell
          session={session}
          path={current}
          badges={{
            ...(queued === undefined ? {} : { queue: queued }),
            ...(quotaPending === undefined ? {} : { quotaRequests: quotaPending }),
          }}
          onLogout={logout}
          search={search}
          health={api.health}
          readOnlyInLockdown={api.readOnlyInLockdown}
        >
          {render ? (
            render()
          ) : (
            <EmptyState title={t('shell.notFound')}>
              <Paragraph>{t('shell.notFoundHelp')}</Paragraph>
            </EmptyState>
          )}
        </Shell>
      </FlagsProvider>
    </ContentReasonProvider>
  );
};
