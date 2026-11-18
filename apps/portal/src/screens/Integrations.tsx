import { Alert } from '@digdir/designsystemet-react';
import { useContext, useState } from 'react';
import type { ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT, type PlainKey } from '../i18n';
import type { ScreenProps } from '../screen';
import { Loading } from '../states';
import { IntegrationTab } from './developer-routes';
import { CallFromCode, LiveCallFromCode } from './integrations/CallFromCode';
import { Connections } from './integrations/Connections';
import { Frontends } from './integrations/Frontends';
import { HookEditor, Hooks } from './integrations/Hooks';
import { KeyPolicies } from './integrations/KeyPolicies';
import { Keys } from './integrations/Keys';
import { MaskinportenClients } from './integrations/MaskinportenClients';
import { PageEmpty, PageError, PageLead } from './integrations/PageStates';
import { Triggers } from './integrations/Triggers';
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

type Flash = { text: string; color: 'success' | 'info' | 'danger' };

export const Integrations = (props: ScreenProps) => {
  const { tenantName, route } = props;
  if (route.segments[1] === 'api')
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

const TriggersPage = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const [tick, setTick] = useState(0);
  const [state, retry] = useAsync(
    (signal) => api.triggers.list(tenant, signal),
    [api, tenant, tick],
  );
  return (
    <>
      <PageLead text={t('devTriggers.lead')}>
        <a className="ds-button" data-variant="primary" href="#/services">
          {t('devTriggers.new')}
        </a>
      </PageLead>
      {state.status === 'loading' ? (
        <Loading label={t('integrations.loadingTriggers')} />
      ) : state.status === 'error' ? (
        <PageError
          error={state.error}
          title={t('devTriggers.errorTitle')}
          text={t('devTriggers.errorText')}
          onRetry={retry}
        />
      ) : state.data.length === 0 ? (
        <PageEmpty title={t('devTriggers.emptyTitle')} text={t('devTriggers.emptyText')}>
          <a href="#/services">{t('devTriggers.new')}</a>
        </PageEmpty>
      ) : (
        <Triggers
          api={api}
          tenant={tenant}
          triggers={state.data}
          onChanged={() => setTick((n) => n + 1)}
        />
      )}
    </>
  );
};

const Overview = ({ api, tenant, tenantName, route, live }: ScreenProps) => {
  const only = useContext(IntegrationTab);
  const tab = tabFrom(only ?? route.query.get('tab'));
  const t = useT();
  const openParam = route.query.get('open') ?? undefined;
  const [flash, setFlash] = useState<Flash | undefined>(() =>
    route.query.get('saved') ? { text: t('integrations.hookSaved'), color: 'success' } : undefined,
  );
  const say = (text: string, color: Flash['color'] = 'success') => setFlash({ text, color });
  return (
    <div className="stack int">
      <div aria-live="polite">
        {flash ? (
          <Alert data-color={flash.color} data-size="sm">
            {flash.text}
          </Alert>
        ) : null}
      </div>
      <div className="stack-md">
        {tab === 'systems' ? (
          live ? (
            <MaskinportenClients api={api} tenant={tenant} onFlash={say}>
              {(mp) => (
                <Connections
                  api={api}
                  tenant={tenant}
                  {...(openParam ? { initialOpen: openParam } : {})}
                  moreButton={mp.button}
                  moreRows={mp.rows}
                  after={mp.after}
                />
              )}
            </MaskinportenClients>
          ) : (
            <Connections
              api={api}
              tenant={tenant}
              {...(openParam ? { initialOpen: openParam } : {})}
            />
          )
        ) : null}
        {tab === 'frontends' ? <Frontends api={api} tenant={tenant} onFlash={say} /> : null}
        {tab === 'triggers' ? <TriggersPage api={api} tenant={tenant} /> : null}
        {tab === 'keys' ? <Keys api={api} tenant={tenant} onFlash={say} live={live} /> : null}
        {tab === 'keys' && live ? <KeyPolicies api={api} tenant={tenant} onFlash={say} /> : null}
        {tab === 'hooks' ? (
          <Hooks api={api} tenant={tenant} tenantName={tenantName} onFlash={say} />
        ) : null}
      </div>
    </div>
  );
};
