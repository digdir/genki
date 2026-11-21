import {
  BranchingIcon,
  CodeIcon,
  KeyHorizontalIcon,
  LightningIcon,
  LinkIcon,
  MonitorIcon,
  RouterIcon,
  ShieldIcon,
  TimelineIcon,
  VitalsIcon,
} from '@navikt/aksel-icons';
import { Heading, Paragraph, Tabs } from '@digdir/designsystemet-react';
import { useEffect, type ReactNode } from 'react';
import type { ApiClient } from '../api';
import { Icon, type IconComponent } from '../components/Icon';
import { navigate, useAsync } from '../hooks';
import { useT, type PlainKey } from '../i18n';
import type { ScreenProps } from '../screen';
import { ApiReference } from './ApiReference';
import { Guardrails } from './integrations/Guardrails';
import { TracingPage } from './integrations/TracingPage';
import { DevStatus } from './integrations/DevStatus';
import { StepFlowsHome } from './stepflows/StepFlowsHome';
import './integrations.css';
import { developerTabs, IntegrationTab } from './developer-routes';

interface Tool {
  id: string;
  label: PlainKey;
  icon: IconComponent;
}

const statusTool: Tool = {
  id: 'status',
  label: 'devTools.status',
  icon: VitalsIcon,
};

const tools: readonly Tool[] = [
  statusTool,
  {
    id: 'keys',
    label: 'devTools.keys',
    icon: KeyHorizontalIcon,
  },
  {
    id: 'frontends',
    label: 'devTools.frontends',
    icon: MonitorIcon,
  },
  {
    id: 'systems',
    label: 'devTools.systems',
    icon: RouterIcon,
  },
  {
    id: 'triggers',
    label: 'devTools.triggers',
    icon: LightningIcon,
  },
  {
    id: 'step-flows',
    label: 'devTools.stepFlows',
    icon: BranchingIcon,
  },
  {
    id: 'hooks',
    label: 'devTools.hooks',
    icon: LinkIcon,
  },
  {
    id: 'tracing',
    label: 'integrations.tabTracing',
    icon: TimelineIcon,
  },
  {
    id: 'guardrails',
    label: 'devTools.guardrails',
    icon: ShieldIcon,
  },
  {
    id: 'api',
    label: 'devTools.api',
    icon: CodeIcon,
  },
];

export type Attention = Partial<Record<'systems' | 'triggers', number>>;

export const useAttention = (
  api: Pick<ApiClient, 'integrations' | 'triggers' | 'toolConnections'>,
  tenant: string,
): Attention => {
  const [state] = useAsync(
    async (signal): Promise<Attention> => {
      const [integrations, triggers, syncs] = await Promise.all([
        api.integrations(tenant, signal).catch(() => undefined),
        api.triggers.list(tenant, signal).catch(() => undefined),
        api.toolConnections(tenant, signal).catch(() => []),
      ]);
      const failed = new Set(syncs.filter((c) => c.lastSync?.ok === false).map((c) => c.id));
      return {
        systems:
          integrations?.connections.filter((c) => c.pending.length > 0 || failed.has(c.id))
            .length ?? 0,
        triggers: triggers?.filter((x) => x.status === 'failing').length ?? 0,
      };
    },
    [api, tenant],
  );
  return state.status === 'ready' ? state.data : {};
};

/** The Utviklerverktøy heading and submenu around one of its pages. */
export const DeveloperToolsFrame = ({
  currentId,
  attention = {},
  children,
}: {
  currentId: string;
  attention?: Attention;
  children: ReactNode;
}) => {
  const t = useT();
  return (
    <>
      <Heading level={1} data-size="lg">
        {t('devTools.title')}
      </Heading>
      <Paragraph className="dev-tools-intro">{t('devTools.intro')}</Paragraph>
      <div className="dev-tools">
        <nav aria-label={t('devTools.menu')} className="dev-tools-nav sticky-rail">
          <ul className="nav-list">
            {tools.map((tool) => {
              const active = tool.id === currentId;
              const count = attention[tool.id as keyof Attention] ?? 0;
              return (
                <li key={tool.id}>
                  <a
                    href={`#/developer/${tool.id}`}
                    aria-current={active ? 'page' : undefined}
                    className={active ? 'active' : undefined}
                  >
                    <Icon icon={tool.icon} />
                    {t(tool.label)}
                    {count > 0 ? ' ' : null}
                    {count > 0 ? (
                      <span className="dev-tools-badge">
                        <span aria-hidden="true">{count}</span>
                        <span className="visually-hidden">
                          {t('devTools.needsFollowUp', { count })}
                        </span>
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="dev-tools-page">{children}</div>
      </div>
    </>
  );
};

const ApiPage = (props: ScreenProps & { integrations: (props: ScreenProps) => ReactNode }) => {
  const t = useT();
  const { integrations, ...rest } = props;
  const tab = props.route.segments[2] === 'reference' ? 'reference' : 'start';
  return (
    <Tabs
      value={tab}
      onChange={(v) =>
        navigate(v === 'reference' ? '#/developer/api/reference' : '#/developer/api')
      }
    >
      <Tabs.List aria-label={t('devTools.apiTabs')}>
        <Tabs.Tab value="start">{t('devTools.apiStart')}</Tabs.Tab>
        <Tabs.Tab value="reference">{t('devTools.apiReference')}</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="start">{tab === 'start' ? integrations(rest) : null}</Tabs.Panel>
      <Tabs.Panel value="reference">
        {tab === 'reference' ? <ApiReference {...rest} /> : null}
      </Tabs.Panel>
    </Tabs>
  );
};

const NotFoundHere = () => {
  const t = useT();
  return (
    <div className="stack-sm">
      <Heading level={2} data-size="xs">
        {t('notFound.title')}
      </Heading>
      <Paragraph>{t('notFound.text', { path: window.location.hash })}</Paragraph>
      <a href="#/developer/status">{t('devPages.goToStatus')}</a>
    </div>
  );
};

/** Older addresses of a developer page, sent on to where it lives now. */
const movedPages: Readonly<Record<string, string>> = { runs: 'tracing' };

export const DeveloperTools = ({
  integrations,
  ...props
}: ScreenProps & { integrations: (props: ScreenProps) => ReactNode }) => {
  const { api, route, tenant } = props;
  const t = useT();
  const attention = useAttention(api, tenant);
  const page = route.segments[1];
  const moved = page ? movedPages[page] : undefined;
  useEffect(() => {
    if (moved)
      window.location.replace(
        window.location.hash.replace(`/developer/${page}`, `/developer/${moved}`),
      );
  }, [moved, page]);
  if (moved) return null;
  const current = page === undefined ? statusTool : tools.find((tool) => tool.id === page);
  return (
    <DeveloperToolsFrame currentId={current?.id ?? ''} attention={attention}>
      {current === undefined ? (
        <NotFoundHere />
      ) : current.id === 'api' ? (
        <ApiPage {...props} integrations={integrations} />
      ) : current.id === 'step-flows' ? (
        <StepFlowsHome api={api} tenant={tenant} />
      ) : (
        <>
          <Heading level={2} data-size="xs">
            {t(current.label)}
          </Heading>
          {current.id === 'status' ? (
            <DevStatus api={api} tenant={tenant} />
          ) : current.id === 'guardrails' ? (
            <Guardrails api={api} tenant={tenant} tenantName={props.tenantName} />
          ) : current.id === 'tracing' ? (
            <TracingPage api={api} tenant={tenant} />
          ) : developerTabs[current.id] ? (
            <IntegrationTab.Provider value={developerTabs[current.id]}>
              {integrations(props)}
            </IntegrationTab.Provider>
          ) : null}
        </>
      )}
    </DeveloperToolsFrame>
  );
};
