import { credentialFor, type SecretResolver, type TokenProviders } from '@genai/kernel';
import type {
  DatasetConfig,
  DatasetEmbedding,
  KnowledgeAdapter,
  LocalEndpointConfig,
} from './adapter.js';
import type { CatalogDataset, CatalogKnowledgeEndpoint, KnowledgeCatalog } from './catalog.js';
import { KnowledgeError } from './port.js';

export const endpointConfig = (
  endpoint: CatalogKnowledgeEndpoint,
  options: unknown,
  credentials: { secrets: SecretResolver; tokenProviders?: TokenProviders | undefined },
  timeoutMs: number,
): LocalEndpointConfig => ({
  ...(endpoint.baseURL ? { baseURL: endpoint.baseURL } : {}),
  ...(endpoint.auth
    ? { credential: credentialFor(endpoint.auth, credentials.secrets, credentials.tokenProviders) }
    : {}),
  options,
  timeoutMs,
});

export const datasetConfig = (dataset: CatalogDataset, options: unknown): DatasetConfig => ({
  id: dataset.id,
  filters: dataset.filters,
  options,
  ...(dataset.embedding ? { embedding: dataset.embedding } : {}),
});

export const aliasesOf = (catalog: KnowledgeCatalog) => {
  const aliases = new Map<string, string>();
  for (const dataset of catalog.datasets)
    for (const alias of dataset.aliases) aliases.set(alias, dataset.id);
  return aliases;
};

export interface DatasetOverrides {
  endpointOptions?: Record<string, unknown>;
  datasetOptions?: Record<string, unknown>;
  embedding?: DatasetEmbedding;
}

export interface Relocated {
  dataset: CatalogDataset;
  endpoint: CatalogKnowledgeEndpoint;
  adapter: KnowledgeAdapter;
  endpointOptions: unknown;
  datasetOptions: unknown;
}

const issues = (what: string, error: { issues: { path: PropertyKey[]; message: string }[] }) =>
  new KnowledgeError(
    'bad_request',
    `invalid ${what}: ${error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ')}`,
  );

/** The dataset as if it lived on another catalog endpoint; the catalog itself is unchanged. */
export const relocate = (
  dataset: CatalogDataset,
  endpointId: string,
  catalog: KnowledgeCatalog,
  adapters: KnowledgeAdapter[],
  overrides: DatasetOverrides = {},
): Relocated => {
  const found = catalog.endpoints[endpointId];
  if (!found) throw new KnowledgeError('bad_request', `no endpoint ${endpointId} in the catalog`);
  const adapter = adapters.find((a) => a.engine === found.engine);
  if (!adapter) throw new KnowledgeError('unsupported', `no adapter for engine ${found.engine}`);
  const sameEngine = catalog.endpoints[dataset.endpoint]?.engine === found.engine;
  const embedding = overrides.embedding ?? dataset.embedding;
  const given = overrides.datasetOptions ?? (sameEngine ? dataset.options : {});
  const options = {
    ...given,
    ...(adapter.defaults?.({
      filters: dataset.filters,
      options: given,
      ...(embedding ? { embedding } : {}),
    }) ?? {}),
  };
  const datasetOptions = adapter.datasetOptions.safeParse(options);
  if (!datasetOptions.success) throw issues('dataset options', datasetOptions.error);
  const endpoint = overrides.endpointOptions
    ? { ...found, options: { ...found.options, ...overrides.endpointOptions } }
    : found;
  const endpointOptions = adapter.endpointOptions.safeParse(endpoint.options);
  if (!endpointOptions.success) throw issues('endpoint options', endpointOptions.error);
  return {
    dataset: { ...dataset, endpoint: endpointId, options, ...(embedding ? { embedding } : {}) },
    endpoint,
    adapter,
    endpointOptions: endpointOptions.data,
    datasetOptions: datasetOptions.data,
  };
};
