import { Tabs, TabsList, TabsPanel, TabsTab, ToggleGroup } from '@digdir/designsystemet-react';
import {
  blockIds,
  fitService,
  fromTemplate,
  offerOf,
  turnOn,
  withProfile,
  type AssistantLayout,
  type BlockId,
  type BuilderState,
  type ProfileData,
  type ServiceFacts,
  type TemplateId,
} from '@genai/ui-blocks/builder';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useT } from '../../../i18n';
import { BlocksPanel, takeOut } from './BlocksPanel';
import { LayoutTransfer } from './LayoutTransfer';
import { startTemplate, type BlocksStart } from './layoutStore';
import { ServicePreview, type PreviewMode } from './ServicePreview';
import type { Collection } from './profileEdit';
import { TemplatesPanel } from './TemplatesPanel';
import { TextsPanel } from './TextsPanel';
import type { TryRun } from './TryView';
import './blocks.css';
import { BackLink } from '../../../components/BackLink';

type LeftTab = 'chat' | 'blocks' | 'templates' | 'texts';

const leftMin = 320;
const leftMax = 640;
const fullHeightMin = 480;
const fullHeightMax = 1400;

/**
 * The builder's blocks, and the facts of the draft they are for when it has any. Without a kept
 * start it starts from {@link startTemplate}; `keep` is told each layout the person makes.
 */
export const useBlocksState = (
  start?: () => BlocksStart | undefined,
  facts?: ServiceFacts | undefined,
  keep?: (start: BlocksStart) => void,
) => {
  const [first] = useState(() => start?.());
  const [state, setState] = useState<BuilderState>(() =>
    first
      ? { layout: first.layout, chosen: {}, ...(first.held ? { held: first.held } : {}) }
      : fromTemplate(startTemplate),
  );
  const [template, setTemplate] = useState<TemplateId | undefined>(() =>
    first ? first.template : startTemplate,
  );
  // The blocks the draft cannot back yet are kept too, so they come back after a reload.
  useEffect(() => {
    keep?.({
      layout: state.layout,
      ...(template ? { template } : {}),
      ...(state.held?.length ? { held: state.held } : {}),
    });
  }, [keep, state.layout, state.held, template]);
  const [mode, setMode] = useState<PreviewMode>('try');
  const [tab, setTab] = useState<LeftTab>('blocks');
  const [width, setWidth] = useState(380);
  const [height, setHeight] = useState(720);
  const offered = (id: (typeof blockIds)[number]) => offerOf(id, facts).offered;
  // A block the draft can no longer back is held, and comes back where it stood once it can.
  const offeredKey = facts ? blockIds.filter(offered).join(',') : undefined;
  useEffect(() => {
    if (offeredKey === undefined) return;
    const backed = new Set(offeredKey.split(','));
    setState((s) => fitService(s, (id) => backed.has(id)).state);
  }, [offeredKey]);
  return {
    state,
    layout: state.layout,
    facts,
    template,
    mode,
    tab,
    width,
    height,
    setMode,
    setTab,
    setWidth,
    setHeight,
    change: (next: BuilderState) => {
      setState(next);
      setTemplate(undefined);
    },
    // Blocks the draft cannot back yet are held, and come in once it can. The words stay: they are
    // the service's, not the template's.
    pick: (id: TemplateId) => {
      setState((s) => fitService(withProfile(fromTemplate(id), s.layout.profile), offered).state);
      setTemplate(id);
    },
    // A pasted layout replaces this one, and its blocks the draft cannot back are held.
    paste: (layout: AssistantLayout) => {
      setState(fitService({ layout, chosen: {} }, offered).state);
      setTemplate(undefined);
    },
    add: (ids: readonly BlockId[]) => {
      setState((s) => fitService(ids.reduce(turnOn, s), offered).state);
      setTemplate(undefined);
    },
    // The words are the service's, not a template's: the template stays chosen.
    setProfile: (profile: ProfileData | undefined) => setState((s) => withProfile(s, profile)),
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
  /** Where the drag began, and the size then; undefined when nothing is being dragged. */
  const [drag, setDrag] = useState<{ from: number; size: number }>();
  const at = (e: PointerEvent<HTMLDivElement>) => (axis === 'x' ? e.clientX : e.clientY);
  const start = (e: PointerEvent<HTMLDivElement>) => {
    // The main button, a touch or a pen; a right click is a menu, not a drag.
    if (e.button !== 0) return;
    // No text selection, so focus is moved here by hand for the arrow keys.
    e.preventDefault();
    e.currentTarget.focus();
    // Every move and the release come here until the pointer is let go, wherever it is then.
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: at(e), size: value });
  };
  const stop = () => setDrag(undefined);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    // No button is down: the release happened where the page could not see it.
    if (e.buttons === 0) return stop();
    onChange(clamp(drag.size + at(e) - drag.from));
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
      data-dragging={drag ? '' : undefined}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={key}
    />
  );
};

export const BlocksStep = ({
  state,
  narrow,
  assistant,
  collections,
  transfer = true,
  run,
  address,
  onFullscreen,
}: {
  state: BlocksState;
  narrow: boolean;
  /** The builder assistant. Without it there is no Chat tab. */
  assistant?: ReactNode;
  /** «Kopier oppsettet» and «Lim inn oppsett» under the panels; off where they live elsewhere. */
  transfer?: boolean;
  /** The collections the draft searches, whose words «Tekster» edits. Without it, no such tab. */
  collections?: readonly Collection[] | undefined;
  run: TryRun | undefined;
  address: string;
  onFullscreen: () => void;
}) => {
  const t = useT();
  const [pane, setPane] = useState<'blocks' | 'preview'>('blocks');
  const switcher = useRef<HTMLFieldSetElement>(null);
  const [fit, setFit] = useState(leftMin);
  // Measured beside the preview only: on a narrow screen the switcher wraps.
  useLayoutEffect(() => {
    if (narrow) return;
    const w = switcher.current?.offsetWidth;
    if (w) setFit(Math.max(leftMin, Math.ceil(w)));
  }, [t, narrow]);
  const width = Math.max(state.width, fit);
  const left = (
    <div className="blocks-left" data-narrow={narrow || undefined}>
      <ToggleGroup
        ref={switcher}
        data-size="sm"
        variant="secondary"
        className="blocks-switcher"
        aria-label={t('builderBlocks.leftLabel')}
        value={state.tab}
        onChange={(v) => state.setTab(v as LeftTab)}
      >
        <ToggleGroup.Item value="templates">{t('builderBlocks.tabTemplates')}</ToggleGroup.Item>
        <ToggleGroup.Item value="blocks">{t('builderBlocks.tabBlocks')}</ToggleGroup.Item>
        {collections ? (
          <ToggleGroup.Item value="texts">{t('builderBlocks.tabTexts')}</ToggleGroup.Item>
        ) : null}
        {assistant ? (
          <ToggleGroup.Item value="chat">{t('builderBlocks.tabChat')}</ToggleGroup.Item>
        ) : null}
      </ToggleGroup>
      {state.tab === 'chat' ? assistant : null}
      {state.tab === 'blocks' ? (
        <BlocksPanel state={state.state} facts={state.facts} onChange={state.change} />
      ) : null}
      {state.tab === 'templates' ? (
        <TemplatesPanel current={state.template} onPick={state.pick} />
      ) : null}
      {state.tab === 'texts' && collections ? (
        <TextsPanel layout={state.layout} collections={collections} onChange={state.setProfile} />
      ) : null}
      {state.tab === 'chat' || !transfer ? null : (
        <LayoutTransfer layout={state.layout} onPaste={state.paste} />
      )}
    </div>
  );
  const preview = (
    <ServicePreview
      layout={state.layout}
      mode={state.mode}
      address={address}
      run={run}
      onMode={state.setMode}
      onRemove={(id, zone) => state.change(takeOut(state.state, id, zone))}
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
    <div className="blocks-split" style={{ ['--left-width' as string]: `${width}px` }}>
      {left}
      <ResizeHandle
        axis="x"
        value={width}
        min={fit}
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
  run,
  address,
  backHref,
  onExit,
}: {
  state: BlocksState;
  run: TryRun | undefined;
  address: string;
  backHref: string;
  onExit: () => void;
}) => {
  const t = useT();
  return (
    <div className="blocks-fullscreen">
      <BackLink label={t('builderBlocks.backToBuilder')} href={backHref} />
      <ServicePreview
        layout={state.layout}
        mode={state.mode}
        address={address}
        run={run}
        onMode={state.setMode}
        onRemove={(id, zone) => state.change(takeOut(state.state, id, zone))}
        onExitFullscreen={onExit}
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
