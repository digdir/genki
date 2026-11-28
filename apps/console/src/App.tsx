import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { resolveLocale } from '@genai/i18n';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient } from './api';
import { useT } from './i18n';
import { LoginError, operatorRole, type AuthClient } from './auth';
import { Forward, navigate, splitRoute, useDelayed, useNavigation } from './hooks';
import * as Screen from './lazy-screens';
import { pendingCount } from './screens/queue/lanes';
import { FlagsProvider, WhenFlag } from './flags';
import { Shell } from './Shell';
import { EmptyState, Loading, NavigationProgress, PageLoading, ScreenBoundary } from './states';
import { menuItemFor } from './menu';
import { PageTabs } from './page-tabs';
import { prefetchCode, prefetchOnIntent, prefetchPath } from './prefetch';
import { ContentReasonProvider } from './content-reason';
import { definitionKindOfParam } from './definition-kinds';
import { useSessionRenewal } from './session-renewal';
import {
  forgetUnsavedInput,
  pendingInputHash,
  restoreUnsavedInput,
  saveUnsavedInput,
} from './unsaved-input';

import type { OperatorSession } from './types';

const apisTab = { tab: 'apis' };

const routeOf = (hash: string) => {
  const { path } = splitRoute(hash);
  return path === '/' ? '/tenants' : path;
};

const ScreenLoading = ({ path }: { path: string }) => {
  const t = useT();
  const item = menuItemFor(path);
  const label =
    item?.pages?.find((page) => page.path === path && !page.tab)?.label ??
    (item?.path === path ? item.label : undefined);
  return (
    <div className="screen-loading">
      {label ? (
        <>
          <div className="page-header">
            <Heading level={1} data-size="lg">
              {t(label)}
            </Heading>
          </div>
          <PageTabs />
          <Loading label={t('common.loading')} shape="list" />
        </>
      ) : (
        <PageLoading label={t('common.loading')} shape="detail" />
      )}
    </div>
  );
};

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
}

export const App = ({ auth, fetch: send, baseUrl = '/api' }: Props) => {
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
  const [hash, navigating] = useNavigation();
  const slowNavigation = useDelayed(navigating, 200);
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
    });
  }, [auth, send, baseUrl, endSession]);
  const search = useMemo(
    () => ({ tenants: api.listTenants, services: api.tenantDefinitions }),
    [api],
  );
  const authorized = Boolean(session?.roles.includes(operatorRole));
  const signedIn = Boolean(session);
  useSessionRenewal(auth, session, setSession, endSession);
  const route = routeOf(hash);

  useEffect(() => {
    if (!signedIn) api.forgetResponses();
  }, [api, signedIn]);

  useEffect(() => {
    const target = splitRoute(hash).path === '/' ? route : hash;
    if (authorized) prefetchPath(target, api);
    else prefetchCode(target);
  }, [api, authorized, route, hash]);

  useEffect(() => {
    if (!authorized) return;
    return prefetchOnIntent(document, (path) => prefetchPath(path, api));
  }, [api, authorized]);

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
        <Loading label={t('shell.checkingLogin')} shape="form" rows={1} />
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

  const { params } = splitRoute(hash);
  const current = route;
  if (current === '/atlas')
    return (
      <Suspense fallback={null}>
        <Screen.Atlas api={api} />
      </Suspense>
    );
  const notFound = (
    <EmptyState title={t('shell.notFound')}>
      <Paragraph>{t('shell.notFoundHelp')}</Paragraph>
    </EmptyState>
  );
  const screens: Record<string, () => React.ReactNode> = {
    '/tenants': () => <Screen.Tenants api={api} />,
    '/queue': () =>
      params.get('tab') ? (
        <Screen.Queue
          api={api}
          tab={params.get('tab') ?? undefined}
          onDecided={() => setDecided((n) => n + 1)}
        />
      ) : (
        <Screen.Inbox
          api={api}
          type={params.get('type') ?? undefined}
          request={params.get('request') ?? undefined}
          onDecided={() => {
            setDecided((n) => n + 1);
            setQuotaDecided((n) => n + 1);
          }}
        />
      ),
    '/quota-requests': () => (
      <Screen.QuotaRequests
        api={api}
        tenant={params.get('tenant') ?? undefined}
        onDecided={() => setQuotaDecided((n) => n + 1)}
      />
    ),
    '/tenants/services': () => (
      <Screen.TenantServices
        api={api}
        tenant={params.get('tenant') ?? undefined}
        kind={definitionKindOfParam(params.get('kind'))}
        id={params.get('id') ?? undefined}
      />
    ),
    '/onboarding': () => <Screen.Onboarding api={api} />,
    '/models': () => <Screen.Models api={api} params={params} />,
    '/platform-secrets': () => <Screen.PlatformSecrets api={api} />,
    '/flags': () => <Screen.Flags api={api} />,
    '/model-operations': () => <Forward to="/models" params={apisTab} />,
    '/catalog': () => <Screen.Catalog api={api} tab={params.get('tab') ?? undefined} />,
    '/policies': () => <Screen.Policies api={api} tab={params.get('tab') ?? undefined} />,
    '/building-blocks': () => (
      <Screen.BuildingBlocks api={api} initial={params.get('block') ?? undefined} />
    ),
    '/block-reviews': () => (
      <WhenFlag flag="blockStudio" otherwise={notFound}>
        <Screen.BlockReviews api={api} />
      </WhenFlag>
    ),
    '/shared-services': () => <Screen.SharedServices api={api} />,
    '/demos': () => <Screen.Demos api={api} params={params} />,
    '/settings': () => <Screen.Settings api={api} />,
    '/quality': () => <Screen.Quality api={api} />,
    '/search-engines': () => <Screen.SearchEngines api={api} />,
    '/state-register': () => <Screen.StateRegister api={api} />,
    '/quality-matrix': () => <Screen.QualityMatrix api={api} tab={params.get('tab') ?? 'matrix'} />,
    '/tracing': () => <Screen.Tracing api={api} />,
    '/operations': () => <Screen.Operations api={api} tab={params.get('tab') ?? undefined} />,
    '/diagnostics': () =>
      params.get('task') && params.get('tenant') ? (
        <Screen.Run api={api} tenant={params.get('tenant') ?? ''} task={params.get('task') ?? ''} />
      ) : (
        <Screen.Diagnostics
          api={api}
          tenant={params.get('tenant') ?? undefined}
          kind={params.get('kind') === 'service' ? 'service' : 'run'}
        />
      ),
    '/support-access': () => (
      <Screen.OrgPage
        api={api}
        tenant={params.get('tenant') ?? undefined}
        tab={params.get('tab') ?? undefined}
        setting={params.get('setting') ?? undefined}
      />
    ),
    '/audit': () => <Screen.Audit api={api} />,
    '/platform-defaults': () => <Screen.PlatformDefaults />,
    '/schemas': () => <Screen.Schemas api={api} initial={params.get('kind') ?? undefined} />,
  };
  const render = Object.hasOwn(screens, current) ? screens[current] : undefined;
  return (
    <ContentReasonProvider api={api}>
      <FlagsProvider load={api.myFlags}>
        <Shell
          session={session}
          path={current}
          tab={params.get('tab') ?? undefined}
          badges={{
            ...(queued === undefined ? {} : { queue: queued }),
            ...(quotaPending === undefined ? {} : { quotaRequests: quotaPending }),
          }}
          onLogout={logout}
          search={search}
          health={api.health}
          readOnlyInLockdown={api.readOnlyInLockdown}
        >
          {slowNavigation ? <NavigationProgress label={t('common.loading')} /> : null}
          <ScreenBoundary path={hash} onRetry={() => window.location.reload()}>
            <Suspense fallback={<ScreenLoading path={current} />}>
              {render ? render() : notFound}
            </Suspense>
          </ScreenBoundary>
        </Shell>
      </FlagsProvider>
    </ContentReasonProvider>
  );
};
