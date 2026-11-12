import { afterEach, describe, expect, it } from 'vitest';
import { envSecrets, type PortContext } from '@genai/kernel';
import { KnowledgeRouter, type IndexDocument } from '@genai/port-knowledge';
import { fakeTypesense, type FakeTypesense } from './fake.js';
import { typesense, typesenseDatasetOptions } from './index.js';

const options = {
  collections: { docs: 'kudos_docs', chunks: 'kudos_chunks' },
  profiles: {
    content: { collection: 'chunks', queryBy: ['content_markdown'], textField: 'content_markdown' },
  },
};

const documents: IndexDocument[] = [
  {
    id: '377252',
    title: 'Årsrapport 2024',
    url: 'https://kudos.dfo.no/377252',
    fields: { type: 'Statusrapport', concerned_years: [2024] },
    chunks: [
      { id: 'b350da7c3d85', position: 1, text: 'Forord', metadata: { metadata: '{}' } },
      { id: '9eba71d9524c', position: 0, text: '{0}', metadata: { metadata: '{}' } },
    ],
    phrases: [],
  },
  {
    id: '33',
    title: 'Idékraft verda treng',
    fields: { type: 'Strategi' },
    chunks: [{ id: '3ad789576ed3', position: 0, text: 'Strategi', metadata: { metadata: '{}' } }],
    phrases: [],
  },
];

let fake: FakeTypesense | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const exportOf = async (docs = documents, datasetOptions: Record<string, unknown> = options) => {
  fake = await fakeTypesense(docs, typesenseDatasetOptions.parse(datasetOptions));
  const ctx: PortContext = {
    tenant: 'platform',
    principal: { kind: 'agency-system', issuer: 'platform', subject: 'engine-switch' },
    task: 't1',
    signal: new AbortController().signal,
    meter: async () => undefined,
  };
  const router = new KnowledgeRouter({
    catalog: {
      endpoints: {
        ts: {
          engine: 'typesense',
          baseURL: fake.url,
          auth: { kind: 'api-key', secret: 'secret://env/typesense-key' },
        },
      },
      datasets: [
        { id: 'digdir/kudos', endpoint: 'ts', residency: 'global', options: datasetOptions },
      ],
    },
    adapters: [typesense],
    secrets: envSecrets({ TYPESENSE_KEY: 'search-only' }),
  });
  const exported = router.open({ kind: 'dataset', id: 'digdir/kudos' }, ctx).export;
  if (!exported?.list || !exported.document) throw new Error('no document reads on the export');
  return { list: exported.list, document: exported.document };
};

describe('the Typesense export', () => {
  it('reads one document for a copy without its search phrases', async () => {
    const withPhrases = documents.map((d) => ({
      ...d,
      phrases: [{ id: `${d.id}-p`, chunkId: d.chunks[0]?.id ?? '', text: 'hva sier forordet' }],
    }));
    const { document } = await exportOf(withPhrases, {
      ...options,
      collections: { ...options.collections, phrases: 'kudos_phrases' },
    });
    expect((await document('377252'))?.phrases).toEqual([]);
  });

  it('lists documents without their chunks and reads one document with its chunks', async () => {
    const { list, document } = await exportOf();
    const listed = [];
    for await (const doc of list()) listed.push(doc);
    expect(listed).toEqual([
      {
        id: '377252',
        title: 'Årsrapport 2024',
        url: 'https://kudos.dfo.no/377252',
        fields: { type: 'Statusrapport', concerned_years: [2024] },
      },
      { id: '33', title: 'Idékraft verda treng', fields: { type: 'Strategi' } },
    ]);
    const one = await document('377252');
    expect(one?.chunks.map((c) => [c.position, c.text])).toEqual([
      [0, '{0}'],
      [1, 'Forord'],
    ]);
    expect(one?.phrases).toEqual([]);
    expect(await document('404')).toBeUndefined();
    expect(fake?.writes).toEqual([]);
  });
});
