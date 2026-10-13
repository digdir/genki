import { InMemoryDefinitionStore } from '@genai/definitions';
import { describe, expect, it } from 'vitest';
import type { CatalogItem } from './catalog-registry.js';
import { pluginUsage } from './plugin-usage.js';
import { digdir, files, klarsprak, plugins, settingDefinitions } from './testkit.js';

const item = (
  kind: CatalogItem['kind'],
  id: string,
  spec: Record<string, unknown>,
): CatalogItem => ({
  kind,
  id,
  scope: 'platform',
  origin: 'seed',
  version: 1,
  spec,
});

describe('plugin usage', () => {
  it('counts a service as a user of the protocol plugin behind the model it runs on', async () => {
    const store = new InMemoryDefinitionStore({ ...plugins, settings: settingDefinitions });
    await store.publish(klarsprak(), 'test', 'seed', files);

    const usage = await pluginUsage({
      store,
      tenants: () => [digdir],
      modelEndpoint: () => 'foundry',
      datasetEndpoint: () => undefined,
      endpoint: (kind, id) =>
        kind === 'model-endpoint' && id === 'foundry'
          ? item(kind, id, { protocol: 'openai-chat' })
          : undefined,
    });

    expect(usage.get('model.openai-chat')).toEqual([`${digdir}/klarsprak`]);
  });
});
