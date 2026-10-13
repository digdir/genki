import type { DatasetLocation } from '@genai/definitions';
import { residencies, type Residency } from '@genai/port-model';
import type { CatalogItem, CatalogRegistry } from './catalog-registry.js';
import type { EngineDescription } from './knowledge-engines.js';

export const widest = (...values: (Residency | undefined)[]): Residency =>
  values.reduce<Residency>(
    (acc, r) => (r && residencies.indexOf(r) > residencies.indexOf(acc) ? r : acc),
    'norway',
  );

export interface LocationDeps {
  catalog: Pick<CatalogRegistry, 'get' | 'qualify'>;
  engines(): EngineDescription[];
  embeddingResidency(model: string): Residency | undefined;
}

const isResidency = (value: unknown): value is Residency =>
  residencies.includes(value as Residency);

export const locationOf = (deps: LocationDeps, item: CatalogItem): DatasetLocation => {
  const spec = item.spec as {
    residency?: unknown;
    endpoint?: unknown;
    embedding?: { model?: unknown };
  };
  const endpoint = String(spec.endpoint ?? '');
  const endpointItem =
    deps.catalog.get('knowledge-endpoint', deps.catalog.qualify(item.scope, endpoint)) ??
    deps.catalog.get('knowledge-endpoint', endpoint);
  const engine = deps.engines().find((e) => e.engine === endpointItem?.spec.engine);
  const declared = isResidency(spec.residency) ? spec.residency : 'global';
  const model = typeof spec.embedding?.model === 'string' ? spec.embedding.model : undefined;
  return {
    stored: widest(declared, engine?.dataLocation),
    ...(model ? { embedding: { model, residency: deps.embeddingResidency(model) } } : {}),
  };
};

export const effectiveResidency = (location: DatasetLocation): Residency =>
  widest(
    location.stored,
    location.embedding ? (location.embedding.residency ?? 'global') : undefined,
  );
