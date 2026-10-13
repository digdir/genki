import { describe, expect, it } from 'vitest';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import {
  accessRequestsPath,
  datasetRunCall,
  settingCall,
  type RouteCall,
} from '../../portal/src/data/api-calls.js';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { createPlatform } from './composition.js';

const routeTable = async () => {
  const settings = new SettingsRegistry(platformSettings);
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    settings,
    prices: {},
    secrets: envSecrets({}),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async () => undefined,
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    extensions: platform.extensions,
  });
  const app = createApp('test', {
    platform: {
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      admin,
      auth: { authenticate: async () => undefined },
      tenantGate: platform.tenantGate,
    },
  });
  platform.mount(app, admin);
  return app.routes.map((r) => ({
    method: r.method,
    pattern: new RegExp(
      `^${r.path
        .replace(/[.]/g, '\\.')
        .replace(/:[A-Za-z]+(\{[^}]*\})?/g, '[^/]+')
        .replace(/\/\*$/, '/.+')}$`,
    ),
  }));
};

const exists = (routes: Awaited<ReturnType<typeof routeTable>>, call: RouteCall) =>
  routes.some((r) => r.method === call.method && r.pattern.test(call.path));

describe('API calls the portal shows', () => {
  it('every route shown in the settings and dataset panels exists in the API route table', async () => {
    const routes = await routeTable();
    const shown = [
      settingCall({
        kind: 'tenant',
        tenant: '991825827',
        key: 'search.topK',
        value: 5,
        reset: false,
      }),
      settingCall({
        kind: 'tenant',
        tenant: '991825827',
        key: 'search.topK',
        value: null,
        reset: true,
      }),
      settingCall({ kind: 'service', tenant: '991825827', service: 'ka', key: 'k', value: 1 }),
      settingCall({ kind: 'serviceDraft', tenant: '991825827', service: 'ka', key: 'k', value: 1 }),
      datasetRunCall('991825827', 'kudos', 'nightly'),
      datasetRunCall('991825827', 'kudos', '{pipeline}'),
      { method: 'POST', path: accessRequestsPath } satisfies RouteCall,
    ];
    expect(shown.filter((c) => c === undefined || !exists(routes, c))).toEqual([]);
    expect(exists(routes, { method: 'POST', path: '/api/v1/datasett/kudos/innlesinger' })).toBe(
      false,
    );
  });

  it('shows no API call for settings per dataset, which have no route', () => {
    expect(settingCall({ kind: 'dataset' })).toBeUndefined();
  });
});
