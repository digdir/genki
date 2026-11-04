import { Alert, Button, Paragraph } from '@digdir/designsystemet-react';
import { negotiate, type Locale } from '@genai/i18n';
import { LocaleProvider, storedPreference, useFormat, useLocale } from '@genai/i18n/react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient } from './api';
import { appTitle } from './app-title';
import type { AuthClient } from './auth';
import { navigate, parseRoute, useRoute } from './hooks';
import { prefetchOnIntent, prefetchPath } from './prefetch';
import { tenantNotRegistered } from './problem-types';
import { PublicLanding } from './screens/about/PublicLanding';
import { translator, useT } from './i18n';
import { useSessionTimer } from './session-timer';
import { EmptyState, Loading } from './states';
import { pendingInputHash, restoreUnsavedInput, saveUnsavedInput } from './unsaved-input';
import type { Organisation, Session } from './types';

const Shell = lazy(() => import('./Shell').then((m) => ({ default: m.Shell })));
const NoAccess = lazy(() => import('./screens/NoAccess').then((m) => ({ default: m.NoAccess })));
const Page = lazy(() => import('./signed-in-page').then((m) => ({ default: m.Page })));

interface Props {
  auth: AuthClient;
  fetch: typeof fetch;
  baseUrl?: string;
  live?: boolean;
  languages?: readonly string[] | undefined;
}

const inputStore = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => {
  try {
    return window.sessionStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  }
};

const chosen = (session: Session, org: string | null) =>
  session.organisations.find((o) => o.orgNumber === org) ?? session.organisations[0];

const chosenLanguage = storedPreference(
  typeof window === 'undefined' ? undefined : window.localStorage,
);

export const App = ({ languages, ...props }: Props) => {
  const [language, setLanguage] = useState<Locale | null>(chosenLanguage.load);
  const save = useRef<(next: Locale | null) => void>(() => undefined);
  return (
    <LocaleProvider
      preference={language}
      detected={languages}
      title={appTitle}
      onPreferenceChange={(next) => {
        setLanguage(next);
        chosenLanguage.save(next);
        save.current(next);
      }}
    >
      <Portal {...props} languages={languages} onLoaded={setLanguage} save={save} />
    </LocaleProvider>
  );
};

const Portal = ({
  auth,
  fetch: send,
  baseUrl = '/api',
  live = false,
  languages,
  onLoaded,
  save,
}: Props & {
  onLoaded: (language: Locale | null) => void;
  save: { current: (next: Locale | null) => void };
}) => {
  const t = useT();
  const route = useRoute();
  const orgParam = route.query.get('org');
  const [session, setSession] = useState<Session | undefined>(auth.current());
  const [picked, setOrganisation] = useState<Organisation | undefined>(
    () => session && chosen(session, orgParam),
  );
  const organisation = session
    ? (session.organisations.find((o) => o.orgNumber === orgParam) ?? picked)
    : undefined;
  const [busy, setBusy] = useState(() => auth.callbackPending?.() ?? false);
  const [failed, setFailed] = useState(false);
  const [unregistered, setUnregistered] = useState<Set<string>>(() => new Set());
  const [expired, setExpired] = useState(false);
  const [failingIngests, setFailingIngests] = useState<Record<string, number>>({});
  const [serverRights, setServerRights] = useState<Record<string, string[]>>({});
  const active = useLocale().locale;
  const locale = useRef<Locale>(active);
  locale.current = active;
  const api = useMemo(() => {
    const watched: typeof fetch = async (input, init) => {
      const response = await send(input, init);
      if (response.status === 401 && auth.current()) {
        saveUnsavedInput(inputStore());
        setExpired(true);
        void auth.logout().then(() => setSession(undefined));
      }
      if (response.status === 403) {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const tenant = /\/tenants\/([^/?]+)/.exec(url)?.[1];
        const problem = (await response
          .clone()
          .json()
          .catch(() => undefined)) as { type?: string } | undefined;
        if (tenant && problem?.type === tenantNotRegistered)
          setUnregistered((all) => new Set(all).add(decodeURIComponent(tenant)));
      }
      return response;
    };
    return createApiClient({
      baseUrl,
      fetch: watched,
      token: () => auth.current()?.token,
      actorName: () => auth.current()?.name,
      locale: () => locale.current,
    });
  }, [auth, send, baseUrl]);
  const f = useFormat();
  const warnAt = useSessionTimer(
    auth,
    session,
    (renewed) => setSession(renewed),
    () => {
      saveUnsavedInput(inputStore());
      setExpired(true);
      void auth.logout().then(() => setSession(undefined));
    },
  );
  const token = session?.token;
  useEffect(() => {
    if (!token) return;
    const store = inputStore();
    const hash = pendingInputHash(store);
    if (hash === undefined) return;
    if (hash && hash !== window.location.hash) navigate(hash.replace(/^#/, ''));
    return restoreUnsavedInput(store);
  }, [token]);
  const tenantKey = organisation?.orgNumber;
  const reportFailing = useCallback(
    (count: number) => {
      if (tenantKey)
        setFailingIngests((all) =>
          all[tenantKey] === count ? all : { ...all, [tenantKey]: count },
        );
    },
    [tenantKey],
  );

  const login = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const s = await auth.login();
      setSession(s);
      setOrganisation(chosen(s, orgParam));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!auth.callbackPending?.()) return;
    let active = true;
    auth.login().then(
      (s) => {
        if (!active) return;
        setSession(s);
        setOrganisation(chosen(s, parseRoute(window.location.hash).query.get('org')));
        setBusy(false);
      },
      () => {
        if (!active) return;
        setFailed(true);
        setBusy(false);
      },
    );
    return () => {
      active = false;
    };
  }, [auth]);

  useEffect(() => {
    const found = session?.organisations.find((o) => o.orgNumber === orgParam);
    if (found) setOrganisation(found);
  }, [session, orgParam]);

  useEffect(() => {
    if (!tenantKey) return;
    const controller = new AbortController();
    api.preferences.get(tenantKey, controller.signal).then(
      (p) => onLoaded(p.language),
      () => undefined,
    );
    return () => controller.abort();
  }, [api, tenantKey]);

  useEffect(() => {
    setServerRights({});
  }, [token]);

  useEffect(() => {
    if (!live || !tenantKey) return;
    const controller = new AbortController();
    api.preferences.rights(tenantKey, controller.signal).then(
      (rights) => setServerRights((all) => ({ ...all, [tenantKey]: rights })),
      () => undefined,
    );
    return () => controller.abort();
  }, [api, live, tenantKey, token]);

  const routePath = route.path;
  useEffect(() => {
    if (tenantKey && token) prefetchPath(routePath, api, tenantKey, live);
  }, [routePath, api, tenantKey, token, live]);
  useEffect(() => {
    if (!tenantKey || !token) return;
    return prefetchOnIntent(document, (path) => prefetchPath(path, api, tenantKey, live));
  }, [api, tenantKey, token, live]);

  save.current = (next) => {
    locale.current = next ?? negotiate(languages) ?? 'nb';
    if (tenantKey)
      void api.preferences
        .save(tenantKey, { language: next }, translator(locale.current)('app.languageReason'))
        .catch(() => undefined);
  };

  return <Suspense fallback={null}>{content()}</Suspense>;

  function content() {
    if (!session && expired)
      return (
        <main id="hovedinnhold" className="signed-out" lang={active}>
          <EmptyState title={t('app.signedOutTitle')}>
            <Paragraph>{t('app.sessionExpired')}</Paragraph>
            <Button
              data-size="sm"
              onClick={() => {
                setExpired(false);
                void login();
              }}
            >
              {t('app.login')}
            </Button>
          </EmptyState>
        </main>
      );
    if (!session)
      return (
        <PublicLanding route={route} onLogin={() => void login()} busy={busy} failed={failed} />
      );
    if (!organisation)
      return (
        <NoAccess
          name={session.name}
          live={live}
          onLogout={() => {
            void auth.logout(true).then(() => setSession(undefined));
          }}
          onSwitchOrg={() => {
            void auth.logout(true).then(() => setSession(undefined));
          }}
          onRecheck={async () => {
            const s = await auth.login();
            const org = chosen(s, orgParam);
            setSession(s);
            setOrganisation(org);
            return org !== undefined;
          }}
        />
      );

    const failing = failingIngests[organisation.orgNumber] ?? 0;
    const reported = serverRights[organisation.orgNumber];
    const effective =
      route.segments.length === 0 ? { ...route, path: '/overview', segments: ['overview'] } : route;
    return (
      <Shell
        session={session}
        organisation={reported ? { ...organisation, actions: reported } : organisation}
        onSwitch={(org) => {
          setOrganisation(org);
          if (effective.segments[0] !== 'overview' || orgParam)
            navigate(`/overview?org=${org.orgNumber}`);
        }}
        onLogout={() => {
          void auth.logout(true).then(() => setSession(undefined));
        }}
        path={effective.path}
        unregistered={unregistered.has(organisation.orgNumber)}
        registeredElsewhere={session.organisations
          .filter((o) => o.orgNumber !== organisation.orgNumber && !unregistered.has(o.orgNumber))
          .map((o) => o.name)}
        api={api}
        badges={
          failing > 0
            ? {
                '/datasets': {
                  count: failing,
                  label: t('shell.badgeIngest', { count: failing }),
                },
              }
            : {}
        }
      >
        {warnAt !== undefined ? (
          <Alert data-color="warning" data-size="sm" className="session-warning">
            <Paragraph data-size="sm">
              {t('app.sessionEnding', { time: f.time(new Date(warnAt)) })}
            </Paragraph>
            <Button
              data-size="sm"
              variant="secondary"
              onClick={() => {
                saveUnsavedInput(inputStore());
                void auth.login();
              }}
            >
              {t('app.sessionRelogin')}
            </Button>
          </Alert>
        ) : null}
        <Suspense fallback={<Loading label={t('common.loading')} />}>
          <Page
            api={api}
            tenant={organisation.orgNumber}
            tenantName={organisation.name}
            route={effective}
            live={live}
            onFailingIngests={reportFailing}
          />
        </Suspense>
      </Shell>
    );
  }
};
