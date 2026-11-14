import {
  Alert,
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
import { lazy, Suspense, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { useT, type PlainKey } from '../../../i18n';
import { blockLabel } from './BlocksPanel';
import { draftServiceOf, type RunProblem } from './draftService';
import { previewScale, previewWidth } from './preview-size';
import { describeProblem } from '../../service/publish';
import type { ReportProblem, TryRun } from './TryView';

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
  const titleId = useId();
  // A refusal is the draft's, over every thread; a failed answer only over its own thread.
  const [refusal, setRefusal] = useState<RunProblem>();
  const [failures, setFailures] = useState<ReadonlyMap<string, RunProblem>>(() => new Map());
  const [thread, setThread] = useState<string>();
  const report = useCallback<ReportProblem>((next, at) => {
    if (at === undefined) {
      setRefusal(next);
      return;
    }
    setFailures((all) => {
      if (!next && !all.has(at)) return all;
      const kept = new Map(all);
      if (next) kept.set(at, next);
      else kept.delete(at);
      return kept;
    });
  }, []);
  const problem = refusal ?? (thread === undefined ? undefined : failures.get(thread));
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
              : [problem.title, problem.detail].filter(Boolean).join(' ')}
          </Paragraph>
        </Alert>
      ) : null}
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
                onProblem={report}
                onThreadChange={setThread}
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
