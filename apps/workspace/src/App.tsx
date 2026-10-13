import {
  Alert,
  Avatar,
  Badge,
  Button,
  Fieldset,
  Heading,
  Paragraph,
  Radio,
  SkipLink,
  Spinner,
} from '@digdir/designsystemet-react';
import type { Locale } from '@genai/i18n';
import { LanguageChoice, LocaleProvider, useFormat, useLocale } from '@genai/i18n/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import type { AuthClient } from './auth';
import { useAsync, useHashRoute } from './hooks';
import { useSessionTimer } from './session-timer';
import { pendingInputHash, restoreUnsavedInput, saveUnsavedInput } from './unsaved-input';
import { useT, type PlainKey, type T } from './i18n';
import type { ProjectsApi } from './projects-api';
import { Approvals, type Resolved } from './screens/Approvals';
import { Chat, runLogUrl, type Thread } from './screens/Chat';
import { DocumentDraft } from './screens/DocumentDraft';
import { FailedRuns } from './screens/FailedRuns';
import { Projects } from './screens/projects/Projects';
import { labelledInput } from './saved-runs';
import { serviceIdOf } from './screens/projects/shared';
import { TableResult, type TableEntry } from './screens/TableResult';
import type {
  Approval,
  ApprovalsApi,
  AssistantMessage,
  ChatMessage,
  Decision,
  DocumentDraft as Draft,
  Organisation,
  ServiceOption,
  Session,
  WorkspaceApi,
  WrittenStandard,
} from './types';

export const views = [
  { id: 'chat', label: 'shell.navChat' },
  { id: 'projects', label: 'shell.navProjects' },
  { id: 'approvals', label: 'shell.navApprovals' },
  { id: 'errors', label: 'shell.navErrors' },
  { id: 'document', label: 'shell.navDocument' },
] as const satisfies readonly { id: string; label: PlainKey }[];

type View = (typeof views)[number]['id'] | 'table';

const routeOf = (hash: string) => {
  const [path = '/', query = ''] = hash.split('?');
  const section = path.split('/')[1] ?? '';
  return { path, section, params: new URLSearchParams(query) };
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

export interface AppProps {
  auth: AuthClient;
  api: WorkspaceApi;
  approvals?: ApprovalsApi;
  projects?: ProjectsApi;
  draft?: Draft;
  initialMessages?: ChatMessage[];
  now?: () => Date;
  languages?: readonly string[];
}

const organisationName = (org: Organisation | undefined, t: T) => {
  if (!org) return t('shell.platformName');
  if (org.name && org.name !== org.orgNumber) return org.name;
  return t('shell.orgNumber', {
    number: org.orgNumber.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3'),
  });
};

const Loading = ({ label }: { label: string }) => (
  <div role="status" className="state">
    <Spinner aria-label={label} data-size="md" />
  </div>
);

const Failed = ({ title, onRetry }: { title: string; onRetry: () => void }) => {
  const t = useT();
  return (
    <Alert data-color="danger" className="failed">
      <Paragraph className="alert-title">{title}</Paragraph>
      <Paragraph>{t('shell.notYourFault')}</Paragraph>
      <Button variant="secondary" data-size="sm" className="alert-action" onClick={onRetry}>
        {t('shell.tryAgain')}
      </Button>
    </Alert>
  );
};

const signedOut = (error: unknown) => error instanceof ApiError && error.status === 401;

const noApprovals: ApprovalsApi = {
  listPending: async () => [],
  resolve: async () => undefined,
};

const standards: [WrittenStandard, PlainKey, PlainKey][] = [
  ['user', 'shell.standardUser', 'shell.standardSavedUser'],
  ['bokmal', 'shell.standardBokmal', 'shell.standardSavedBokmal'],
  ['nynorsk', 'shell.standardNynorsk', 'shell.standardSavedNynorsk'],
];

const UserMenu = ({
  session,
  role,
  standard,
  onStandard,
  onLanguage,
  onLogout,
}: {
  session: Session;
  role: string;
  standard: WrittenStandard;
  onStandard?: ((value: WrittenStandard) => void) | undefined;
  onLanguage: (value: Locale | null) => void;
  onLogout: () => void;
}) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const click = (e: MouseEvent) =>
      root.current && !root.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener('keydown', key);
    document.addEventListener('mousedown', click);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('mousedown', click);
    };
  }, [open]);
  return (
    <div className="user-menu" ref={root}>
      <Button
        variant="tertiary"
        data-size="sm"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={t('shell.openUserMenu', { name: session.name })}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar aria-hidden data-size="sm">
          {initials(session.name)}
        </Avatar>
        <span className="user-name">{session.name}</span>
      </Button>
      {open ? (
        <div role="dialog" aria-label={t('shell.userMenu')} className="user-popover">
          <div className="user-who">
            <span className="strong">{session.name}</span>
            <span className="subtle-sm">{role}</span>
          </div>
          <LanguageChoice
            className="user-standard"
            description={t('shell.languageDescription')}
            onChange={(value) => {
              onLanguage(value);
              setOpen(false);
            }}
          />
          {onStandard ? (
            <Fieldset data-size="sm" className="user-standard">
              <Fieldset.Legend>{t('shell.standardLegend')}</Fieldset.Legend>
              <Fieldset.Description>{t('shell.standardDescription')}</Fieldset.Description>
              {standards.map(([value, label]) => (
                <Radio
                  key={value}
                  name="malform"
                  label={t(label)}
                  checked={standard === value}
                  onChange={() => {
                    onStandard(value);
                    setOpen(false);
                  }}
                />
              ))}
            </Fieldset>
          ) : null}
          <Button variant="secondary" data-size="sm" onClick={onLogout}>
            {t('shell.logout')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

const lastServiceKey = 'workspace.lastService';

const readLastService = () => {
  try {
    return window.localStorage.getItem(lastServiceKey) ?? undefined;
  } catch {
    return undefined;
  }
};

const saveLastService = (id: string) => {
  try {
    window.localStorage.setItem(lastServiceKey, id);
  } catch {
    return;
  }
};

const matchService = (services: ServiceOption[], hint: string | null) =>
  hint ? services.find((s) => s.id === hint || serviceIdOf(s.id) === serviceIdOf(hint)) : undefined;

const managingRights = ['manage-services', 'manage-datasets', 'register-building-blocks'];

const roleText = (t: T, rights: string[] | undefined, hasTenant: boolean, organisation: string) => {
  if (!hasTenant) return t('shell.roleSelf');
  if (!rights) return t('shell.role', { organisation });
  if (rights.some((r) => managingRights.includes(r)))
    return t('shell.roleManager', { organisation });
  if (rights.includes('use-services')) return t('shell.role', { organisation });
  return t('shell.roleNoAccess', { organisation });
};

const Workspace = ({
  session,
  api,
  approvals,
  projects,
  draft,
  initialMessages,
  now = () => new Date(),
  onLogout,
  onExpired,
  onLanguage,
  notice,
}: Omit<AppProps, 'auth' | 'languages'> & {
  session: Session;
  notice?: ReactNode;
  onLogout: () => void;
  onExpired: () => void;
  onLanguage: (value: Locale | null) => void;
}) => {
  const t = useT();
  const latest = useRef(t);
  latest.current = t;
  const { locale } = useLocale();
  const tenant = session.organisations[0]?.orgNumber;
  const [rights, setRights] = useState<string[] | undefined>();
  const mayUse = Boolean(tenant) && (!rights || rights.includes('use-services'));
  const available: Record<(typeof views)[number]['id'], boolean> = {
    chat: true,
    projects: Boolean(projects) && mayUse,
    approvals: Boolean(approvals),
    errors: Boolean(api.failedRuns) && mayUse,
    document: Boolean(draft),
  };
  const shown = views.filter((v) => available[v.id]);
  const route = routeOf(useHashRoute());
  const view: View =
    route.section === 'table' ? 'table' : (shown.find((v) => v.id === route.section)?.id ?? 'chat');
  const [flash, setFlash] = useState('');
  const [serviceId, setServiceId] = useState<string | undefined>(readLastService);
  const chooseService = useCallback((id: string) => {
    saveLastService(id);
    setServiceId(id);
  }, []);
  const [question, setQuestion] = useState('');
  const threads = useRef(new Map<string, Thread>());
  const [done, setDone] = useState<Resolved[]>([]);
  const [tables, setTables] = useState<Map<string, TableEntry>>(new Map());
  const [standard, setStandard] = useState<WrittenStandard>('user');
  const [services, retryServices] = useAsync((signal) => api.listServices(signal), [api]);
  const [pending, retryPending, setPending] = useAsync(
    (signal) => (approvals ?? noApprovals).listPending(signal),
    [approvals],
  );
  const organisation = organisationName(session.organisations[0], t);
  const serviceList = services.status === 'ready' ? services.data : [];
  const asked = matchService(serviceList, route.params.get('service'));
  const service =
    serviceList.find((s) => s.id === serviceId) ??
    asked ??
    serviceList.find((s) => !s.paused) ??
    serviceList[0];
  const pendingCount = pending.status === 'ready' ? pending.data.length : 0;

  useEffect(() => {
    if (!tenant || !api.rights) return;
    const controller = new AbortController();
    api.rights(tenant, controller.signal).then(
      (value) => !controller.signal.aborted && setRights(value),
      () => undefined,
    );
    return () => controller.abort();
  }, [api, tenant]);

  useEffect(() => {
    if (!tenant || !api.writtenStandard) return;
    const controller = new AbortController();
    api.writtenStandard(tenant, controller.signal).then(
      (value) => !controller.signal.aborted && setStandard(value),
      () => undefined,
    );
    return () => controller.abort();
  }, [api, tenant]);

  useEffect(() => {
    if (!tenant || !api.language) return;
    const controller = new AbortController();
    api.language(tenant, controller.signal).then(
      (value) => !controller.signal.aborted && value && onLanguage(value),
      () => undefined,
    );
    return () => controller.abort();
  }, [api, tenant]);

  const go = useCallback((path: string) => {
    window.location.hash = path;
  }, []);

  useEffect(() => setFlash(''), [route.path]);
  useEffect(() => {
    if (asked) setServiceId(asked.id);
  }, [asked?.id]);
  const expired = services.status === 'error' && signedOut(services.error);
  useEffect(() => {
    if (expired) onExpired();
  }, [expired]);

  const chooseStandard = async (value: WrittenStandard) => {
    if (!tenant || !api.setWrittenStandard) return;
    const saved = standards.find(([v]) => v === value)?.[2] ?? 'shell.standardSavedUser';
    try {
      await api.setWrittenStandard(tenant, value);
      setStandard(value);
      setFlash(t(saved));
    } catch {
      setFlash(t('shell.standardNotSaved'));
    }
  };

  const chooseLanguage = async (value: Locale | null) => {
    if (!tenant || !api.setLanguage) return;
    try {
      await api.setLanguage(tenant, value);
      setFlash(latest.current('shell.languageSaved'));
    } catch {
      setFlash(latest.current('shell.languageNotSaved'));
    }
  };

  const resolve = async (approval: Approval, decision: Decision, comment: string) => {
    await (approvals ?? noApprovals).resolve(approval.id, decision, comment);
    setPending((state) =>
      state.status === 'ready'
        ? { status: 'ready', data: state.data.filter((a) => a.id !== approval.id) }
        : state,
    );
    setDone((list) => [...list, { approval, decision }]);
  };

  const openTable = (message: AssistantMessage, inputs: { label: string; value: string }[]) => {
    if (!message.table) return;
    const key = message.task ?? message.id;
    setTables((map) =>
      new Map(map).set(key, {
        key,
        ...(message.task ? { task: message.task } : {}),
        serviceName: service?.name ?? t('shell.service'),
        createdAt: now().toISOString(),
        inputs,
        table: message.table as NonNullable<AssistantMessage['table']>,
        ...(message.csv ? { csv: message.csv } : {}),
      }),
    );
    go(`/table/${encodeURIComponent(key)}`);
  };

  const chatContent = () => {
    if (services.status === 'loading') return <Loading label={t('shell.loadingServices')} />;
    if (services.status === 'error' && expired) return <Loading label={t('shell.loggingOut')} />;
    if (services.status === 'error')
      return <Failed title={t('shell.servicesFailed')} onRetry={retryServices} />;
    if (!service)
      return (
        <div className="empty">
          <Paragraph className="empty-title">{t('shell.noServices')}</Paragraph>
          <Paragraph data-size="sm" className="subtle-sm">
            {t('shell.noServicesText')}
          </Paragraph>
        </div>
      );
    return (
      <Chat
        key={service.id}
        api={api}
        services={serviceList}
        service={service}
        onSelectService={chooseService}
        question={question}
        onQuestion={setQuestion}
        organisation={organisation}
        onOpenTable={openTable}
        saved={threads.current.get(service.id)}
        onSave={(thread) => threads.current.set(service.id, thread)}
        tenant={tenant}
        {...(initialMessages && service.id === serviceList[0]?.id ? { initialMessages } : {})}
        now={now}
      />
    );
  };

  const tableKey = decodeURIComponent(route.path.split('/')[2] ?? '');

  return (
    <div className="shell" lang={locale}>
      <SkipLink href="#hovedinnhold">{t('shell.skipLink')}</SkipLink>
      <header className="header">
        <div className="header-row">
          <span className="brand">
            <span className="brand-owner">{organisation}</span>
            <span className="brand-name">{t('shell.productName')}</span>
          </span>
          <UserMenu
            session={session}
            role={roleText(t, rights, Boolean(tenant), organisation)}
            standard={standard}
            onStandard={
              api.setWrittenStandard && tenant ? (v) => void chooseStandard(v) : undefined
            }
            onLanguage={(value) => void chooseLanguage(value)}
            onLogout={onLogout}
          />
        </div>
        <nav aria-label={t('shell.navLabel')} className="header-nav">
          {shown.map((v) => {
            const current = view === v.id || (view === 'table' && v.id === 'chat');
            return (
              <a
                key={v.id}
                href={`#/${v.id}`}
                aria-current={current ? 'page' : undefined}
                className={current ? 'nav-link current' : 'nav-link'}
              >
                {t(v.label)}
                {v.id === 'approvals' && pendingCount > 0 ? (
                  <Badge
                    data-color="danger"
                    count={pendingCount}
                    aria-label={t('shell.waitingForYou', { count: pendingCount })}
                  />
                ) : null}
              </a>
            );
          })}
        </nav>
      </header>
      <main id="hovedinnhold" tabIndex={-1} className="main">
        {notice}
        <div aria-live="polite">
          {flash ? (
            <Alert data-color="success" data-size="sm" className="flash">
              {flash}
            </Alert>
          ) : null}
        </div>
        <div hidden={view !== 'chat'}>{chatContent()}</div>
        {view === 'table' ? (
          <TableRoute
            api={api}
            tenant={tenant}
            entry={tables.get(tableKey)}
            tableKey={tableKey}
            userName={session.name}
            services={serviceList}
            onFlash={setFlash}
          />
        ) : null}
        {view === 'projects' && projects && tenant ? (
          <Projects
            api={projects}
            tenant={tenant}
            path={route.path}
            services={serviceList}
            userName={session.name}
            onFlash={setFlash}
          />
        ) : null}
        {view === 'document' && draft ? (
          <>
            <Heading level={1} data-size="md" className="page-title">
              {draft.serviceName}
            </Heading>
            <DocumentDraft
              draft={draft}
              onDownload={() => setFlash(t('shell.wordNotReady'))}
              onGoToApprovals={() => go('/approvals')}
            />
          </>
        ) : null}
        {view === 'approvals' && approvals ? (
          <>
            <Heading level={1} data-size="lg" className="page-title">
              {t('shell.approvalsTitle')}
            </Heading>
            <Approvals
              state={pending}
              done={done}
              onRetry={retryPending}
              onResolve={resolve}
              onFlash={setFlash}
            />
          </>
        ) : null}
        {view === 'errors' && api.failedRuns && tenant ? (
          <FailedRuns
            api={api}
            tenant={tenant}
            now={now()}
            retryHref={(run) => `#/chat?service=${encodeURIComponent(run.service)}`}
          />
        ) : null}
      </main>
    </div>
  );
};

const TableRoute = ({
  api,
  tenant,
  entry,
  tableKey,
  userName,
  services,
  onFlash,
}: {
  services: ServiceOption[];
  api: WorkspaceApi;
  tenant: string | undefined;
  entry: TableEntry | undefined;
  tableKey: string;
  userName: string;
  onFlash: (text: string) => void;
}) => {
  const t = useT();
  const task = entry?.task ?? (entry ? undefined : tableKey);
  const [loaded] = useAsync(
    async (signal): Promise<TableEntry | undefined> => {
      if (entry) return entry;
      if (!tenant || !api.tableReview || !task) return undefined;
      const review = await api.tableReview(tenant, task, signal);
      return review.table
        ? {
            key: task,
            task,
            serviceName: t('table.fromRun'),
            ...(review.service ? { serviceRef: review.service } : {}),
            ...(review.createdAt ? { createdAt: review.createdAt } : {}),
            inputs: [],
            ...(review.input ? { input: review.input } : {}),
            table: review.table,
            ...(review.csv ? { csv: review.csv } : {}),
          }
        : undefined;
    },
    [api, tenant, task, entry, t],
  );
  const load = useCallback(
    (signal: AbortSignal) =>
      tenant && task && api.tableReview
        ? api.tableReview(tenant, task, signal)
        : Promise.reject(new Error('no review')),
    [api, tenant, task],
  );
  if (loaded.status === 'loading') return <Loading label={t('table.loading')} />;
  const found = loaded.status === 'ready' ? loaded.data : undefined;
  if (!found)
    return (
      <div className="empty">
        <Paragraph className="empty-title">{t('table.notFound')}</Paragraph>
        <a href="#/chat">{t('table.backToChat')}</a>
      </div>
    );
  const reviewed = Boolean(tenant && found.task);
  const ran = services.find((s) => serviceIdOf(s.id) === found.serviceRef?.split('/')[1]);
  const inputs = found.inputs.length
    ? found.inputs
    : labelledInput(ran?.inputFields ?? [], found.input);
  return (
    <TableResult
      entry={{ ...found, ...(ran ? { serviceName: ran.name } : {}), inputs }}
      userName={userName}
      onFlash={onFlash}
      {...(found.task ? { logUrl: runLogUrl(found.task) } : {})}
      actions={
        reviewed && tenant && found.task
          ? {
              ...(api.tableReview ? { load } : {}),
              ...(api.saveTableEdits
                ? {
                    save: (edits) =>
                      (api.saveTableEdits as NonNullable<WorkspaceApi['saveTableEdits']>)(
                        tenant,
                        found.task as string,
                        edits,
                      ),
                  }
                : {}),
              ...(api.approveTable
                ? {
                    approve: () =>
                      (api.approveTable as NonNullable<WorkspaceApi['approveTable']>)(
                        tenant,
                        found.task as string,
                      ),
                  }
                : {}),
            }
          : {}
      }
    />
  );
};

export const App = ({ languages, ...props }: AppProps) => {
  const [preference, setPreference] = useState<Locale | null>(null);
  return (
    <LocaleProvider
      preference={preference}
      detected={languages}
      onPreferenceChange={setPreference}
      title={{ nb: 'KI-arbeidsflaten', en: 'AI workspace' }}
    >
      <Root {...props} onLanguage={setPreference} />
    </LocaleProvider>
  );
};

const inputStore = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => {
  try {
    return window.sessionStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  }
};

const Root = ({
  auth,
  onLanguage,
  ...rest
}: Omit<AppProps, 'languages'> & { onLanguage: (value: Locale | null) => void }) => {
  const t = useT();
  const { locale } = useLocale();
  const [session, setSession] = useState<Session | undefined>(auth.current());
  const [failed, setFailed] = useState(false);
  const [loggedOut, setLoggedOut] = useState<false | 'self' | 'expired'>(false);
  const [attempt, setAttempt] = useState(0);
  const f = useFormat();
  const warnAt = useSessionTimer(auth, session, setSession, () => logout('expired'));
  const token = session?.token;
  useEffect(() => {
    if (!token) return;
    const store = inputStore();
    const hash = pendingInputHash(store);
    if (hash === undefined) return;
    if (hash && hash !== window.location.hash) window.location.hash = hash;
    return restoreUnsavedInput(store);
  }, [token]);

  useEffect(() => {
    if (session || loggedOut) return;
    let active = true;
    setFailed(false);
    auth.login().then(
      (s) => active && setSession(s),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [auth, session, loggedOut, attempt]);

  const logout = (why: 'self' | 'expired') => {
    if (why === 'expired') saveUnsavedInput(inputStore());
    void (auth.logout?.(why === 'self') ?? Promise.resolve()).then(() => {
      setLoggedOut(why);
      setSession(undefined);
    });
  };

  if (session)
    return (
      <Workspace
        session={session}
        notice={
          warnAt === undefined ? undefined : (
            <Alert data-color="warning" data-size="sm" className="session-warning">
              <Paragraph data-size="sm">
                {t('shell.sessionEnding', { time: f.time(new Date(warnAt)) })}
              </Paragraph>
              <Button
                data-size="sm"
                variant="secondary"
                onClick={() => {
                  saveUnsavedInput(inputStore());
                  void auth.login();
                }}
              >
                {t('shell.sessionRelogin')}
              </Button>
            </Alert>
          )
        }
        onLogout={() => logout('self')}
        onExpired={() => logout('expired')}
        onLanguage={onLanguage}
        {...rest}
      />
    );
  return (
    <main id="hovedinnhold" className="login" lang={locale}>
      {loggedOut ? (
        <div className="empty">
          <Paragraph className="empty-title">{t('shell.loggedOut')}</Paragraph>
          {loggedOut === 'expired' ? (
            <Paragraph data-size="sm" className="subtle-sm">
              {t('shell.sessionExpired')}
            </Paragraph>
          ) : null}
          <Button data-size="sm" onClick={() => setLoggedOut(false)}>
            {t('shell.login')}
          </Button>
        </div>
      ) : failed ? (
        <Alert data-color="danger">
          <Paragraph className="alert-title">{t('shell.loginFailed')}</Paragraph>
          <Paragraph>{t('shell.loginFailedText')}</Paragraph>
          <Button
            variant="secondary"
            data-size="sm"
            className="alert-action"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t('shell.tryAgain')}
          </Button>
        </Alert>
      ) : (
        <Loading label={t('shell.loggingIn')} />
      )}
    </main>
  );
};
