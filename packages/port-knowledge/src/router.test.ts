import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { envSecrets, type PortContext } from '@genai/kernel';
import {
  KnowledgeError,
  KnowledgeRouter,
  legacyCapabilities,
  localKnowledgeAdapter,
  parseKnowledgeCatalog,
  type KnowledgeAdapter,
  type SearchRequest,
} from './index.js';

const context = (tenant = '991825827', signal = new AbortController().signal): PortContext => ({
  tenant,
  principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant },
  task: 't1',
  signal,
  meter: async () => undefined,
});

const stub = (fail?: Error) => {
  const searches: SearchRequest[][] = [];
  const other: string[] = [];
  const adapter: KnowledgeAdapter<{ cluster: string }, { collection: string }> = {
    engine: 'stub',
    endpointOptions: z.strictObject({ cluster: z.string().default('one') }),
    datasetOptions: z.strictObject({ collection: z.string() }),
    connect: () => ({
      profiles: () => ['phrase', 'content'],
      search: async (dataset, requests) => {
        searches.push(requests);
        if (fail) throw fail;
        return requests.map((r) => ({
          hits: [
            {
              id: 'c1',
              score: 1,
              text: `${dataset.options.collection}:${r.profile}:${r.query}`,
              fields: {},
            },
          ],
        }));
      },
      fetch: async (_d, ids) => {
        other.push(`fetch:${ids.join(',')}`);
        return ids.map((id) => ({ id, score: 0, text: '', fields: {} }));
      },
      range: async (_d, document, from, to) => {
        other.push(`range:${document}:${from}-${to}`);
        return [];
      },
      facets: async (_d, fields) => {
        other.push(`facets:${fields.join(',')}`);
        return Object.fromEntries(fields.map((f) => [f, [{ value: 'Digdir', count: 3 }]]));
      },
    }),
  };
  return { adapter, searches, other };
};

const catalog = {
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
        type: 'multiselect',
        orgs_short: 'multiselect',
        title: 'text',
        published: 'range',
        archived: 'boolean',
      },
      options: { collection: 'kudos' },
    },
    {
      id: 'nav/internal',
      endpoint: 'main',
      residency: 'norway',
      tenants: ['889640782'],
      options: { collection: 'nav' },
    },
  ],
};

const router = (adapter = stub().adapter, extra = {}) =>
  new KnowledgeRouter({
    catalog,
    adapters: [adapter],
    secrets: envSecrets({ K: 'key' }),
    ...extra,
  });

const kudos = (r: KnowledgeRouter, ctx = context()) =>
  r.open({ kind: 'dataset', id: 'digdir/kudos' }, ctx);

describe('knowledge catalog', () => {
  it('refuses a literal key, an engine without an adapter and unknown dataset options', () => {
    const literal = parseKnowledgeCatalog(
      {
        endpoints: {
          main: {
            engine: 'stub',
            baseURL: 'https://s.example',
            auth: { kind: 'api-key', secret: 'xyz' },
          },
        },
        datasets: [],
      },
      [stub().adapter],
    );
    expect(!literal.ok && literal.errors.map((e) => e.path)).toEqual([
      'endpoints.main.auth.secret',
    ]);

    const result = parseKnowledgeCatalog(
      {
        endpoints: {
          ...catalog.endpoints,
          other: {
            engine: 'elastic',
            baseURL: 'https://e.example',
            auth: { kind: 'bearer', secret: 'secret://v/e' },
          },
        },
        datasets: [{ ...catalog.datasets[0], options: {} }],
      },
      [stub().adapter],
    );
    expect(!result.ok && result.errors.map((e) => e.path)).toEqual([
      'endpoints.other.engine',
      'datasets.0.options.collection',
    ]);
  });
});

describe('knowledge catalog addresses', () => {
  it('refuses an address without http or https, such as a bare host:port', () => {
    for (const baseURL of ['search.example.no:8108', 'ftp://search.example.no']) {
      const result = parseKnowledgeCatalog(
        { ...catalog, endpoints: { main: { ...catalog.endpoints.main, baseURL } } },
        [stub().adapter],
      );
      expect(!result.ok && result.errors.map((e) => e.path)).toEqual(['endpoints.main.baseURL']);
    }
  });
});

describe('knowledge router', () => {
  it('uses the first profile by default, caps the limit, and batches searches', async () => {
    const { adapter, searches } = stub();
    const port = kudos(router(adapter, { maxLimit: 50 }));

    const one = await port.search({ query: 'tildelingsbrev', limit: 500 });
    const many = await port.searchMany([
      { query: 'a', profile: 'phrase' },
      { query: 'a', profile: 'content' },
    ]);

    expect(one.hits[0]?.text).toBe('kudos:phrase:tildelingsbrev');
    expect(searches[0]).toEqual([{ query: 'tildelingsbrev', profile: 'phrase', limit: 50 }]);
    expect(many.map((r) => r.hits[0]?.text)).toEqual(['kudos:phrase:a', 'kudos:content:a']);
    expect(searches).toHaveLength(2);
    expect(port.info().profiles).toEqual(['phrase', 'content']);
  });

  it('records the dataset, engine and the generation the engine serves on the task, once per port', async () => {
    const { adapter } = stub();
    const served: unknown[] = [];
    const withGeneration: typeof adapter = {
      ...adapter,
      connect: (endpoint) => ({
        ...adapter.connect(endpoint),
        served: async () => ({ generation: 'g7', collections: ['kudos'] }),
      }),
    };
    const ctx = { ...context(), provenance: async (r: unknown) => void served.push(r) };
    const port = kudos(router(withGeneration), ctx);

    await port.search({ query: 'a' });
    await port.fetch(['c1']);
    await kudos(router(adapter), ctx).search({ query: 'a' });

    expect(served).toEqual([
      {
        index: {
          dataset: 'digdir/kudos',
          engine: 'stub',
          generation: 'g7',
          collections: ['kudos'],
        },
      },
      { index: { dataset: 'digdir/kudos', engine: 'stub' } },
    ]);
  });

  it('still answers when the engine cannot tell which generation it serves', async () => {
    const { adapter } = stub();
    const served: unknown[] = [];
    const failing: typeof adapter = {
      ...adapter,
      connect: (endpoint) => ({
        ...adapter.connect(endpoint),
        served: async () => {
          throw new Error('no alias');
        },
      }),
    };
    const ctx = { ...context(), provenance: async (r: unknown) => void served.push(r) };

    const result = await kudos(router(failing), ctx).search({ query: 'a' });

    expect(result.hits).toHaveLength(1);
    expect(served).toEqual([{ index: { dataset: 'digdir/kudos', engine: 'stub' } }]);
  });

  it('accepts filters of the declared kinds and refuses anything else before searching', async () => {
    const { adapter, searches } = stub();
    const port = kudos(router(adapter));

    await port.search({
      query: 'x',
      filters: {
        type: ['Tildelingsbrev', 'Årsrapport'],
        orgs_short: { not: ['NAV'] },
        title: { contains: ['2025'] },
        published: { gte: '2024-01-01' },
        archived: false,
      },
    });
    await port.search({
      query: 'x',
      filters: { orgs_short: { all: [['DIGDIR', 'NAV'], { not: ['NAV'] }] } },
    });
    const refused = [
      { owner: 'digdir' },
      { published: '2024' },
      { published: { gte: 1, drop: 2 } },
      { archived: 'no' },
      { type: [] },
      { type: { contains: ['x'] } },
      { title: { not: ['x'] } },
      { orgs_short: { all: [['A']] } },
      { orgs_short: { all: [['A'], { all: [['B'], ['C']] }] } },
      { orgs_short: { all: [['A'], { contains: ['x'] }] } },
    ];
    for (const filters of refused) {
      await expect(port.search({ query: 'x', filters: filters as never })).rejects.toBeInstanceOf(
        KnowledgeError,
      );
    }
    await expect(port.search({ query: 'x', profile: 'vector' })).rejects.toThrow(
      /no search profile vector/,
    );
    expect(searches).toHaveLength(2);
  });

  it('bounds batches, fetches and ranges, and only facets on declared filters', async () => {
    const { adapter, other } = stub();
    const port = kudos(router(adapter, { maxBatch: 2 }));

    await expect(port.searchMany([{ query: 'a' }, { query: 'b' }, { query: 'c' }])).rejects.toThrow(
      /at most 2/,
    );
    await expect(port.range('d1', 5, 60)).rejects.toThrow(/1 to 50/);
    await expect(port.range('d1', 3, 2)).rejects.toThrow(/1 to 50/);
    await expect(port.facets(['secret_field'])).rejects.toThrow(/no facet secret_field/);
    expect(await port.fetch([])).toEqual([]);

    await port.fetch(['c1', 'c2']);
    await port.range('d1', 0, 5);
    expect(await port.facets(['orgs_short'])).toEqual({
      orgs_short: [{ value: 'Digdir', count: 3 }],
    });
    expect(other).toEqual(['fetch:c1,c2', 'range:d1:0-5', 'facets:orgs_short']);
  });

  it('keeps a dataset shared with named tenants away from everyone else', async () => {
    const r = router();

    expect(() =>
      r.open({ kind: 'dataset', id: 'nav/internal', tenant: '991825827' }, context()),
    ).toThrow(/not shared/);
    expect(
      (
        await r
          .open({ kind: 'dataset', id: 'nav/internal', tenant: '889640782' }, context())
          .search({ query: 'x' })
      ).hits,
    ).toHaveLength(1);
  });

  it('refuses an unknown dataset and a dataset outside the allowed residency', () => {
    const euOnly = new KnowledgeRouter({
      catalog: { ...catalog, datasets: [{ ...catalog.datasets[0], residency: 'global' }] },
      adapters: [stub().adapter],
      secrets: envSecrets({}),
      maxResidency: 'eu',
    });

    expect(() => euOnly.open({ kind: 'dataset', id: 'none' }, context())).toThrow(
      /no dataset none/,
    );
    expect(() => kudos(euOnly)).toThrow(/outside eu/);
  });

  it('reports an engine crash as unavailable and a cancelled task as cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const crashing = router(stub(new TypeError('socket hang up')).adapter);

    await expect(kudos(crashing).search({ query: 'x' })).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(
      kudos(crashing, context('991825827', controller.signal)).search({ query: 'x' }),
    ).rejects.toMatchObject({
      code: 'cancelled',
    });
  });
});

describe('knowledge capabilities', () => {
  it('needs a baseURL and auth only for adapters that ask for them', () => {
    const bare = { endpoints: { main: { engine: 'stub' } }, datasets: [] };
    const remote = parseKnowledgeCatalog(bare, [stub().adapter]);
    expect(!remote.ok && remote.errors.map((e) => e.path)).toEqual([
      'endpoints.main.baseURL',
      'endpoints.main.auth',
    ]);
    const local = localKnowledgeAdapter({ ...stub().adapter, connect: stub().adapter.connect });
    expect(parseKnowledgeCatalog(bare, [local]).ok).toBe(true);
  });

  it('fills the engine and treats an adapter without capabilities as before', () => {
    const info = kudos(router()).info();
    expect(info.engine).toBe('stub');
    expect(info.capabilities).toEqual([...legacyCapabilities]);
  });

  it('fails a call to an undeclared capability as unsupported before reaching the engine', async () => {
    const { adapter, searches, other } = stub();
    const limited: typeof adapter = {
      ...adapter,
      capabilities: () => ['search.text', 'filter.select', 'filter.boolean'],
    };
    const port = kudos(router(limited));

    for (const call of [
      () => port.fetch(['c1']),
      () => port.range('d1', 0, 1),
      () => port.facets(['type']),
      () => port.search({ query: 'x', filters: { published: { gte: '2024' } } }),
      () => port.search({ query: 'x', filters: { type: ['Årsrapport'] } }),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'unsupported' });
    await port.search({ query: 'x', filters: { archived: true } });
    expect(searches).toHaveLength(1);
    expect(other).toEqual([]);
  });
});

describe('source links from the catalog', () => {
  const hit = (document: string, url?: string) => ({
    id: `${document}-0`,
    score: 1,
    text: 'Tekst',
    title: 'Tildelingsbrev 2021',
    document,
    ...(url ? { url } : {}),
    fields: {},
  });
  const adapter: KnowledgeAdapter<Record<string, never>, { collection: string }> = {
    engine: 'stub',
    endpointOptions: z.strictObject({}),
    datasetOptions: z.strictObject({ collection: z.string() }),
    requiresBaseURL: false,
    connect: () => ({
      profiles: () => ['content'],
      search: async (_d, requests) =>
        requests.map(() => ({
          hits: [
            hit('330296'),
            hit('330297', 'digdir://doc/330297'),
            hit('4711', 'https://a.no/4711'),
          ],
        })),
      fetch: async () => [hit('330296')],
      range: async () => [hit('330296')],
      facets: async () => ({}),
      documents: async () => ({
        documents: [{ id: '330296', title: 'Tildelingsbrev 2021', fields: {} }],
      }),
    }),
  };
  const linked = new KnowledgeRouter({
    catalog: {
      endpoints: { main: { engine: 'stub' } },
      datasets: [
        {
          id: 'digdir/kudos',
          endpoint: 'main',
          residency: 'norway',
          links: 'kudos-legacy',
          options: { collection: 'kudos' },
        },
        { id: 'arkiv/saker', endpoint: 'main', residency: 'norway', options: { collection: 'a' } },
      ],
    },
    adapters: [adapter],
    secrets: envSecrets({}),
  });
  const search = 'https://kudos.dfo.no/dokumenter?query=Tildelingsbrev%202021';

  it('links retired numeric ids to a Kudos title search only for a dataset marked kudos-legacy', async () => {
    const kudosPort = linked.open({ kind: 'dataset', id: 'digdir/kudos' }, context());
    const other = linked.open({ kind: 'dataset', id: 'arkiv/saker' }, context());

    const [plain, pinned, own] = (await kudosPort.search({ query: 'x' })).hits;
    expect(plain?.url).toBe(search);
    expect(pinned?.url).toBe(search);
    expect(own?.url).toBe('https://a.no/4711');
    expect((await kudosPort.fetch(['330296-0']))[0]?.url).toBe(search);
    expect((await kudosPort.range('330296', 0, 1))[0]?.url).toBe(search);
    expect((await kudosPort.documents?.({}))?.documents[0]?.url).toBe(search);

    const [bare, internal, kept] = (await other.search({ query: 'x' })).hits;
    expect(bare).not.toHaveProperty('url');
    expect(internal?.url).toBe('digdir://doc/330297');
    expect(kept?.url).toBe('https://a.no/4711');
    expect((await other.documents?.({}))?.documents[0]).not.toHaveProperty('url');
  });

  it('refuses an unknown link rule in the catalog', () => {
    const parsed = parseKnowledgeCatalog(
      {
        endpoints: { main: { engine: 'stub' } },
        datasets: [
          {
            id: 'd',
            endpoint: 'main',
            residency: 'norway',
            links: 'guess',
            options: { collection: 'x' },
          },
        ],
      },
      [adapter],
    );

    expect(parsed.ok).toBe(false);
  });
});
