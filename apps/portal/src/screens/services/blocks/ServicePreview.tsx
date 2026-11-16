import { Alert, Button, Card, Heading, Paragraph, ToggleGroup } from '@digdir/designsystemet-react';
import { ArrowCirclepathIcon, ExpandIcon, ShrinkIcon, XMarkIcon } from '@navikt/aksel-icons';
import {
  blocksIn,
  blockSpec,
  zones,
  zonesOf,
  type AssistantLayout,
  type BlockId,
  type Zone,
} from '@genai/ui-blocks/builder';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { useT, type PlainKey } from '../../../i18n';
import { blockLabel } from './BlocksPanel';
import { previewScale, previewWidth } from './preview-size';
import { describeProblem } from '../../service/publish';
import type { TryRun } from './TryView';
import { KeepTryView, useKeptTryView } from './TryViewKeeper';

export type PreviewMode = 'setup' | 'try';

const controlIcons = {
  reload: ArrowCirclepathIcon,
  expand: ExpandIcon,
  collapse: ShrinkIcon,
};

/** The width the frame has to draw on, measured as it changes. */
const useAvailableWidth = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
};

const frameLabel: Record<Zone, PlainKey> = {
  primary: 'builderBlocks.frameLeft',
  main: 'builderBlocks.frameMain',
  secondary: 'builderBlocks.frameRight',
};

const stops = new Set(['.', '!', '?', ':', '…']);

/** A problem's title and detail as one text, with a colon after a title that has no stop. */
const titled = (title: string, detail: string | undefined) => {
  const head = title.trimEnd();
  if (!detail) return title;
  return head ? `${head}${stops.has(head.slice(-1)) ? '' : ':'} ${detail}` : detail;
};

const removeButtons = '.preview-card button';

interface ServicePreviewProps {
  layout: AssistantLayout;
  mode: PreviewMode;
  address: string;
  /** What the try view runs on; without it the try view has nothing to ask. */
  run: TryRun | undefined;
  onMode: (mode: PreviewMode) => void;
  onRemove: (id: BlockId, zone: Zone) => void;
  onFullscreen?: () => void;
  onExitFullscreen?: () => void;
  height?: number;
}

/** The service's blocks, or its assistant as the nearest `TryViewKeeper` keeps it. */
export const ServicePreview = (props: ServicePreviewProps) => (
  <KeepTryView>
    <Preview {...props} />
  </KeepTryView>
);

const Preview = ({
  layout,
  mode,
  address,
  run,
  onMode,
  onRemove,
  onFullscreen,
  onExitFullscreen,
  height,
}: ServicePreviewProps) => {
  const t = useT();
  const titleId = useId();
  const { place, show, restart, problem } = useKeptTryView();
  // The try view follows the layout and the draft, on screen or not.
  useLayoutEffect(() => {
    show(run ? { layout, run } : undefined);
  }, [show, layout, run]);
  // After a remove, the focus goes to the next «Fjern», else the previous, else the frame's text.
  const frame = useRef<HTMLDivElement>(null);
  const [refocus, setRefocus] = useState<number>();
  useLayoutEffect(() => {
    if (refocus === undefined) return;
    setRefocus(undefined);
    const buttons = frame.current?.querySelectorAll<HTMLElement>(removeButtons) ?? [];
    const next = buttons[Math.min(refocus, buttons.length - 1)];
    (next ?? frame.current?.querySelector<HTMLElement>('.service-preview-empty'))?.focus();
  }, [refocus]);
  const remove = (id: BlockId, zone: Zone, button: HTMLElement) => {
    setRefocus([...(frame.current?.querySelectorAll(removeButtons) ?? [])].indexOf(button));
    onRemove(id, zone);
  };
  const used = zones.filter((zone) => blocksIn(layout, zone).length);
  const [viewport, available] = useAvailableWidth();
  const scale = previewScale(available);
  return (
    <section className="service-preview" aria-labelledby={titleId}>
      <div className="service-preview-head">
        <Heading level={2} data-size="2xs" id={titleId}>
          {t('builderBlocks.previewTitle')}
        </Heading>
        <ToggleGroup
          data-size="sm"
          variant="secondary"
          aria-label={t('builderBlocks.previewView')}
          value={mode}
          onChange={(v) => onMode(v as PreviewMode)}
        >
          <ToggleGroup.Item value="try">{t('builderBlocks.viewTry')}</ToggleGroup.Item>
          <ToggleGroup.Item value="setup">{t('builderBlocks.viewSetup')}</ToggleGroup.Item>
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
          onClick={restart}
        >
          <Icon icon={controlIcons.reload} />
        </Button>
        <span className="service-preview-address">{address}</span>
        {onFullscreen ? (
          <Button
            variant="tertiary"
            data-size="sm"
            icon
            aria-label={t('builderBlocks.fullscreen')}
            onClick={onFullscreen}
          >
            <Icon icon={controlIcons.expand} />
          </Button>
        ) : null}
        {onExitFullscreen ? (
          <Button
            variant="tertiary"
            data-size="sm"
            icon
            aria-label={t('builderBlocks.exitFullscreen')}
            onClick={onExitFullscreen}
          >
            <Icon icon={controlIcons.collapse} />
          </Button>
        ) : null}
      </div>
      {mode === 'try' && problem ? (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">
            {problem.errors.length > 0
              ? t('builderBlocks.tryNotReady', {
                  problems: problem.errors
                    .map((e) => describeProblem({ ...e, path: e.path.replace(/^setup\./, '') }, t))
                    .map((p) => `${p.section}: ${p.message}`)
                    .join(' '),
                  notStored: t('playground.notStored'),
                })
              : titled(problem.title, problem.detail)}
          </Paragraph>
        </Alert>
      ) : null}
      <div
        className="service-preview-viewport"
        ref={viewport}
        style={height ? { height: `${height}px` } : undefined}
      >
        <div
          ref={frame}
          className="service-preview-frame"
          data-mode={mode}
          style={{
            width: `${previewWidth}px`,
            zoom: scale,
            ['--preview-scale' as string]: scale,
            ...(height ? { height: `${height / scale}px` } : {}),
          }}
        >
          {used.length === 0 ? (
            <p className="meta service-preview-empty" tabIndex={-1}>
              {t('builderBlocks.nothingPlaced')}
            </p>
          ) : mode === 'setup' ? (
            used.map((zone) => (
              <SetupPanel key={zone} zone={zone} layout={layout} onRemove={remove} />
            ))
          ) : run ? (
            <div className="service-preview-slot" ref={place} />
          ) : null}
        </div>
      </div>
    </section>
  );
};

const SetupPanel = ({
  zone,
  layout,
  onRemove,
}: {
  zone: Zone;
  layout: AssistantLayout;
  onRemove: (id: BlockId, zone: Zone, button: HTMLElement) => void;
}) => {
  const t = useT();
  const ids = blocksIn(layout, zone);
  // A block in two panels has a «Fjern» in each, named by its panel.
  const removeLabel = (id: BlockId) =>
    zonesOf(layout, id).length > 1
      ? t('builderBlocks.removeBlockFrom', {
          block: t(blockLabel(id)),
          panel: t(frameLabel[zone]).toLocaleLowerCase(),
        })
      : t('builderBlocks.removeBlock', { block: t(blockLabel(id)) });
  return (
    <div className="preview-panel" data-zone={zone}>
      <span className="preview-panel-name">{t(frameLabel[zone])}</span>
      <ul className="preview-cards">
        {ids.map((id) => (
          <Card
            asChild
            variant="tinted"
            key={id}
            data-size="sm"
            className="preview-card"
            data-block={id}
            data-bottom={blockSpec(id).slot === 'foot'}
          >
            <li>
              <span className="preview-card-name">{t(blockLabel(id))}</span>
              <Button
                variant="tertiary"
                data-size="sm"
                icon
                aria-label={removeLabel(id)}
                onClick={(e) => onRemove(id, zone, e.currentTarget)}
              >
                <Icon icon={XMarkIcon} size={16} />
              </Button>
            </li>
          </Card>
        ))}
      </ul>
    </div>
  );
};
