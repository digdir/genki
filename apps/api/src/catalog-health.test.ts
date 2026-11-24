import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { skippedEntries } from './catalog-health.js';

const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: '312521172' },
};

const options = {
  collections: { docs: 'docs', chunks: 'chunks' },
  profiles: { content: { collection: 'chunks', queryBy: ['text'], textField: 'text' } },
};

const boot = async (stored: { endpoint: string; generation?: string }[]) => {
  const store = new InMemoryConfigEntryStore();
  for (const [i, spec] of stored.entries())
    await store.append({
      kind: 'dataset',
      scope: 'platform',
      id: 'kudos',
      version: i + 1,
      spec: { residency: 'norway', options, ...spec },
      deleted: false,
      by: 'drift',
      at: `2026-11-1${i + 7}T09:22:00.000Z`,
      reason: 'test',
    });
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: {
        endpoints: {
          'kudos-typesense': {
            engine: 'typesense',
            baseURL: 'http://127.0.0.1:1',
            auth: { kind: 'api-key', secret: 'secret://env/ts-key' },
            sharing: { tenants: ['991825827', '312521172'] },
          },
        },
        datasets: [
          {
            id: 'kudos',
            endpoint: 'kudos-typesense',
            residency: 'norway',
            options,
          },
        ],
      },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ TS_KEY: 'x' }),
    configurables: { store },
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  return async (tenant: string, as: string) => {
    const response = await app.request(`/tenants/${tenant}/datasets/kudos`, {
      headers: { authorization: `Bearer ${as}` },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { effective?: Record<string, unknown> };
  };
};

describe('where a dataset runs', () => {
  it('shows the owner a dataset that runs on its seed, with the stored version the catalog left out', async () => {
    const view = await boot([{ endpoint: 'kunnskapsserveren', generation: 'g-20261116-abcdef' }]);

    expect((await view('991825827', 'kari')).effective).toEqual({
      endpoint: 'kudos-typesense',
      engine: 'typesense',
      engineTitle: 'Typesense',
      version: 0,
      fromSeed: true,
      expected: {
        endpoint: 'kunnskapsserveren',
        generation: 'g-20261116-abcdef',
        version: 1,
        at: '2026-11-17T09:22:00.000Z',
      },
    });
  });

  it('shows no expected version while the newest stored version is the one in use', async () => {
    const view = await boot([{ endpoint: 'kudos-typesense' }]);

    const { effective } = await view('991825827', 'kari');
    expect(effective).toMatchObject({ endpoint: 'kudos-typesense', version: 1, fromSeed: false });
    expect(effective).not.toHaveProperty('expected');
  });

  it('shows where a platform dataset runs only to members of the platform tenant', async () => {
    const view = await boot([{ endpoint: 'kunnskapsserveren' }]);

    expect(await view('312521172', 'ola')).not.toHaveProperty('effective');
  });
});

describe('the skipped list', () => {
  it('reads both the kind-and-id strings and the entries with problems', () => {
    expect(
      skippedEntries([
        'dataset digdir/kudos',
        {
          kind: 'knowledge-endpoint',
          id: 'kunnskapsserveren',
          problems: [{ path: 'endpoints', message: 'unknown engine' }],
        },
      ]),
    ).toEqual([
      { kind: 'dataset', id: 'digdir/kudos' },
      { kind: 'knowledge-endpoint', id: 'kunnskapsserveren', reasons: ['unknown engine'] },
    ]);
  });
});
