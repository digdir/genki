import type { DefinitionStore, FlowFinder, StepFlowDefinition } from '@genai/definitions';
import type { ConfigEntryStore } from './config-store.js';

export const recipeShareKind = 'recipe-share';

export interface RecipeShareSpec {
  flow: string;
  state: 'shared' | 'none';
}

const stateOf = (spec: unknown) => (spec as Partial<RecipeShareSpec> | undefined)?.state;

export const isRecipeShared = async (
  entries: ConfigEntryStore,
  platformTenant: string,
  flow: string,
) =>
  stateOf((await entries.history(recipeShareKind, platformTenant, flow)).at(-1)?.spec) === 'shared';

const wasRecipeShared = async (entries: ConfigEntryStore, platformTenant: string, flow: string) =>
  (await entries.history(recipeShareKind, platformTenant, flow)).some(
    (e) => stateOf(e.spec) === 'shared',
  );

export const sharedRecipeFinder =
  (
    entries: ConfigEntryStore,
    store: () => DefinitionStore | undefined,
    platformTenant: string,
    reach: 'shared-now' | 'shared-once',
  ): FlowFinder =>
  async (tenant, id, version) => {
    if (tenant === platformTenant) return undefined;
    const allowed =
      reach === 'shared-now'
        ? await isRecipeShared(entries, platformTenant, id)
        : await wasRecipeShared(entries, platformTenant, id);
    if (!allowed) return undefined;
    const found = await store()?.get('StepFlow', platformTenant, id, version);
    const flow = found?.definition as StepFlowDefinition | undefined;
    return flow?.kind === 'StepFlow' && flow.spec.recipe ? flow : undefined;
  };
