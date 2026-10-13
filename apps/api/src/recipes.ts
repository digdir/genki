import {
  appendVersion,
  isRecipeShared,
  recipeShareKind,
  sharedRecipeFinder,
  type ConfigEntryStore,
  type RecipeShareSpec,
} from '@genai/composition';
import type { DefinitionStore, StepFlowDefinition } from '@genai/definitions';
import type { Context } from 'hono';
import { enterTenant } from './access.js';
import { actorOf, type AdminHandler } from './admin.js';
import { changeReasonOf, isReasonLongEnough, problem, reasonTooShort } from './http.js';
import type { PlatformModuleFactory } from './platform-modules.js';

export interface Recipe {
  ref: string;
  id: string;
  version: number;
  origin: 'own' | 'shared';
  shared?: boolean;
  name?: string;
  title: { nb: string; en: string };
  summary: { nb: string; en: string };
  purpose: string;
  settings: Record<string, unknown>;
  steps: StepFlowDefinition['spec']['steps'];
}

export interface RecipeSources {
  platformTenant: string;
  configEntries: ConfigEntryStore;
}

const recipeOf = (
  flow: StepFlowDefinition | undefined,
  version: number,
  origin: Recipe['origin'],
): Omit<Recipe, 'shared'> | undefined =>
  flow?.kind === 'StepFlow' && flow.spec.recipe
    ? {
        ref: `${flow.metadata.id}@${version}`,
        id: flow.metadata.id,
        version,
        origin,
        ...(flow.metadata.name ? { name: flow.metadata.name } : {}),
        title: flow.spec.recipe.title,
        summary: flow.spec.recipe.summary,
        purpose: flow.spec.purpose,
        settings: flow.spec.settings ?? { type: 'object', properties: {}, required: [] },
        steps: flow.spec.steps,
      }
    : undefined;

const latestRecipes = async (
  store: DefinitionStore,
  tenant: string,
  origin: Recipe['origin'],
): Promise<Omit<Recipe, 'shared'>[]> => {
  const recipes: Omit<Recipe, 'shared'>[] = [];
  for (const entry of await store.list(tenant)) {
    if (entry.kind !== 'StepFlow') continue;
    const found = await store.get('StepFlow', tenant, entry.id);
    const recipe = found && recipeOf(found.definition as StepFlowDefinition, found.version, origin);
    if (recipe) recipes.push(recipe);
  }
  return recipes;
};

const byTitle = (a: Recipe, b: Recipe) => a.title.nb.localeCompare(b.title.nb, 'nb');

export const recipesOf = async (
  store: DefinitionStore,
  tenant: string,
  sources?: RecipeSources,
): Promise<Recipe[]> => {
  const own = await latestRecipes(store, tenant, 'own');
  if (!sources) return own.sort(byTitle);
  const sharedBy = (id: string) =>
    isRecipeShared(sources.configEntries, sources.platformTenant, id);
  if (tenant === sources.platformTenant)
    return (await Promise.all(own.map(async (r) => ({ ...r, shared: await sharedBy(r.id) })))).sort(
      byTitle,
    );
  const ownIds = new Set(own.map((r) => r.id));
  const platform = await latestRecipes(store, sources.platformTenant, 'shared');
  const shared: Recipe[] = [];
  for (const r of platform) if (!ownIds.has(r.id) && (await sharedBy(r.id))) shared.push(r);
  return [...own.sort(byTitle), ...shared.sort(byTitle)];
};

export const recipeShareActions = ['platform.recipe.share', 'platform.recipe.unshare'] as const;

export const recipesModule: PlatformModuleFactory = (deps) => {
  const sources = { platformTenant: deps.platformTenant, configEntries: deps.configEntries };
  const pinned = sharedRecipeFinder(
    deps.configEntries,
    () => deps.definitions,
    deps.platformTenant,
    'shared-once',
  );

  const shareHandler =
    (state: RecipeShareSpec['state']): AdminHandler =>
    async (input, principal) => {
      const flow = String(input.flow ?? '');
      const target = `recipe-share:${flow}`;
      if (principal.kind !== 'operator')
        return {
          ok: false,
          errors: [{ path: 'principal', message: 'only operators share recipes' }],
          target,
        };
      const found = await deps.definitions.get('StepFlow', deps.platformTenant, flow);
      if (!found || !recipeOf(found.definition as StepFlowDefinition, found.version, 'own'))
        return {
          ok: false,
          errors: [{ path: 'flow', message: `no published recipe ${flow} to share` }],
          target,
        };
      const saved = await appendVersion<RecipeShareSpec>(deps.configEntries, {
        kind: recipeShareKind,
        scope: deps.platformTenant,
        id: flow,
        spec: { flow, state },
        deleted: false,
        by: actorOf(principal),
        reason: input.reason,
      });
      return {
        ok: true,
        value: saved,
        target,
        audit: { scope: 'platform', after: { state, version: found.version } },
      };
    };

  return {
    id: 'recipes',
    handlers: {
      'platform.recipe.share': shareHandler('shared'),
      'platform.recipe.unshare': shareHandler('none'),
    },
    mount: (app, mountDeps) => {
      app.get('/tenants/:tenant/step-flows/recipes', async (c) => {
        const principal = await mountDeps.authenticate(c.req.raw);
        if (!principal) return c.json({ title: 'Not authenticated', status: 401 }, 401);
        const tenant = c.req.param('tenant') ?? '';
        const entered = enterTenant(c, mountDeps.access, principal, tenant);
        if ('response' in entered) return entered.response;
        return c.json({ recipes: await recipesOf(deps.definitions, tenant, sources) });
      });

      app.get('/tenants/:tenant/step-flows/recipes/:id/versions/:version', async (c) => {
        const principal = await mountDeps.authenticate(c.req.raw);
        if (!principal) return c.json({ title: 'Not authenticated', status: 401 }, 401);
        const tenant = c.req.param('tenant') ?? '';
        const entered = enterTenant(c, mountDeps.access, principal, tenant);
        if ('response' in entered) return entered.response;
        const id = c.req.param('id') ?? '';
        const version = Number(c.req.param('version'));
        if (!Number.isInteger(version)) return problem(c, 404, 'Not found');
        const own = (await deps.definitions.get('StepFlow', tenant, id, version))?.definition;
        const recipe =
          recipeOf(own as StepFlowDefinition | undefined, version, 'own') ??
          recipeOf(await pinned(tenant, id, version), version, 'shared');
        return recipe ? c.json({ recipe }) : problem(c, 404, 'Not found');
      });

      const operator = async (c: Context) => {
        const principal = await mountDeps.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, 'Unauthorized') };
        if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
        return { principal };
      };

      app.get('/operator/recipes/shares', async (c) => {
        const guard = await operator(c);
        if ('response' in guard) return guard.response;
        const data = (await recipesOf(deps.definitions, deps.platformTenant, sources)).map((r) => ({
          flow: r.id,
          version: r.version,
          title: r.title,
          shared: r.shared === true,
        }));
        return c.json({ data });
      });

      const decide = (action: (typeof recipeShareActions)[number]) => async (c: Context) => {
        const guard = await operator(c);
        if ('response' in guard) return guard.response;
        const reason = (changeReasonOf(c) ?? '').trim();
        if (!isReasonLongEnough(reason))
          return problem(c, 400, 'Invalid request', {
            errors: [{ path: 'change-reason', message: reasonTooShort }],
          });
        const flow = c.req.param('flow') ?? '';
        const result = await mountDeps.admin.perform<{ spec: RecipeShareSpec }>(
          { ...guard.principal, tenant: deps.platformTenant },
          action,
          { tenant: deps.platformTenant, reason, flow },
        );
        c.header('genai-task', result.task);
        if (!result.ok) return problem(c, 404, 'Not found', { errors: result.errors });
        return c.json({ flow, shared: result.value.spec.state === 'shared' });
      };
      app.put('/operator/recipes/shares/:flow', decide('platform.recipe.share'));
      app.delete('/operator/recipes/shares/:flow', decide('platform.recipe.unshare'));
    },
  };
};
