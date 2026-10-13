import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { createAdmin } from './admin.js';
import { readGitDefinitions, seedDefinitions } from './definition-sources.js';
import { withoutUnknownVariantModels } from './seed-variants.js';
import { digdir, files, klarsprak, plugins, settingDefinitions } from './testkit.js';

const services = join(import.meta.dirname, '..', 'config', 'local', 'services');

const entry = (definition: Record<string, unknown>) => ({
  file: 'klarsprak.yaml',
  kind: 'Service' as const,
  tenant: digdir,
  id: 'klarsprak',
  definition,
  files,
});

describe('seeding variants whose model is not configured', () => {
  it('drops the KA mini variant and keeps the service when discovery has no gpt-5-mini', () => {
    const ka = readGitDefinitions([{ dir: services }]).definitions.filter(
      (d) => d.id === 'kunnskapsassistenten',
    );

    const { definitions, dropped } = withoutUnknownVariantModels(
      ka,
      (id) => id === 'foundry-openai/gpt-4o-2m-tps',
    );

    expect(dropped).toEqual([
      {
        file: expect.stringContaining('kunnskapsassistenten.yaml'),
        service: 'kunnskapsassistenten',
        variant: 'mini',
        model: 'foundry-openai/gpt-5-mini',
      },
    ]);
    const variantIds = (d: (typeof ka)[number] | undefined) =>
      (d?.definition.spec as { variants: { id: string }[] }).variants.map((v) => v.id);
    expect(variantIds(definitions[0])).toEqual(variantIds(ka[0]).filter((id) => id !== 'mini'));
    expect(variantIds(definitions[0])).toContain('default');
  });

  it('keeps the KA mini variant when gpt-5-mini is discovered', () => {
    const ka = readGitDefinitions([{ dir: services }]).definitions.filter(
      (d) => d.id === 'kunnskapsassistenten',
    );

    const { definitions, dropped } = withoutUnknownVariantModels(ka, () => true);

    expect(dropped).toEqual([]);
    expect(definitions).toEqual(ka);
  });

  it('leaves a service alone when every variant names an unknown model, so its publish reports why', () => {
    const only = entry(klarsprak({ variants: [{ id: 'mini', model: 'foundry/gpt-5-mini' }] }));

    const { definitions, dropped } = withoutUnknownVariantModels([only], () => false);

    expect(dropped).toEqual([]);
    expect(definitions).toEqual([only]);
  });

  it('publishes the service with its other variants when one variant model is unknown', async () => {
    const store = new InMemoryDefinitionStore(plugins);
    const admin = createAdmin({
      store,
      plugins,
      settings: new SettingsRegistry(settingDefinitions),
    });
    const { definitions } = withoutUnknownVariantModels(
      [
        entry(
          klarsprak({
            variants: [{ id: 'default' }, { id: 'mini', model: 'foundry/gpt-5-mini' }],
          }),
        ),
      ],
      (id) => plugins.models.has(id),
    );

    const outcomes = await seedDefinitions(admin, store, definitions);

    expect(outcomes).toMatchObject([{ state: 'published', version: 1 }]);
    const published = await store.get('Service', digdir, 'klarsprak');
    expect((published?.definition.spec as { variants?: unknown }).variants).toEqual([
      { id: 'default', aliases: [], overrides: {} },
    ]);
  });
});
