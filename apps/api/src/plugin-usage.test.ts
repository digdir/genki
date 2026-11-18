import { InMemoryDefinitionStore } from '@genai/definitions';
import { describe, expect, it } from 'vitest';
import { pluginUsage } from './plugin-usage.js';
import { digdir, files, klarsprak, plugins, settingDefinitions } from './testkit.js';

describe('plugin usage', () => {
  it('counts a service as a user of the plugin behind the chat API its model binds', async () => {
    const store = new InMemoryDefinitionStore({ ...plugins, settings: settingDefinitions });
    await store.publish(klarsprak(), 'test', 'seed', files);

    const usage = await pluginUsage({
      store,
      tenants: () => [digdir],
      modelApis: () => ({ chat: 'openai/responses@1' }),
      datasetEndpoint: () => undefined,
      endpoint: () => undefined,
    });

    expect(usage.get('model.openai-chat')).toEqual([`${digdir}/klarsprak`]);
  });
});
