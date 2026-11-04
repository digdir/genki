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
import { Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { Icon, type IconComponent } from '../components/Icon';
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
                    <Icon icon={tool.icon} />
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
