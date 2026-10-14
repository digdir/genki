import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { envSecrets, type PortContext } from '@genai/kernel';
import { KnowledgeRouter, type KnowledgePort } from '@genai/port-knowledge';
import { fakeHttp, type FakeReply, type FakeServer } from '@genai/port-model/testing';
import { probeKnowledgeEndpoint } from '@genai/port-knowledge';
import { assertReadOnly, assertSearchOnly, defaultTypesenseProfiles, typesense } from './index.js';

const servers: FakeServer[] = [];
const fake = async (reply: (body: Record<string, unknown>, attempt: number) => FakeReply) => {
  const server = await fakeHttp(reply);
  servers.push(server);
  return server;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const example = parseYaml(
  readFileSync(join(import.meta.dirname, '..', 'examples', 'kudos.yaml'), 'utf8'),
) as {
  endpoints: Record<string, { baseURL: string }>;
  datasets: unknown[];
};

const DOCS = 'KUDOS_preprod_v4_documents_ab897fbdedfa';
const CHUNKS = 'KUDOS_preprod_v4_chunks_ab897fbdedfa';
const PHRASES = 'KUDOS_preprod_v4_phrases_ab897fbdedfa';

const context = (signal = new AbortController().signal): PortContext => ({
  tenant: '991825827',
  principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
  task: 't1',
  signal,
  meter: async () => undefined,
});

const kudos = (url: string): KnowledgePort =>
  new KnowledgeRouter({
    catalog: {
      ...example,
      endpoints: { 'kudos-typesense': { ...example.endpoints['kudos-typesense'], baseURL: url } },
    },
    adapters: [typesense],
    secrets: envSecrets({ TYPESENSE_KEY: 'test-key' }),
  }).open({ kind: 'dataset', id: 'digdir/kudos' }, context());

const searches = (body: Record<string, unknown>) => body.searches as Record<string, unknown>[];

describe('typesense adapter', () => {
  it('sends KA-shaped searches for each profile in one multi_search, with the key header', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: {
        results: [
          {
            found: 1,
            hits: [
              {
                document: { chunk_id: 'c7', search_phrase: 'tildelingsbrev 2025', doc_num: 'd1' },
                hybrid_search_info: { rank_fusion_score: 0.82 },
              },
            ],
          },
          {
            found: 1,
            hits: [
              {
                document: { chunk_id: 'c9', content_markdown: 'Tildelingsbrevet sier ...' },
                text_match_info: { score: '1157451471441100913' },
              },
            ],
          },
        ],
      },
    }));

    const [phrase, content] = await kudos(url).searchMany([
      {
        query: 'tildelingsbrev',
        profile: 'phrase',
        limit: 30,
        filters: { orgs_short: ['DIGDIR'], concerned_years: ['2024'] },
      },
      { query: 'tildelingsbrev', profile: 'content', limit: 30 },
    ]);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/multi_search');
    expect(seen[0]?.headers['x-typesense-api-key']).toBe('test-key');
    expect(searches(seen[0]?.body ?? {})[0]).toEqual({
      collection: PHRASES,
      q: 'tildelingsbrev',
      query_by: 'search_phrase,phrase_vec',
      include_fields: 'chunk_id,search_phrase,doc_num',
      exclude_fields: 'phrase_vec',
      per_page: 30,
      filter_by: `$${DOCS}(orgs_short:=[\`DIGDIR\`] && concerned_years:=[2024])`,
      sort_by: '_text_match:desc',
      prioritize_exact_match: false,
      drop_tokens_threshold: 5,
    });
    expect(phrase?.hits[0]).toMatchObject({
      id: 'c7',
      score: 0.82,
      text: 'tildelingsbrev 2025',
      document: 'd1',
    });
    expect(content?.hits[0]).toMatchObject({
      id: 'c9',
      score: Number('1157451471441100913'),
      text: 'Tildelingsbrevet sier ...',
    });
  });

  it('serialises every filter kind like headless-rag and filters documents directly', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: { results: [{ hits: [] }, { hits: [] }] },
    }));
    const filters = {
      type: ['Tildelingsbrev', 'Årsrapport'],
      concerned_years: [2024, 2025],
      orgs_short: { not: ['NAV'] },
      title: { contains: ['2024', '2025'] },
    };

    await kudos(url).searchMany([
      { query: 'x', profile: 'metadata', filters },
      { query: 'x', profile: 'doc-title', filters: { title: '2025' } },
    ]);

    const [metadata, title] = searches(seen[0]?.body ?? {});
    expect(metadata?.filter_by).toBe(
      `$${DOCS}(type:=[\`Tildelingsbrev\`,\`Årsrapport\`] && concerned_years:=[2024,2025] && orgs_short:!=[\`NAV\`] && (title:2024 || title:2025))`,
    );
    expect(metadata?.collection).toBe(CHUNKS);
    expect(title).toMatchObject({ collection: DOCS, filter_by: 'title:2025' });
  });

  it('quotes words in a contains filter and combines several clauses on one field', async () => {
    const { url, seen } = await fake(() => ({ status: 200, json: { results: [{ hits: [] }] } }));

    await kudos(url).search({
      query: 'x',
      profile: 'doc-title',
      filters: {
        title: { contains: ['Årsrapport 2024'] },
        orgs_short: { all: [['DIGDIR', 'NAV'], { not: ['NAV'] }] },
      },
    });

    expect(searches(seen[0]?.body ?? {})[0]?.filter_by).toBe(
      'title:`Årsrapport 2024` && orgs_short:=[`DIGDIR`,`NAV`] && orgs_short:!=[`NAV`]',
    );
  });

  it.each(['NAV`) || true', 'back\\slash', 'line\nbreak'])(
    'refuses a filter value that could escape its quotes: %j',
    async (value) => {
      const { url, seen } = await fake(() => ({ status: 200, json: { results: [{ hits: [] }] } }));

      await expect(
        kudos(url).search({ query: 'x', filters: { orgs_short: [value] } }),
      ).rejects.toMatchObject({ code: 'bad_request' });
      await expect(kudos(url).range(value, 0, 3)).rejects.toMatchObject({ code: 'bad_request' });
      expect(seen).toHaveLength(0);
    },
  );

  it('keeps going when one search in a batch fails, with a warning for that search', async () => {
    const { url } = await fake(() => ({
      status: 200,
      json: {
        results: [
          { code: 404, error: 'Not found.' },
          { hits: [{ document: { chunk_id: 'c1', metadata: 'm' } }] },
        ],
      },
    }));

    const [failed, ok] = await kudos(url).searchMany([
      { query: 'x', profile: 'phrase' },
      { query: 'x', profile: 'metadata' },
    ]);

    expect(failed).toEqual({ hits: [], warning: 'Not found.' });
    expect(ok?.hits.map((h) => h.id)).toEqual(['c1']);
  });

  it('fetches chunks by id with document fields joined in, in the order asked for', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: {
        results: [
          {
            hits: ['c2', 'c1'].map((id, i) => ({
              document: {
                chunk_id: id,
                doc_num: 'd1',
                chunk_index: i,
                content_markdown: `tekst ${id}`,
                [DOCS]: {
                  title: 'Tildelingsbrev 2025',
                  url: 'https://kudos.dfo.no/d1',
                  total_chunks: 4,
                },
              },
            })),
          },
        ],
      },
    }));

    const hits = await kudos(url).fetch(['c1', 'c2', 'missing']);

    expect(searches(seen[0]?.body ?? {})[0]).toMatchObject({
      collection: CHUNKS,
      q: '*',
      query_by: 'chunk_id',
      filter_by: 'chunk_id:=[`c1`,`c2`,`missing`]',
      per_page: 3,
      include_fields: `id,chunk_id,doc_num,chunk_index,content_markdown,content_length,metadata,$${DOCS}(url,title,total_chunks,orgs_long,orgs_short,file_sha256,files)`,
    });
    expect(hits.map((h) => [h.id, h.title, h.url, h.text])).toEqual([
      ['c1', 'Tildelingsbrev 2025', 'https://kudos.dfo.no/d1', 'tekst c1'],
      ['c2', 'Tildelingsbrev 2025', 'https://kudos.dfo.no/d1', 'tekst c2'],
    ]);
  });

  it('reads neighbouring chunks of a document in order', async () => {
    const { url, seen } = await fake(() => ({ status: 200, json: { results: [{ hits: [] }] } }));

    await kudos(url).range('d1', 2, 6);

    expect(searches(seen[0]?.body ?? {})[0]).toMatchObject({
      collection: CHUNKS,
      filter_by: 'doc_num:=`d1` && chunk_index:>=2 && chunk_index:<=6',
      sort_by: 'chunk_index:asc',
      per_page: 5,
    });
  });

  it('reads facet values for filters from the documents collection', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: {
        results: [
          {
            facet_counts: [{ field_name: 'orgs_short', counts: [{ value: 'DIGDIR', count: 12 }] }],
          },
        ],
      },
    }));

    const facets = await kudos(url).facets(['orgs_short', 'orgs_long']);

    expect(facets).toEqual({ orgs_short: [{ value: 'DIGDIR', count: 12 }], orgs_long: [] });
    expect(searches(seen[0]?.body ?? {})[0]).toMatchObject({
      collection: DOCS,
      facet_by: 'orgs_short,orgs_long',
      per_page: 0,
      max_facet_values: 300,
    });
  });

  it('maps a refused key and an overloaded engine', async () => {
    const refused = await fake(() => ({
      status: 401,
      json: { message: 'Forbidden - a valid `x-typesense-api-key` header must be sent.' },
    }));
    const down = await fake(() => ({ status: 503, json: { message: 'Not Ready or Lagging' } }));

    await expect(kudos(refused.url).search({ query: 'x' })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(kudos(down.url).search({ query: 'x' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('search-only guard', () => {
  it.each([
    ['DELETE', '/collections/KUDOS_preprod_v4_chunks_ab897fbdedfa'],
    ['POST', '/collections'],
    ['PATCH', '/collections/x'],
    ['POST', '/collections/x/documents/import'],
    ['DELETE', '/collections/x/documents'],
    ['POST', '/collections/x/documents'],
    ['PUT', '/collections/x/synonyms/s'],
    ['PUT', '/aliases/a'],
    ['POST', '/keys'],
    ['GET', '/keys'],
    ['GET', '/collections/x/documents/export'],
    ['POST', '/operations/snapshot'],
    ['GET', '/collections/x/documents/search/../../../keys'],
  ])('refuses %s %s', (method, path) => {
    expect(() => assertSearchOnly(method, path)).toThrow(/only searches/);
  });

  it('allows only multi_search', () => {
    expect(() => assertSearchOnly('POST', '/multi_search')).not.toThrow();
    expect(() => assertSearchOnly('GET', '/multi_search')).toThrow(/only searches/);
    expect(() => assertSearchOnly('GET', '/collections/KUDOS_x/documents/search')).toThrow(
      /only searches/,
    );
  });

  it('only ever sends multi_search requests across every operation', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: { results: [{ hits: [], facet_counts: [] }] },
    }));
    const port = kudos(url);

    await port.search({ query: 'x' });
    await port.fetch(['c1']);
    await port.range('d1', 0, 1);
    await port.facets(['type']);

    expect(seen.map((s) => s.path)).toEqual([
      '/multi_search',
      '/multi_search',
      '/multi_search',
      '/multi_search',
    ]);
  });
});

describe('read-only guard', () => {
  it.each([
    ['POST', '/collections/x/documents/import'],
    ['DELETE', '/collections/x'],
    ['DELETE', '/collections/x/documents'],
    ['PUT', '/aliases/a'],
    ['PATCH', '/collections/x'],
    ['POST', '/collections'],
    ['GET', '/keys'],
    ['GET', '/collections/x/documents/export/../../../keys'],
    ['POST', '/collections/x/documents/export'],
  ])('refuses %s %s', (method, path) => {
    expect(() => assertReadOnly(method, path)).toThrow(/only reads/);
  });

  it('allows health, the collection list and document export', () => {
    for (const path of ['/health', '/collections', '/collections/x/documents/export'])
      expect(() => assertReadOnly('GET', path)).not.toThrow();
  });
});

describe('typesense probe', () => {
  const probe = (url: string) =>
    probeKnowledgeEndpoint(
      {
        engine: 'typesense',
        baseURL: url,
        auth: { kind: 'api-key', secret: 'secret://env/probe-key' },
      },
      { adapters: [typesense], secrets: envSecrets({ PROBE_KEY: 'test-key' }) },
    );

  it('probe succeeds on a reachable endpoint and fails clearly otherwise', async () => {
    const healthy = await fake(() => ({ status: 200, json: { ok: true } }));
    expect(await probe(healthy.url)).toMatchObject({ ok: true, engine: 'typesense' });
    expect(healthy.seen.map((s) => s.path.split('?')[0])).toEqual(['/health', '/collections']);
    expect(healthy.seen[1]?.headers['x-typesense-api-key']).toBe('test-key');

    const refused = await fake((_body, attempt) =>
      attempt === 1 ? { status: 200, json: { ok: true } } : { status: 401, json: {} },
    );
    expect(await probe(refused.url)).toMatchObject({
      ok: false,
      code: 'unauthorized',
      message: 'the search engine refused the key',
    });

    const lagging = await fake(() => ({ status: 503, json: { message: 'Not Ready' } }));
    expect(await probe(lagging.url)).toMatchObject({ ok: false, code: 'unavailable' });

    expect(await probe('http://127.0.0.1:1')).toMatchObject({
      ok: false,
      code: 'unavailable',
      message: expect.stringContaining('unreachable'),
    });
  });
});

const envFile = join(import.meta.dirname, '..', '..', '..', '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const live = process.env.TYPESENSE_URL && process.env.TYPESENSE_KEY;

describe.skipIf(!live)('live Typesense (search only)', () => {
  it('finds phrases for a KA question and reads the chunks behind them', async () => {
    const port = new KnowledgeRouter({
      catalog: {
        ...example,
        endpoints: {
          'kudos-typesense': {
            ...example.endpoints['kudos-typesense'],
            baseURL: process.env.TYPESENSE_URL,
          },
        },
      },
      adapters: [typesense],
      secrets: envSecrets(),
    }).open({ kind: 'dataset', id: 'digdir/kudos' }, context());

    const result = await port.search({
      query: 'tildelingsbrev Digdir 2025',
      profile: 'phrase',
      limit: 5,
    });
    const chunks = await port.fetch(result.hits.map((h) => h.id));

    expect(result.hits.length).toBeGreaterThan(0);
    expect(chunks[0]?.text.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('enrichment collections', () => {
  type DatasetExample = {
    options: { collections: Record<string, string>; profiles: Record<string, unknown> };
  };
  const dataset = example.datasets[0] as DatasetExample;

  const withQuestions = (url: string) =>
    new KnowledgeRouter({
      catalog: {
        endpoints: {
          'kudos-typesense': { ...example.endpoints['kudos-typesense'], baseURL: url },
        },
        datasets: [
          {
            ...dataset,
            options: {
              ...dataset.options,
              collections: { ...dataset.options.collections, questions: 'KUDOS_questions_x' },
              profiles: {
                ...dataset.options.profiles,
                questions: {
                  collection: 'questions',
                  queryBy: ['question', 'question_vec'],
                  textField: 'question',
                  include: ['chunk_id', 'question'],
                  exclude: ['question_vec'],
                  score: 'fusion',
                  params: {
                    sort_by: '_text_match:desc',
                    prioritize_exact_match: false,
                    drop_tokens_threshold: 5,
                  },
                },
              },
            },
          },
        ],
      },
      adapters: [typesense],
      secrets: envSecrets({ TYPESENSE_KEY: 'test-key' }),
    }).open({ kind: 'dataset', id: 'digdir/kudos' }, context());

  it('searches a declared enrichment collection like headless-rag, filtering through the documents', async () => {
    const { url, seen } = await fake(() => ({ status: 200, json: { results: [{ hits: [] }] } }));

    await withQuestions(url).search({
      query: 'frist',
      profile: 'questions',
      limit: 20,
      filters: { type: ['Rundskriv'] },
    });

    expect(searches(seen[0]?.body ?? {})[0]).toMatchObject({
      collection: 'KUDOS_questions_x',
      query_by: 'question,question_vec',
      include_fields: 'chunk_id,question',
      exclude_fields: 'question_vec',
      per_page: 20,
      filter_by: `$${DOCS}(type:=[\`Rundskriv\`])`,
    });
  });

  it('refuses a profile that names a collection the dataset does not declare', () => {
    const result = typesense.datasetOptions.safeParse({
      ...dataset.options,
      profiles: {
        ...dataset.options.profiles,
        triples: { collection: 'triples', queryBy: ['triple_text'], textField: 'triple_text' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('refuses profile params that would replace the collection or the checked search fields', () => {
    const [name, first] = (Object.entries(dataset.options.profiles)[0] ?? []) as [
      string | undefined,
      Record<string, unknown> | undefined,
    ];
    for (const key of ['collection', 'filter_by', 'q', 'query_by']) {
      const result = typesense.datasetOptions.safeParse({
        ...dataset.options,
        profiles: { [name ?? 'p']: { ...first, params: { [key]: 'kudos_docs' } } },
      });
      expect(result.success).toBe(false);
    }
    const allowed = typesense.datasetOptions.safeParse({
      ...dataset.options,
      profiles: { [name ?? 'p']: { ...first, params: { prefix: false } } },
    });
    expect(allowed.success).toBe(true);
  });
});

describe('typesense capabilities and defaults', () => {
  const kudosDataset = example.datasets[0] as { filters: Record<string, never>; options: unknown };
  const config = (options: unknown) => ({
    id: 'digdir/kudos',
    filters: kudosDataset.filters,
    options: typesense.datasetOptions.parse(options),
  });

  it('declares hybrid search for KA, whose phrase profile fuses text and vector scores', () => {
    expect(typesense.capabilities?.(config(kudosDataset.options)).sort()).toEqual(
      [
        'search.text',
        'search.hybrid',
        'fetch',
        'range',
        'facets',
        'filter.select',
        'filter.multiselect',
        'filter.text',
        'filter.range',
        'filter.boolean',
      ].sort(),
    );
  });

  it('declares text search only when no profile fuses scores', () => {
    const declared = typesense.capabilities?.(
      config({ collections: { docs: 'd', chunks: 'c' }, profiles: defaultTypesenseProfiles }),
    );
    expect(declared).toContain('search.text');
    expect(declared).not.toContain('search.hybrid');
    expect(declared).not.toContain('search.vector');
  });

  it('defaults produce the same profiles the API used to add', () => {
    const apiProfiles = {
      content: {
        collection: 'chunks',
        queryBy: ['content_markdown'],
        textField: 'content_markdown',
        include: ['chunk_id', 'content_markdown'],
      },
    };
    const draft = { filters: {}, options: { collections: { docs: 'd', chunks: 'c' } } };
    expect(typesense.defaults?.(draft)).toEqual({ profiles: apiProfiles });
    expect(
      typesense.datasetOptions.safeParse({ ...draft.options, ...typesense.defaults?.(draft) })
        .success,
    ).toBe(true);
  });

  it('adds no defaults when profiles are given or there is no chunks collection', () => {
    expect(
      typesense.defaults?.({
        filters: {},
        options: { collections: { docs: 'd', chunks: 'c' }, profiles: {} },
      }),
    ).toEqual({});
    expect(typesense.defaults?.({ filters: {}, options: { collections: { docs: 'd' } } })).toEqual(
      {},
    );
  });
});
