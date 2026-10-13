import { InMemoryDefinitionStore, type PluginSchemas } from '@genai/definitions';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InMemoryConfigEntryStore, appendVersion } from './config-store.js';
import { recipeShareKind, sharedRecipeFinder } from './recipe-shares.js';

const digdir = '991825827';
const other = '999888777';

const plugins: PluginSchemas = {
  strategies: new Map<string, z.ZodType>(),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(['template@1']),
  models: new Map(),
};

const recipe = (purpose: string, recipeMark = true) => ({
  apiVersion: 'genai/v1',
  kind: 'StepFlow',
  metadata: { tenant: digdir, id: 'kort-svar' },
  spec: {
    purpose,
    ...(recipeMark
      ? { recipe: { title: { nb: 'Kort', en: 'Short' }, summary: { nb: 'Velg', en: 'Pick' } } }
      : {}),
    steps: [{ id: 'svar', block: 'template@1', input: { text: '{{input.query}}' } }],
  },
});

const setup = async () => {
  const store = new InMemoryDefinitionStore(plugins);
  const entries = new InMemoryConfigEntryStore();
  const share = (state: 'shared' | 'none') =>
    appendVersion(entries, {
      kind: recipeShareKind,
      scope: digdir,
      id: 'kort-svar',
      spec: { flow: 'kort-svar', state },
      deleted: false,
      by: 'operator:test:drift',
      reason: 'Deler oppskriften',
    });
  const finder = (reach: 'shared-now' | 'shared-once') =>
    sharedRecipeFinder(entries, () => store, digdir, reach);
  return { store, share, finder };
};

describe('shared recipe lookup', () => {
  it('an unshared recipe is invisible to other organisations', async () => {
    const { store, finder } = await setup();
    await store.publish(recipe('Første'), 'kari', 'oppskrift');

    expect(await finder('shared-now')(other, 'kort-svar', 1)).toBeUndefined();
    expect(await finder('shared-once')(other, 'kort-svar', 1)).toBeUndefined();
  });

  it('another organisation can use a shared recipe, at exactly the version it names', async () => {
    const { store, share, finder } = await setup();
    await store.publish(recipe('Første'), 'kari', 'oppskrift');
    await share('shared');
    await store.publish(recipe('Andre'), 'kari', 'ny versjon');

    expect((await finder('shared-now')(other, 'kort-svar', 1))?.spec.purpose).toBe('Første');
    expect((await finder('shared-now')(other, 'kort-svar', 2))?.spec.purpose).toBe('Andre');
  });

  it('only flows marked as recipes are shared', async () => {
    const { store, share, finder } = await setup();
    await store.publish(recipe('Ikke oppskrift', false), 'kari', 'flyt');
    await share('shared');

    expect(await finder('shared-now')(other, 'kort-svar', 1)).toBeUndefined();
  });

  it('after unsharing, new use is refused but services already published keep running their pinned version', async () => {
    const { store, share, finder } = await setup();
    await store.publish(recipe('Første'), 'kari', 'oppskrift');
    await share('shared');
    await share('none');

    expect(await finder('shared-now')(other, 'kort-svar', 1)).toBeUndefined();
    expect((await finder('shared-once')(other, 'kort-svar', 1))?.spec.purpose).toBe('Første');
  });
});
