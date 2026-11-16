import type { Principal } from '@genai/contracts';
import { INTERNAL_GRANT_PREFIX } from '@genai/identity';
import { servesModelPort, type ModelDescription } from '@genai/port-model';
import type { CatalogRegistry } from './catalog-registry.js';
import { platformScope } from './config-store.js';

export const candidateRelease = 'candidate';

export const isCandidate = (catalog: Pick<CatalogRegistry, 'get'>, model: string) => {
  const item = catalog.get('model', model);
  return item?.scope === platformScope && item.spec.release === candidateRelease;
};

export const candidateTrialScope = `${INTERNAL_GRANT_PREFIX}candidate-trial`;

export const triesCandidates = (principal: Principal) =>
  !principal.confinedTo && (principal.scopes?.includes(candidateTrialScope) ?? false);

export const withCandidateTrial = (principal: Principal): Principal =>
  triesCandidates(principal)
    ? principal
    : { ...principal, scopes: [...(principal.scopes ?? []), candidateTrialScope] };

const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

export const candidatesIn = (catalog: Pick<CatalogRegistry, 'get'>, definition: unknown) => {
  const spec = objectOf(objectOf(definition).spec);
  const model = objectOf(spec.model);
  const variants = Array.isArray(spec.variants) ? spec.variants : [];
  return [
    model.primary,
    model.fallback,
    ...Object.values(objectOf(model.roles)),
    ...variants.map((v) => objectOf(v).model),
  ].filter((m): m is string => typeof m === 'string' && isCandidate(catalog, m));
};

const belongsElsewhere = (catalog: Pick<CatalogRegistry, 'get'>, model: string, tenant: string) => {
  const item = catalog.get('model', model);
  const tenants = item?.spec.tenants;
  if (item && item.scope !== platformScope && item.scope !== tenant) return true;
  if (Array.isArray(tenants) && !tenants.includes(tenant)) return true;
  const owner = /^(\d{9})\//.exec(model)?.[1];
  return owner !== undefined && owner !== tenant;
};

export const ownedElsewhere = (
  catalog: Pick<CatalogRegistry, 'get'>,
  model: string,
  tenant: string,
) => isCandidate(catalog, model) || belongsElsewhere(catalog, model, tenant);

export const tenantModelRefusal = (
  catalog: Pick<CatalogRegistry, 'get'>,
  model: string,
  tenant: string,
): string | undefined => {
  if (isCandidate(catalog, model))
    return `model ${model} is not released yet; it is waiting for the quality matrix`;
  if (ownedElsewhere(catalog, model, tenant)) return `model ${model} belongs to another tenant`;
  return undefined;
};

export const modelsForTenant = (
  deps: { catalog: Pick<CatalogRegistry, 'get'>; models: { describe(): ModelDescription[] } },
  tenant: string,
  withCandidates = false,
): ModelDescription[] => {
  const usable = deps.models
    .describe()
    .filter(
      (m) =>
        m.enabled &&
        servesModelPort(m) &&
        !belongsElsewhere(deps.catalog, m.id, tenant) &&
        (withCandidates || !isCandidate(deps.catalog, m.id)),
    );
  const candidate = (m: ModelDescription) => Number(isCandidate(deps.catalog, m.id));
  return withCandidates ? usable.sort((a, b) => candidate(a) - candidate(b)) : usable;
};

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
