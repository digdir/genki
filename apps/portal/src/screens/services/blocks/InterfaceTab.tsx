import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import {
  datasetsOfDefinition,
  factsFromDefinition,
  isBlockId,
  type AssistantLayout,
  type BlockId,
  type ServiceFacts,
} from '@genai/ui-blocks/builder';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../../api';
import { useT } from '../../../i18n';
import { BlocksFullscreen, BlocksStep, useBlocksState } from './BlocksStep';
import { draftChannels } from './channels';
import { useDatasetFilters } from './datasetFilters';
import {
  draftLayoutOf,
  draftStart,
  forgetKept,
  keptStart,
  storedLayout,
  type BlocksStart,
  type PinnedRef,
} from './layoutStore';
import type { PinnedDraft } from '../../../api/design';
import { FromLibrary, usePinnedBlocks, type PinActions } from './FromDesign';
import { useFlag, useFlags } from '../../../flags';
import { collectionsOf, type Collection } from './profileEdit';
import type { TryRun } from './TryView';

/**
 * The service page's «Grensesnitt» tab: the building blocks, the templates and the try view, for
 * the service's draft, which keeps the layout in `spec.interface`.
 */
export const InterfaceTab = ({
  api,
  tenant,
  service,
  definition,
  files,
  narrow,
  onLayout,
  fullscreen,
  backHref,
  adding,
  assistant,
  onAdded,
  onFullscreen,
  onExitFullscreen,
  simple = false,
  pins,
}: {
  api: ApiClient;
  tenant: string;
  /** The id the layout is kept under: the service's, or its draft's while it is new. */
  service: string;
  /** The draft as the playground runs it. */
  definition: Record<string, unknown>;
  files: Record<string, string>;
  narrow: boolean;
  /** Writes a layout into the draft; without it the builder changes nothing that is kept. */
  onLayout?: ((layout: AssistantLayout) => void) | undefined;
  /** Only Maler and Designelementer, as in the new Oppsett. */
  simple?: boolean;
  /** The preview on its own, larger. */
  fullscreen: boolean;
  backHref: string;
  /** Blocks the builder assistant chose, turned on once per key. */
  adding?: { key: string; blocks: readonly string[] } | undefined;
  assistant?: ReactNode;
  onAdded?: () => void;
  onFullscreen: () => void;
  onExitFullscreen: () => void;
  pins?: PinActions | undefined;
}) => {
  const studio = useFlag('blockStudio');
  const flagsReady = useFlags().ready;
  const datasets = useMemo(() => datasetsOfDefinition(definition), [definition]);
  const datasetFilters = useDatasetFilters(api, datasets);
  const collections = useMemo(
    () => collectionsOf(datasets, (dataset) => datasetFilters[dataset]),
    [datasets, datasetFilters],
  );
  const facts = useMemo(
    () =>
      factsFromDefinition(definition, {
        channels: draftChannels,
        filtersOf: (dataset) => datasetFilters[dataset],
      }),
    [definition, datasetFilters],
  );
  const stored = draftLayoutOf(definition);
  const storedJson = JSON.stringify(stored ?? null);
  const start = draftStart(stored, studio);
  const pinned = useMemo<readonly PinnedRef[]>(() => {
    const found = draftStart(JSON.parse(storedJson) ?? undefined, studio);
    return found && found !== 'foreign' ? (found.pinned ?? []) : [];
  }, [storedJson, studio]);
  const refBlocks = usePinnedBlocks(api, tenant, pinned);
  const run = useMemo(
    () => ({ api, tenant, source: { definition, files }, pinned, refBlocks }),
    [api, tenant, definition, files, pinned, refBlocks],
  );
  const id = (definition.metadata as { id?: unknown } | undefined)?.id;
  const address = `${typeof id === 'string' && id ? id : service}.genki.no`;

  const written = useRef(storedJson);
  const [generation, setGeneration] = useState(0);
  // A layout changed elsewhere, by another tab, person or the YAML, starts the builder again.
  useEffect(() => {
    if (storedJson === written.current) return;
    written.current = storedJson;
    setGeneration((g) => g + 1);
  }, [storedJson]);
  const [offer, setOffer] = useState(() =>
    onLayout && stored === undefined ? keptStart(tenant, service) : undefined,
  );
  const write = useCallback(
    (layout: AssistantLayout) => {
      if (!onLayout) return;
      written.current = JSON.stringify(layout);
      onLayout(layout);
      if (offer) {
        forgetKept(tenant, service);
        setOffer(undefined);
      }
    },
    [onLayout, offer, tenant, service],
  );
  const shown = useRef<AssistantLayout | undefined>(undefined);
  if (start === 'foreign') return flagsReady ? <ForeignLayout /> : null;
  const actions =
    studio && pins
      ? {
          ...pins,
          beforePin: () => {
            const first = stored === undefined ? shown.current : undefined;
            if (first) written.current = JSON.stringify(first);
            return pins.beforePin(first);
          },
          onPinned: (draft: PinnedDraft, isPinned: boolean) => {
            written.current = JSON.stringify(draftLayoutOf(draft.definition) ?? null);
            pins.onPinned(draft, isPinned);
          },
        }
      : undefined;
  const builder = (
    <InterfaceBuilder
      key={generation}
      start={start ?? offer}
      facts={facts}
      write={write}
      adding={adding}
      onAdded={onAdded}
      fullscreen={fullscreen}
      narrow={narrow}
      assistant={simple ? undefined : assistant}
      collections={simple ? undefined : collections}
      transfer={!simple}
      run={run}
      address={address}
      backHref={backHref}
      onFullscreen={onFullscreen}
      onExitFullscreen={onExitFullscreen}
      shown={shown}
      pinned={pinned}
      refs={
        actions ? (
          <FromLibrary
            api={api}
            tenant={tenant}
            service={service}
            pinned={pinned}
            actions={actions}
          />
        ) : undefined
      }
    />
  );
  return (
    <>
      {offer && !fullscreen ? (
        <KeptOffer
          onSave={() => write(storedLayout(offer))}
          onDiscard={() => {
            forgetKept(tenant, service);
            setOffer(undefined);
            setGeneration((g) => g + 1);
          }}
        />
      ) : null}
      {builder}
    </>
  );
};

const ForeignLayout = () => {
  const t = useT();
  return (
    <Alert data-color="info" data-size="sm">
      <Heading level={2} data-size="2xs">
        {t('builderBlocks.foreignTitle')}
      </Heading>
      <Paragraph data-size="sm">{t('builderBlocks.foreignText')}</Paragraph>
    </Alert>
  );
};

const KeptOffer = ({ onSave, onDiscard }: { onSave: () => void; onDiscard: () => void }) => {
  const t = useT();
  return (
    <Alert data-color="warning" data-size="sm">
      <Heading level={2} data-size="2xs">
        {t('builderBlocks.keptTitle')}
      </Heading>
      <Paragraph data-size="sm">{t('builderBlocks.keptText')}</Paragraph>
      <div className="blocks-transfer-actions">
        <Button data-size="sm" onClick={onSave}>
          {t('builderBlocks.keptSave')}
        </Button>
        <Button variant="tertiary" data-size="sm" onClick={onDiscard}>
          {t('builderBlocks.keptDiscard')}
        </Button>
      </div>
    </Alert>
  );
};

const InterfaceBuilder = ({
  start,
  facts,
  write,
  adding,
  onAdded,
  fullscreen,
  narrow,
  assistant,
  collections,
  transfer,
  run,
  address,
  backHref,
  onFullscreen,
  onExitFullscreen,
  shown,
  pinned,
  refs,
}: {
  start: BlocksStart | undefined;
  facts: ServiceFacts | undefined;
  write: (layout: AssistantLayout) => void;
  adding?: { key: string; blocks: readonly string[] } | undefined;
  onAdded?: (() => void) | undefined;
  fullscreen: boolean;
  narrow: boolean;
  assistant?: ReactNode;
  collections: Collection[] | undefined;
  transfer: boolean;
  run: TryRun;
  address: string;
  backHref: string;
  onFullscreen: () => void;
  onExitFullscreen: () => void;
  shown: { current: AssistantLayout | undefined };
  pinned: readonly PinnedRef[];
  refs?: ReactNode;
}) => {
  const [first] = useState(start);
  const pins = useRef(pinned);
  pins.current = pinned;
  const begin = useCallback(() => first, [first]);
  const kept = useRef<string | undefined>(undefined);
  // The layout the builder opened with is not a change; only what the person does is written.
  const keep = useCallback(
    (next: BlocksStart) => {
      const layout = storedLayout({ ...next, pinned: pins.current });
      shown.current = layout;
      const json = JSON.stringify(layout);
      const opened = kept.current === undefined;
      if (json === kept.current) return;
      kept.current = json;
      if (!opened) write(layout);
    },
    [write, shown],
  );
  const blocks = useBlocksState(begin, facts, keep);
  const added = useRef<string | undefined>(undefined);
  const { add } = blocks;
  useEffect(() => {
    if (!adding || added.current === adding.key) return;
    added.current = adding.key;
    add(adding.blocks.filter((id): id is BlockId => isBlockId(id)));
    onAdded?.();
  }, [adding, add, onAdded]);
  return fullscreen ? (
    <BlocksFullscreen
      state={blocks}
      run={run}
      address={address}
      backHref={backHref}
      onExit={onExitFullscreen}
    />
  ) : (
    <BlocksStep
      state={blocks}
      narrow={narrow}
      assistant={assistant}
      collections={collections}
      transfer={transfer}
      run={run}
      address={address}
      onFullscreen={onFullscreen}
      refs={refs}
    />
  );
};
