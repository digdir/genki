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

export const blockIcon: Record<BlockId, string> = {
  projects: 'M3 6h6l2 2h10v11H3z',
  threads: 'M5 6h14M5 12h14M5 18h9',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
  chat: 'M5 5h14v10H10l-5 4z',
  sources: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM5 18a2 2 0 0 1 2-2h11M9 8h5',
  notes: 'M4 20l1-4L16 5l3 3L8 19zM14 7l3 3M13 20h7',
  filter: 'M4 5h16l-6 7v6l-4 2v-8z',
  procedure:
    'M8 8h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zM12 4v4M10 13v1M14 13v1',
  documentView: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
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
