import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { envSecrets, type PortContext } from '@genai/kernel';
import {
  KnowledgeError,
  KnowledgeRouter,
  knowledgeCapabilities,
  type FilterValue,
  type Hit,
  type KnowledgeAdapter,
  type KnowledgeCapability,
  type SearchRequest,
} from '@genai/port-knowledge';
import { memoryEngine, openTarget, seedCorpus } from '@genai/port-knowledge/testing';
import {
  RerankRouter,
  type Ranked,
  type RerankAdapter,
  type RerankRequest,
} from '@genai/port-rerank';
import { FacetCache, retrieve } from './pipeline.js';

const ctx: PortContext = {
  tenant: '991825827',
  principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
  task: 't1',
  signal: new AbortController().signal,
  meter: async () => undefined,
};

interface Doc {
  document: string;
  position: number;
  text: string;
  title: string;
  metadata?: string;
  digest?: string;
}

const corpus: Record<string, Doc> = {
  c1: {
    document: 'd1',
    position: 0,
    title: 'Årsrapport 2022 Digdir',
    text: 'Digdir hadde 326 årsverk i 2022.',
    metadata: '{"Header 1" "Ansatte"}',
    digest: 'sha-1',
  },
  c2: {
    document: 'd1',
    position: 1,
    title: 'Årsrapport 2022 Digdir',
    text: 'Budsjettet var stort.',
    digest: 'sha-1',
  },
  c3: {
    document: 'd2',
    position: 0,
    title: 'Årsrapport 2022 Digdir (kopi)',
    text: 'Digdir hadde 326 årsverk.',
    digest: 'sha-1',
  },
  c4: { document: 'd3', position: 0, title: 'Tildelingsbrev 2023', text: 'Tildelingen for 2023.' },
  c5: {
    document: 'd5',
    position: 0,
    title: 'Evaluering av veiledningstjenesten (2019)',
    text: ' ',
  },
};

type Script = (request: SearchRequest) => string[];

interface StubOptions {
  profiles?: string[];
  capabilities?: KnowledgeCapability[];
  refuse?: (request: SearchRequest) => boolean;
}

const knowledgeStub = (script: Script, options: StubOptions = {}) => {
  const batches: SearchRequest[][] = [];
  const fetched: string[][] = [];
  const ranges: string[] = [];
  const facetCalls: string[][] = [];
  const toHit = (id: string, score: number): Hit => {
    const d = corpus[id] as Doc;
    return {
      id,
      score,
      text: d.text,
      title: d.title,
      document: d.document,
      position: d.position,
      fields: {
        ...(d.metadata ? { metadata: d.metadata } : {}),
        docs: {
          orgs_long: ['Digitaliseringsdirektoratet'],
          orgs_short: ['Digdir'],
          ...(d.digest ? { file_sha256: [d.digest] } : {}),
        },
      },
    };
  };
  const adapter: KnowledgeAdapter = {
    engine: 'stub',
    endpointOptions: z.strictObject({}),
    datasetOptions: z.strictObject({}),
    ...(options.capabilities ? { capabilities: () => options.capabilities ?? [] } : {}),
    connect: () => ({
      profiles: () => options.profiles ?? ['phrase', 'metadata', 'content', 'doc-title'],
      search: async (_d, requests) => {
        batches.push(requests);
        if (requests.some((r) => options.refuse?.(r)))
          throw new KnowledgeError('unsupported', 'engine cannot run this search');
        return requests.map((r) => ({
          hits: script(r).map((id, i) =>
            r.profile === 'doc-title'
              ? { id, score: 100 - i, text: id, document: id, fields: {} }
              : toHit(id, 1 - i * 0.1),
          ),
        }));
      },
      fetch: async (_d, ids) => {
        fetched.push(ids);
        return ids.filter((id) => id in corpus).map((id) => toHit(id, 0));
      },
      range: async (_d, document, from, to) => {
        ranges.push(`${document}:${from}-${to}`);
        return Object.keys(corpus)
          .filter((id) => corpus[id]?.document === document)
          .map((id) => toHit(id, 0));
      },
      facets: async (_d, fields) => {
        facetCalls.push(fields);
        return {
          orgs_long: [{ value: 'Digitaliseringsdirektoratet', count: 9 }],
          orgs_short: [{ value: 'Digdir', count: 9 }],
        };
      },
    }),
  };
  const port = new KnowledgeRouter({
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
          filters: {
            orgs_long: 'multiselect',
            orgs_short: 'multiselect',
            title: 'text',
            type: 'multiselect',
          },
        },
      ],
    },
    adapters: [adapter],
    secrets: envSecrets({ K: 'k' }),
  }).open({ kind: 'dataset', id: 'digdir/kudos' }, ctx);
  return { port, batches, fetched, ranges, facetCalls };
};

const rerankStub = (
  rank: (r: RerankRequest) => Ranked[] | Promise<Ranked[]>,
  onFailure: 'degrade' | 'fail' = 'degrade',
) => {
  const requests: RerankRequest[] = [];
  const warnings: string[] = [];
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
        colbert: {
          engine: 'stub',
          baseURL: 'https://rerank.example',
          auth: { kind: 'api-key', secret: 'secret://env/k' },
        },
      },
      rerankers: [{ id: 'colbert', endpoint: 'colbert', residency: 'norway', onFailure }],
    },
    adapters: [adapter],
    secrets: envSecrets({ K: 'k' }),
    onWarning: (m) => warnings.push(m),
  }).open({ kind: 'dataset', id: 'colbert' }, ctx);
  return { port, requests, warnings };
};

const at = <T>(items: readonly T[] | undefined, i: number): T => {
  const item = items?.[i];
  if (item === undefined) throw new Error(`missing item ${i}`);
  return item;
};

const filtersOf = (r: SearchRequest): Record<string, FilterValue> => r.filters ?? {};

describe('retrieval pipeline', () => {
  it('runs every strategy for every query in one batch, with org and year auto-filters', async () => {
    const k = knowledgeStub((r) =>
      r.profile === 'content' ? ['c1', 'c4'] : r.profile === 'phrase' ? ['c4'] : [],
    );

    const result = await retrieve({
      knowledge: k.port,
      queries: ['Hvor mange årsverk hadde Digdir i 2022?', 'årsverk Digdir'],
      facetCache: new FacetCache(),
    });

    expect(k.batches).toHaveLength(1);
    expect(k.batches[0]?.map((r) => `${r.profile}:${r.query}`)).toEqual([
      'phrase:Hvor mange årsverk hadde Digdir i 2022?',
      'phrase:årsverk Digdir',
      'metadata:Hvor mange årsverk hadde Digdir i 2022?',
      'metadata:årsverk Digdir',
      'content:Hvor mange årsverk hadde Digdir i 2022?',
      'content:årsverk Digdir',
    ]);
    expect(filtersOf(at(at(k.batches, 0), 0))).toEqual({
      orgs_short: ['Digdir'],
      title: { contains: ['2022'] },
    });
    expect(k.batches[0]?.every((r) => r.limit === 30)).toBe(true);
    expect(k.facetCalls).toEqual([['orgs_long', 'orgs_short']]);
    expect(result.trace.expansion.hitsPerStrategy).toEqual({ phrase: 1, metadata: 0, content: 2 });
    expect(result.chunks.map((c) => c.id)).toEqual(['c4', 'c1']);
    expect(result.chunks[0]?.retrievalPrior).toBeCloseTo(2 + 0.07 + 0.4 + 0.43, 10);
    expect(result.chunks[1]?.retrievalPrior).toBeCloseTo(
      1 + 0.1 + 0.06 + 0.15 + 0.4 + 0.2 + 0.45 + 0.35,
      10,
    );
  });

  it('lets an explicit filter win over a detected one, and retries without auto-filters on zero hits', async () => {
    const k = knowledgeStub((r) => ('title' in filtersOf(r) ? [] : ['c4']));

    const result = await retrieve({
      knowledge: k.port,
      queries: ['Tildelingsbrev 2023 Digdir'],
      filters: { orgs_short: ['NAV'] },
      facetCache: new FacetCache(),
      config: { strategies: [{ name: 'content', profiles: ['content'] }] },
    });

    expect(filtersOf(at(at(k.batches, 0), 0))).toEqual({
      orgs_short: ['NAV'],
      title: { contains: ['2023'] },
    });
    expect(filtersOf(at(at(k.batches, 1), 0))).toEqual({ orgs_short: ['NAV'] });
    expect(result.trace.expansion.autoFilterFallback).toBe(true);
    expect(result.chunks.map((c) => c.id)).toEqual(['c4']);
  });

  it('caches facet values per dataset for the configured time', async () => {
    const k = knowledgeStub(() => ['c4']);
    const cache = new FacetCache();
    let clock = 0;
    const run = () =>
      retrieve({ knowledge: k.port, queries: ['Digdir'], facetCache: cache, now: () => clock });

    await run();
    clock = 299_999;
    await run();
    clock = 300_000;
    await run();

    expect(k.facetCalls).toHaveLength(2);
  });

  it('suppresses a second registration of one file only when content is fetched', async () => {
    const script: (r: SearchRequest) => string[] = (r) =>
      r.profile === 'content' ? ['c1', 'c3', 'c2'] : [];
    const full = await retrieve({
      knowledge: knowledgeStub(script).port,
      queries: ['x'],
      config: { autoFilter: { enabled: false } },
    });
    const metadataOnly = await retrieve({
      knowledge: knowledgeStub(script).port,
      queries: ['x'],
      config: { autoFilter: { enabled: false }, metadataOnly: true },
    });

    expect(full.chunks.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect(full.trace.expansion.droppedAsDuplicateFile).toBe(1);
    expect(metadataOnly.chunks.map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(metadataOnly.chunks.every((c) => c.text === undefined)).toBe(true);
  });

  it('fetches at most retrieve-top-k chunks and caps chunks per document', async () => {
    const k = knowledgeStub((r) => (r.profile === 'content' ? ['c1', 'c2', 'c4'] : []));

    const result = await retrieve({
      knowledge: k.port,
      queries: ['x'],
      config: {
        autoFilter: { enabled: false },
        retrieveTopK: 2,
        maxPerDocument: 1,
        duplicateFiles: 'never',
      },
    });

    expect(k.fetched).toEqual([['c1', 'c2']]);
    expect(result.chunks.map((c) => c.id)).toEqual(['c1']);
    expect(result.trace.expansion).toMatchObject({
      effectiveMaxPerDocument: 1,
      droppedByDiversity: 1,
    });
  });

  it('reranks the top candidates with title, headers and the best window, and attaches snippets', async () => {
    const k = knowledgeStub((r) => (r.profile === 'content' ? ['c1', 'c4', 'c2'] : []));
    const rr = rerankStub((r) =>
      r.documents.map((_, i) => ({ index: i, score: i, rank: r.documents.length - i })),
    );

    const result = await retrieve({
      knowledge: k.port,
      rerank: rr.port,
      queries: ['årsverk'],
      config: {
        autoFilter: { enabled: false },
        duplicateFiles: 'never',
        rerank: { enabled: true, candidateK: 2 },
        metadataOnly: true,
      },
    });

    expect(rr.requests[0]?.query).toBe('årsverk');
    expect(rr.requests[0]?.documents[0]).toBe(
      'Title: Årsrapport 2022 Digdir\n\n### AnsatteDigdir hadde 326 årsverk i 2022.',
    );
    expect(result.chunks.map((c) => [c.id, c.rerankScore])).toEqual([
      ['c4', 1],
      ['c1', 0],
      ['c2', undefined],
    ]);
    expect(result.chunks[1]?.snippet).toBe('Digdir hadde 326 årsverk i 2022.');
    expect(result.chunks[2]?.snippet).toBeUndefined();
    expect(result.chunks[0]?.text).toBeUndefined();
    expect(result.trace.expansion.rerank).toMatchObject({ status: 'reranked', candidates: 2 });
  });

  it('keeps retrieval order when the reranker fails in degrade mode, and warns once per tenant', async () => {
    const k = knowledgeStub((r) => (r.profile === 'content' ? ['c1', 'c4'] : []));
    const rr = rerankStub(() => Promise.reject(new Error('connection refused')));
    const run = () =>
      retrieve({
        knowledge: k.port,
        rerank: rr.port,
        queries: ['x'],
        config: { autoFilter: { enabled: false }, rerank: { enabled: true } },
      });

    const first = await run();
    await run();

    expect(first.chunks.map((c) => c.id)).toEqual(['c1', 'c4']);
    expect(first.chunks.every((c) => c.snippet === undefined && c.rerankScore === undefined)).toBe(
      true,
    );
    expect(first.trace.expansion.rerank).toMatchObject({
      status: 'degraded',
      error: 'connection refused',
    });
    expect(rr.warnings).toHaveLength(1);
  });

  it('fails retrieval when the reranker fails in fail mode', async () => {
    const k = knowledgeStub((r) => (r.profile === 'content' ? ['c1'] : []));
    const rr = rerankStub(() => Promise.reject(new Error('down')), 'fail');

    await expect(
      retrieve({
        knowledge: k.port,
        rerank: rr.port,
        queries: ['x'],
        config: { autoFilter: { enabled: false }, rerank: { enabled: true } },
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('keeps order with snippets when no reranker is configured or it answers with nothing', async () => {
    const script: (r: SearchRequest) => string[] = (r) =>
      r.profile === 'content' ? ['c1', 'c4'] : [];
    const config = { autoFilter: { enabled: false }, rerank: { enabled: true } };
    const unconfigured = await retrieve({
      knowledge: knowledgeStub(script).port,
      queries: ['årsverk'],
      config,
    });
    const empty = await retrieve({
      knowledge: knowledgeStub(script).port,
      rerank: rerankStub(() => []).port,
      queries: ['årsverk'],
      config,
    });

    for (const result of [unconfigured, empty]) {
      expect(result.chunks.map((c) => c.id)).toEqual(['c1', 'c4']);
      expect(result.chunks[0]?.snippet).toBe('Digdir hadde 326 årsverk i 2022.');
    }
    expect(unconfigured.trace.expansion.rerank.status).toBe('unconfigured');
    expect(empty.trace.expansion.rerank.status).toBe('empty');
  });

  it('adds a doc-title strategy that fans out to the first chunks of the best documents', async () => {
    const k = knowledgeStub((r) => (r.profile === 'doc-title' ? ['d3', 'd1'] : []));

    const result = await retrieve({
      knowledge: k.port,
      queries: ['tildelingsbrev'],
      config: {
        autoFilter: { enabled: false },
        docTitle: { profiles: ['doc-title'], fanout: 2 },
        duplicateFiles: 'never',
      },
    });

    expect(k.ranges).toEqual(['d3:0-1', 'd1:0-1']);
    expect(result.trace.expansion.hitsPerStrategy['doc-title']).toBe(3);
    expect(result.trace.expansion.merged.map((m) => m.id)).toEqual(['c4', 'c1', 'c2']);
  });

  it('runs a second pass for a distinct user intent and merges with the configured union', async () => {
    const k = knowledgeStub((r) =>
      r.profile !== 'content' ? [] : r.query === 'intent' ? ['c4'] : ['c1', 'c4'],
    );
    const config = { autoFilter: { enabled: false }, userIntentUnion: { enabled: true, cap: 1 } };

    const result = await retrieve({
      knowledge: k.port,
      queries: ['a', 'b'],
      userIntent: ' intent ',
      config,
    });
    const same = await retrieve({
      knowledge: k.port,
      queries: ['intent'],
      userIntent: 'intent',
      config,
    });

    expect(result.chunks.map((c) => c.id)).toEqual(['c4', 'c1']);
    expect(result.trace.union).toEqual({ mode: 'cap', cap: 1, rrfK: 60 });
    expect(result.trace.intent?.queries).toEqual(['intent']);
    expect(same.trace.intent).toBeUndefined();
  });

  it('continues without auto-filters when facets fail', async () => {
    const k = knowledgeStub(() => ['c4']);
    vi.spyOn(k.port, 'facets').mockRejectedValue(new Error('facets down'));

    const result = await retrieve({
      knowledge: k.port,
      queries: ['Digdir'],
      facetCache: new FacetCache(),
    });

    expect(result.trace.expansion.autoFilterError).toBe('facets down');
    expect(result.chunks.map((c) => c.id)).toEqual(['c4']);
  });
  describe('engine capabilities', () => {
    const allCapabilities = [...knowledgeCapabilities];
    const numericQueries = ['Hvor mange årsverk hadde Digdir i 2022?', 'årsverk Digdir'];
    const numericScript: Script = (r) =>
      r.profile === 'content' ? ['c1', 'c4'] : r.profile === 'phrase' ? ['c4'] : [];

    it('strategies whose profile the dataset lacks are skipped with a notice', async () => {
      const k = knowledgeStub((r) => (r.profile === 'content' ? ['c4'] : []), {
        profiles: ['content'],
      });

      const result = await retrieve({
        knowledge: k.port,
        queries: ['x'],
        config: {
          autoFilter: { enabled: false },
          enrichment: [{ type: 'verified-phrases', profiles: ['verified'] }],
        },
      });

      expect(k.batches[0]?.map((r) => r.profile)).toEqual(['content']);
      expect(result.trace.expansion.hitsPerStrategy).toEqual({ content: 1 });
      expect(result.trace.expansion.warnings).toEqual([
        'skipped phrase search: dataset lacks profile phrase',
        'skipped metadata search: dataset lacks profile metadata',
        'skipped verified-phrases search: dataset lacks profile verified',
      ]);
      expect(result.chunks.map((c) => c.id)).toEqual(['c4']);
    });

    it('searches the first dataset profile with a notice when no configured profile exists', async () => {
      const k = knowledgeStub(() => ['c4'], { profiles: ['default'] });

      const result = await retrieve({
        knowledge: k.port,
        queries: ['x'],
        config: { autoFilter: { enabled: false } },
      });

      expect(k.batches[0]?.map((r) => r.profile)).toEqual(['default']);
      expect(result.trace.expansion.warnings).toContain(
        'no configured profile on dataset, searching default',
      );
      expect(result.chunks.map((c) => c.id)).toEqual(['c4']);
    });

    it('leaves out hits without text and says which document and why', async () => {
      const k = knowledgeStub((r) => (r.profile === 'content' ? ['c4', 'c5'] : []));

      const result = await retrieve({
        knowledge: k.port,
        queries: ['x'],
        config: { autoFilter: { enabled: false } },
      });

      expect(result.chunks.map((c) => c.id)).toEqual(['c4']);
      expect(result.trace.expansion.skipped).toEqual([
        { document: 'Evaluering av veiledningstjenesten (2019)', reason: 'no_text' },
      ]);
    });

    it('auto-filter is skipped without the facets capability', async () => {
      const k = knowledgeStub(numericScript, {
        capabilities: allCapabilities.filter((c) => c !== 'facets'),
      });

      const result = await retrieve({
        knowledge: k.port,
        queries: numericQueries,
        facetCache: new FacetCache(),
      });

      expect(k.facetCalls).toEqual([]);
      expect(filtersOf(at(at(k.batches, 0), 0))).toEqual({ title: { contains: ['2022'] } });
      expect(result.trace.expansion.autoFilterError).toBeUndefined();
      expect(result.trace.expansion.warnings).toEqual([
        'skipped org auto-filter: engine lacks facets',
      ]);
      expect(result.chunks.map((c) => c.id)).toEqual(['c4', 'c1']);
    });

    it('skips a detected filter whose kind the engine cannot filter on', async () => {
      const k = knowledgeStub(numericScript, {
        capabilities: allCapabilities.filter((c) => c !== 'filter.text'),
      });

      const result = await retrieve({
        knowledge: k.port,
        queries: numericQueries,
        facetCache: new FacetCache(),
      });

      expect(filtersOf(at(at(k.batches, 0), 0))).toEqual({ orgs_short: ['Digdir'] });
      expect(result.trace.expansion.warnings).toEqual([
        'skipped auto-filter on title: engine lacks filter.text',
      ]);
    });

    it('skips org auto-filter fields the dataset does not declare, without a notice', async () => {
      const k = knowledgeStub(() => ['c4']);

      const result = await retrieve({
        knowledge: k.port,
        queries: ['Digdir'],
        facetCache: new FacetCache(),
        config: { autoFilter: { orgFields: ['orgs_short', 'departments'] } },
      });

      expect(k.facetCalls).toEqual([['orgs_short']]);
      expect(result.trace.expansion.warnings).toEqual([]);
    });

    it('notes an org auto-filter field the dataset declares as something other than multiselect', async () => {
      const k = knowledgeStub(() => ['c4']);

      const result = await retrieve({
        knowledge: k.port,
        queries: ['Digdir'],
        facetCache: new FacetCache(),
        config: { autoFilter: { orgFields: ['orgs_short', 'title'] } },
      });

      expect(result.trace.expansion.warnings).toContain(
        'skipped org auto-filter on title: dataset lacks a multiselect field',
      );
    });

    it('the doc-title fan-out is skipped without range', async () => {
      const k = knowledgeStub(
        (r) => (r.profile === 'doc-title' ? ['d3'] : r.profile === 'content' ? ['c1'] : []),
        { capabilities: allCapabilities.filter((c) => c !== 'range') },
      );

      const result = await retrieve({
        knowledge: k.port,
        queries: ['tildelingsbrev'],
        config: {
          autoFilter: { enabled: false },
          docTitle: { profiles: ['doc-title'], fanout: 2 },
        },
      });

      expect(k.ranges).toEqual([]);
      expect(k.batches.flat().some((r) => r.profile === 'doc-title')).toBe(false);
      expect(result.trace.expansion.hitsPerStrategy['doc-title']).toBeUndefined();
      expect(result.trace.expansion.warnings).toEqual([
        'skipped doc-title fan-out: engine lacks range',
      ]);
      expect(result.chunks.map((c) => c.id)).toEqual(['c1']);
    });

    it('uses search hits with a notice when the engine lacks fetch', async () => {
      const k = knowledgeStub((r) => (r.profile === 'content' ? ['c1', 'c4'] : []), {
        capabilities: allCapabilities.filter((c) => c !== 'fetch'),
      });

      const result = await retrieve({
        knowledge: k.port,
        queries: ['x'],
        config: { autoFilter: { enabled: false } },
      });

      expect(k.fetched).toEqual([]);
      expect(result.chunks.map((c) => c.id).sort()).toEqual(['c1', 'c4']);
      expect(result.chunks.find((c) => c.id === 'c1')?.text).toBe(
        'Digdir hadde 326 årsverk i 2022.',
      );
      expect(result.trace.expansion.warnings).toEqual([
        'skipped fetch: engine lacks fetch, using search hits',
      ]);
    });

    it('an unsupported error from the engine becomes a notice, not a failed run', async () => {
      const k = knowledgeStub((r) => (r.profile === 'content' ? ['c4'] : []), {
        refuse: (r) => r.profile === 'phrase',
      });

      const result = await retrieve({
        knowledge: k.port,
        queries: ['x'],
        config: { autoFilter: { enabled: false } },
      });

      expect(result.chunks.map((c) => c.id)).toEqual(['c4']);
      expect(result.trace.expansion.hitsPerStrategy).toEqual({
        phrase: 0,
        metadata: 0,
        content: 1,
      });
      expect(result.trace.expansion.warnings).toEqual([
        'skipped phrase search: engine cannot run this search',
      ]);
    });

    it('turns unsupported fetch, range and facets calls into notices', async () => {
      const k = knowledgeStub((r) => (r.profile === 'doc-title' ? ['d3'] : ['c1']));
      const refuse = (what: string) => async () => {
        throw new KnowledgeError('unsupported', `no ${what}`);
      };
      vi.spyOn(k.port, 'fetch').mockImplementation(refuse('fetch'));
      vi.spyOn(k.port, 'range').mockImplementation(refuse('range'));
      vi.spyOn(k.port, 'facets').mockImplementation(refuse('facets'));

      const result = await retrieve({
        knowledge: k.port,
        queries: ['Digdir'],
        facetCache: new FacetCache(),
        config: { docTitle: { profiles: ['doc-title'] } },
      });

      expect(result.chunks.map((c) => c.id)).toEqual(['c1']);
      expect(result.trace.expansion.autoFilterError).toBeUndefined();
      expect(result.trace.expansion.warnings).toEqual([
        'skipped org auto-filter: no facets',
        'skipped doc-title fan-out: no range',
        'skipped fetch: no fetch, using search hits',
      ]);
    });

    it('a dataset with every capability retrieves exactly as before', async () => {
      const run = async (options: StubOptions) => {
        const k = knowledgeStub(numericScript, options);
        const result = await retrieve({
          knowledge: k.port,
          queries: numericQueries,
          facetCache: new FacetCache(),
          config: { docTitle: { profiles: ['doc-title'] } },
        });
        return { k, result };
      };

      const legacy = await run({});
      const full = await run({ capabilities: allCapabilities });

      expect(full.k.batches).toEqual(legacy.k.batches);
      expect(full.k.fetched).toEqual(legacy.k.fetched);
      expect(full.k.facetCalls).toEqual([['orgs_long', 'orgs_short']]);
      expect(full.result).toEqual(legacy.result);
      expect(full.result.trace.expansion.warnings).toEqual([]);
      expect(full.result.chunks.map((c) => c.id)).toEqual(['c4', 'c1']);
    });

    it('retrieves from a text-only memory engine with notices for what it lacks', async () => {
      const engine = memoryEngine({ capabilities: ['search.text', 'filter.select'] });
      const dataset = { id: 'kapabiliteter', filters: { virksomheter: 'multiselect' as const } };
      const writer = engine.writer.connect(
        { options: {}, timeoutMs: 1000 },
        {
          signal: new AbortController().signal,
        },
      );
      await seedCorpus(writer, { id: dataset.id, filters: dataset.filters, options: {} });
      const port = openTarget({ adapter: engine.adapter }, dataset);

      const result = await retrieve({
        knowledge: port,
        queries: ['skyplattform'],
        facetCache: new FacetCache(),
        config: {
          autoFilter: { orgFields: ['virksomheter'] },
          docTitle: { profiles: ['doc-title'] },
        },
      });

      expect(result.chunks.map((c) => c.id)).toEqual(['dok-1-2']);
      expect(result.trace.expansion.warnings).toEqual([
        'skipped org auto-filter: engine lacks facets',
        'skipped doc-title fan-out: engine lacks range',
        'skipped fetch: engine lacks fetch, using search hits',
      ]);
    });
  });
});
