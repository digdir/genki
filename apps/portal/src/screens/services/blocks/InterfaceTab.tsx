import { datasetsOfDefinition, factsFromDefinition } from '@genai/ui-blocks/builder';
import { useCallback, useMemo } from 'react';
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
  const run = { api, tenant, source: { definition, files } };
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
      collections={collections}
      run={run}
      address={address}
      onFullscreen={onFullscreen}
    />
  );
};
