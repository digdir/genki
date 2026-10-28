import {
  Alert,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  ToggleGroup,
} from '@digdir/designsystemet-react';
import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Icon } from '../../../components/Icon';
import { useT } from '../../../i18n';
import { BlocksPanel, type BlocksPanelVariant } from './BlocksPanel';
import { defaultLayout, turnOff, type BlockLayout, type TemplateId } from './rules';
import { ServicePreview, type PreviewDevice, type PreviewMode } from './ServicePreview';
import { TemplatesPanel, templateLabel } from './TemplatesPanel';
import './blocks.css';

type LeftTab = 'chat' | 'blocks' | 'templates';

const leftMin = 320;
const leftMax = 640;
const fullHeightMin = 480;
const fullHeightMax = 1400;

export const useBlocksState = () => {
  const [layout, setLayout] = useState<BlockLayout>(defaultLayout);
  const [template, setTemplate] = useState<TemplateId | undefined>('full');
  const [mode, setMode] = useState<PreviewMode>('setup');
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [tab, setTab] = useState<LeftTab>('blocks');
  const [width, setWidth] = useState(380);
  const [height, setHeight] = useState(720);
  const [conversation, setConversation] = useState(0);
  return {
    layout,
    template,
    mode,
    device,
    tab,
    width,
    height,
    conversation,
    setMode,
    setDevice,
    setTab,
    setWidth,
    setHeight,
    change: (next: BlockLayout) => {
      setLayout(next);
      setTemplate(undefined);
    },
    pick: (id: TemplateId, next: BlockLayout) => {
      setLayout(next);
      setTemplate(id);
    },
    restart: () => setConversation((n) => n + 1),
  };
};

export type BlocksState = ReturnType<typeof useBlocksState>;

const ResizeHandle = ({
  axis,
  value,
  min,
  max,
  label,
  onChange,
}: {
  axis: 'x' | 'y';
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (v: number) => void;
}) => {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const start = (e: PointerEvent<HTMLDivElement>) => {
    const from = axis === 'x' ? e.clientX : e.clientY;
    const size = value;
    const move = (ev: globalThis.PointerEvent) =>
      onChange(clamp(axis === 'x' ? size + (ev.clientX - from) : size + (ev.clientY - from)));
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };
  const grow = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
  const shrink = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === grow) onChange(clamp(value + 40));
    else if (e.key === shrink) onChange(clamp(value - 40));
    else return;
    e.preventDefault();
  };
  return (
    <div
      className="blocks-resize"
      data-axis={axis}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={key}
    />
  );
};

export const BlocksStep = ({
  state,
  narrow,
  assistant,
  chat,
  address,
  onFullscreen,
  variant,
}: {
  variant?: BlocksPanelVariant;
  state: BlocksState;
  narrow: boolean;
  assistant: ReactNode;
  chat: ReactNode;
  address: string;
  onFullscreen: () => void;
}) => {
  const t = useT();
  const [pane, setPane] = useState<'blocks' | 'preview'>('blocks');
  const left = (
    <div className="blocks-left">
      <ToggleGroup
        data-size="sm"
        data-color="neutral"
        variant="secondary"
        className="blocks-switcher"
        aria-label={t('builderBlocks.leftLabel')}
        value={state.tab}
        onChange={(v) => state.setTab(v as LeftTab)}
      >
        <ToggleGroup.Item value="templates">{t('builderBlocks.tabTemplates')}</ToggleGroup.Item>
        <ToggleGroup.Item value="blocks">{t('builderBlocks.tabBlocks')}</ToggleGroup.Item>
        <ToggleGroup.Item value="chat">{t('builderBlocks.tabChat')}</ToggleGroup.Item>
      </ToggleGroup>
      {state.tab === 'chat' ? assistant : null}
      {state.tab === 'blocks' ? (
        <BlocksPanel
          layout={state.layout}
          onChange={state.change}
          {...(variant ? { variant } : {})}
        />
      ) : null}
      {state.tab === 'templates' ? (
        <>
          {state.template ? (
            <Alert data-color="info" data-size="sm" className="blocks-applied">
              {t('builderBlocks.templateApplied', { name: t(templateLabel[state.template]) })}
            </Alert>
          ) : null}
          <TemplatesPanel current={state.template} onPick={state.pick} />
        </>
      ) : null}
    </div>
  );
  const preview = (
    <ServicePreview
      layout={state.layout}
      mode={state.mode}
      device={state.device}
      address={address}
      chat={chat}
      onMode={state.setMode}
      onDevice={state.setDevice}
      onRemove={(id) => state.change(turnOff(state.layout, id))}
      onReload={state.restart}
      onFullscreen={onFullscreen}
    />
  );
  if (narrow)
    return (
      <Tabs value={pane} onChange={(v) => setPane(v as 'blocks' | 'preview')}>
        <TabsList aria-label={t('builderBlocks.sectionLabel')}>
          <TabsTab value="blocks">{t('builderBlocks.paneBlocks')}</TabsTab>
          <TabsTab value="preview">{t('builderBlocks.panePreview')}</TabsTab>
        </TabsList>
        <TabsPanel value="blocks">{pane === 'blocks' ? left : null}</TabsPanel>
        <TabsPanel value="preview">{pane === 'preview' ? preview : null}</TabsPanel>
      </Tabs>
    );
  return (
    <div className="blocks-split" style={{ ['--left-width' as string]: `${state.width}px` }}>
      {left}
      <ResizeHandle
        axis="x"
        value={state.width}
        min={leftMin}
        max={leftMax}
        label={t('builderBlocks.resize')}
        onChange={state.setWidth}
      />
      <div className="blocks-preview">{preview}</div>
    </div>
  );
};

export const BlocksFullscreen = ({
  state,
  chat,
  address,
  backHref,
}: {
  state: BlocksState;
  chat: ReactNode;
  address: string;
  backHref: string;
}) => {
  const t = useT();
  return (
    <div className="blocks-fullscreen">
      <a href={backHref} className="back-link">
        <Icon d="M15 6l-6 6 6 6" size={18} />
        {t('builderBlocks.backToBuilder')}
      </a>
      <ServicePreview
        layout={state.layout}
        mode={state.mode}
        device={state.device}
        address={address}
        chat={chat}
        onMode={state.setMode}
        onDevice={state.setDevice}
        onRemove={(id) => state.change(turnOff(state.layout, id))}
        onReload={state.restart}
        height={state.height}
      />
      <ResizeHandle
        axis="y"
        value={state.height}
        min={fullHeightMin}
        max={fullHeightMax}
        label={t('builderBlocks.resizeHeight')}
        onChange={state.setHeight}
      />
    </div>
  );
};
