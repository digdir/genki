import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { envSecrets } from '@genai/kernel';
import {
  KnowledgeError,
  KnowledgeRouter,
  type DatasetConfig,
  type FilterValue,
  type IndexDocument,
  type KnowledgeAdapter,
} from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import { createRestAdapter, remoteFileOriginsFrom, type RestAdapterOptions } from './index.js';

const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' };
const nav: Principal = { kind: 'employee', issuer: 'test', subject: 'ola', tenant: '889640782' };

type Corpus = IndexDocument[] | 'unavailable';

const report = (id: string, type: string, year: number): IndexDocument => ({
  id,
  title: `${type} ${year}`,
  fields: { type, concerned_years: year },
  chunks: [{ id: `${id}-0`, position: 0, text: `${type} for ${year}.` }],
  phrases: [],
});

const facetCorpus: Corpus = [
  report('t1', 'Tildelingsbrev', 2025),
  report('t2', 'Tildelingsbrev', 2025),
  report('t3', 'Tildelingsbrev', 2024),
  report('e1', 'Evaluering', 2025),
  report('e2', 'Evaluering', 2024),
];

const engineWith = async (corpus: Corpus) => {
  const { adapter, writer } = memoryEngine();
  const store = writer.connect({ engine: 'memory' } as never, {
    signal: new AbortController().signal,
  });
  const dataset = { id: 'digdir/kudos', filters: {}, options: {} } as DatasetConfig<never>;
  await store.prepare(dataset, 'g1');
  for (const doc of corpus === 'unavailable' ? [] : corpus) await store.store(dataset, 'g1', doc);
  await store.promote(dataset, 'g1');
  const reads: { op: string; filters?: Record<string, FilterValue> }[] = [];
  const recorded: KnowledgeAdapter = {
    ...(adapter as KnowledgeAdapter),
    connect: (endpoint) => {
      const inner = (adapter as KnowledgeAdapter).connect(endpoint);
      const down = () => {
        if (corpus === 'unavailable')
          throw new KnowledgeError('unavailable', 'Not Ready or Lagging');
      };
      return {
        ...inner,
        search: async (d, requests, signal) => {
          reads.push(...requests.map((r) => ({ op: 'search', filters: r.filters ?? {} })));
          down();
          return inner.search(d, requests, signal);
        },
        facets: async (d, fields, filters, signal) => {
          reads.push({ op: 'facets', filters });
          down();
          return inner.facets(d, fields, filters, signal);
        },
        documents: async (d, request, signal) => {
          reads.push({ op: 'documents', filters: request.filters ?? {} });
          down();
          if (!inner.documents) throw new Error('the memory engine lists documents');
          return inner.documents(d, request, signal);
        },
      };
    },
  };
  return { adapter: recorded, reads };
};

const setup = async (corpus: Corpus = facetCorpus, extra: Partial<RestAdapterOptions> = {}) => {
  const engine = await engineWith(corpus);
  const knowledge = new KnowledgeRouter({
    catalog: {
      endpoints: { lokal: { engine: 'memory' } },
      datasets: [
        {
          id: 'digdir/kudos',
          endpoint: 'lokal',
          residency: 'norway',
          filters: {
            type: 'multiselect',
            concerned_years: 'multiselect',
            orgs_short: 'multiselect',
            title: 'text',
          },
          valueTypes: { concerned_years: 'integer' },
          options: {},
        },
        {
          id: 'nav/internal',
          endpoint: 'lokal',
          residency: 'norway',
          tenants: ['889640782'],
          options: {},
        },
      ],
    },
    adapters: [engine.adapter],
    secrets: envSecrets({}),
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
  return { app, server: { seen: engine.reads } };
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
    const { app } = await setup(facetCorpus, {
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
            { value: 'Evaluering', count: 2, selected: false },
            { value: 'Tildelingsbrev', count: 3, selected: false },
          ],
        },
        {
          field: 'concerned_years',
          options: [
            { value: '2024', count: 2, selected: false },
            { value: '2025', count: 3, selected: false },
          ],
        },
      ],
    });
    expect(server.seen.length).toBeGreaterThan(0);
    expect(server.seen.every((r) => Object.keys(r.filters ?? {}).length === 0)).toBe(true);
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
      { value: 'Evaluering', count: 2, selected: true },
      { value: 'Tildelingsbrev', count: 3, selected: false },
    ]);
    expect(years?.options).toEqual([
      { value: '2024', count: 1, selected: false },
      { value: '2025', count: 1, selected: false },
    ]);
    expect(server.seen.map((r) => JSON.stringify(r.filters?.type ?? null))).toContain(
      '["Evaluering"]',
    );
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
    const { app } = await setup('unavailable');

    const res = await get(app, facets({ fields: 'type' }));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'Facets are unavailable for this dataset.' });
  });
});

const recordsOf = (records: Record<string, unknown>[]): IndexDocument[] =>
  records.map(({ doc_num, title, url, ...fields }) => ({
    id: String(doc_num),
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof url === 'string' ? { url } : {}),
    fields,
    chunks: [{ id: `${String(doc_num)}-0`, position: 0, text: String(title ?? '') }],
    phrases: [],
  }));

const fileOf = (doc: string, dataset = 'kudos') => `/api/datasets/${dataset}/documents/${doc}/file`;

describe('a document file', () => {
  const remote = recordsOf([
    { doc_num: '4711', title: 'Årsrapport', url: 'https://kilde.example/files/4711.pdf#page=3' },
    { doc_num: '4712', title: 'Landingsside', url: 'https://kilde.example/dokument/4712' },
    { doc_num: '4713', title: 'Uten adresse' },
    { doc_num: '4714', title: 'Farlig', url: 'javascript:alert(1)' },
  ]);

  it('sends a reader of the dataset to the remote source of a document', async () => {
    const { app } = await setup(remote);

    const res = await get(app, fileOf('4711'));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://kilde.example/files/4711.pdf');
  });

  it('describes the remote file as JSON when asked, with its media type when the address shows it', async () => {
    const { app } = await setup(remote);
    const asJson = (doc: string) =>
      app.request(fileOf(doc), {
        headers: { authorization: 'Bearer kari', accept: 'application/json' },
      });

    const pdf = await asJson('4711');
    const page = await asJson('4712');

    expect(pdf.headers.get('cache-control')).toBe('private, no-store');
    expect(await pdf.json()).toEqual({
      kind: 'source',
      url: 'https://kilde.example/files/4711.pdf',
      mediaType: 'application/pdf',
    });
    expect(await page.json()).toEqual({
      kind: 'source',
      url: 'https://kilde.example/dokument/4712',
      mediaType: null,
    });
  });

  it('answers document_file_not_found for a document without an address, or with one that is not http', async () => {
    const { app } = await setup(remote);

    for (const doc of ['4713', '4714']) {
      const res = await get(app, fileOf(doc));
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'document_file_not_found' });
    }
  });

  it('answers document_not_found for a number the dataset does not hold', async () => {
    const { app } = await setup(remote);

    const res = await get(app, fileOf('9999'));

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'document_not_found' });
  });

  it('keeps the access rules of the dataset: a hidden dataset reads as one that does not exist', async () => {
    const { app, server } = await setup(remote);

    const hidden = await get(app, fileOf('4711', 'nav/internal'));
    const refused = await (
      await setup(remote, { mayRead: () => false })
    ).app.request(fileOf('4711'), { headers: { authorization: 'Bearer kari' } });
    const anonymous = await get(app, fileOf('4711'), '');

    for (const res of [hidden, refused]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'dataset_not_found' });
    }
    expect(anonymous.status).toBe(401);
    expect(server.seen).toHaveLength(0);
  });

  it('serves an uploaded original in place of the source, a PDF inline and anything else as an attachment', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7');
    const { app } = await setup(remote, {
      originalFile: async (_principal, _dataset, doc) =>
        doc === '4711'
          ? { name: 'årsrapport.pdf', type: 'application/pdf', body: pdf }
          : doc === '4712'
            ? { name: 'side.html', type: 'text/html', body: new TextEncoder().encode('<b>x</b>') }
            : undefined,
    });

    const inline = await get(app, fileOf('4711'));
    const html = await get(app, fileOf('4712'));

    expect(inline.status).toBe(200);
    expect(inline.headers.get('content-type')).toBe('application/pdf');
    expect(inline.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(inline.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await inline.arrayBuffer())).toEqual(pdf);
    expect(html.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(html.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('asks for the original as the caller, so the platform can refuse it to another organisation', async () => {
    const asked: string[] = [];
    const { app } = await setup(remote, {
      originalFile: async (principal) => {
        asked.push(principal.subject);
        return undefined;
      },
    });

    const res = await get(app, fileOf('4711'));

    expect(asked).toEqual(['kari']);
    expect(res.status).toBe(302);
  });
});

describe('a remote PDF genki serves', () => {
  const pdfBytes = new TextEncoder().encode('%PDF-1.7 innhold');
  const listed = recordsOf([
    {
      doc_num: '4711',
      title: 'Årsrapport',
      url: 'https://kilde.example/dokument/4711',
      files: [
        { url: 'https://kilde.example/dokument/4711/filer/a.pdf', mimetype: 'application/pdf' },
        { url: 'https://kilde.example/dokument/4711/filer/b.pdf', mimetype: 'application/pdf' },
        { url: 'https://annen.example/x.pdf', mimetype: 'application/pdf' },
        { url: 'https://kilde.example/dokument/4711/filer/Årsrapport 2022.pdf' },
        { url: 'https://kilde.example/dokument/4711/filer/100%.pdf' },
      ],
    },
    { doc_num: '4712', title: 'Landingsside', url: 'https://kilde.example/dokument/4712' },
  ]);
  const source = (body: BodyInit, headers: Record<string, string> = {}, status = 200) => {
    const asked: { url: string; redirect: RequestRedirect | undefined }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      asked.push({ url: String(input), redirect: init?.redirect });
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/pdf', ...headers },
      });
    };
    return { asked, fetcher };
  };
  const remote = (fetcher: typeof fetch, extra: object = {}) => ({
    remoteFile: { origins: ['https://kilde.example'], fetch: fetcher, ...extra },
  });

  it('serves the first PDF the record lists on an allowed origin, inline, framed only by its own site', async () => {
    const { asked, fetcher } = source(pdfBytes);
    const { app } = await setup(listed, remote(fetcher));

    const res = await get(app, fileOf('4711'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'self'",
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdfBytes);
    expect(asked).toEqual([
      { url: 'https://kilde.example/dokument/4711/filer/a.pdf', redirect: 'manual' },
    ]);
  });

  it('serves the excerpt’s own file only when the record lists it on an allowed origin', async () => {
    const { asked, fetcher } = source(pdfBytes);
    const { app } = await setup(listed, remote(fetcher));
    const asking = (file: string) => `${fileOf('4711')}?file=${encodeURIComponent(file)}`;

    const own = await get(app, asking('https://kilde.example/dokument/4711/filer/b.pdf#page=3'));
    const elsewhere = await get(app, asking('https://annen.example/x.pdf'));
    const unlisted = await get(app, asking('https://kilde.example/dokument/9999/filer/c.pdf'));

    expect(own.status).toBe(200);
    for (const res of [elsewhere, unlisted]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'document_file_not_found' });
    }
    expect(asked.map((a) => a.url)).toEqual(['https://kilde.example/dokument/4711/filer/b.pdf']);
  });

  it('serves a listed file whose name has spaces or æøå, however the address is spelled', async () => {
    const { asked, fetcher } = source(pdfBytes);
    const { app } = await setup(listed, remote(fetcher));
    const asking = (file: string) => `${fileOf('4711')}?file=${encodeURIComponent(file)}`;

    const raw = await get(
      app,
      asking('https://KILDE.example/dokument/4711/filer/Årsrapport 2022.pdf#page=2'),
    );
    const encoded = await get(
      app,
      asking('https://kilde.example/dokument/4711/filer/%C3%85rsrapport%202022.pdf'),
    );

    expect([raw.status, encoded.status]).toEqual([200, 200]);
    expect(raw.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''%C3%85rsrapport%202022.pdf",
    );
    expect(asked.map((a) => a.url)).toEqual([
      'https://kilde.example/dokument/4711/filer/%C3%85rsrapport%202022.pdf',
      'https://kilde.example/dokument/4711/filer/%C3%85rsrapport%202022.pdf',
    ]);
  });

  it('names a file with a stray percent sign as it is, and still serves it', async () => {
    const { fetcher } = source(pdfBytes);
    const { app } = await setup(listed, remote(fetcher));

    const res = await get(
      app,
      `${fileOf('4711')}?file=${encodeURIComponent('https://kilde.example/dokument/4711/filer/100%.pdf')}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('filename="100_.pdf"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdfBytes);
  });

  it('stops a body without a length once it passes the cap', async () => {
    const big = new Uint8Array(64).fill(0x41);
    big.set(pdfBytes.subarray(0, 5));
    const streamed = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(big.subarray(0, 32));
          controller.enqueue(big.subarray(32));
          controller.close();
        },
      });
    const fetcher: typeof fetch = async () =>
      new Response(streamed(), { headers: { 'content-type': 'application/pdf' } });
    const { app } = await setup(listed, remote(fetcher, { maxBytes: 40 }));

    const res = await get(app, fileOf('4711'));

    expect(res.headers.get('content-length')).toBeNull();
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it('answers document_unavailable when the source does not answer in time', async () => {
    const fetcher: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      );
    const { app } = await setup(listed, remote(fetcher, { timeoutMs: 20 }));

    const res = await get(app, fileOf('4711'));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'document_unavailable' });
  });

  it('says it serves the PDF itself as JSON when asked, without reading the source', async () => {
    const { asked, fetcher } = source(pdfBytes);
    const { app } = await setup(listed, remote(fetcher));

    const res = await app.request(fileOf('4711'), {
      headers: { authorization: 'Bearer kari', accept: 'application/json' },
    });

    expect(await res.json()).toEqual({
      kind: 'served',
      mediaType: 'application/pdf',
      source: 'https://kilde.example/dokument/4711/filer/a.pdf',
    });
    expect(asked).toEqual([]);
  });

  it('keeps sending a document without a listed PDF to its source', async () => {
    const { asked, fetcher } = source(pdfBytes);
    const { app } = await setup(listed, remote(fetcher));

    const res = await get(app, fileOf('4712'));

    expect(res.status).toBe(302);
    expect(asked).toEqual([]);
  });

  it('reads nothing remote without allowed origins', async () => {
    const { asked, fetcher } = source(pdfBytes);
    const { app } = await setup(listed, { remoteFile: { origins: [], fetch: fetcher } });

    const res = await get(app, fileOf('4711'));

    expect(res.status).toBe(302);
    expect(asked).toEqual([]);
  });

  it('answers document_unavailable for a source that redirects, sends no PDF or a file too large', async () => {
    const cases = [
      source('', { location: 'http://169.254.169.254/' }, 302),
      source('<html>', { 'content-type': 'text/html' }),
      source(pdfBytes, { 'content-length': '999' }),
    ];
    for (const { fetcher } of cases) {
      const { app } = await setup(listed, remote(fetcher, { maxBytes: 10 }));
      const res = await get(app, fileOf('4711'));
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: 'document_unavailable' });
    }
  });

  it('stops a body that does not start as a PDF', async () => {
    const { fetcher } = source(new TextEncoder().encode('<html>not a pdf</html>'));
    const { app } = await setup(listed, remote(fetcher));

    const res = await get(app, fileOf('4711'));

    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it('keeps the access rules of the dataset before it reads anything remote', async () => {
    const { asked, fetcher } = source(pdfBytes);
    const refused = await (
      await setup(listed, { ...remote(fetcher), mayRead: () => false })
    ).app.request(fileOf('4711'), { headers: { authorization: 'Bearer kari' } });

    expect(refused.status).toBe(404);
    expect(asked).toEqual([]);
  });

  it('takes only https origins written out in full, a trailing slash allowed, as allowed origins', () => {
    expect(
      remoteFileOriginsFrom(
        'https://kudos.dfo.no, https://d.example/, http://a.example, https://b.example/path, https://u:p@c.example,x',
      ),
    ).toEqual(['https://kudos.dfo.no', 'https://d.example']);
  });

  it('says there is no file to show when the record lists the remote PDF as larger than 50 MiB', async () => {
    const big = 'https://kilde.example/dokument/4715/filer/stor.pdf';
    const withBig = recordsOf([
      {
        doc_num: '4715',
        title: 'Stor rapport',
        url: 'https://kilde.example/dokument/4715',
        files: [{ url: big, mimetype: 'application/pdf', size: 50 * 1024 * 1024 + 1 }],
      },
    ]);
    const { asked, fetcher } = source(pdfBytes);
    const { app } = await setup(withBig, remote(fetcher));
    const asking = `${fileOf('4715')}?file=${encodeURIComponent(big)}`;
    const json = { authorization: 'Bearer kari', accept: 'application/json' };

    const answers = [
      await app.request(asking, { headers: json }),
      await app.request(fileOf('4715'), { headers: json }),
      await get(app, asking),
      await get(app, fileOf('4715')),
    ];

    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'document_file_not_found' });
    }
    expect(asked).toEqual([]);
  });

  it('still serves a remote PDF the record lists at exactly 50 MiB', async () => {
    const atCap = 'https://kilde.example/dokument/4716/filer/full.pdf';
    const withAtCap = recordsOf([
      {
        doc_num: '4716',
        title: 'Full rapport',
        url: 'https://kilde.example/dokument/4716',
        files: [{ url: atCap, mimetype: 'application/pdf', size: 50 * 1024 * 1024 }],
      },
    ]);
    const { asked, fetcher } = source(pdfBytes);
    const { app } = await setup(withAtCap, remote(fetcher));
    const asking = `${fileOf('4716')}?file=${encodeURIComponent(atCap)}`;

    const probe = await app.request(asking, {
      headers: { authorization: 'Bearer kari', accept: 'application/json' },
    });
    const res = await get(app, asking);

    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({ kind: 'served' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(asked.map((a) => a.url)).toEqual([atCap]);
  });
});
