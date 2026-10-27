import {
  Button,
  Details,
  Dropdown,
  Heading,
  Paragraph,
  ToggleGroup,
} from '@digdir/designsystemet-react';
import { useRef, useState, type ReactNode } from 'react';
import { Icon, icons } from '../../../components/Icon';
import { useT, type PlainKey } from '../../../i18n';
import { blockIcon, blockLabel } from './BlocksPanel';
import { blocksIn, rightPanelMode, type BlockId, type BlockLayout, type Panel } from './rules';

export type PreviewMode = 'setup' | 'try';
export type PreviewDevice = 'desktop' | 'mobile';

const paths = {
  reload: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  desktop: 'M3 5h18v11H3zM8 20h8M12 16v4',
  mobile: 'M7 3h10v18H7zM11 18h2',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
};

const frameLabel: Record<Panel, PlainKey> = {
  left: 'builderBlocks.frameLeft',
  main: 'builderBlocks.frameMain',
  right: 'builderBlocks.frameRight',
};

export const ServicePreview = ({
  layout,
  mode,
  device,
  address,
  chat,
  onMode,
  onDevice,
  onRemove,
  onReload,
  onFullscreen,
  height,
}: {
  layout: BlockLayout;
  mode: PreviewMode;
  device: PreviewDevice;
  address: string;
  chat: ReactNode;
  onMode: (mode: PreviewMode) => void;
  onDevice: (device: PreviewDevice) => void;
  onRemove: (id: BlockId) => void;
  onReload: () => void;
  onFullscreen?: () => void;
  height?: number;
}) => {
  const t = useT();
  const used = (['left', 'main', 'right'] as Panel[]).filter((p) => blocksIn(layout, p).length);
  return (
    <section className="service-preview" aria-labelledby="forhandsvisning-tittel">
      <div className="service-preview-head">
        <Heading level={2} data-size="2xs" id="forhandsvisning-tittel">
          {t('builderBlocks.previewTitle')}
        </Heading>
        <ToggleGroup
          data-size="sm"
          data-color="accent"
          aria-label={t('builderBlocks.previewView')}
          value={mode}
          onChange={(v) => onMode(v as PreviewMode)}
        >
          <ToggleGroup.Item value="setup">{t('builderBlocks.viewSetup')}</ToggleGroup.Item>
          <ToggleGroup.Item value="try">{t('builderBlocks.viewTry')}</ToggleGroup.Item>
        </ToggleGroup>
      </div>
      <Paragraph data-size="sm" className="meta">
        {mode === 'setup' ? t('builderBlocks.setupHelp') : t('builderBlocks.tryHelp')}
      </Paragraph>
      <div className="service-preview-toolbar">
        <Button
          variant="tertiary"
          data-size="sm"
          icon
          aria-label={t('builderBlocks.reload')}
          onClick={onReload}
        >
          <Icon d={paths.reload} />
        </Button>
        <span className="service-preview-address">{address}</span>
        <ToggleGroup
          data-size="sm"
          variant="secondary"
          aria-label={t('builderBlocks.device')}
          value={device}
          onChange={(v) => onDevice(v as PreviewDevice)}
        >
          <ToggleGroup.Item value="desktop" icon aria-label={t('builderBlocks.desktop')}>
            <Icon d={paths.desktop} />
          </ToggleGroup.Item>
          <ToggleGroup.Item value="mobile" icon aria-label={t('builderBlocks.mobile')}>
            <Icon d={paths.mobile} />
          </ToggleGroup.Item>
        </ToggleGroup>
        {onFullscreen ? (
          <Button
            variant="tertiary"
            data-size="sm"
            icon
            aria-label={t('builderBlocks.fullscreen')}
            onClick={onFullscreen}
          >
            <Icon d={paths.expand} />
          </Button>
        ) : null}
      </div>
      <div
        className="service-preview-frame"
        data-device={device}
        data-mode={mode}
        style={height ? { height: `${height}px` } : undefined}
      >
        {used.length === 0 ? (
          <p className="meta service-preview-empty">{t('builderBlocks.nothingPlaced')}</p>
        ) : mode === 'setup' ? (
          used.map((p) => <SetupPanel key={p} panel={p} layout={layout} onRemove={onRemove} />)
        ) : (
          <TryView layout={layout} chat={chat} />
        )}
      </div>
    </section>
  );
};

const SetupPanel = ({
  panel,
  layout,
  onRemove,
}: {
  panel: Panel;
  layout: BlockLayout;
  onRemove: (id: BlockId) => void;
}) => {
  const t = useT();
  const ids = blocksIn(layout, panel);
  const rightMode = panel === 'right' ? rightPanelMode(ids.length) : undefined;
  return (
    <div className="preview-panel" data-panel={panel}>
      <div className="preview-panel-head">
        <span className="preview-panel-name">{t(frameLabel[panel])}</span>
        {rightMode === 'heading' ? (
          <span className="meta">{t('builderBlocks.rightModeHeading')}</span>
        ) : rightMode === 'tabs' ? (
          <span className="meta">{t('builderBlocks.rightModeTabs')}</span>
        ) : rightMode === 'dropdown' ? (
          <span className="meta">{t('builderBlocks.rightModeDropdown', { n: ids.length })}</span>
        ) : null}
      </div>
      <ul className="preview-cards">
        {ids.map((id) => (
          <li key={id} className="preview-card" data-block={id} data-bottom={id === 'settings'}>
            <span className="preview-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="preview-card-name">{t(blockLabel[id])}</span>
            <Button
              variant="tertiary"
              data-size="sm"
              icon
              aria-label={t('builderBlocks.removeBlock', { block: t(blockLabel[id]) })}
              onClick={() => onRemove(id)}
            >
              <Icon d={icons.close} size={16} />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
};

const TryView = ({ layout, chat }: { layout: BlockLayout; chat: ReactNode }) => {
  const t = useT();
  const left = blocksIn(layout, 'left');
  const main = blocksIn(layout, 'main');
  const right = blocksIn(layout, 'right');
  const hasChat = main.includes('chat') || right.includes('chat');
  return (
    <>
      {left.length ? (
        <aside className="preview-panel try-left" aria-label={t('builderBlocks.frameLeft')}>
          {left.map((id) => (
            <div key={id} data-bottom={id === 'settings'}>
              <TryBlock id={id} chat={chat} where="left" />
            </div>
          ))}
        </aside>
      ) : null}
      <div className="preview-panel try-main">
        <Paragraph data-size="xs" className="meta">
          {t('builderBlocks.exampleNote')}
        </Paragraph>
        {main.map((id) => (
          <TryBlock key={id} id={id} chat={chat} where="main" />
        ))}
        {hasChat ? null : <p className="meta">{t('builderBlocks.noChat')}</p>}
      </div>
      {right.length ? <TryRight ids={right} chat={chat} /> : null}
    </>
  );
};

const TryRight = ({ ids, chat }: { ids: BlockId[]; chat: ReactNode }) => {
  const t = useT();
  const [picked, setPicked] = useState<BlockId | undefined>();
  const menu = useRef<HTMLDivElement>(null);
  const active = picked && ids.includes(picked) ? picked : (ids[0] ?? 'sources');
  const mode = rightPanelMode(ids.length);
  return (
    <aside className="preview-panel try-right" aria-label={t('builderBlocks.frameRight')}>
      {mode === 'heading' ? (
        <>
          <Heading level={3} data-size="2xs" className="try-tool-heading">
            <Icon d={blockIcon[active]} />
            {t(blockLabel[active])}
          </Heading>
          <TryBlock id={active} chat={chat} where="right" />
        </>
      ) : mode === 'tabs' ? (
        <>
          <ToggleGroup
            data-size="sm"
            data-color="neutral"
            variant="secondary"
            className="try-tool-switcher"
            aria-label={t('builderBlocks.toolPicker')}
            value={active}
            onChange={(v) => setPicked(v as BlockId)}
          >
            {ids.map((id) => (
              <ToggleGroup.Item key={id} value={id}>
                <Icon d={blockIcon[id]} />
                {t(blockLabel[id])}
              </ToggleGroup.Item>
            ))}
          </ToggleGroup>
          <TryBlock id={active} chat={chat} where="right" />
        </>
      ) : (
        <>
          <Dropdown.TriggerContext>
            <Dropdown.Trigger
              variant="secondary"
              data-color="neutral"
              data-size="sm"
              className="try-tool-trigger"
              aria-label={`${t(blockLabel[active])}, ${t('builderBlocks.toolPicker')}`}
            >
              <span className="try-tool-heading">
                <Icon d={blockIcon[active]} />
                {t(blockLabel[active])}
              </span>
              <Icon d={icons.chevronDown} size={18} />
            </Dropdown.Trigger>
            <Dropdown data-size="sm" placement="bottom-start" ref={menu}>
              <Dropdown.List>
                {ids.map((id) => (
                  <Dropdown.Item key={id}>
                    <Dropdown.Button
                      aria-current={id === active ? 'true' : undefined}
                      onClick={() => {
                        setPicked(id);
                        menu.current?.hidePopover();
                      }}
                    >
                      <Icon d={blockIcon[id]} />
                      {t(blockLabel[id])}
                    </Dropdown.Button>
                  </Dropdown.Item>
                ))}
              </Dropdown.List>
            </Dropdown>
          </Dropdown.TriggerContext>
          <TryBlock id={active} chat={chat} where="right" />
        </>
      )}
    </aside>
  );
};

const TryBlock = ({ id, chat, where }: { id: BlockId; chat: ReactNode; where: Panel }) => {
  const t = useT();
  switch (id) {
    case 'chat':
      return <div className="try-chat">{chat}</div>;
    case 'projects':
      return (
        <div className="stack-xs">
          <span className="try-label">{t('builderBlocks.projects')}</span>
          <span className="try-item">{t('builderBlocks.exampleProject')}</span>
        </div>
      );
    case 'threads':
      return (
        <div className="stack-xs">
          <Button data-size="sm" variant="primary" className="align-start" tabIndex={-1}>
            {t('builderBlocks.newThread')}
          </Button>
          <span className="meta">{t('builderBlocks.today')}</span>
          <span className="try-item" data-selected="true">
            {t('builderBlocks.exampleThread1')}
          </span>
          <span className="try-item">{t('builderBlocks.exampleThread2')}</span>
        </div>
      );
    case 'filter':
      return (
        <div className="stack-xs">
          {where === 'left' ? (
            <>
              <span className="try-label">{t('builderBlocks.filterTitle')}</span>
              <span className="meta">{t('builderBlocks.filterApplies')}</span>
            </>
          ) : null}
          <p className="try-filter-summary">
            {t('builderBlocks.filterSummary')}{' '}
            {where === 'main' ? (
              <span className="try-link">{t('builderBlocks.filterChange')}</span>
            ) : null}
          </p>
        </div>
      );
    case 'settings':
      return <span className="try-item">{t('builderBlocks.settings')}</span>;
    case 'procedure':
      return (
        <Details data-color="neutral" className="try-procedure">
          <Details.Summary>
            {t('builderBlocks.procedure')} · {t('builderBlocks.procedureSummary')}
          </Details.Summary>
          <Details.Content>
            <ol className="try-steps">
              <li>{t('builderBlocks.procedureStep1')}</li>
              <li>{t('builderBlocks.procedureStep2')}</li>
              <li>{t('builderBlocks.procedureStep3')}</li>
              <li>{t('builderBlocks.procedureStep4')}</li>
            </ol>
          </Details.Content>
        </Details>
      );
    case 'footnotes':
      return <p className="meta">{t('builderBlocks.footnotesExample')}</p>;
    case 'sources':
      return (
        <ol className="try-sources">
          {(
            [
              ['builderBlocks.source1', 'builderBlocks.source1Meta'],
              ['builderBlocks.source2', 'builderBlocks.source2Meta'],
              ['builderBlocks.source3', 'builderBlocks.source3Meta'],
            ] as const
          ).map(([title, meta], i) => (
            <li key={title} className="try-source">
              <span className="try-footnote">{i + 1}</span>
              <span className="stack-xs">
                <span className="try-source-title">{t(title)}</span>
                <span className="meta">{t(meta)}</span>
              </span>
            </li>
          ))}
        </ol>
      );
    case 'documentView':
      return <p className="try-document meta">{t('builderBlocks.documentExample')}</p>;
    case 'notes':
      return <p className="meta">{t('builderBlocks.notesEmpty')}</p>;
  }
};
