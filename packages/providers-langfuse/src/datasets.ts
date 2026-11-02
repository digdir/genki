import type { LangfuseApiOptions } from './judges.js';

/** A Langfuse dataset a test set's runs are linked to; it holds no items (ADR 0040). */
export interface LangfuseDataset {
  id: string;
  name: string;
}

/**
 * The dataset of a test set. Ids only: genki cannot delete a dataset in Langfuse (405), so the
 * name stays there after the test set is gone and must hold nothing personal.
 */
export const datasetName = (service: string, testSet: string) => `genki/${service}/${testSet}`;

/** The stable dataset routes (v2), the same on Langfuse 4.4.0 and 4.72.0. */
export const langfuseDatasets = (api: LangfuseApiOptions) => {
  const send = api.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(`${api.publicKey}:${api.secretKey}`).toString('base64')}`;
  const failed = (status: number, path: string) =>
    new Error(`Langfuse answered HTTP ${status} for ${path}`);

  const named = async (name: string) => {
    const path = `/api/public/v2/datasets/${encodeURIComponent(name)}`;
    const response = await send(new URL(path, api.host), { headers: { authorization } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw failed(response.status, '/api/public/v2/datasets/{name}');
    const found = (await response.json()) as LangfuseDataset;
    return { id: found.id, name: found.name };
  };

  return {
    /**
     * The dataset by its name, created when Langfuse has none. One that exists is never written:
     * a POST upserts by name and would replace what the agency wrote in its description.
     */
    ensure: async (name: string): Promise<LangfuseDataset> => {
      const found = await named(name);
      if (found) return found;
      const path = '/api/public/v2/datasets';
      const response = await send(new URL(path, api.host), {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          description:
            'genki links its test runs of this test set here. The cases stay in genki, so the dataset has no items.',
        }),
      });
      if (!response.ok) throw failed(response.status, path);
      const made = (await response.json()) as LangfuseDataset;
      return { id: made.id, name: made.name };
    },
  };
};
