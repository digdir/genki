import {
  envSecrets,
  type EndpointAuth,
  type PortContext,
  type SecretResolver,
} from '@genai/kernel';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatasetConfig, DatasetEmbedding, KnowledgeAdapter } from '../adapter.js';
import {
  KnowledgeError,
  knowledgeProfiles,
  matchAllQuery,
  searchCapabilities,
  type FacetValue,
  type FieldFilter,
  type KnowledgeCapability,
  type KnowledgePort,
  type SearchRequest,
} from '../port.js';
import { KnowledgeRouter } from '../router.js';
import { IndexWriterRouter, type IndexDocument, type IndexWriter } from '../writer.js';
import {
  facetCase,
  filterCases,
  fixtureDocuments,
  fixtureFilters,
  fixtureQueries,
  rangeCase,
  trickyCases,
  withVectors,
} from './corpus.js';
import { memoryEngine } from './memory.js';

export interface ContractDataset {
  id: string;
  filters: Record<string, FieldFilter>;
}

export interface KnowledgeTarget {
  adapter: KnowledgeAdapter;
  endpoint?: { baseURL?: string; auth?: EndpointAuth; options?: Record<string, unknown> };
  datasetOptions?: Record<string, unknown>;
  embedding?: DatasetEmbedding;
  secrets?: SecretResolver;
  /** A request this engine fails on its own, used to prove one failure becomes a warning. */
  failingRequest?: SearchRequest;
  close?(): Promise<void>;
}

export interface IndexWriterTarget extends KnowledgeTarget {
  writer: IndexWriter;
  dataset: DatasetConfig;
}

export const contractDocuments = (embedding?: DatasetEmbedding, documents = fixtureDocuments) =>
  embedding ? withVectors(documents, embedding.dimensions) : documents;

export const seedCorpus = async (
  writer: IndexWriter,
  dataset: DatasetConfig,
  documents: IndexDocument[] = fixtureDocuments,
  generation = 'g1',
) => {
  await writer.prepare(dataset, generation);
  for (const doc of contractDocuments(dataset.embedding, documents))
    await writer.store(dataset, generation, doc);
  return writer.promote(dataset, generation);
};

const contextFor = (signal: AbortSignal): PortContext => ({
  tenant: '991825827',
  principal: { kind: 'employee', issuer: 'contract', subject: 'kari', tenant: '991825827' },
  task: 'contract',
  signal,
  meter: async () => undefined,
});

export const openTarget = (
  target: KnowledgeTarget,
  dataset: ContractDataset,
  signal: AbortSignal = new AbortController().signal,
): KnowledgePort => {
  const router = new KnowledgeRouter({
    catalog: {
      endpoints: {
        contract: {
          engine: target.adapter.engine,
          ...(target.endpoint?.baseURL ? { baseURL: target.endpoint.baseURL } : {}),
          ...(target.endpoint?.auth ? { auth: target.endpoint.auth } : {}),
          options: target.endpoint?.options ?? {},
        },
      },
      datasets: [
        {
          id: dataset.id,
          endpoint: 'contract',
          residency: 'norway',
          filters: dataset.filters,
          options: target.datasetOptions ?? {},
          ...(target.embedding ? { embedding: target.embedding } : {}),
        },
      ],
    },
    adapters: [target.adapter],
    secrets: target.secrets ?? envSecrets({}),
  });
  return router.open({ kind: 'dataset', id: dataset.id }, contextFor(signal));
};

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const sorted = (values: string[]) => [...new Set(values)].sort();

const normalised = (facets: Record<string, FacetValue[]>) =>
  Object.fromEntries(
    Object.entries(facets).map(([field, values]) => [
      field,
      [...values].sort((a, b) => a.value.localeCompare(b.value)),
    ]),
  );

const refusal = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
};

export const knowledgeAdapterContract = (
  name: string,
  setup: (input: { dataset: ContractDataset }) => Promise<KnowledgeTarget>,
) =>
  describe(`knowledge adapter contract: ${name}`, () => {
    const dataset: ContractDataset = { id: `contract/${slug(name)}`, filters: fixtureFilters };
    let target: KnowledgeTarget;
    let port: KnowledgePort;
    let declared: Set<KnowledgeCapability>;
    const has = (capability: KnowledgeCapability) => declared.has(capability);
    const searchable = () => searchCapabilities.some(has);

    beforeAll(async () => {
      target = await setup({ dataset });
      port = openTarget(target, dataset);
      declared = new Set(port.info().capabilities ?? []);
    });
    afterAll(async () => target?.close?.());

    it('search hits resolve through fetch in request order', async (ctx) => {
      if (!searchable() || !has('fetch')) ctx.skip();
      const { hits } = await port.search({ query: fixtureQueries.everywhere, limit: 5 });
      expect(hits.length).toBeGreaterThan(1);
      const ids = [...hits.map((h) => h.id)].reverse();
      const fetched = await port.fetch([...ids, 'finnes-ikke']);
      expect(fetched.map((h) => h.id)).toEqual(ids);
      const texts = new Map(hits.map((h) => [h.id, h.text]));
      for (const hit of fetched) expect(hit.text).toBe(texts.get(hit.id));
    });

    it('every listed profile is searchable', async (ctx) => {
      if (!searchable()) ctx.skip();
      const profiles = port.info().profiles;
      expect(profiles.length).toBeGreaterThan(0);
      for (const profile of profiles) {
        const result = await port.search({ query: fixtureQueries.everywhere, profile, limit: 5 });
        expect(result.hits.length, `profile ${profile}`).toBeGreaterThan(0);
      }
    });

    it('each filter kind narrows results', async (ctx) => {
      const cases = filterCases.filter((c) => has(c.capability));
      if (!searchable() || cases.length === 0) ctx.skip();
      const all = await port.search({ query: fixtureQueries.everywhere, limit: 50 });
      const everyDocument = sorted(all.hits.map((h) => h.document ?? ''));
      for (const c of cases) {
        const { hits } = await port.search({
          query: fixtureQueries.everywhere,
          filters: c.filters,
          limit: 50,
        });
        expect(sorted(hits.map((h) => h.document ?? '')), c.name).toEqual(sorted(c.documents));
        expect(everyDocument.length, c.name).toBeGreaterThan(c.documents.length);
      }
    });

    it("range returns one document's chunks in position order, inclusive", async (ctx) => {
      if (!has('range')) ctx.skip();
      const hits = await port.range(rangeCase.document, rangeCase.from, rangeCase.to);
      expect(hits.map((h) => h.id)).toEqual(rangeCase.chunks);
      expect(hits.map((h) => h.position)).toEqual([rangeCase.from, rangeCase.to]);
      expect(new Set(hits.map((h) => h.document))).toEqual(new Set([rangeCase.document]));
    });

    it('facets count values over filtered docs, or the dataset does not declare facets and the call fails as unsupported', async () => {
      if (!has('facets')) {
        await expect(port.facets(facetCase.fields)).rejects.toMatchObject({ code: 'unsupported' });
        return;
      }
      const filters = has('filter.boolean') ? facetCase.filters : undefined;
      const facets = await port.facets(facetCase.fields, filters);
      if (filters) expect(normalised(facets)).toEqual(facetCase.expected);
      else expect(Object.keys(facets).sort()).toEqual([...facetCase.fields].sort());
    });

    it('filter values with quotes, backticks and SQL metacharacters are data', async (ctx) => {
      if (!searchable() || !has('filter.select')) ctx.skip();
      for (const tricky of trickyCases) {
        const filters = { merknad: tricky.value };
        const error = await refusal(() =>
          port.search({ query: fixtureQueries.everywhere, filters, limit: 50 }),
        );
        if (error !== undefined) {
          expect(tricky.mayRefuse, String(error)).toBe(true);
          expect(error).toBeInstanceOf(KnowledgeError);
          expect(error).toMatchObject({ code: 'bad_request' });
          continue;
        }
        const { hits } = await port.search({
          query: fixtureQueries.everywhere,
          filters,
          limit: 50,
        });
        expect(sorted(hits.map((h) => h.document ?? ''))).toEqual(tricky.documents);
      }
      const all = await port.search({ query: fixtureQueries.everywhere, limit: 50 });
      expect(sorted(all.hits.map((h) => h.document ?? '')).length).toBe(fixtureDocuments.length);
    });

    it('searchMany keeps order and turns one failing request into a warning', async (ctx) => {
      if (!searchable()) ctx.skip();
      const requests: SearchRequest[] = [
        { query: fixtureQueries.unique.query, limit: 3 },
        ...(target.failingRequest ? [target.failingRequest] : []),
        { query: fixtureQueries.everywhere, limit: 2 },
      ];
      const results = await port.searchMany(requests);
      expect(results).toHaveLength(requests.length);
      expect(results[0]?.hits[0]?.id).toBe(fixtureQueries.unique.chunk);
      expect(results.at(-1)?.hits.length).toBe(2);
      if (target.failingRequest) {
        expect(results[1]?.warning).toBeTruthy();
        expect(results[1]?.hits).toEqual([]);
      }
    });

    it('an aborted signal fails with cancelled', async (ctx) => {
      if (!searchable()) ctx.skip();
      const controller = new AbortController();
      controller.abort();
      const aborted = openTarget(target, dataset, controller.signal);
      await expect(aborted.search({ query: fixtureQueries.everywhere })).rejects.toMatchObject({
        code: 'cancelled',
      });
    });

    it('the match-all query on the document title profile lists every document once, narrowed by filters', async (ctx) => {
      if (!searchable() || !port.info().profiles.includes(knowledgeProfiles.docTitle)) ctx.skip();
      const profile = knowledgeProfiles.docTitle;
      const all = await port.search({ query: matchAllQuery, profile, limit: 50 });
      expect(sorted(all.hits.map((h) => h.document ?? h.id))).toEqual(
        sorted(fixtureDocuments.map((d) => d.id)),
      );
      const c = filterCases.find((f) => has(f.capability));
      if (!c) return;
      const narrowed = await port.search({
        query: matchAllQuery,
        profile,
        filters: c.filters,
        limit: 50,
      });
      expect(sorted(narrowed.hits.map((h) => h.document ?? h.id))).toEqual(sorted(c.documents));
    });

    it('document listing returns every document once, narrowed by filters and ids', async (ctx) => {
      if (!port.documents) ctx.skip();
      const list = port.documents?.bind(port);
      if (!list) return;
      const all = await list({ limit: 50 });
      expect(sorted(all.documents.map((d) => d.id))).toEqual(
        sorted(fixtureDocuments.map((d) => d.id)),
      );
      const c = filterCases.find((f) => has(f.capability));
      if (c) {
        const narrowed = await list({ filters: c.filters, limit: 50 });
        expect(sorted(narrowed.documents.map((d) => d.id))).toEqual(sorted(c.documents));
      }
      const named = await list({ ids: ['dok-2', 'finnes-ikke'], limit: 50 });
      expect(named.documents.map((d) => d.id)).toEqual(['dok-2']);
    });

    it('an unknown profile is bad_request', async (ctx) => {
      if (!searchable()) ctx.skip();
      await expect(
        port.search({ query: fixtureQueries.everywhere, profile: 'finnes-ikke' }),
      ).rejects.toMatchObject({ code: 'bad_request' });
    });
  });

const collect = async <T>(items: AsyncIterable<T>) => {
  const all: T[] = [];
  for await (const item of items) all.push(item);
  return all;
};

const comparable = (docs: IndexDocument[]) =>
  [...docs]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((doc) => ({
      id: doc.id,
      pipeline: doc.pipeline,
      title: doc.title,
      url: doc.url,
      fields: doc.fields,
      chunks: [...doc.chunks]
        .sort((a, b) => a.position - b.position)
        .map((c) => ({
          id: c.id,
          position: c.position,
          text: c.text,
          metadata: c.metadata ?? {},
          dimensions: c.vector?.length ?? 0,
        })),
      phrases: [...doc.phrases]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => ({
          id: p.id,
          chunkId: p.chunkId,
          text: p.text,
          dimensions: p.vector?.length ?? 0,
        })),
    }));

const vectorsOf = (docs: IndexDocument[]) =>
  new Map(
    docs.flatMap((d) => [
      ...d.chunks.map((c) => [c.id, c.vector] as const),
      ...d.phrases.map((p) => [p.id, p.vector] as const),
    ]),
  );

export const indexWriterContract = (
  name: string,
  setup: (input: { dataset: ContractDataset }) => Promise<IndexWriterTarget>,
) =>
  describe(`index writer contract: ${name}`, () => {
    let runs = 0;
    let target: IndexWriterTarget;
    let reader: KnowledgePort;
    let declared: Set<KnowledgeCapability>;
    const [first, second] = fixtureDocuments as [IndexDocument, IndexDocument];

    const docs = (...documents: IndexDocument[]) =>
      contractDocuments(target.dataset.embedding, documents);
    const store = async (generation: string, ...documents: IndexDocument[]) => {
      await target.writer.prepare(target.dataset, generation);
      for (const doc of docs(...documents))
        await target.writer.store(target.dataset, generation, doc);
    };
    const visible = async (chunk: string, document: string) => {
      if (declared.has('fetch')) return (await reader.fetch([chunk])).length > 0;
      const { hits } = await reader.search({ query: fixtureQueries.everywhere, limit: 50 });
      return hits.some((h) => h.document === document);
    };

    beforeEach(async () => {
      runs += 1;
      const dataset = { id: `contract-writer/${slug(name)}-${runs}`, filters: fixtureFilters };
      target = await setup({ dataset });
      reader = openTarget(target, dataset);
      declared = new Set(reader.info().capabilities ?? []);
    });
    afterEach(async () => target?.close?.());

    it("store replaces a document's chunks and phrases and removes orphans", async () => {
      const replacement: IndexDocument = {
        ...first,
        chunks: first.chunks
          .slice(0, 2)
          .map((c) => ({ ...c, text: `${c.text} Oppdatert tilskudd.` })),
        phrases: first.phrases.slice(0, 1),
      };
      await store('g1', first, second);
      await target.writer.store(target.dataset, 'g1', docs(replacement)[0] as IndexDocument);
      expect(await target.writer.stats(target.dataset, 'g1')).toEqual({
        documents: 2,
        chunks: 2 + second.chunks.length,
        phrases: 1 + second.phrases.length,
      });
      await target.writer.promote(target.dataset, 'g1');
      if (declared.has('fetch')) {
        const ids = first.chunks.map((c) => c.id);
        const fetched = await reader.fetch(ids);
        expect(fetched.map((h) => h.id)).toEqual(ids.slice(0, 2));
        expect(fetched[0]?.text).toContain('Oppdatert');
      }
      if (declared.has('range')) {
        const range = await reader.range(first.id, 0, 10);
        expect(range.map((h) => h.position)).toEqual([0, 1]);
      }
    });

    it('a new generation is invisible until promote', async () => {
      const [a, b] = [first.chunks[0]?.id ?? '', second.chunks[0]?.id ?? ''];
      await store('g1', first);
      await target.writer.promote(target.dataset, 'g1');
      await store('g2', second);
      expect(await visible(a, first.id)).toBe(true);
      expect(await visible(b, second.id)).toBe(false);
      await target.writer.promote(target.dataset, 'g2');
      expect(await visible(b, second.id)).toBe(true);
      expect(await visible(a, first.id)).toBe(false);
    });

    it('promote returns the previous generation', async () => {
      await store('g1', first);
      await store('g2', second);
      expect(await target.writer.promote(target.dataset, 'g1')).toBeUndefined();
      expect(await target.writer.promote(target.dataset, 'g2')).toBe('g1');
    });

    it('conditional promotion refuses stale generations, including an initially empty dataset', async (ctx) => {
      const promote = target.writer.promoteIfActive?.bind(target.writer);
      if (!promote) return ctx.skip();
      await store('g1', first);
      await store('g2', second);
      expect(await promote(target.dataset, 'g1', undefined)).toBeUndefined();
      await expect(promote(target.dataset, 'g2', undefined)).rejects.toMatchObject({
        code: 'bad_request',
      });
      expect(await target.writer.active(target.dataset)).toBe('g1');
      expect(await promote(target.dataset, 'g2', 'g1')).toBe('g1');
      await expect(promote(target.dataset, 'g1', 'g1')).rejects.toMatchObject({
        code: 'bad_request',
      });
      expect(await target.writer.active(target.dataset)).toBe('g2');
    });

    it('only one of two concurrent conditional promotions can replace the same snapshot', async (ctx) => {
      const promote = target.writer.promoteIfActive?.bind(target.writer);
      if (!promote) return ctx.skip();
      await store('g1', first);
      await store('g2', second);
      await store('g3', first, second);
      await target.writer.promote(target.dataset, 'g1');
      const results = await Promise.allSettled([
        promote(target.dataset, 'g2', 'g1'),
        promote(target.dataset, 'g3', 'g1'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const winner = results[0]?.status === 'fulfilled' ? 'g2' : 'g3';
      expect(await target.writer.active(target.dataset)).toBe(winner);
    });

    it('read streams stored documents with vectors', async (ctx) => {
      const read = target.writer.read?.bind(target.writer);
      if (!read) return ctx.skip();
      await store('g1', first, second);
      await target.writer.promote(target.dataset, 'g1');
      await store('g2', second);
      const expected = docs(first, second);
      const active = await collect(read(target.dataset));
      expect(comparable(active)).toEqual(comparable(expected));
      const stored = vectorsOf(active);
      for (const [id, vector] of vectorsOf(expected)) {
        if (!vector) continue;
        const got = stored.get(id) ?? [];
        expect(got, id).toHaveLength(vector.length);
        got.forEach((value, i) => expect(value).toBeCloseTo(vector[i] ?? 0, 5));
      }
      expect((await collect(read(target.dataset, 'g2'))).map((d) => d.id)).toEqual([second.id]);
    });

    it('round-trips pipeline provenance separately from source metadata and clears it on unattributed replacement', async (ctx) => {
      const read = target.writer.read?.bind(target.writer);
      if (!read) return ctx.skip();
      const attributed = {
        ...first,
        pipeline: 'actual-owner',
        fields: { ...first.fields, ingestion_pipeline: 'user-owner', pipeline: 'user-column' },
      };
      await store('g1', attributed);
      await target.writer.promote(target.dataset, 'g1');
      const [doc] = await collect(read(target.dataset));
      expect(doc?.pipeline).toBe('actual-owner');
      expect(doc?.fields).toMatchObject({
        ingestion_pipeline: 'user-owner',
        pipeline: 'user-column',
      });
      const legacy: IndexDocument = { ...attributed };
      delete legacy.pipeline;
      await target.writer.store(target.dataset, 'g1', docs(legacy)[0] as IndexDocument);
      const [replaced] = await collect(read(target.dataset));
      expect(replaced?.pipeline).toBeUndefined();
      expect(replaced?.fields).toMatchObject({
        ingestion_pipeline: 'user-owner',
        pipeline: 'user-column',
      });
    });

    const elsewhere = memoryEngine({ engine: 'contract-elsewhere' });
    const datasetOptions = () =>
      target.datasetOptions ?? (target.dataset.options as Record<string, unknown>);
    const routed = (served: 'contract' | 'elsewhere') =>
      new IndexWriterRouter({
        catalog: {
          endpoints: {
            contract: {
              engine: target.adapter.engine,
              ...(target.endpoint?.baseURL ? { baseURL: target.endpoint.baseURL } : {}),
              ...(target.endpoint?.auth ? { auth: target.endpoint.auth } : {}),
              options: target.endpoint?.options ?? {},
            },
            elsewhere: { engine: 'contract-elsewhere', options: {} },
          },
          datasets: [
            {
              id: target.dataset.id,
              endpoint: served,
              residency: 'norway',
              filters: target.dataset.filters,
              options: served === 'contract' ? datasetOptions() : {},
              ...(target.embedding ? { embedding: target.embedding } : {}),
            },
          ],
        },
        adapters: [
          {
            engine: target.adapter.engine,
            needs: { vectors: false },
            datasetOptions: target.adapter.datasetOptions,
            connect: () => target.writer,
          },
        ],
        knowledgeAdapters: [target.adapter, elsewhere.adapter],
        secrets: target.secrets ?? envSecrets({}),
      });

    it('drop refuses the generation the catalog serves', async () => {
      await store('g1', first);
      await target.writer.promote(target.dataset, 'g1');
      await store('g2', second);
      const route = routed('contract').open(target.dataset.id, {
        signal: new AbortController().signal,
      });
      await expect(route.writer.drop(target.dataset, 'g1', { force: true })).rejects.toMatchObject({
        code: 'bad_request',
      });
      expect(await visible(first.chunks[0]?.id ?? '', first.id)).toBe(true);
      await route.writer.drop(target.dataset, 'g2', { force: true });
      expect(await target.writer.active(target.dataset)).toBe('g1');
    });

    it('drop removes an inactive generation', async () => {
      await store('g1', first);
      await target.writer.promote(target.dataset, 'g1');
      const route = routed('elsewhere').openAt(
        target.dataset.id,
        'contract',
        { signal: new AbortController().signal },
        { datasetOptions: datasetOptions() },
      );
      await route.writer.drop(target.dataset, 'g1', { force: true });
      expect(await target.writer.active(target.dataset)).toBeUndefined();
      const read = target.writer.read?.bind(target.writer);
      if (read) await expect(collect(read(target.dataset, 'g1'))).rejects.toThrow();
    });

    it('drop refuses the active generation', async () => {
      await store('g1', first);
      await store('g2', second);
      await target.writer.promote(target.dataset, 'g1');
      await expect(target.writer.drop(target.dataset, 'g1')).rejects.toMatchObject({
        code: 'bad_request',
      });
      await target.writer.drop(target.dataset, 'g2');
      expect(await visible(first.chunks[0]?.id ?? '', first.id)).toBe(true);
    });
  });
