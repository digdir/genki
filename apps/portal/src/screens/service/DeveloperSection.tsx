import {
  ClockIcon,
  CodeIcon,
  FileCodeIcon,
  KeyHorizontalIcon,
  LightningIcon,
  TimelineIcon,
} from '@navikt/aksel-icons';
import { Alert, Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { Icon, type IconComponent } from '../../components/Icon';
import { useT, type PlainKey } from '../../i18n';
import { servicePath } from './sections';
import { defaultApiBase, serverSnippet } from './snippets';

export type DeveloperTool = 'call' | 'keys' | 'triggers' | 'runs' | 'definition' | 'versions';

interface Tool {
  id: DeveloperTool;
  label: PlainKey;
  desc: PlainKey;
  icon: IconComponent;
  /** Where the organisation-wide part of this tool lives. */
  links?: readonly (readonly [string, PlainKey])[];
}

const callTool: Tool = {
  id: 'call',
  label: 'devTools.call',
  desc: 'devTools.callDesc',
  icon: CodeIcon,
};

const tools: readonly Tool[] = [
  callTool,
  {
    id: 'keys',
    label: 'devTools.keys',
    desc: 'devTools.serviceKeysDesc',
    icon: KeyHorizontalIcon,
    links: [['#/developer/keys', 'devTools.openOrgKeys']],
  },
  {
    id: 'triggers',
    label: 'devTools.triggers',
    desc: 'devTools.serviceTriggersDesc',
    icon: LightningIcon,
  },
  {
    id: 'runs',
    label: 'devTools.runs',
    desc: 'devTools.serviceRunsDesc',
    icon: TimelineIcon,
  },
  {
    id: 'definition',
    label: 'devTools.definition',
    desc: 'devTools.definitionDesc',
    icon: FileCodeIcon,
  },
  {
    id: 'versions',
    label: 'devTools.versions',
    desc: 'devTools.versionsDesc',
    icon: ClockIcon,
  },
];

export const isDeveloperTool = (id: string | undefined): id is DeveloperTool =>
  tools.some((tool) => tool.id === id);

/** The Utviklerverktøy tab on one service: the technical parts, behind one flat submenu. What the owner sets up stays in Oppsett and Avanserte innstillinger. */
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
                  <Icon icon={x.icon} />
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
