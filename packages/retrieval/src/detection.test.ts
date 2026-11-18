import { describe, expect, it } from 'vitest';
import type { Hit, KnowledgePort, SearchRequest } from '@genai/port-knowledge';
import { createAgentRetrieval, createRagRetrieval } from './factories.js';
import { FacetCache, retrieve } from './pipeline.js';

const doc = (id: string, title: string, long: string[], short: string[]): Hit => ({
  id,
  score: 1,
  text: `${title}.`,
  title,
  document: id,
  fields: { orgs_long: long, orgs_short: short },
});

const corpus = [
  doc('nav-2022', 'Årsrapport 2022', ['Arbeids- og velferdsdirektoratet'], ['NAV']),
  doc('dfo-eval', 'Evaluering av tilsynet', ['Direktoratet for økonomistyring'], ['DFØ']),
  doc('dt-2023', 'Årsrapport 2023', ['Datatilsynet'], []),
];

const kudos = () => {
  const requests: SearchRequest[] = [];
  const port: KnowledgePort = {
    info: () => ({
      id: 'kudos',
      residency: 'norway',
      filters: { orgs_long: 'multiselect', orgs_short: 'multiselect', title: 'text' },
      profiles: ['content'],
    }),
    searchMany: async (batch) => {
      requests.push(...batch);
      return batch.map(() => ({ hits: corpus }));
    },
    search: async (request) => {
      requests.push(request);
      return { hits: corpus };
    },
    fetch: async (ids) => corpus.filter((h) => ids.includes(h.id)),
    range: async () => [],
    facets: async () => ({
      orgs_long: [
        { value: 'Datatilsynet', count: 9 },
        { value: 'Direktoratet for økonomistyring', count: 9 },
        { value: 'Arbeids- og velferdsdirektoratet', count: 9 },
      ],
      orgs_short: [
        { value: 'NAV', count: 9 },
        { value: 'DFØ', count: 9 },
      ],
    }),
  };
  return { port, requests };
};

const config = { strategies: [{ name: 'content', profiles: ['content'] }] };
const signal = new AbortController().signal;

const run = (queries: string[], extra: Record<string, unknown> = {}) => {
  const k = kudos();
  return retrieve({
    knowledge: k.port,
    queries,
    facetCache: new FacetCache(),
    config: { ...config, ...extra },
  }).then((result) => ({ ...result, requests: k.requests }));
};

describe('an agent and the auto-filter', () => {
  it("an agent's search is never narrowed by an organisation the query only mentions", async () => {
    const k = kudos();
    const agent = createAgentRetrieval({ knowledge: k.port, config, facetCache: new FacetCache() });

    const found = await agent.search(
      ['Hva sier DFØ om Datatilsynet?'],
      { filters: [{ field: 'orgs_short', selectedOptions: ['DFØ'] }] },
      signal,
    );

    expect(k.requests.map((r) => r.filters)).toEqual([{ orgs_short: ['DFØ'] }]);
    expect(found.chunks.map((c) => c.chunkId).sort()).toEqual(['dfo-eval', 'dt-2023', 'nav-2022']);
  });

  it("an agent's search returns what the query names as a hint", async () => {
    const agent = createAgentRetrieval({
      knowledge: kudos().port,
      config,
      facetCache: new FacetCache(),
    });

    const found = await agent.search(['Hva sier DFØ om Datatilsynet?'], {}, signal);

    expect(found.attribution?.detections).toEqual([
      {
        kind: 'organisation',
        field: 'orgs_long',
        values: ['Datatilsynet'],
        queries: ['Hva sier DFØ om Datatilsynet?'],
        use: 'hint',
      },
      {
        kind: 'organisation',
        field: 'orgs_short',
        values: ['DFØ'],
        queries: ['Hva sier DFØ om Datatilsynet?'],
        use: 'hint',
      },
    ]);
    expect(found.attribution?.autoFilter).toBeUndefined();
  });

  it("an agent's hint names the indexed value when the query uses an owner's alias", async () => {
    const agent = createAgentRetrieval({
      knowledge: kudos().port,
      config: {
        ...config,
        autoFilter: { aliases: { 'Direktoratet for økonomistyring': ['DFO'] } },
      },
      facetCache: new FacetCache(),
    });

    const found = await agent.search(['Hva sier DFO om tilsynet?'], {}, signal);

    expect(found.attribution?.detections).toEqual([
      {
        kind: 'organisation',
        field: 'orgs_long',
        values: ['Direktoratet for økonomistyring'],
        queries: ['Hva sier DFO om tilsynet?'],
        use: 'hint',
      },
      {
        kind: 'organisation',
        field: 'orgs_short',
        values: ['DFØ'],
        queries: ['Hva sier DFO om tilsynet?'],
        use: 'hint',
      },
    ]);
  });

  it('an agent gets no hint on a field its search already filters', async () => {
    const agent = createAgentRetrieval({
      knowledge: kudos().port,
      config,
      facetCache: new FacetCache(),
    });

    const found = await agent.search(
      ['Hva sier DFØ om Datatilsynet?'],
      { filters: [{ field: 'orgs_short', selectedOptions: ['NAV'] }] },
      signal,
    );

    expect(found.attribution?.detections?.map((d) => d.field)).toEqual(['orgs_long']);
  });

  it("an agent's filter_by on a text field filters by what the field contains", async () => {
    const k = kudos();
    const agent = createAgentRetrieval({ knowledge: k.port, config, facetCache: new FacetCache() });

    await agent.search(
      ['årsrapport'],
      { filters: [{ field: 'title', selectedOptions: ['2023'] }] },
      signal,
    );

    expect(k.requests[0]?.filters).toEqual({ title: { contains: ['2023'] } });
  });

  it("an agent's search gets a configured rule as a hint, not a filter", async () => {
    const k = kudos();
    const agent = createAgentRetrieval({
      knowledge: k.port,
      config: {
        ...config,
        autoFilter: {
          orgFields: [],
          rules: [
            {
              type: 'shape-pattern',
              field: 'orgs_short',
              patterns: [{ value: 'NAV', regex: '(?i)arbeidsledighet' }],
            },
          ],
        },
      },
      facetCache: new FacetCache(),
    });

    const found = await agent.search(['arbeidsledighet'], {}, signal);

    expect(k.requests.every((r) => r.filters === undefined)).toBe(true);
    expect(found.attribution?.detections).toEqual([
      {
        kind: 'rule',
        field: 'orgs_short',
        values: ['NAV'],
        queries: ['arbeidsledighet'],
        use: 'hint',
      },
    ]);
  });
});

describe('a service without an agent and the auto-filter', () => {
  it('without an agent, hits from the named organisation rank first but others still come back', async () => {
    const result = await run(['Hva sier Datatilsynet?']);

    expect(result.requests.every((r) => r.filters === undefined)).toBe(true);
    expect(result.chunks[0]?.id).toBe('dt-2023');
    expect(result.chunks).toHaveLength(3);
  });

  it('without an agent, a question about one organisation from another keeps both', async () => {
    const result = await run(['Hva sier DFØ om Datatilsynet?']);

    expect(
      result.chunks
        .map((c) => c.id)
        .slice(0, 2)
        .sort(),
    ).toEqual(['dfo-eval', 'dt-2023']);
    expect(result.chunks).toHaveLength(3);
  });

  it('without an agent, the rag factory ranks rather than filters too', async () => {
    const k = kudos();
    const rag = createRagRetrieval({ knowledge: k.port, config, facetCache: new FacetCache() });

    const found = await rag.retrieve(['Datatilsynet'], {}, signal);

    expect(k.requests.every((r) => r.filters === undefined)).toBe(true);
    expect(found.chunks.map((c) => c.chunkId)[0]).toBe('dt-2023');
    expect(found.attribution?.detections?.map((d) => d.use)).toEqual(['boost']);
  });

  it('without query-aware ranking, organisations and years are not looked for', async () => {
    const result = await run(['Datatilsynet 2023'], { queryAwareBoost: false });

    expect(result.trace.expansion.detections).toBeUndefined();
    expect(result.chunks.map((c) => c.id)).toEqual(['nav-2022', 'dfo-eval', 'dt-2023']);
  });

  it('turning the auto-filter off detects nothing', async () => {
    const result = await run(['Datatilsynet 2023'], { autoFilter: { enabled: false } });

    expect(result.trace.expansion.detections).toBeUndefined();
  });
});

describe('the trace', () => {
  it('each detection is recorded in the trace, with the query it came from and its use', async () => {
    const result = await run(['Datatilsynet og NAV', 'Årsrapport 2023']);

    expect(result.trace.expansion.detections).toEqual([
      {
        kind: 'organisation',
        field: 'orgs_long',
        values: ['Datatilsynet'],
        queries: ['Datatilsynet og NAV'],
        use: 'boost',
      },
      {
        kind: 'organisation',
        field: 'orgs_short',
        values: ['NAV'],
        queries: ['Datatilsynet og NAV'],
        use: 'boost',
      },
      {
        kind: 'year',
        field: 'title',
        values: ['2023'],
        queries: ['Årsrapport 2023'],
        use: 'boost',
      },
    ]);
  });

  it('an amount in a query is not recorded as a year', async () => {
    const result = await run(['Kostnad på 2000 kroner i 2023']);

    expect(result.trace.expansion.detections).toEqual([
      expect.objectContaining({ kind: 'year', values: ['2023'] }),
    ]);
  });
});
