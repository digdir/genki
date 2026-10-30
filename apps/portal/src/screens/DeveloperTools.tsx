import { Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { NotAvailable } from '../components/NotAvailable';
import { useT, type PlainKey } from '../i18n';
import type { ScreenProps } from '../screen';
import { Status } from './FooterPages';
import { GuardrailRules } from './service/GuardrailRules';
import { developerTabs, IntegrationTab } from './developer-routes';

interface Tool {
  id: string;
  label: PlainKey;
  desc?: PlainKey;
  icon: string;
  /** Where the content lives today, until it moves in here. */
  links?: readonly (readonly [string, PlainKey])[];
}

const statusTool: Tool = {
  id: 'status',
  label: 'devTools.status',
  desc: 'devTools.statusDesc',
  icon: 'M3 12h4l3-7 4 14 3-7h4',
};

const tools: readonly Tool[] = [
  statusTool,
  {
    id: 'keys',
    label: 'devTools.keys',
    desc: 'devTools.keysDesc',
    icon: 'M14 10a4 4 0 1 0-4 4l2 2h2v2h2v2h4v-4z',
  },
  {
    id: 'frontends',
    label: 'devTools.frontends',
    desc: 'devTools.frontendsDesc',
    icon: 'M4 5h16v11H4zM8 20h8M12 16v4',
  },
  {
    id: 'systems',
    label: 'devTools.systems',
    desc: 'devTools.systemsDesc',
    icon: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
  },
  {
    id: 'triggers',
    label: 'devTools.triggers',
    desc: 'devTools.triggersDesc',
    icon: 'M13 3L5 14h6l-1 7 8-11h-6z',
  },
  {
    id: 'step-flows',
    label: 'devTools.stepFlows',
    desc: 'devTools.stepFlowsDesc',
    icon: 'M5 5h5v5H5zM14 14h5v5h-5zM10 7.5h4v9',
    links: [['#/step-flows', 'devTools.openStepFlows']],
  },
  {
    id: 'hooks',
    label: 'devTools.hooks',
    icon: 'M10 4v8a4 4 0 1 0 8 0M18 12l-2-2M18 12l2-2',
  },
  {
    id: 'runs',
    label: 'integrations.tabTracing',
    desc: 'devTools.runsDesc',
    icon: 'M4 6h16M4 12h10M4 18h6',
    links: [['#/log', 'devTools.openLog']],
  },
  {
    id: 'guardrails',
    label: 'devTools.guardrails',
    desc: 'devTools.guardrailsDesc',
    icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  },
  {
    id: 'api',
    label: 'devTools.api',
    desc: 'devTools.apiDesc',
    icon: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
    links: [
      ['#/developer/api/code', 'integrations.callFromCode'],
      ['#/api-reference', 'devTools.openApiReference'],
    ],
  },
];

/** The Utviklerverktøy heading and submenu around one of its pages. */
export const DeveloperToolsFrame = ({
  currentId,
  children,
}: {
  currentId: string;
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
              return (
                <li key={tool.id}>
                  <a
                    href={`#/developer/${tool.id}`}
                    aria-current={active ? 'page' : undefined}
                    className={active ? 'active' : undefined}
                  >
                    <Icon d={tool.icon} />
                    {t(tool.label)}
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

export const DeveloperTools = ({
  integrations,
  ...props
}: ScreenProps & { integrations: (props: ScreenProps) => ReactNode }) => {
  const { api, route, tenant, live } = props;
  const t = useT();
  const current = tools.find((tool) => tool.id === route.segments[1]) ?? statusTool;
  return (
    <DeveloperToolsFrame currentId={current.id}>
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
        <Status api={api} />
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
          <Icon d={current.icon} size={32} />
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
