import { afterEach, describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { KnowledgeRouter } from '@genai/port-knowledge';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { typesense } from '@genai/providers-typesense';
import { cachedDocumentCount } from './configurables.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant: '991825827',
} as const;

describe('counting the documents of a shared dataset on a search-only engine', () => {
  it('reads the count from one search on the documents collection and keeps it for a while', async () => {
    const server = await fakeHttp(() => ({
      status: 200,
      json: { results: [{ found: 45321, hits: [] }] },
    }));
    servers.push(server);
    const router = new KnowledgeRouter({
      catalog: {
        endpoints: {
          ts: {
            engine: 'typesense',
            baseURL: server.url,
            auth: { kind: 'api-key', secret: 'secret://env/key' },
          },
        },
        datasets: [
          {
            id: 'digdir/kudos',
            endpoint: 'ts',
            residency: 'norway',
            options: {
              collections: { docs: 'kudos_docs', chunks: 'kudos_chunks' },
              profiles: {
                content: {
                  collection: 'chunks',
                  queryBy: ['content_markdown'],
                  textField: 'content_markdown',
                },
              },
            },
          },
        ],
      },
      adapters: [typesense],
      secrets: envSecrets({ KEY: 'search-only' }),
    });
    const count = cachedDocumentCount(router);
    const input = { dataset: 'digdir/kudos', tenant: '991825827', principal };

    expect(await count(input)).toBe(45321);
    expect(await count(input)).toBe(45321);
    expect(server.seen).toHaveLength(1);
    const search = (server.seen[0]?.body as { searches: Record<string, unknown>[] }).searches[0];
    expect(search).toMatchObject({ collection: 'kudos_docs', q: '*', per_page: 1 });
  });
});
