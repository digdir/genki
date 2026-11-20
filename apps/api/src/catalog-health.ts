import type { CatalogItem, CatalogRegistry } from './catalog-registry.js';

export type SkippedSource =
  string | { kind: string; id: string; problems?: readonly { path?: string; message: string }[] };

export interface SkippedEntry {
  kind: string;
  id: string;
  reasons?: string[];
}

/** Takes the skipped list as `kind id` strings or as `{kind, id, problems}`; drop the strings once both shapes are merged. */
export const skippedEntries = (skipped: readonly SkippedSource[]): SkippedEntry[] =>
  skipped.map((entry) => {
    if (typeof entry !== 'string') {
      const reasons = (entry.problems ?? []).map((p) => p.message);
      return { kind: entry.kind, id: entry.id, ...(reasons.length ? { reasons } : {}) };
    }
    const space = entry.indexOf(' ');
    return { kind: entry.slice(0, space), id: entry.slice(space + 1) };
  });

const tenantId = /^\d{9}\//;

/** What a public route may show: an organisation's own entry is named by its kind only. */
export const publicSkipped = (entries: readonly SkippedEntry[]) =>
  entries.map(({ kind, id }) => (tenantId.test(id) ? { kind } : { kind, id }));

export interface EndpointEngine {
  engine?: string;
  engineTitle?: string;
}

export interface DatasetEffective extends EndpointEngine {
  endpoint: string;
  generation?: string;
  version: number;
  fromSeed: boolean;
  expected?: EndpointEngine & {
    endpoint: string;
    generation?: string;
    version: number;
    at: string;
  };
}

export interface EffectiveDeps {
  catalog: Pick<CatalogRegistry, 'history' | 'skipped'>;
  engineOf(scope: string, endpoint: string): EndpointEngine;
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** The engine and generation a dataset runs on, and the stored version replay skipped, if any. */
export const datasetEffective = async (
  deps: EffectiveDeps,
  item: CatalogItem,
): Promise<DatasetEffective> => {
  const endpoint = String(item.spec.endpoint ?? '');
  const generation = text(item.spec.generation);
  const skipped = skippedEntries(deps.catalog.skipped()).some(
    (s) => s.kind === 'dataset' && s.id === item.id,
  );
  const newest = skipped ? (await deps.catalog.history('dataset', item.id)).at(-1) : undefined;
  const stored = newest && !newest.deleted ? (newest.spec as Record<string, unknown>) : undefined;
  const storedEndpoint = String(stored?.endpoint ?? '');
  const storedGeneration = text(stored?.generation);
  return {
    endpoint,
    ...deps.engineOf(item.scope, endpoint),
    ...(generation ? { generation } : {}),
    version: item.version,
    fromSeed: item.origin === 'seed',
    ...(newest && stored
      ? {
          expected: {
            endpoint: storedEndpoint,
            ...deps.engineOf(item.scope, storedEndpoint),
            ...(storedGeneration ? { generation: storedGeneration } : {}),
            version: newest.version,
            at: newest.at,
          },
        }
      : {}),
  };
};
