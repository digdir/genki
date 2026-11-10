import { datasetsOfDefinition, factsFromDefinition } from '@genai/ui-blocks/builder';
import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../../api';
import { initialSetup } from '../../../data/playground';
import { draftChannels } from './channels';
import { useDatasetFilters } from './datasetFilters';
import { playgroundDefinition } from './draftService';

/** What the playground's first setup can back, so its builder offers what its try view draws. */
export const usePlaygroundFacts = (
  api: ApiClient | undefined,
  tenant: string | undefined,
  name: string,
) => {
  const [definition, setDefinition] = useState<Record<string, unknown>>();
  useEffect(() => {
    if (!api || !tenant) return;
    const controller = new AbortController();
    api.playground.options(tenant, controller.signal).then(
      (options) =>
        !controller.signal.aborted &&
        setDefinition(playgroundDefinition(options, initialSetup(options, 'free'), tenant, name)),
      // Without the options every built block stays offered, as before they are read.
      () => undefined,
    );
    return () => controller.abort();
  }, [api, tenant, name]);
  const filters = useDatasetFilters(api, definition ? datasetsOfDefinition(definition) : []);
  return useMemo(
    () =>
      definition
        ? factsFromDefinition(definition, {
            channels: draftChannels,
            filtersOf: (dataset) => filters[dataset],
          })
        : undefined,
    [definition, filters],
  );
};
