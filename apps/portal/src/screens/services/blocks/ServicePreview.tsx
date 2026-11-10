import {
  Button,
  Card,
  Heading,
  Paragraph,
  Spinner,
  ToggleGroup,
} from '@digdir/designsystemet-react';
import { ArrowCirclepathIcon, ExpandIcon, ShrinkIcon, XMarkIcon } from '@navikt/aksel-icons';
import {
  blocksIn,
  blockSpec,
  zones,
  type AssistantLayout,
  type BlockId,
  type Zone,
} from '@genai/ui-blocks/builder';
import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { useT, type PlainKey } from '../../../i18n';
import { blockLabel } from './BlocksPanel';
import { draftServiceOf } from './draftService';
import { previewScale, previewWidth } from './preview-size';
import type { TryRun } from './TryView';

// The assistant and its blocks load when the try view is first shown, not with the builder.
const TryView = lazy(() => import('./TryView'));

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

export const ServicePreview = ({
  layout,
  mode,
  address,
  run,
  conversation,
  onMode,
  onRemove,
  onReload,
  onFullscreen,
  onExitFullscreen,
  height,
}: {
  layout: AssistantLayout;
  mode: PreviewMode;
  address: string;
  /** What the try view runs on; without it the try view has nothing to ask. */
  run: TryRun | undefined;
  /** A new number starts the conversation in the try view again. */
  conversation: number;
  onMode: (mode: PreviewMode) => void;
  onRemove: (id: BlockId) => void;
  onReload: () => void;
  onFullscreen?: () => void;
  onExitFullscreen?: () => void;
  height?: number;
}) => {
  const t = useT();
  const used = zones.filter((zone) => blocksIn(layout, zone).length);
  const [viewport, available] = useAvailableWidth();
  const scale = previewScale(available);
  return (
    <section className="service-preview" aria-labelledby="forhandsvisning-tittel">
      <div className="service-preview-head">
        <Heading level={2} data-size="2xs" id="forhandsvisning-tittel">
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
          onClick={onReload}
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
      <div
        className="service-preview-viewport"
        ref={viewport}
        style={height ? { height: `${height}px` } : undefined}
      >
        <div
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
            <p className="meta service-preview-empty">{t('builderBlocks.nothingPlaced')}</p>
          ) : mode === 'setup' ? (
            used.map((zone) => (
              <SetupPanel key={zone} zone={zone} layout={layout} onRemove={onRemove} />
            ))
          ) : run ? (
            <Suspense
              fallback={
                <Spinner
                  aria-label={t('builderBlocks.tryLoading')}
                  className="service-preview-empty"
                />
              }
            >
              <TryView
                key={`${draftServiceOf(run.source)}:${conversation}`}
                layout={layout}
                run={run}
              />
            </Suspense>
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
  onRemove: (id: BlockId) => void;
}) => {
  const t = useT();
  const ids = blocksIn(layout, zone);
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
                aria-label={t('builderBlocks.removeBlock', { block: t(blockLabel(id)) })}
                onClick={() => onRemove(id)}
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
