import {
  datasetsOfDefinition,
  factsFromDefinition,
  isBlockId,
  type BlockId,
} from '@genai/ui-blocks/builder';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ApiClient } from '../../../api';
import { BlocksFullscreen, BlocksStep, useBlocksState } from './BlocksStep';
import { draftChannels } from './channels';
import { useDatasetFilters } from './datasetFilters';
import { keepStart, keptStart, type BlocksStart } from './layoutStore';
import { collectionsOf } from './profileEdit';

/**
 * The service page's «Grensesnitt» tab: the building blocks, the templates and the try view, for
 * the service's draft. The layout is kept in this browser for the session, per service.
 */
export const InterfaceTab = ({
  api,
  tenant,
  service,
  definition,
  files,
  narrow,
  fullscreen,
  backHref,
  adding,
  assistant,
  onAdded,
  onFullscreen,
  onExitFullscreen,
}: {
  api: ApiClient;
  tenant: string;
  /** The id the layout is kept under: the service's, or its draft's while it is new. */
  service: string;
  /** The draft as the playground runs it. */
  definition: Record<string, unknown>;
  files: Record<string, string>;
  narrow: boolean;
  /** The preview on its own, larger. */
  fullscreen: boolean;
  backHref: string;
  /** Blocks the builder assistant chose, turned on once per key. */
  adding?: { key: string; blocks: readonly string[] } | undefined;
  assistant?: ReactNode;
  onAdded?: () => void;
  onFullscreen: () => void;
  onExitFullscreen: () => void;
}) => {
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
  const start = useCallback(() => keptStart(tenant, service), [tenant, service]);
  const keep = useCallback(
    (kept: BlocksStart) => keepStart(tenant, service, kept),
    [tenant, service],
  );
  const blocks = useBlocksState(start, facts, keep);
  const added = useRef<string | undefined>(undefined);
  const { add } = blocks;
  useEffect(() => {
    if (!adding || added.current === adding.key) return;
    added.current = adding.key;
    add(adding.blocks.filter((id): id is BlockId => isBlockId(id)));
    onAdded?.();
  }, [adding, add, onAdded]);
  const run = useMemo(
    () => ({ api, tenant, source: { definition, files } }),
    [api, tenant, definition, files],
  );
  const id = (definition.metadata as { id?: unknown } | undefined)?.id;
  const address = `${typeof id === 'string' && id ? id : service}.genki.no`;
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
      run={run}
      address={address}
      onFullscreen={onFullscreen}
    />
  );
};
