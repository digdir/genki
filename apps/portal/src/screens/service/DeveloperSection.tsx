import { Alert, Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { useT, type PlainKey } from '../../i18n';
import { servicePath } from './sections';
import { defaultApiBase, serverSnippet } from './snippets';

export type DeveloperTool =
  | 'call'
  | 'keys'
  | 'triggers'
  | 'model'
  | 'step-flow'
  | 'guardrails'
  | 'runs'
  | 'definition'
  | 'versions';

interface Tool {
  id: DeveloperTool;
  label: PlainKey;
  desc: PlainKey;
  icon: string;
  /** Where the organisation-wide part of this tool lives. */
  links?: readonly (readonly [string, PlainKey])[];
}

const callTool: Tool = {
  id: 'call',
  label: 'devTools.call',
  desc: 'devTools.callDesc',
  icon: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
};

const tools: readonly Tool[] = [
  callTool,
  {
    id: 'keys',
    label: 'devTools.keys',
    desc: 'devTools.serviceKeysDesc',
    icon: 'M14 10a4 4 0 1 0-4 4l2 2h2v2h2v2h4v-4z',
    links: [['#/developer/keys', 'devTools.openOrgKeys']],
  },
  {
    id: 'triggers',
    label: 'devTools.triggers',
    desc: 'devTools.serviceTriggersDesc',
    icon: 'M13 3L5 14h6l-1 7 8-11h-6z',
  },
  {
    id: 'model',
    label: 'devTools.model',
    desc: 'devTools.modelDesc',
    icon: 'M4 7h16M4 17h16M9 4v6M15 14v6',
  },
  {
    id: 'step-flow',
    label: 'devTools.stepFlow',
    desc: 'devTools.stepFlowDesc',
    icon: 'M5 5h5v5H5zM14 14h5v5h-5zM10 7.5h4v9',
    links: [['#/step-flows', 'devTools.openStepFlows']],
  },
  {
    id: 'guardrails',
    label: 'devTools.serviceGuardrails',
    desc: 'devTools.serviceGuardrailsDesc',
    icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
    links: [['#/developer/guardrails', 'devTools.openCommonGuardrails']],
  },
  {
    id: 'runs',
    label: 'devTools.runs',
    desc: 'devTools.serviceRunsDesc',
    icon: 'M4 6h16M4 12h10M4 18h6',
  },
  {
    id: 'definition',
    label: 'devTools.definition',
    desc: 'devTools.definitionDesc',
    icon: 'M6 3h9l4 4v14H6zM14 3v5h5',
  },
  {
    id: 'versions',
    label: 'devTools.versions',
    desc: 'devTools.versionsDesc',
    icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  },
];

export const isDeveloperTool = (id: string | undefined): id is DeveloperTool =>
  tools.some((tool) => tool.id === id);

/** The Utviklerverktøy tab on one service: everything technical, behind one flat submenu. */
export const DeveloperSection = ({
  id,
  model,
  isNew,
  current,
  pages,
}: {
  /** The service id in the address. */
  id: string;
  /** The model name callers use for this service. */
  model: string;
  isNew: boolean;
  current: DeveloperTool;
  /** Content made by the builder, which owns the draft. */
  pages: Partial<Record<DeveloperTool, ReactNode>>;
}) => {
  const t = useT();
  const tool = tools.find((x) => x.id === current) ?? callTool;
  const page =
    pages[tool.id] ??
    (tool.id === 'call' ? (
      <>
        {isNew ? (
          <Alert data-color="info" data-size="sm">
            {t('devTools.callNotPublished')}
          </Alert>
        ) : null}
        <div className="stack-sm">
          <Heading level={3} data-size="2xs">
            {t('devTools.endpoint')}
          </Heading>
          <code>POST {defaultApiBase}/v1/chat/completions</code>
        </div>
        <div className="stack-sm">
          <Heading level={3} data-size="2xs">
            {t('devTools.example')}
          </Heading>
          <pre>
            <code>{serverSnippet(defaultApiBase, model, ['rest'])}</code>
          </pre>
        </div>
      </>
    ) : null);
  return (
    <div className="dev-tools">
      <nav aria-label={t('devTools.serviceMenu')} className="dev-tools-nav">
        <ul className="nav-list">
          {tools.map((x) => {
            const active = x.id === tool.id;
            return (
              <li key={x.id}>
                <a
                  href={`#${servicePath(id, 'developer', `/${x.id}`)}`}
                  aria-current={active ? 'page' : undefined}
                  className={active ? 'active' : undefined}
                >
                  <Icon d={x.icon} />
                  {t(x.label)}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="dev-tools-page">
        <div>
          <Heading level={2} data-size="xs">
            {t(tool.label)}
          </Heading>
          <Paragraph className="meta">{t(tool.desc)}</Paragraph>
        </div>
        {tool.links ? (
          <div className="dev-tools-links">
            {tool.links.map(([href, label]) => (
              <a key={href} href={href}>
                {t(label)}
              </a>
            ))}
          </div>
        ) : null}
        {page}
      </div>
    </div>
  );
};
