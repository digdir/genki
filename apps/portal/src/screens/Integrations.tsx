import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useContext, useEffect, useRef, useState } from 'react';
import { NotAvailable } from '../components/NotAvailable';
import type { TriggerView } from '../api/triggers';
import { API_BASE, endpoints } from '../data/api-reference';
import {
  docs,
  exampleFrontends,
  exampleSystems,
  exampleTriggers,
  type Frontend,
  type SystemClient,
  type TriggerSource,
} from '../data/integrations';
import { navigate, useAsync } from '../hooks';
import { useT, type PlainKey, type T } from '../i18n';
import type { ScreenProps } from '../screen';
import { ErrorState, Loading } from '../states';
import { developerPageFor, IntegrationService, IntegrationTab } from './DeveloperTools';
import { CallFromCode, LiveCallFromCode } from './integrations/CallFromCode';
import { Connections } from './integrations/Connections';
import { Frontends } from './integrations/Frontends';
import { FormDialog, type DialogKind, type FormValues } from './integrations/FormDialog';
import { ItemList, type ItemRowData } from './integrations/ItemList';
import { KeyPolicies } from './integrations/KeyPolicies';
import { Keys } from './integrations/Keys';
import { HookEditor, Hooks } from './integrations/Hooks';
import { MaskinportenClients } from './integrations/MaskinportenClients';
import { Tracing } from './integrations/Tracing';
import { problemOf, Triggers } from './integrations/Triggers';
import './integrations.css';

type Tab = 'systems' | 'frontends' | 'triggers' | 'keys' | 'hooks' | 'tracing' | 'docs';

const tabs: [Tab, PlainKey][] = [
  ['systems', 'integrations.tabSystems'],
  ['frontends', 'integrations.tabFrontends'],
  ['triggers', 'integrations.tabTriggers'],
  ['keys', 'integrations.tabKeys'],
  ['hooks', 'integrations.tabHooks'],
  ['tracing', 'integrations.tabTracing'],
  ['docs', 'integrations.tabDocs'],
];

const tabFrom = (v: string | null): Tab => (tabs.some(([t]) => t === v) ? (v as Tab) : 'systems');

const defaultOpen: Partial<Record<Tab, string>> = { systems: 'okon', triggers: 'ko-post' };

type Flash = { text: string; color: 'success' | 'info' | 'danger' };

const downloadOpenApi = (t: T) => {
  const paths: Record<string, Record<string, { summary: string }>> = {};
  endpoints.forEach((e) => {
    paths[e.path] = { ...paths[e.path], [e.method.toLowerCase()]: { summary: t(e.summary) } };
  });
  const spec = {
    openapi: '3.1.0',
    info: { title: 'Fellesløsning for generativ KI', version: '1.0.0' },
    servers: [{ url: API_BASE }],
    paths,
  };
  if (typeof URL.createObjectURL !== 'function') return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }),
  );
  a.download = 'felleslosning-ki-openapi.json';
  a.click();
};

export const Integrations = (props: ScreenProps) => {
  const { tenantName, route } = props;
  if (route.segments[1] === 'api' && route.segments[2] === 'code')
    return props.live ? (
      <LiveCallFromCode api={props.api} tenant={props.tenant} tenantName={tenantName} />
    ) : (
      <CallFromCode tenantName={tenantName} />
    );
  if (route.segments[1] === 'hooks' && route.segments[2])
    return (
      <HookEditor
        api={props.api}
        tenant={props.tenant}
        id={route.segments[2] === 'new' ? undefined : decodeURIComponent(route.segments[2])}
      />
    );
  return <Overview {...props} />;
};

const Overview = ({ api, tenant, tenantName, route, live }: ScreenProps) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const only = useContext(IntegrationTab);
  const forService = useContext(IntegrationService);
  const queryTab = only ?? route.query.get('tab');
  const tab = tabFrom(queryTab);
  const [open, setOpen] = useState<string | undefined>(
    () => route.query.get('open') ?? defaultOpen[tab],
  );
  const [systems, setSystems] = useState<SystemClient[]>(live ? [] : exampleSystems);
  const [frontends, setFrontends] = useState<Frontend[]>(live ? [] : exampleFrontends);
  const [triggers, setTriggers] = useState<TriggerSource[]>(live ? [] : exampleTriggers);
  const [flash, setFlash] = useState<Flash | undefined>(() =>
    route.query.get('saved') ? { text: t('integrations.hookSaved'), color: 'success' } : undefined,
  );
  const [dialog, setDialog] = useState<{ kind: DialogKind; initial: FormValues } | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [triggerTick, setTriggerTick] = useState(0);
  const [liveTriggers] = useAsync(
    async (signal): Promise<TriggerView[]> => (live ? api.triggers.list(tenant, signal) : []),
    [api, tenant, live, triggerTick],
  );
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const openParam = route.query.get('open');
  const shown = useRef({ tab: queryTab, open: openParam });
  useEffect(() => {
    const before = shown.current;
    shown.current = { tab: queryTab, open: openParam };
    if (before.tab === queryTab && before.open === openParam) return;
    setOpen(openParam ?? defaultOpen[tab]);
    if (before.tab !== queryTab) setFlash(undefined);
  }, [queryTab, openParam]);

  const say = (text: string, color: Flash['color'] = 'success') => setFlash({ text, color });
  const hrefFor = (next: Tab, id: string) =>
    `#/developer/${developerPageFor(next)}?open=${encodeURIComponent(id)}`;
  const choose = (next: Tab, id: string) =>
    forService && next === 'triggers' ? setOpen(id) : navigate(hrefFor(next, id));

  const shownTriggers = forService
    ? triggers.filter((x) => x.service === forService.name)
    : triggers;
  const shownLive =
    live && liveTriggers.status === 'ready'
      ? liveTriggers.data.filter((x) => !forService || x.service === forService.id)
      : [];
  const failingSystems = forService ? [] : systems.filter((x) => x.status === 'Feiler');
  const failingTriggers = shownTriggers.filter((x) => x.status === 'Feiler');
  const failingLive = shownLive.filter((x) => x.status === 'failing');
  const problem = (kind: Tab, id: string, text: string) => ({
    text,
    href: hrefFor(kind, id),
    go: () => choose(kind, id),
  });
  const problems =
    tab === 'systems' || tab === 'triggers'
      ? [
          ...failingSystems.map((x) =>
            problem('systems', x.id, t('integrations.systemRejected', { name: x.name })),
          ),
          ...failingTriggers.map((x) => problem('triggers', x.id, `${x.name}: ${x.count}`)),
          ...failingLive.map((x) => problem('triggers', x.id, problemOf(x, t, f))),
        ]
      : [];

  const openScopes = (x: SystemClient) =>
    setDialog({ kind: 'scope', initial: { id: x.id, name: x.name, scopes: [...x.scopes] } });

  const systemItems: ItemRowData[] = systems.map((x) => ({
    id: x.id,
    name: x.name,
    status: x.status,
    sub: t('integrations.systemSub', { env: x.env, owner: x.owner }),
    metaLabel: t('integrations.lastUsed'),
    meta: `${x.last} · ${x.calls}`,
    ...(x.error
      ? {
          error: {
            what: x.error.what,
            why: x.error.why,
            code: x.error.code,
            color: 'danger' as const,
            actions: [
              {
                label: t('integrations.editScopes'),
                variant: 'primary' as const,
                onClick: () => openScopes(x),
              },
            ],
          },
        }
      : {}),
    rows: [
      {
        k: t('integrations.clientId'),
        v: x.client,
        copyLabel: t('integrations.copyClientId', { name: x.name }),
      },
      { k: t('integrations.scopes'), v: '', tags: x.scopes },
      {
        k: t('integrations.callsServices'),
        v: x.services.length ? x.services.join(', ') : t('integrations.noneYet'),
      },
      { k: t('integrations.environment'), v: x.env },
    ],
    actions: [
      { label: t('integrations.editScopes'), variant: 'secondary', onClick: () => openScopes(x) },
      {
        label: t('integrations.disconnect'),
        variant: 'tertiary',
        onClick: () => {
          setSystems((all) => all.filter((y) => y.id !== x.id));
          say(t('integrations.systemDisconnected', { name: x.name }));
        },
      },
    ],
  }));

  const frontendItems: ItemRowData[] = frontends.map((x) => ({
    id: x.id,
    name: x.name,
    status: x.status,
    sub: `${x.env} · ${x.redirect}`,
    metaLabel: t('integrations.lastUsed'),
    meta: `${x.last} · ${x.logins}`,
    rows: [
      {
        k: t('integrations.clientId'),
        v: x.client,
        copyLabel: t('integrations.copyClientId', { name: x.name }),
      },
      { k: t('integrations.redirectAfterLogin'), v: x.redirect },
      { k: t('integrations.scopes'), v: '', tags: x.scopes },
      { k: t('integrations.canUse'), v: x.services.join(', ') },
      { k: t('integrations.login'), v: t('integrations.loginAnsattportenHigh') },
    ],
    actions: [
      {
        label: t('common.edit'),
        variant: 'secondary',
        onClick: () => say(t('integrations.frontendEditUndecided'), 'info'),
      },
      {
        label: t('common.remove'),
        variant: 'tertiary',
        onClick: () => {
          setFrontends((all) => all.filter((y) => y.id !== x.id));
          say(t('integrations.frontendRemoved', { name: x.name }));
        },
      },
    ],
  }));

  const triggerItems: ItemRowData[] = shownTriggers.map((x) => {
    const error: ItemRowData['error'] = x.error
      ? {
          what: x.error.what,
          why: x.error.why,
          code: x.error.code,
          color: 'danger',
          actions: [
            {
              label: t('integrations.pasteNewKey'),
              variant: 'primary',
              onClick: () => setDialog({ kind: 'key', initial: {} }),
            },
            {
              label: t('common.tryAgain'),
              variant: 'secondary',
              busy: busy === x.id,
              onClick: () => {
                setBusy(x.id);
                timer.current = setTimeout(() => {
                  setBusy(undefined);
                  say(tRef.current('integrations.retryKeyExpired'), 'info');
                }, 900);
              },
            },
          ],
        }
      : x.note
        ? {
            what: t('integrations.lastRunFailed'),
            why: x.note,
            code: 'TOOL-503',
            color: 'info',
            actions: [
              {
                label: t('integrations.seeInLog'),
                variant: 'secondary',
                onClick: () => navigate('#/log'),
              },
            ],
          }
        : undefined;
    const paused = x.status === 'Satt på pause';
    return {
      id: x.id,
      name: x.name,
      status: x.status,
      sub: t('integrations.triggerSub', { kind: x.kind, service: x.service }),
      metaLabel: t('integrations.lastEvent'),
      meta: `${x.last} · ${x.count}`,
      ...(error ? { error } : {}),
      rows: [
        { k: t('integrations.rowType'), v: x.kind },
        { k: t('integrations.rowSource'), v: x.where },
        { k: t('integrations.rowStarts'), v: x.service },
      ],
      events: x.events.map(([when, text, status]) => ({ when, text, status })),
      actions: [
        {
          label: paused ? t('integrations.startAgain') : t('integrations.pause'),
          variant: 'secondary',
          onClick: () => {
            setTriggers((all) =>
              all.map((y) =>
                y.id === x.id ? { ...y, status: paused ? 'Aktiv' : 'Satt på pause' } : y,
              ),
            );
            say(
              paused
                ? t('integrations.triggerRestarted', { name: x.name })
                : t('integrations.triggerPaused', { name: x.name }),
            );
          },
        },
      ],
    };
  });

  const save = (v: FormValues) => {
    if (!dialog) return;
    const name = (v.name ?? '').trim();
    if (dialog.kind === 'scope') {
      const ok = (v.scopes ?? []).includes('digdir:ki.forbruk.les');
      setSystems((all) =>
        all.map((y) => {
          if (y.id !== v.id) return y;
          const next: SystemClient = { ...y, scopes: v.scopes ?? [] };
          if (ok) {
            next.status = 'Aktiv';
            delete next.error;
          }
          return next;
        }),
      );
      say(
        t(ok ? 'integrations.scopesSavedAccepted' : 'integrations.scopesSaved', {
          name: v.name ?? '',
        }),
      );
    }
    if (dialog.kind === 'sys') {
      const id = `n${Date.now()}`;
      setSystems((all) => [
        {
          id,
          name,
          env: t('integrations.envProduction'),
          client: (v.client ?? '').trim(),
          scopes: v.scopes ?? [],
          last: t('integrations.notUsedYet'),
          calls: t('integrations.noCallsYet'),
          services: [],
          status: 'Ikke i bruk',
          owner: 'Kari Nordmann',
        },
        ...all,
      ]);
      setOpen(id);
      say(t('integrations.systemConnected', { name }));
    }
    if (dialog.kind === 'fe') {
      const id = `n${Date.now()}`;
      setFrontends((all) => [
        {
          id,
          name,
          env: t('integrations.envTest'),
          client: `testetaten-${name.toLowerCase().replace(/[^a-zæøå0-9]+/g, '-')}`,
          redirect: (v.redirect ?? '').trim(),
          scopes: ['openid', 'digdir:ki.tjenester.kall'],
          services: v.services?.length ? v.services : [t('integrations.noneYet')],
          last: t('integrations.notUsedYet'),
          logins: t('integrations.noLoginsYet'),
          status: 'Bare testmiljø',
        },
        ...all,
      ]);
      setOpen(id);
      say(t('integrations.frontendRegistered', { name }));
    }
    if (dialog.kind === 'key') {
      setTriggers((all) =>
        all.map((y) => {
          if (y.id !== 'ko-post') return y;
          const next: TriggerSource = {
            ...y,
            status: 'Aktiv',
            last: 'I dag kl. 10.53',
            count: '132 meldinger behandles nå',
            events: [['I dag kl. 10.53', 'Begynte å lese 132 meldinger', 'Fullført'], ...y.events],
          };
          delete next.error;
          return next;
        }),
      );
      say(t('integrations.keySaved'));
    }
    setDialog(undefined);
  };

  const intro: Partial<Record<Tab, { text: string; add: string; onAdd: () => void }>> = {
    systems: {
      text: t('integrations.introSystems'),
      add: t('integrations.addSystem'),
      onAdd: () => setDialog({ kind: 'sys', initial: { scopes: ['digdir:ki.tjenester.kall'] } }),
    },
    frontends: {
      text: t('integrations.introFrontends'),
      add: t('integrations.addFrontend'),
      onAdd: () => setDialog({ kind: 'fe', initial: {} }),
    },
    triggers: {
      text: t('integrations.introTriggers'),
      add: t('integrations.addTrigger'),
      onAdd: () => say(t('integrations.triggerSetupInfo'), 'info'),
    },
  };

  const list = (items: ItemRowData[], empty: { title: string; text: string }) => (
    <ItemList
      items={items}
      open={open}
      onToggle={(id) => setOpen(open === id ? undefined : id)}
      empty={empty}
    />
  );
  const current = intro[tab];
  const id = tab;

  return (
    <div className="stack int">
      {problems.length ? (
        <Alert data-color="warning">
          <Heading level={2} data-size="2xs">
            {t('integrations.needFollowUp', { count: problems.length })}
          </Heading>
          <ul className="bullets">
            {problems.map((p) => (
              <li key={p.text}>
                <a
                  href={p.href}
                  onClick={(e) => {
                    e.preventDefault();
                    p.go();
                  }}
                >
                  {p.text}
                </a>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div aria-live="polite">
        {flash ? (
          <Alert data-color={flash.color} data-size="sm">
            {flash.text}
          </Alert>
        ) : null}
      </div>
      <div className="stack-md">
        {current && !(live && id === 'frontends') ? (
          <div className="int-intro">
            <Paragraph className="meta int-intro-text">{current.text}</Paragraph>
            {live ? null : (
              <Button variant="primary" onClick={current.onAdd}>
                {current.add}
              </Button>
            )}
          </div>
        ) : null}
        {live && id === 'tracing' ? (
          <NotAvailable>{t('integrations.tracingNotAvailable')}</NotAvailable>
        ) : null}
        {id === 'frontends' && live ? <Frontends api={api} tenant={tenant} onFlash={say} /> : null}
        {id === 'triggers' && live ? (
          liveTriggers.status === 'loading' ? (
            <Loading label={t('integrations.loadingTriggers')} />
          ) : liveTriggers.status === 'error' ? (
            <ErrorState error={liveTriggers.error} onRetry={() => setTriggerTick((n) => n + 1)} />
          ) : (
            <Triggers
              api={api}
              tenant={tenant}
              triggers={shownLive}
              open={open}
              onToggle={(id) => setOpen(open === id ? undefined : id)}
              onChanged={() => setTriggerTick((n) => n + 1)}
              onFlash={say}
            />
          )
        ) : null}
        {id === 'systems' && live ? (
          <>
            <MaskinportenClients api={api} tenant={tenant} onFlash={say} />
            <Connections api={api} tenant={tenant} />
          </>
        ) : null}
        {id === 'systems' && !live ? (
          <>
            {list(systemItems, {
              title: t('integrations.noSystems'),
              text: t('integrations.noSystemsText'),
            })}
            <Connections api={api} tenant={tenant} />
          </>
        ) : null}
        {id === 'frontends' && !live
          ? list(frontendItems, {
              title: t('integrations.noFrontends'),
              text: t('integrations.noFrontendsText'),
            })
          : null}
        {id === 'triggers' && !live
          ? list(triggerItems, {
              title: t('integrations.noTriggers'),
              text: t('integrations.noTriggersText'),
            })
          : null}
        {id === 'keys' ? <Keys api={api} tenant={tenant} onFlash={say} live={live} /> : null}
        {id === 'keys' && live ? <KeyPolicies api={api} tenant={tenant} onFlash={say} /> : null}
        {id === 'hooks' ? (
          <Hooks api={api} tenant={tenant} tenantName={tenantName} onFlash={say} />
        ) : null}
        {id === 'tracing' && !live ? (
          <Tracing
            tenantName={tenantName}
            status={route.query.get('status') === 'ok' ? 'ok' : 'feil'}
            fullContent
          />
        ) : null}
        {id === 'docs' ? (
          <div className="stack-md">
            <ul className="int-docs plain-list">
              {docs.map((d) => (
                <li key={d.title}>
                  <a href={d.href} className="int-doc">
                    <span className="int-doc-title">{t(d.title)}</span>
                    <span className="meta small">{t(d.desc)}</span>
                  </a>
                </li>
              ))}
            </ul>
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  downloadOpenApi(t);
                  say(t('integrations.openApiDownloaded'));
                }}
              >
                {t('integrations.downloadOpenApi')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      {dialog ? (
        <FormDialog
          kind={dialog.kind}
          initial={dialog.initial}
          onSave={save}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </div>
  );
};
