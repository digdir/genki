import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeHttp, type FakeReply, type FakeServer } from '@genai/port-model/testing';
import { contractSchemas } from './contract.test-utils.js';
import { createTypesenseWriter, generationNames, SharedClusterRefused } from './index.js';

const servers: FakeServer[] = [];
const fake = async (reply: (body: Record<string, unknown>, attempt: number) => FakeReply) => {
  const server = await fakeHttp(reply);
  servers.push(server);
  return server;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const credential = { kind: 'api-key' as const, key: async () => 'local-key' };
const names = { docs: 'test_documents_x', chunks: 'test_chunks_x', phrases: 'test_phrases_x' };

describe('typesense writer', () => {
  it('refuses to start against the shared cluster, by host, whatever the port or scheme', () => {
    const shared = ['search.example.no:8108', 'https://other.example:443/'];
    for (const baseURL of [
      'https://search.example.no:8108',
      'http://SEARCH.example.no:9999',
      'https://other.example.',
    ]) {
      expect(() =>
        createTypesenseWriter({
          baseURL,
          credential,
          schemas: contractSchemas(),
          sharedClusterUrls: shared,
        }),
      ).toThrow(SharedClusterRefused);
    }
    expect(() =>
      createTypesenseWriter({
        baseURL: 'http://localhost:8108',
        credential,
        schemas: contractSchemas(),
        sharedClusterUrls: shared,
      }),
    ).not.toThrow();
  });

  it('creates only missing collections from the contract, with references and optional embeddings', async () => {
    const created: Record<string, unknown>[] = [];
    const { url, seen } = await fake((body) => {
      if (body.name) {
        created.push(body);
        return { status: 201, json: body };
      }
      return seen.length === 1
        ? { status: 200, json: { name: names.docs } }
        : { status: 404, json: {} };
    });
    const writer = createTypesenseWriter({
      baseURL: url,
      credential,
      schemas: contractSchemas(),
      sharedClusterUrls: [],
      embeddings: false,
    });

    await writer.ensureCollections(names);

    expect(created.map((c) => c.name)).toEqual([names.chunks, names.phrases]);
    const chunkFields = created[0]?.fields as { name: string; reference?: string }[];
    expect(chunkFields.find((f) => f.name === 'doc_num')?.reference).toBe(`${names.docs}.doc_num`);
    expect((created[1]?.fields as { name: string }[]).some((f) => f.name === 'phrase_vec')).toBe(
      false,
    );
    expect(seen.every((s) => s.headers['x-typesense-api-key'] === 'local-key')).toBe(true);
  });

  it('imports in batches with upsert and fails when any document is refused', async () => {
    const bodies: string[] = [];
    const ok = await fakeHttp(() => ({ status: 200, json: undefined }));
    servers.push(ok);
    const writer = createTypesenseWriter({
      baseURL: ok.url,
      credential,
      schemas: contractSchemas(),
      sharedClusterUrls: [],
      batchSize: 2,
      fetch: async (input, init) => {
        bodies.push(String(init?.body));
        const lines = String(init?.body).split('\n');
        return new Response(
          lines
            .map((l) =>
              JSON.stringify(
                l.includes('"bad"') ? { success: false, error: 'bad doc' } : { success: true },
              ),
            )
            .join('\n'),
          { status: 200 },
        );
      },
    });

    await writer.upsert(names.chunks, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(bodies).toEqual(['{"id":"a"}\n{"id":"b"}', '{"id":"c"}']);
    await expect(writer.upsert(names.chunks, [{ id: 'bad' }])).rejects.toThrow(/bad doc/);
  });

  it('deletes orphans by doc_num with a keep list, and refuses ids that could change the filter', async () => {
    const { url, seen } = await fake(() => ({ status: 200, json: { num_deleted: 1 } }));
    const writer = createTypesenseWriter({
      baseURL: url,
      credential,
      schemas: contractSchemas(),
      sharedClusterUrls: [],
    });

    await writer.deleteOrphans(names.chunks, '12345', ['ab90aa0c353d', '5a9ebad21a18']);
    await writer.deleteOrphans(names.chunks, '12345', []);
    await expect(writer.deleteOrphans(names.chunks, '12345', ['x] || id:!=[y'])).rejects.toThrow(
      /plain/,
    );

    expect(seen).toHaveLength(1);
    expect(decodeURIComponent(seen[0]?.path ?? '')).toContain(
      'filter_by=doc_num:=12345 && id:!=[ab90aa0c353d,5a9ebad21a18]',
    );
  });

  it('promotes a generation behind aliases and returns what the aliases pointed at before', async () => {
    const aliases = new Map<string, string>([[names.docs, 'old_docs']]);
    const writer = createTypesenseWriter({
      baseURL: 'http://localhost:1',
      credential,
      schemas: contractSchemas(),
      sharedClusterUrls: [],
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const alias = decodeURIComponent(path.replace('/aliases/', ''));
        if (init?.method === 'PUT') {
          aliases.set(
            alias,
            (JSON.parse(String(init.body)) as { collection_name: string }).collection_name,
          );
          return new Response('{}', { status: 200 });
        }
        const target = aliases.get(alias);
        return target
          ? new Response(JSON.stringify({ name: alias, collection_name: target }), { status: 200 })
          : new Response('{}', { status: 404 });
      },
    });

    const generation = generationNames(names, 'g20261006');
    const previous = await writer.promote(names, generation);

    expect(previous).toEqual({ docs: 'old_docs' });
    expect(aliases.get(names.chunks)).toBe('test_chunks_x__g20261006');
    expect(() => generationNames(names, '../x')).toThrow(/plain/);
  });
});

const envFile = join(import.meta.dirname, '..', '..', '..', '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);

describe.skipIf(!process.env.TYPESENSE_URL)('the configured shared cluster', () => {
  it('is refused by default, before any request is sent', () => {
    let requests = 0;
    expect(() =>
      createTypesenseWriter({
        baseURL: process.env.TYPESENSE_URL ?? '',
        credential,
        schemas: contractSchemas(),
        fetch: async () => {
          requests += 1;
          return new Response('{}');
        },
      }),
    ).toThrow(SharedClusterRefused);
    expect(requests).toBe(0);
  });
});
