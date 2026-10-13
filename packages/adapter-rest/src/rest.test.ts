import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { envSecrets } from '@genai/kernel';
import { KnowledgeRouter } from '@genai/port-knowledge';
import { fakeHttp, type FakeReply, type FakeServer } from '@genai/port-model/testing';
import { typesense } from '@genai/providers-typesense';
import { createRestAdapter, type RestAdapterOptions } from './index.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const DOCS = 'KUDOS_docs';
type Search = Record<string, unknown>;

const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' };
const nav: Principal = { kind: 'employee', issuer: 'test', subject: 'ola', tenant: '889640782' };

const counts: Record<string, { value: string; count: number }[]> = {
  type: [
    { value: 'Tildelingsbrev', count: 3378 },
    { value: 'Evaluering', count: 1472 },
  ],
  concerned_years: [
    { value: '2025', count: 900 },
    { value: '2024', count: 800 },
  ],
};

const facetReply = (body: Record<string, unknown>): FakeReply => ({
  status: 200,
  json: {
    results: (body.searches as Search[]).map((s) => {
      const filtered = typeof s.filter_by === 'string';
      return {
        hits: [],
        facet_counts: String(s.facet_by)
          .split(',')
          .map((field) => ({
            field_name: field,
            counts: (counts[field] ?? []).map((c) => ({
              value: c.value,
              count: filtered ? Math.floor(c.count / 10) : c.count,
            })),
          })),
      };
    }),
  },
});

const setup = async (
  reply: (body: Record<string, unknown>) => FakeReply = facetReply,
  extra: Partial<RestAdapterOptions> = {},
) => {
  const server = await fakeHttp(reply);
  servers.push(server);
  const knowledge = new KnowledgeRouter({
    catalog: {
      endpoints: {
        ts: {
          engine: 'typesense',
          baseURL: server.url,
          auth: { kind: 'api-key', secret: 'secret://env/k' },
        },
      },
      datasets: [
        {
          id: 'digdir/kudos',
          endpoint: 'ts',
          residency: 'norway',
          filters: {
            type: 'multiselect',
            concerned_years: 'multiselect',
            orgs_short: 'multiselect',
            title: 'text',
          },
          valueTypes: { concerned_years: 'integer' },
          options: {
            collections: { docs: DOCS, chunks: 'KUDOS_chunks' },
            profiles: {
              content: {
                collection: 'chunks',
                queryBy: ['content_markdown'],
                textField: 'content_markdown',
              },
            },
          },
        },
        {
          id: 'nav/internal',
          endpoint: 'ts',
          residency: 'norway',
          tenants: ['889640782'],
          options: {
            collections: { docs: 'NAV_docs', chunks: 'NAV_chunks' },
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
    secrets: envSecrets({ K: 'key' }),
  });
  const app = createRestAdapter({
    knowledge,
    auth: {
      authenticate: async (r) =>
        ({ 'Bearer kari': kari, 'Bearer ola': nav })[r.headers.get('authorization') ?? ''],
    },
    describe: (id) =>
      id === 'digdir/kudos' ? { name: 'Kudos', description: 'Offentlige rapporter' } : undefined,
    ...extra,
  });
  return { app, server };
};

const get = (app: Awaited<ReturnType<typeof setup>>['app'], path: string, who = 'kari') =>
  app.request(path, { headers: who ? { authorization: `Bearer ${who}` } : {} });

const facets = (query: Record<string, string>) =>
  `/api/facets?${new URLSearchParams({ tenant: 'digdir', 'dataset-config-key': 'kudos', ...query }).toString()}`;

describe('datasets', () => {
  it('lists only the datasets the caller can see, in headless-rag shape', async () => {
    const { app } = await setup();

    const kariList = await (await get(app, '/api/datasets')).json();
    const olaList = (await (await get(app, '/api/datasets', 'ola')).json()) as {
      datasets: { id: string }[];
    };

    expect(kariList).toEqual({
      datasets: [
        {
          id: 'kudos',
          tenant: 'digdir',
          name: 'Kudos',
          description: 'Offentlige rapporter',
          'enabled?': true,
          status: 'configured',
        },
      ],
    });
    expect(olaList.datasets.map((d) => d.id)).toEqual(['kudos', 'internal']);
  });

  it('returns one visible dataset and 404 for one that is hidden or unknown', async () => {
    const { app } = await setup();

    const found = await get(app, '/api/datasets/kudos');
    const byFullId = await get(app, '/api/datasets/digdir/kudos');
    const hidden = await get(app, '/api/datasets/nav/internal');
    const unknown = await get(app, '/api/datasets/nope');

    expect(found.status).toBe(200);
    expect(((await found.json()) as { dataset: { id: string } }).dataset.id).toBe('kudos');
    expect(byFullId.status).toBe(200);
    for (const res of [hidden, unknown]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'Dataset not found' });
    }
  });

  it('lists the filter fields a dataset declares, with their value type, so a frontend can build /api/facets requests', async () => {
    const { app } = await setup();

    const body = (await (await get(app, '/api/datasets/kudos')).json()) as {
      dataset: { filters: { field: string; kinds: string[] }[] };
    };

    expect(body.dataset.filters).toEqual([
      { field: 'type', kinds: ['multiselect'], 'value-type': 'string' },
      { field: 'concerned_years', kinds: ['multiselect'], 'value-type': 'integer' },
      { field: 'orgs_short', kinds: ['multiselect'], 'value-type': 'string' },
      { field: 'title', kinds: ['text'], 'value-type': 'string' },
    ]);
  });

  it('names the owner tenant of each dataset, the tenant /api/facets takes', async () => {
    const { app } = await setup();

    const list = (await (await get(app, '/api/datasets', 'ola')).json()) as {
      datasets: { id: string; tenant?: string }[];
    };

    expect(list.datasets.map((d) => [d.id, d.tenant])).toEqual([
      ['kudos', 'digdir'],
      ['internal', 'nav'],
    ]);
  });

  it('reports the status the platform derives from the ingestion pipelines of each dataset', async () => {
    const { app } = await setup(facetReply, {
      status: async (id) => (id === 'digdir/kudos' ? 'degraded' : 'needs-pipeline'),
    });

    const list = (await (await get(app, '/api/datasets', 'ola')).json()) as {
      datasets: { id: string; status: string }[];
    };
    const one = (await (await get(app, '/api/datasets/kudos')).json()) as {
      dataset: { status: string };
    };

    expect(list.datasets.map((d) => [d.id, d.status])).toEqual([
      ['kudos', 'degraded'],
      ['internal', 'needs-pipeline'],
    ]);
    expect(one.dataset.status).toBe('degraded');
  });

  it('refuses an unauthenticated caller like headless-rag', async () => {
    const { app } = await setup();

    for (const path of [
      '/api/datasets',
      '/api/datasets/digdir/kudos',
      facets({ fields: 'type' }),
    ]) {
      const res = await get(app, path, '');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(await res.json()).toMatchObject({ error: 'Invalid or missing API key' });
    }
  });
});

describe('facets', () => {
  it('returns values and counts for each field, sorted by value, from the documents collection', async () => {
    const { app, server } = await setup();

    const res = await get(app, facets({ fields: 'type,concerned_years' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fields: [
        {
          field: 'type',
          options: [
            { value: 'Evaluering', count: 1472, selected: false },
            { value: 'Tildelingsbrev', count: 3378, selected: false },
          ],
        },
        {
          field: 'concerned_years',
          options: [
            { value: '2024', count: 800, selected: false },
            { value: '2025', count: 900, selected: false },
          ],
        },
      ],
    });
    const searched = server.seen.flatMap((r) => r.body.searches as Search[]);
    expect(searched.every((s) => s.collection === DOCS)).toBe(true);
    expect(searched.every((s) => s.filter_by === undefined)).toBe(true);
  });

  it('narrows each field by the other fields but not by its own selection', async () => {
    const { app, server } = await setup();
    const filter = JSON.stringify({
      fields: [{ field: 'type', 'selected-options': ['Evaluering'] }],
    });

    const res = await get(app, facets({ fields: 'type,concerned_years', filter }));
    const body = (await res.json()) as {
      fields: { field: string; options: { value: string; count: number; selected: boolean }[] }[];
    };

    const type = body.fields.find((f) => f.field === 'type');
    const years = body.fields.find((f) => f.field === 'concerned_years');
    expect(type?.options).toEqual([
      { value: 'Evaluering', count: 1472, selected: true },
      { value: 'Tildelingsbrev', count: 3378, selected: false },
    ]);
    expect(years?.options).toEqual([
      { value: '2024', count: 80, selected: false },
      { value: '2025', count: 90, selected: false },
    ]);
    const filters = server.seen.flatMap((r) =>
      (r.body.searches as Search[]).map((s) => s.filter_by),
    );
    expect(filters).toContain('type:=[`Evaluering`]');
  });

  it('refuses a dataset the caller cannot see, or one that does not exist, with the same answer', async () => {
    const { app, server } = await setup();

    const hidden = await get(
      app,
      facets({ tenant: 'nav', 'dataset-config-key': 'internal', fields: 'type' }),
    );
    const unknown = await get(app, facets({ 'dataset-config-key': 'nope', fields: 'type' }));

    for (const res of [hidden, unknown]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: 'API key is not allowed to access the selected dataset',
      });
    }
    expect(server.seen).toHaveLength(0);
  });

  it.each([
    [{ fields: ',' }, 'fields must name at least one field.'],
    [{ fields: 'a,b,c,d,e,f,g,h,i,j,k' }, 'fields takes at most 10 fields.'],
    [{ fields: 'type;drop' }, 'fields must be plain field names.'],
    [{ fields: 'type', filter: '{' }, 'filter must be JSON.'],
    [{ fields: 'type', filter: '[1]' }, 'filter must be an object with a fields list.'],
    [
      {
        fields: 'type',
        filter: JSON.stringify({
          fields: [{ field: 'type', 'selected-options': ['NAV`) || true'] }],
        }),
      },
      'Invalid filter: Filter options cannot contain a backtick, a backslash or a control character.',
    ],
    [
      {
        fields: 'type',
        filter: JSON.stringify({
          fields: [{ field: 'type', type: 'regex', 'selected-options': ['x'] }],
        }),
      },
      'Invalid filter: Filter type must be one of ("contains" "multiselect" "not-in-set"); got "regex".',
    ],
    [
      { fields: 'type', filter: JSON.stringify({ fields: [] }) },
      'Invalid filter: Filter fields must not be empty.',
    ],
  ])('refuses %j before searching', async (query, error) => {
    const { app, server } = await setup();

    const res = await get(app, facets(query));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error });
    expect(server.seen).toHaveLength(0);
  });

  it('refuses missing parameters as a request validation failure', async () => {
    const { app } = await setup();

    const res = await get(app, '/api/facets?tenant=digdir');

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'Request validation failed',
      details: {
        humanized: {
          'dataset-config-key': ['missing required key'],
          fields: ['missing required key'],
        },
      },
    });
  });

  it('refuses a filter on a field the dataset does not declare, before searching', async () => {
    const { app, server } = await setup();
    const filter = JSON.stringify({
      fields: [{ field: 'secret_field', 'selected-options': ['x'] }],
    });

    const res = await get(app, facets({ fields: 'type', filter }));

    expect(res.status).toBe(400);
    expect(server.seen).toHaveLength(0);
  });

  it('answers 502 when the search index cannot answer', async () => {
    const { app } = await setup(() => ({ status: 503, json: { message: 'Not Ready or Lagging' } }));

    const res = await get(app, facets({ fields: 'type' }));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'Facets are unavailable for this dataset.' });
  });
});
