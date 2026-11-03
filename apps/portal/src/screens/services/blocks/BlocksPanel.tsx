import {
  BookIcon,
  BulletListIcon,
  ChatIcon,
  CogIcon,
  FileTextIcon,
  FolderIcon,
  FunnelIcon,
  NotePencilIcon,
  RobotIcon,
} from '@navikt/aksel-icons';
import type { IconComponent } from '../../../components/Icon';
import { Divider, Fieldset, Heading, Paragraph, Switch } from '@digdir/designsystemet-react';
import { Fragment } from 'react';
import { useT, type PlainKey } from '../../../i18n';
import {
  blocksAllowedIn,
  placeIn,
  turnOff,
  type BlockId,
  type BlockLayout,
  type Panel,
} from './rules';

export const blockLabel: Record<BlockId, PlainKey> = {
  projects: 'builderBlocks.projects',
  threads: 'builderBlocks.threads',
  settings: 'builderBlocks.settings',
  chat: 'builderBlocks.chat',
  sources: 'builderBlocks.sources',
  notes: 'builderBlocks.notes',
  filter: 'builderBlocks.filter',
  procedure: 'builderBlocks.procedure',
  documentView: 'builderBlocks.documentView',
};

export const blockIcon: Record<BlockId, IconComponent> = {
  projects: FolderIcon,
  threads: BulletListIcon,
  settings: CogIcon,
  chat: ChatIcon,
  sources: BookIcon,
  notes: NotePencilIcon,
  filter: FunnelIcon,
  procedure: RobotIcon,
  documentView: FileTextIcon,
};

const blockHelp: Record<BlockId, PlainKey> = {
  projects: 'builderBlocks.projectsHelp',
  threads: 'builderBlocks.threadsHelp',
  settings: 'builderBlocks.settingsHelp',
  chat: 'builderBlocks.chatHelp',
  sources: 'builderBlocks.sourcesHelp',
  notes: 'builderBlocks.notesHelp',
  filter: 'builderBlocks.filterHelp',
  procedure: 'builderBlocks.procedureHelp',
  documentView: 'builderBlocks.documentViewHelp',
};

export const panelLabel: Record<Panel, PlainKey> = {
  left: 'builderBlocks.panelLeft',
  main: 'builderBlocks.panelMain',
  right: 'builderBlocks.panelRight',
};

const groups: { panel: Panel; legend: PlainKey }[] = [
  { panel: 'left', legend: 'builderBlocks.groupLeft' },
  { panel: 'main', legend: 'builderBlocks.groupMain' },
  { panel: 'right', legend: 'builderBlocks.groupRight' },
];

export const BlocksPanel = ({
  layout,
  onChange,
}: {
  layout: BlockLayout;
  onChange: (next: BlockLayout) => void;
}) => {
  const t = useT();
  const help = (id: BlockId) =>
    id === 'settings'
      ? `${t(blockHelp[id])}. ${t('builderBlocks.bottomOfPanel')}`
      : t(blockHelp[id]);

  return (
    <div className="blocks-panel">
      <Paragraph data-size="sm">{t('builderBlocks.intro')}</Paragraph>
      {groups.map(({ panel, legend }) => (
        <Fragment key={panel}>
          <Divider />
          <Fieldset className="blocks-group">
            <Fieldset.Legend>
              <Heading level={2} data-size="2xs">
                {t(legend)}
              </Heading>
            </Fieldset.Legend>
            {blocksAllowedIn(panel).map((id) => {
              const at = layout.placed[id];
              const elsewhere = at !== undefined && at !== panel;
              return (
                <Switch
                  key={id}
                  variant="outline"
                  position="end"
                  label={t(blockLabel[id])}
                  description={
                    elsewhere
                      ? t('builderBlocks.usedIn', {
                          panel: t(panelLabel[at]).toLowerCase(),
                        })
                      : help(id)
                  }
                  checked={at === panel}
                  onChange={() =>
                    onChange(at === panel ? turnOff(layout, id) : placeIn(layout, id, panel))
                  }
                />
              );
            })}
          </Fieldset>
        </Fragment>
      ))}
    </div>
  );
};
