import { Heading, Paragraph } from '@digdir/designsystemet-react';
import { Icon } from '../components/Icon';
import { useT, type PlainKey } from '../i18n';
import type { ScreenProps } from '../screen';
import { Status } from './FooterPages';

/** A page that has a place in the menu but no design yet. */
export const NotDesigned = ({ icon }: { icon: string }) => {
  const t = useT();
  return (
    <div className="empty-state">
      <Icon d={icon} size={32} />
      <Paragraph>{t('devTools.notDesigned')}</Paragraph>
    </div>
  );
};

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
    id: 'runs',
    label: 'devTools.runs',
    desc: 'devTools.runsDesc',
    icon: 'M4 6h16M4 12h10M4 18h6',
    links: [
      ['#/log', 'devTools.openLog'],
      ['#/integrations?tab=tracing', 'devTools.openTracing'],
    ],
  },
  {
    id: 'systems',
    label: 'devTools.systems',
    desc: 'devTools.systemsDesc',
    icon: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
    links: [['#/integrations?tab=systems', 'devTools.openIntegrations']],
  },
  {
    id: 'frontends',
    label: 'devTools.frontends',
    desc: 'devTools.frontendsDesc',
    icon: 'M4 5h16v11H4zM8 20h8M12 16v4',
    links: [['#/integrations?tab=frontends', 'devTools.openIntegrations']],
  },
  {
    id: 'triggers',
    label: 'devTools.triggers',
    desc: 'devTools.triggersDesc',
    icon: 'M13 3L5 14h6l-1 7 8-11h-6z',
    links: [['#/integrations?tab=triggers', 'devTools.openIntegrations']],
  },
  {
    id: 'keys',
    label: 'devTools.keys',
    desc: 'devTools.keysDesc',
    icon: 'M14 10a4 4 0 1 0-4 4l2 2h2v2h2v2h4v-4z',
    links: [['#/integrations?tab=keys', 'devTools.openIntegrations']],
  },
  {
    id: 'hooks',
    label: 'devTools.hooks',
    icon: 'M10 4v8a4 4 0 1 0 8 0M18 12l-2-2M18 12l2-2',
    links: [['#/integrations?tab=hooks', 'devTools.openIntegrations']],
  },
  {
    id: 'step-flows',
    label: 'devTools.stepFlows',
    desc: 'devTools.stepFlowsDesc',
    icon: 'M5 5h5v5H5zM14 14h5v5h-5zM10 7.5h4v9',
    links: [['#/step-flows', 'devTools.openStepFlows']],
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
      ['#/api-reference', 'devTools.openApiReference'],
      ['#/integrations?tab=docs', 'devTools.openDocs'],
    ],
  },
];

export const DeveloperTools = ({ api, route }: ScreenProps) => {
  const t = useT();
  const current = tools.find((tool) => tool.id === route.segments[1]) ?? statusTool;
  return (
    <>
      <Heading level={1} data-size="lg">
        {t('devTools.title')}
      </Heading>
      <div className="dev-tools">
        <nav aria-label={t('devTools.menu')} className="dev-tools-nav">
          <ul className="nav-list">
            {tools.map((tool) => {
              const active = tool.id === current.id;
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
        <section className="dev-tools-page" aria-labelledby="dev-tool-heading">
          <div>
            <Heading level={2} data-size="xs" id="dev-tool-heading">
              {t(current.label)}
            </Heading>
            {current.desc ? <Paragraph className="meta">{t(current.desc)}</Paragraph> : null}
          </div>
          {current.id === 'status' ? (
            <Status api={api} />
          ) : current.links ? (
            <div className="empty-state">
              <Icon d={current.icon} size={32} />
              <Paragraph>{t('devTools.livesElsewhere')}</Paragraph>
              {current.links.map(([href, label]) => (
                <a
                  key={href}
                  className="ds-button"
                  data-variant="secondary"
                  data-size="sm"
                  href={href}
                >
                  {t(label)}
                </a>
              ))}
            </div>
          ) : (
            <NotDesigned icon={current.icon} />
          )}
        </section>
      </div>
    </>
  );
};
