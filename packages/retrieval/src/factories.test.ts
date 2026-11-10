import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { envSecrets, type PortContext } from '@genai/kernel';
import {
  KnowledgeRouter,
  type Hit,
  type KnowledgeAdapter,
  type KnowledgePort,
  type SearchRequest,
} from '@genai/port-knowledge';
import { RerankRouter, type RerankAdapter, type RerankRequest } from '@genai/port-rerank';
import { createAgentRetrieval, createRagRetrieval, listDocuments } from './factories.js';
import { FacetCache } from './pipeline.js';

const ctx: PortContext = {
  tenant: '991825827',
  principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
  task: 't1',
  signal: new AbortController().signal,
  meter: async () => undefined,
};
const signal = new AbortController().signal;

const corpus: Record<string, { document: string; position: number; text: string; title: string }> =
  {
    c1: {
      document: 'd1',
      position: 0,
      title: 'Årsrapport 2022',
      text: 'Digdir hadde 326 årsverk i 2022.',
    },
    c2: { document: 'd1', position: 1, title: 'Årsrapport 2022', text: 'Budsjettet økte.' },
    c3: {
      document: 'd2',
      position: 0,
      title: 'Tildelingsbrev 2023',
      text: 'Tildelingen for 2023.',
    },
  };

const dated: Record<string, Record<string, unknown>> = {
  c1: { docs: { total_chunks: 2, publish_date: '2023-01-15' } },
  c3: { docs: { total_chunks: 1, publish_date: 1735689600 }, document_version: 'v2' },
};

const stub = (blank: string[] = [], extraFields: Record<string, Record<string, unknown>> = {}) => {
  const searches: SearchRequest[] = [];
  const calls: string[] = [];
  const toHit = (id: string, score: number): Hit => {
    const d = corpus[id] ?? { document: 'x', position: 0, title: 'x', text: 'x' };
    return {
      id,
      score,
      text: blank.includes(id) ? '' : d.text,
      title: d.title,
      document: d.document,
      position: d.position,
      fields: {
        metadata: '{"Header 1" "Ansatte", "Header 2" "Årsverk"}',
        content_length: d.text.length,
        docs: { total_chunks: 2 },
        ...extraFields[id],
      },
    };
  };
  const adapter: KnowledgeAdapter = {
    engine: 'stub',
    endpointOptions: z.strictObject({}),
    datasetOptions: z.strictObject({}),
    connect: () => ({
      profiles: () => ['phrase', 'metadata', 'content'],
      search: async (_d, requests) => {
        searches.push(...requests);
        return requests.map((r) => ({
          hits: r.profile === 'content' ? [toHit('c1', 2), toHit('c3', 1)] : [],
        }));
      },
      fetch: async (_d, ids) => {
        calls.push(`fetch:${ids.join(',')}`);
        return ids.filter((id) => id in corpus).map((id) => toHit(id, 0));
      },
      range: async (_d, document, from, to) => {
        calls.push(`range:${document}:${from}-${to}`);
        return ['c1', 'c2'].map((id) => toHit(id, 0));
      },
      facets: async (_d, fields) => {
        calls.push(`facets:${fields.join(',')}`);
        return Object.fromEntries(
          fields.map((f) => [f, [1, 2, 3].map((n) => ({ value: `${f}-${n}`, count: 10 - n }))]),
        );
      },
    }),
  };
  const knowledge = new KnowledgeRouter({
    catalog: {
      endpoints: {
        main: {
          engine: 'stub',
          baseURL: 'https://search.example',
          auth: { kind: 'api-key', secret: 'secret://env/k' },
        },
      },
      datasets: [
        {
          id: 'digdir/kudos',
          endpoint: 'main',
          residency: 'norway',
          filters: { orgs_short: 'multiselect', concerned_years: 'multiselect', title: 'text' },
        },
      ],
    },
    adapters: [adapter],
    secrets: envSecrets({ K: 'k' }),
  }).open({ kind: 'dataset', id: 'digdir/kudos' }, ctx);
  return { knowledge, searches, calls };
};

const reranker = (rank: (r: RerankRequest) => { index: number; score: number; rank: number }[]) => {
  const requests: RerankRequest[] = [];
  const adapter: RerankAdapter = {
    engine: 'stub',
    endpointOptions: z.strictObject({}),
    rerankerOptions: z.strictObject({}),
    connect: () => ({
      rerank: async (_r, request) => {
        requests.push(request);
        return rank(request);
      },
    }),
  };
  const port = new RerankRouter({
    catalog: {
      endpoints: {
        r: {
          engine: 'stub',
          baseURL: 'https://rerank.example',
          auth: { kind: 'api-key', secret: 'secret://env/k' },
        },
      },
      rerankers: [{ id: 'colbert', endpoint: 'r', residency: 'norway' }],
    },
    adapters: [adapter],
    secrets: envSecrets({ K: 'k' }),
  }).open({ kind: 'reranker', id: 'colbert' }, ctx);
  return { port, requests };
};

const metadataOnly = { autoFilter: { enabled: false }, metadataOnly: true };

describe('agent retrieval factory', () => {
  it('searches with the agent filters as typed values and returns summaries with scores and attribution', async () => {
    const s = stub();
    const agent = createAgentRetrieval({
      knowledge: s.knowledge,
      config: metadataOnly,
      facetCache: new FacetCache(),
    });

    const outcome = await agent.search(
      ['årsverk'],
      {
        filters: [
          { field: 'concerned_years', selectedOptions: ['2022'], valueType: 'integer' },
          { field: 'orgs_short', selectedOptions: [] },
        ],
      },
      signal,
    );

    expect(s.searches[0]?.filters).toEqual({ concerned_years: [2022] });
    expect(outcome.chunks[0]).toMatchObject({
      chunkId: 'c1',
      document: 'd1',
      position: 0,
      totalChunks: 2,
      contentLength: 32,
      title: 'Årsrapport 2022',
      headers: ['Ansatte', 'Årsverk'],
      rank: 1,
    });
    expect(outcome.chunks[0]?.score).toBeGreaterThan(0);
    expect(outcome.chunks[0]).not.toHaveProperty('content');
    expect(outcome.attribution).toEqual({ phrase: 0, metadata: 0, content: 2 });
  });

  it('reads chunks and ranges with their content', async () => {
    const s = stub();
    const agent = createAgentRetrieval({ knowledge: s.knowledge });

    const read = await agent.read(['c3', 'c1'], signal);
    const range = await agent.readRange('d1', 0, 1, signal);

    expect(read.map((c) => [c.chunkId, c.content])).toEqual([
      ['c3', 'Tildelingen for 2023.'],
      ['c1', 'Digdir hadde 326 årsverk i 2022.'],
    ]);
    expect(range.map((c) => c.chunkId)).toEqual(['c1', 'c2']);
    expect(s.calls).toEqual(['fetch:c3,c1', 'range:d1:0-1']);
  });

  it('carries the Kudos publish date, an ingestion date and the document version into the chunks', async () => {
    const s = stub([], { ...dated, c2: { ingested_at: '2026-10-01T08:00:00.000Z' } });
    const agent = createAgentRetrieval({ knowledge: s.knowledge });

    const read = await agent.read(['c1', 'c2', 'c3'], signal);

    expect(read.map((c) => [c.chunkId, c.publishedAt, c.version])).toEqual([
      ['c1', '2023-01-15', undefined],
      ['c2', '2026-10-01T08:00:00.000Z', undefined],
      ['c3', '2025-01-01T00:00:00.000Z', 'v2'],
    ]);
  });

  it('lists filter fields with headless type names, and caps facet values', async () => {
    const s = stub();
    const agent = createAgentRetrieval({
      knowledge: s.knowledge,
      valueTypes: { concerned_years: 'integer' },
    });

    expect(await agent.filterFields(signal)).toEqual([
      { field: 'orgs_short', type: 'multiselect', valueType: 'string' },
      { field: 'concerned_years', type: 'multiselect', valueType: 'integer' },
      { field: 'title', type: 'contains', valueType: 'string' },
    ]);
    expect(await agent.facets(['orgs_short', 'secret'], 2, signal)).toEqual({
      orgs_short: [
        { value: 'orgs_short-1', count: 9 },
        { value: 'orgs_short-2', count: 8 },
      ],
    });
    expect(await agent.facets(['secret'], 2, signal)).toEqual({});
  });

  it('reranks read chunks in the reranker order with headers it saw earlier, and leaves them alone without a reranker', async () => {
    const s = stub();
    const r = reranker(() => [
      { index: 1, score: 3, rank: 1 },
      { index: 0, score: 1, rank: 2 },
    ]);
    const agent = createAgentRetrieval({ knowledge: s.knowledge, rerank: r.port });
    const chunks = await agent.read(['c1', 'c3'], signal);

    const reranked = await agent.rerank('årsverk', chunks, signal);

    expect(reranked.map((c) => [c.chunkId, c.rerankScore])).toEqual([
      ['c3', 3],
      ['c1', 1],
    ]);
    expect(r.requests[0]?.documents[0]).toBe(
      'Title: Årsrapport 2022\n\n### Ansatte\n#### ÅrsverkDigdir hadde 326 årsverk i 2022.',
    );
    expect(await createAgentRetrieval({ knowledge: s.knowledge }).rerank('x', chunks, signal)).toBe(
      chunks,
    );
  });

  it('agent search reranks with the service reranker unless rerank is explicitly disabled', async () => {
    const r = reranker((request) =>
      request.documents.map((_, i) => ({ index: i, score: i, rank: request.documents.length - i })),
    );
    const on = await createAgentRetrieval({
      knowledge: stub().knowledge,
      rerank: r.port,
      config: metadataOnly,
      facetCache: new FacetCache(),
    }).search(['årsverk'], {}, signal);
    expect(r.requests).toHaveLength(1);
    expect(on.attribution?.rerankEnabled).toBe(true);
    expect(on.chunks[0]?.rerankScore).toBeDefined();

    const off = await createAgentRetrieval({
      knowledge: stub().knowledge,
      rerank: r.port,
      config: { ...metadataOnly, rerank: { enabled: false } },
      facetCache: new FacetCache(),
    }).search(['årsverk'], {}, signal);
    expect(r.requests).toHaveLength(1);
    expect(off.attribution?.rerankEnabled).toBeUndefined();
  });

  it('plans with the raw query by default or with the planner it is given, and honours a cancelled signal', async () => {
    const s = stub();
    const controller = new AbortController();
    controller.abort();

    expect(await createAgentRetrieval({ knowledge: s.knowledge }).plan('hei', [], signal)).toEqual({
      queries: ['hei'],
    });
    expect(
      await createAgentRetrieval({
        knowledge: s.knowledge,
        plan: async (q) => ({ queries: [q, `${q} utvidet`], userIntent: q }),
      }).plan('hei', [], signal),
    ).toEqual({ queries: ['hei', 'hei utvidet'], userIntent: 'hei' });
    await expect(
      createAgentRetrieval({ knowledge: s.knowledge }).search(['x'], {}, controller.signal),
    ).rejects.toThrow();
    expect(s.searches).toHaveLength(0);
  });
});

describe('rag retrieval factory', () => {
  it('retrieves full chunks, fetching content the metadata-only pipeline left out', async () => {
    const s = stub();
    const rag = createRagRetrieval({ knowledge: s.knowledge, config: metadataOnly });

    const result = await rag.retrieve(['årsverk'], {}, signal);

    expect(result.chunks.map((c) => [c.chunkId, c.content])).toEqual([
      ['c1', 'Digdir hadde 326 årsverk i 2022.'],
      ['c3', 'Tildelingen for 2023.'],
    ]);
    expect(s.calls).toEqual(['fetch:c1,c3', 'fetch:c1,c3']);
    expect(result.attribution?.content).toBe(2);
  });

  it('narrows a step search to the filters the step gives, and the caller filter still wins on the same field', async () => {
    const s = stub();
    const rag = createRagRetrieval({
      knowledge: s.knowledge,
      config: { autoFilter: { enabled: false } },
      filters: { concerned_years: [2023] },
    });

    await rag.retrieve(
      ['årsverk'],
      { filters: { orgs_short: ['DIGDIR'], concerned_years: [2022] } },
      signal,
    );

    expect(s.searches.length).toBeGreaterThan(0);
    expect(
      s.searches.every(
        (r) => JSON.stringify(r.filters) === '{"orgs_short":["DIGDIR"],"concerned_years":[2023]}',
      ),
    ).toBe(true);
  });

  it('names documents left out for lack of text in the attribution', async () => {
    const s = stub(['c3']);
    const rag = createRagRetrieval({
      knowledge: s.knowledge,
      config: { autoFilter: { enabled: false } },
    });

    const result = await rag.retrieve(['årsverk'], {}, signal);

    expect(result.chunks.map((c) => c.chunkId)).toEqual(['c1']);
    expect(result.attribution?.skipped).toEqual([
      { document: 'Tildelingsbrev 2023', reason: 'no_text' },
    ]);
  });

  it('uses content from the pipeline when it has it, and reranks through the same port', async () => {
    const s = stub();
    const r = reranker(() => [{ index: 1, score: 2, rank: 1 }]);
    const rag = createRagRetrieval({
      knowledge: s.knowledge,
      rerank: r.port,
      config: { autoFilter: { enabled: false } },
    });

    const result = await rag.retrieve(['årsverk'], { userIntent: 'årsverk' }, signal);
    const reranked = await rag.rerank('årsverk', result.chunks, signal);

    expect(s.calls).toEqual(['fetch:c1,c3']);
    expect(reranked.map((c) => c.chunkId)).toEqual(['c3']);
    expect(await rag.plan('q', [], signal)).toEqual({ queries: ['q'] });
  });
});

describe("the caller's filter from retrieve-filter-by", () => {
  it('applies to every search, wins over the model on the same field, and is reported', async () => {
    const s = stub();
    const agent = createAgentRetrieval({
      knowledge: s.knowledge,
      config: metadataOnly,
      facetCache: new FacetCache(),
      filters: { orgs_short: ['DIGDIR'] },
    });

    const out = await agent.search(
      ['årsverk'],
      {
        filters: [
          { field: 'orgs_short', selectedOptions: ['NAV'] },
          { field: 'concerned_years', selectedOptions: ['2022'] },
        ],
      },
      signal,
    );
    await agent.search(['årsverk'], {}, signal);

    expect(s.searches[0]?.filters).toEqual({ orgs_short: ['DIGDIR'], concerned_years: ['2022'] });
    expect(s.searches.at(-1)?.filters).toEqual({ orgs_short: ['DIGDIR'] });
    expect(out.attribution?.callerFilter).toEqual([
      {
        type: 'multiselect',
        field: 'orgs_short',
        'selected-options': ['DIGDIR'],
        'value-type': 'string',
      },
    ]);
  });

  it('scopes the RAG retrieval too', async () => {
    const s = stub();
    const rag = createRagRetrieval({
      knowledge: s.knowledge,
      config: metadataOnly,
      facetCache: new FacetCache(),
      filters: { title: { contains: ['2023'] } },
    });

    await rag.retrieve(['tildeling'], {}, signal);

    expect(
      s.searches.every((r) => JSON.stringify(r.filters) === '{"title":{"contains":["2023"]}}'),
    ).toBe(true);
  });
});

describe('documents for step flows', () => {
  const hit = (id: string, document: string, title: string): Hit => ({
    id,
    score: 0,
    text: '',
    title,
    document,
    fields: { docs: { publish_date: '2024-03-01' } },
  });
  const port = (extra: Partial<KnowledgePort> = {}) => {
    const searches: SearchRequest[] = [];
    const ranges: string[] = [];
    const knowledge: KnowledgePort = {
      info: () => ({
        id: 'digdir/kudos',
        residency: 'norway',
        filters: { type: 'multiselect' },
        profiles: ['content', 'doc-title'],
      }),
      search: async (request) => {
        searches.push(request);
        return { hits: [hit('a-0', 'a', 'A'), hit('a-1', 'a', 'A'), hit('b-0', 'b', 'B')] };
      },
      searchMany: async () => [],
      fetch: async () => [],
      range: async (document, from, to) => {
        ranges.push(`${document}:${from}-${to}`);
        const last = document === 'lang' ? 119 : 0;
        return Array.from({ length: Math.max(0, Math.min(to, last) - from + 1) }, (_, i) =>
          hit(`${document}-${from + i}`, document, document.toUpperCase()),
        );
      },
      facets: async () => ({}),
      ...extra,
    };
    return { knowledge, searches, ranges };
  };

  it('lists documents with the match-all query on the document title profile, once each', async () => {
    const p = port();

    const listed = await listDocuments(
      p.knowledge,
      { filters: { type: ['Årsrapport'] }, limit: 20 },
      { orgs_short: ['DIGDIR'] },
      signal,
    );

    expect(p.searches).toEqual([
      {
        query: '*',
        profile: 'doc-title',
        filters: { type: ['Årsrapport'], orgs_short: ['DIGDIR'] },
        limit: 20,
      },
    ]);
    expect(listed.map((d) => [d.id, d.title, d.publishedAt])).toEqual([
      ['a', 'A', '2024-03-01'],
      ['b', 'B', '2024-03-01'],
    ]);
  });

  it('lists documents by id from their first chunk, and pages through the port when it lists documents itself', async () => {
    const p = port();
    expect(
      (await listDocuments(p.knowledge, { ids: ['x', 'x', 'y'], limit: 5 }, undefined, signal)).map(
        (d) => d.id,
      ),
    ).toEqual(['x', 'y']);
    expect(p.ranges).toEqual(['x:0-0', 'y:0-0']);

    const pages: unknown[] = [];
    const listing = port({
      documents: async (request) => {
        pages.push(request);
        const n = Math.min(request.limit ?? 0, 300 - (request.offset ?? 0));
        return { documents: Array.from({ length: n }, (_, i) => ({ id: `d${i}`, fields: {} })) };
      },
    });
    const all = await listDocuments(listing.knowledge, { limit: 400 }, undefined, signal);
    expect(all).toHaveLength(300);
    expect(pages).toEqual([
      { limit: 250, offset: 0 },
      { limit: 150, offset: 250 },
    ]);
  });

  it('reads a whole document in windows the port accepts', async () => {
    const p = port();
    const rag = createRagRetrieval({ knowledge: p.knowledge });

    const chunks = await rag.readDocument('lang', 500, signal);

    expect(chunks).toHaveLength(120);
    expect(p.ranges).toEqual(['lang:0-49', 'lang:50-99', 'lang:100-149']);
  });
});
