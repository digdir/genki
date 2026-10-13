import type { ModelDescription } from '@genai/port-model';
import type { CatalogRegistry } from './catalog-registry.js';
import { platformScope } from './config-store.js';

export const candidateRelease = 'candidate';

export const isCandidate = (catalog: Pick<CatalogRegistry, 'get'>, model: string) => {
  const item = catalog.get('model', model);
  return item?.scope === platformScope && item.spec.release === candidateRelease;
};

export const ownedElsewhere = (
  catalog: Pick<CatalogRegistry, 'get'>,
  model: string,
  tenant: string,
) => {
  const item = catalog.get('model', model);
  const tenants = item?.spec.tenants;
  if (isCandidate(catalog, model)) return true;
  if (item && item.scope !== platformScope && item.scope !== tenant) return true;
  if (Array.isArray(tenants) && !tenants.includes(tenant)) return true;
  const owner = /^(\d{9})\//.exec(model)?.[1];
  return owner !== undefined && owner !== tenant;
};

export const modelsForTenant = (
  deps: { catalog: Pick<CatalogRegistry, 'get'>; models: { describe(): ModelDescription[] } },
  tenant: string,
): ModelDescription[] =>
  deps.models.describe().filter((m) => m.enabled && !ownedElsewhere(deps.catalog, m.id, tenant));

export const modelDisplayNames = (
  models: Pick<ModelDescription, 'id' | 'family' | 'deployment'>[],
): Map<string, string> => {
  const base = (m: Pick<ModelDescription, 'id' | 'family'>) => m.family ?? m.id;
  const groups = Map.groupBy(models, base);
  return new Map(
    models.map((m) => {
      const group = groups.get(base(m)) ?? [];
      if (group.length < 2) return [m.id, base(m)];
      const unique = group.filter((o) => o.deployment === m.deployment).length === 1;
      return [m.id, `${base(m)} (${unique ? m.deployment : m.id})`];
    }),
  );
};
