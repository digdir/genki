import { describe, expect, it } from 'vitest';
import { scopeToDocument, unreachableKnowledge } from './scope.js';
import { fixtureFilters, memoryEngine, openTarget, seedCorpus } from './testing/index.js';

const signal = new AbortController().signal;

const open = async (filters: Record<string, unknown> = fixtureFilters) => {
  const engine = memoryEngine();
  const dataset = { id: 'scope/test', filters: filters as typeof fixtureFilters };
  const writer = engine.writer.connect({ options: {}, timeoutMs: 1000 }, { signal });
  await seedCorpus(writer, { id: dataset.id, filters: {}, options: {} });
  return openTarget({ adapter: engine.adapter }, dataset);
};

describe('a knowledge port scoped to one document', () => {
  it('ranks only that document when the dataset cannot filter on the document id', async () => {
    const scoped = scopeToDocument(await open(), 'dok-1');

    const result = await scoped.search({ query: 'tilskudd rapportering', limit: 3 });
    const many = await scoped.searchMany([{ query: 'fristen' }, { query: 'ukjent ord' }]);

    expect(result.hits.length).toBeGreaterThan(0);
    expect(new Set(result.hits.map((h) => h.document))).toEqual(new Set(['dok-1']));
    expect(many.flatMap((r) => r.hits.map((h) => h.document))).not.toContain('dok-2');
    expect(many[1]?.hits.length).toBeGreaterThan(0);
  });

  it('refuses other documents through fetch, range and listing', async () => {
    const port = await open();
    const scoped = scopeToDocument(port, 'dok-1');
    const other = (await port.range('dok-2', 0, 1)).map((h) => h.id);

    expect(await scoped.fetch(other)).toEqual([]);
    expect(await scoped.range('dok-2', 0, 1)).toEqual([]);
    expect((await scoped.documents?.({ limit: 10 }))?.documents.map((d) => d.id)).toEqual([
      'dok-1',
    ]);
  });

  it('document-scoped facets reveal no global values when the dataset cannot filter by document', async () => {
    const port = await open();
    expect((await port.facets(['kategori'])).kategori?.length).toBeGreaterThan(0);
    const scoped = scopeToDocument(port, 'dok-1');

    expect(await scoped.facets(['kategori', 'virksomheter'])).toEqual({
      kategori: [],
      virksomheter: [],
    });
  });

  it('document-scoped facets enforce the document filter while preserving other caller filters', async () => {
    const port = await open({ ...fixtureFilters, doc_num: 'select' });
    const calls: unknown[] = [];
    const scoped = scopeToDocument(
      {
        ...port,
        facets: async (fields, filters) => {
          calls.push({ fields, filters });
          return { kategori: [{ value: 'Veiledning', count: 1 }] };
        },
      },
      'dok-1',
    );

    expect(await scoped.facets(['kategori'], { doc_num: ['dok-2'], aar: { gte: 2020 } })).toEqual({
      kategori: [{ value: 'Veiledning', count: 1 }],
    });
    expect(calls).toEqual([
      { fields: ['kategori'], filters: { doc_num: ['dok-1'], aar: { gte: 2020 } } },
    ]);
  });

  it('answers nothing from a dataset the document is not in', async () => {
    const empty = unreachableKnowledge(await open());

    expect((await empty.search({ query: 'tilskudd' })).hits).toEqual([]);
    expect(await empty.range('dok-1', 0, 3)).toEqual([]);
  });
});
