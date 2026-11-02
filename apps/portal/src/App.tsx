import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { negotiate, type Locale } from '@genai/i18n';
import { LocaleProvider, useFormat, useLocale } from '@genai/i18n/react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient } from './api';
import type { AuthClient } from './auth';
import { navigate, parseRoute, useRoute } from './hooks';
import type { ScreenProps } from './screen';
import { developerHashFor } from './screens/developer-routes';
import { Overview } from './screens/Overview';
import { Startside } from './screens/Startside';
import { tenantNotRegistered } from './screens/Unregistered';
import { translator, useT } from './i18n';
import { navigation, Shell } from './Shell';
import { useSessionTimer } from './session-timer';
import { StrategyCatalogue } from './strategy-catalogue';
import { EmptyState, Loading } from './states';
import { pendingInputHash, restoreUnsavedInput, saveUnsavedInput } from './unsaved-input';
import type { Organisation, Session } from './types';

const Access = lazy(() => import('./screens/Access').then((m) => ({ default: m.Access })));
const ApiReference = lazy(() =>
  import('./screens/ApiReference').then((m) => ({ default: m.ApiReference })),
);
const BuildingBlocks = lazy(() =>
  import('./screens/BuildingBlocks').then((m) => ({ default: m.BuildingBlocks })),
);
const DataHandling = lazy(() =>
  import('./screens/DataHandling').then((m) => ({ default: m.DataHandling })),
);
const PublicDataHandling = lazy(() =>
  import('./screens/DataHandling').then((m) => ({ default: m.PublicDataHandling })),
);
const Contact = lazy(() => import('./screens/FooterPages').then((m) => ({ default: m.Contact })));
const Guide = lazy(() => import('./screens/FooterPages').then((m) => ({ default: m.Guide })));
const Status = lazy(() => import('./screens/FooterPages').then((m) => ({ default: m.Status })));
const Datasets = lazy(() => import('./screens/Datasets').then((m) => ({ default: m.Datasets })));
const DeveloperTools = lazy(() =>
  import('./screens/DeveloperTools').then((m) => ({ default: m.DeveloperTools })),
);
const Integrations = lazy(() =>
  import('./screens/Integrations').then((m) => ({ default: m.Integrations })),
);
const Log = lazy(() => import('./screens/Log').then((m) => ({ default: m.Log })));
const NoAccess = lazy(() => import('./screens/NoAccess').then((m) => ({ default: m.NoAccess })));
const Profile = lazy(() => import('./screens/Profile').then((m) => ({ default: m.Profile })));
const Playground = lazy(() =>
  import('./screens/Playground').then((m) => ({ default: m.Playground })),
);
const Services = lazy(() => import('./screens/Services').then((m) => ({ default: m.Services })));
const Settings = lazy(() => import('./screens/Settings').then((m) => ({ default: m.Settings })));
const SharedServices = lazy(() =>
  import('./screens/SharedServices').then((m) => ({ default: m.SharedServices })),
);
const Skills = lazy(() => import('./screens/Skills').then((m) => ({ default: m.Skills })));
const StepFlows = lazy(() => import('./screens/StepFlows').then((m) => ({ default: m.StepFlows })));
const Usage = lazy(() => import('./screens/Usage').then((m) => ({ default: m.Usage })));

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

/** Sends an old address on to where the page lives now, keeping the rest of the route. */
const MovedTo = ({ hash }: { hash: string }) => {
  useEffect(() => {
    window.location.replace(hash);
  }, [hash]);
  return null;
};

const footerPages = {
  status: 'shell.status',
  contact: 'shell.contact',
} as const;

const Page = ({
  onFailingIngests,
  ...props
}: ScreenProps & { onFailingIngests: (count: number) => void }) => {
  const t = useT();
  const [area = 'overview', id, sub] = props.route.segments;
  if (area === 'overview') return <Overview {...props} onFailingIngests={onFailingIngests} />;
  if (area === 'services')
    return (
      <StrategyCatalogue api={props.api} tenant={props.tenant}>
        <Services {...props} />
      </StrategyCatalogue>
    );
  if (area === 'step-flows') return <StepFlows {...props} />;
  if (area === 'shared-services') return <SharedServices {...props} />;
  if (area === 'datasets' && id && id !== 'new' && sub === 'settings')
    return <Settings {...props} context={{ kind: 'dataset', id }} />;
  if (area === 'datasets') return <Datasets {...props} />;
  if (area === 'building-blocks') return <BuildingBlocks {...props} />;
  if (area === 'skills') return <Skills {...props} />;
  if (area === 'playground') return <Playground {...props} />;
  if (area === 'access') return <Access {...props} />;
  if (area === 'usage')
    return <MovedTo hash={window.location.hash.replace(/^#\/usage/, '#/statistics')} />;
  if (area === 'statistics') return <Usage {...props} />;
  if (area === 'developer')
    return (id === 'api' && sub === 'code') || (id === 'hooks' && sub) ? (
      <Integrations {...props} />
    ) : (
      <DeveloperTools {...props} integrations={(p) => <Integrations {...p} />} />
    );
  if (area === 'integrations') return <MovedTo hash={developerHashFor(props.route)} />;
  if (area === 'profile') return <Profile />;
  if (area === 'help') return <MovedTo hash="#/onboarding" />;
  if (area === 'onboarding')
    return (
      <>
        <Heading level={1} data-size="lg">
          {t('shell.menuOnboarding')}
        </Heading>
        <Guide />
      </>
    );
  if (area === 'api-reference') return <ApiReference {...props} />;
  if (area === 'log') return <Log {...props} />;
  if (area === 'settings') return <Settings {...props} context={{ kind: 'tenant' }} />;
  if (area === 'data-handling') return <DataHandling api={props.api} />;
  const item = navigation.find((n) => n.path === `/${area}`);
  if (Object.hasOwn(footerPages, area))
    return (
      <>
        <Heading level={1} data-size="lg">
          {t(footerPages[area as keyof typeof footerPages])}
        </Heading>
        {area === 'status' ? <Status api={props.api} /> : <Contact />}
      </>
    );
  return (
    <>
      <Heading level={1} data-size="lg">
        {item
          ? t(item.label)
          : Object.hasOwn(footerPages, area)
            ? t(footerPages[area as keyof typeof footerPages])
            : t('app.notFound')}
      </Heading>
      <Paragraph>{t.rich('app.notDrawn', { link: (c) => <a href="#/overview">{c}</a> })}</Paragraph>
    </>
  );
};

export const App = ({ languages, ...props }: Props) => {
  const [language, setLanguage] = useState<Locale | null>(null);
  const save = useRef<(next: Locale | null) => void>(() => undefined);
  return (
    <LocaleProvider
      preference={language}
      detected={languages}
      title={{
        nb: 'Fellesløsning for generativ KI',
        en: 'Generative AI platform for the public sector',
      }}
      onPreferenceChange={(next) => {
        setLanguage(next);
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
  const [organisation, setOrganisation] = useState<Organisation | undefined>(
    () => session && chosen(session, orgParam),
  );
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

  save.current = (next) => {
    locale.current = next ?? negotiate(languages) ?? 'nb';
    if (tenantKey)
      void api.preferences
        .save(tenantKey, { language: next }, translator(locale.current)('app.languageReason'))
        .catch(() => undefined);
  };

  return <Suspense fallback={null}>{content()}</Suspense>;

  function content() {
    if (!session && route.segments[0] === 'data-handling') return <PublicDataHandling />;
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
    if (!session) return <Startside onLogin={() => void login()} busy={busy} failed={failed} />;
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
