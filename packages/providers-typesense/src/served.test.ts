import { afterEach, describe, expect, it } from 'vitest';
import { envSecrets, type PortContext } from '@genai/kernel';
import { KnowledgeRouter } from '@genai/port-knowledge';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { assertReadOnly, typesense } from './index.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const engine = async () => {
  const server = await fakeHttp((_body, _attempt, path) =>
    path.startsWith('/aliases/')
      ? { status: 200, json: { name: 'site_docs', collection_name: 'site_docs__2026-10-01' } }
      : { status: 200, json: { results: [{ hits: [], found: 0 }] } },
  );
  servers.push(server);
  return server;
};

const dataset = (id: string, writer: boolean) => ({
  id,
  endpoint: 'ts',
  residency: 'norway',
  options: {
    collections: { docs: 'site_docs', chunks: 'site_chunks' },
    profiles: { content: { collection: 'chunks', queryBy: ['text'], textField: 'text' } },
    ...(writer ? { writer: {} } : {}),
  },
});

const searchAs = async (url: string, id: string, recorded: unknown[]) => {
  const ctx: PortContext = {
    tenant: '991825827',
    principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
    task: 't1',
    signal: new AbortController().signal,
    meter: async () => undefined,
    provenance: async (resource) => void recorded.push(resource),
  };
  const router = new KnowledgeRouter({
    catalog: {
      endpoints: {
        ts: {
          engine: 'typesense',
          baseURL: url,
          auth: { kind: 'api-key', secret: 'secret://env/typesense-key' },
        },
      },
      datasets: [dataset('digdir/shared', false), dataset('digdir/site', true)],
    },
    adapters: [typesense],
    secrets: envSecrets({ TYPESENSE_KEY: 'test-key' }),
  });
  await router.open({ kind: 'dataset', id }, ctx).search({ query: 'tilskudd' });
};

describe('typesense served index', () => {
  it('records the collection names of a read-only dataset without asking the engine for aliases', async () => {
    const server = await engine();
    const recorded: unknown[] = [];

    await searchAs(server.url, 'digdir/shared', recorded);

    expect(recorded).toEqual([
      {
        index: {
          dataset: 'digdir/shared',
          engine: 'typesense',
          collections: ['site_docs', 'site_chunks'],
        },
      },
    ]);
    expect(server.seen.map((s) => s.path.split('?')[0])).toEqual(['/multi_search']);
  });

  it('records the generation behind the aliases of a dataset the platform indexes', async () => {
    const server = await engine();
    const recorded: unknown[] = [];

    await searchAs(server.url, 'digdir/site', recorded);

    expect(recorded).toEqual([
      {
        index: {
          dataset: 'digdir/site',
          engine: 'typesense',
          generation: '2026-10-01',
          collections: ['site_docs', 'site_chunks'],
        },
      },
    ]);
    expect(server.seen.every((s) => s.headers['x-typesense-api-key'] === 'test-key')).toBe(true);
  });

  it('lets the reader look up an alias but never change one', () => {
    expect(() => assertReadOnly('GET', '/aliases/site_docs')).not.toThrow();
    expect(() => assertReadOnly('PUT', '/aliases/site_docs')).toThrow(/only reads/);
    expect(() => assertReadOnly('GET', '/aliases/site_docs/../../keys')).toThrow(/only reads/);
  });
});
