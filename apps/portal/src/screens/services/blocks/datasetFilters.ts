import type { DatasetFilter } from '@genai/ui-blocks/builder';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../../../api';

/** A dataset's own filter fields, as `/api/datasets/{key}` declares them to the person. */
export const loadDatasetFilters = async (
  api: ApiClient,
  dataset: string,
  signal?: AbortSignal,
): Promise<readonly DatasetFilter[]> => {
  const key = dataset.slice(dataset.lastIndexOf('/') + 1);
  const body = (await api.getJson(`/api/datasets/${encodeURIComponent(key)}`, signal)) as {
    dataset?: { filters?: DatasetFilter[] };
  };
  return body.dataset?.filters ?? [];
};

/** The filter fields of each dataset a draft searches, by the id the draft names it with. */
export const useDatasetFilters = (api: ApiClient | undefined, datasets: readonly string[]) => {
  const [found, setFound] = useState<Readonly<Record<string, readonly DatasetFilter[]>>>({});
  const wanted = datasets.join('\n');
  useEffect(() => {
    if (!wanted || !api) return;
    const controller = new AbortController();
    for (const dataset of wanted.split('\n'))
      loadDatasetFilters(api, dataset, controller.signal).then(
        (filters) => setFound((all) => ({ ...all, [dataset]: filters })),
        // A dataset that cannot be read offers no filter fields.
        () => undefined,
      );
    return () => controller.abort();
  }, [api, wanted]);
  return found;
};
