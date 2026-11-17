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
import type { ReactNode } from 'react';
import type { ApiClient } from '../api';
import { Icon, type IconComponent } from '../components/Icon';
import { NotAvailable } from '../components/NotAvailable';
import { exampleSystems, exampleTriggers } from '../data/integrations';
import { navigate, useAsync } from '../hooks';
import { useT, type PlainKey } from '../i18n';
import type { ScreenProps } from '../screen';
import { ApiReference } from './ApiReference';
import { GuardrailRules } from './service/GuardrailRules';
import { DevStatus } from './integrations/DevStatus';
import './integrations.css';
import { developerTabs, IntegrationTab } from './developer-routes';

interface Tool {
  id: string;
  label: PlainKey;
  desc?: PlainKey;
  icon: IconComponent;
  /** Where the content lives today, until it moves in here. */
  links?: readonly (readonly [string, PlainKey])[];
}

const statusTool: Tool = {
  id: 'status',
  label: 'devTools.status',
  desc: 'devTools.statusDesc',
  icon: VitalsIcon,
};

const tools: readonly Tool[] = [
  statusTool,
  {
    id: 'keys',
    label: 'devTools.keys',
    desc: 'devTools.keysDesc',
    icon: KeyHorizontalIcon,
  },
  {
    id: 'frontends',
    label: 'devTools.frontends',
    desc: 'devTools.frontendsDesc',
    icon: MonitorIcon,
  },
  {
    id: 'systems',
    label: 'devTools.systems',
    desc: 'devTools.systemsDesc',
    icon: RouterIcon,
  },
  {
    id: 'triggers',
    label: 'devTools.triggers',
    desc: 'devTools.triggersDesc',
    icon: LightningIcon,
  },
  {
    id: 'step-flows',
    label: 'devTools.stepFlows',
    desc: 'devTools.stepFlowsDesc',
    icon: BranchingIcon,
    links: [['#/step-flows', 'devTools.openStepFlows']],
  },
  {
    id: 'hooks',
    label: 'devTools.hooks',
    icon: LinkIcon,
  },
  {
    id: 'runs',
    label: 'integrations.tabTracing',
    desc: 'devTools.runsDesc',
    icon: TimelineIcon,
    links: [['#/log', 'devTools.openLog']],
  },
  {
    id: 'guardrails',
    label: 'devTools.guardrails',
    desc: 'devTools.guardrailsDesc',
    icon: ShieldIcon,
  },
  {
    id: 'api',
    label: 'devTools.api',
    desc: 'devTools.apiDesc',
    icon: CodeIcon,
  },
];

export type Attention = Partial<Record<'systems' | 'triggers', number>>;

export const useAttention = (
  api: Pick<ApiClient, 'integrations' | 'triggers'>,
  tenant: string,
  live: boolean,
): Attention => {
  const [state] = useAsync(
    async (signal): Promise<Attention> => {
      if (!live)
        return {
          systems: exampleSystems.filter((s) => s.status === 'Feiler').length,
          triggers: exampleTriggers.filter((s) => s.status === 'Feiler').length,
        };
      const [integrations, triggers] = await Promise.all([
        api.integrations(tenant, signal).catch(() => undefined),
        api.triggers.list(tenant, signal).catch(() => undefined),
      ]);
      return {
        systems: integrations?.connections.filter((c) => c.pending.length > 0).length ?? 0,
        triggers: triggers?.filter((x) => x.status === 'failing').length ?? 0,
      };
    },
    [api, tenant, live],
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
        <nav aria-label={t('devTools.menu')} className="dev-tools-nav">
          <ul className="nav-list">
            {tools.map((tool) => {
              const active = tool.id === currentId;
              const count = attention[tool.id as keyof Attention] ?? 0;
              return (
                <li key={tool.id}>
                  <a
                    href={tool.id === 'step-flows' ? '#/step-flows' : `#/developer/${tool.id}`}
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

export const DeveloperTools = ({
  integrations,
  ...props
}: ScreenProps & { integrations: (props: ScreenProps) => ReactNode }) => {
  const { api, route, tenant, live } = props;
  const t = useT();
  const attention = useAttention(api, tenant, live);
  const current = tools.find((tool) => tool.id === route.segments[1]) ?? statusTool;
  return (
    <DeveloperToolsFrame currentId={current.id} attention={attention}>
      <div>
        <Heading level={2} data-size="xs">
          {t(current.label)}
        </Heading>
        {current.desc ? <Paragraph className="meta">{t(current.desc)}</Paragraph> : null}
      </div>
      {current.links ? (
        <div className="dev-tools-links">
          {current.links.map(([href, label]) => (
            <a key={href} href={href}>
              {t(label)}
            </a>
          ))}
        </div>
      ) : null}
      {current.id === 'status' ? (
        <DevStatus api={api} />
      ) : current.id === 'api' ? (
        <ApiPage {...props} integrations={integrations} />
      ) : current.id === 'guardrails' ? (
        live ? (
          <GuardrailRules api={api} tenant={tenant} />
        ) : (
          <NotAvailable>{t('devTools.guardrailsNotAvailable')}</NotAvailable>
        )
      ) : developerTabs[current.id] ? (
        <IntegrationTab.Provider value={developerTabs[current.id]}>
          {integrations(props)}
        </IntegrationTab.Provider>
      ) : current.links ? (
        <div className="empty-state">
          <Icon icon={current.icon} size={32} />
          <Paragraph>{t('devTools.livesElsewhere')}</Paragraph>
          {current.links.map(([href, label]) => (
            <a key={href} className="ds-button" data-variant="secondary" data-size="sm" href={href}>
              {t(label)}
            </a>
          ))}
        </div>
      ) : null}
    </DeveloperToolsFrame>
  );
};
