import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { configuredCredentialScope, lockdownUserScope } from '@genai/composition';
import { LEGACY_KEY_ISSUER } from '@genai/identity';
import { envSecrets, KernelError } from '@genai/kernel';
import {
  KnowledgeError,
  KnowledgeRouter,
  type KnowledgeAdapter,
  type SearchRequest,
} from '@genai/port-knowledge';
import { fixtureFilters, memoryEngine, seedCorpus } from '@genai/port-knowledge/testing';
import { uploadDocumentId, uploadPrefix } from '@genai/ingest';
import { InMemoryBlobStore } from '@genai/port-blob';
import type { PortContext } from '@genai/kernel';
import type { Access } from './access.js';
import { policyKind } from './building-blocks.js';
import type { CatalogItem } from './catalog-registry.js';
import { InMemoryConfigEntryStore, platformScope } from './config-store.js';
import {
  datasetDocumentNotFoundType,
  datasetDocumentsFailedType,
  datasetDocumentsPeopleOnlyType,
  documentExcerptLength,
  mountDatasetSearch,
  type DatasetDocumentDetail,
  type DatasetDocumentsPage,
  type DatasetSearchAnswer,
  type DatasetSearchDeps,
} from './dataset-search.js';
import { modelRunRoutes } from './lockdown.js';
import { bootPlatform } from './testkit.js';

const digdir = '991825827';
const other = '889640782';
const signal = new AbortController().signal;

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ingrid: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ingrid',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['read', 'manage-datasets'] }],
  },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['read', 'use-services'] }],
  },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir },
  nokkel: {
    kind: 'agency-system',
    issuer: 'test',
    subject: 'key-1',
    tenant: digdir,
    scopes: ['legacy:admin'],
  },
  admitted: {
    kind: 'employee',
    issuer: 'test',
    subject: 'admitted',
    tenant: digdir,
    scopes: [lockdownUserScope],
  },
};

const item = (id: string, scope: string, spec: Record<string, unknown> = {}): CatalogItem => ({
  kind: 'dataset',
  id,
  scope,
  origin: 'seed',
  version: 1,
  spec: { name: id, ...spec },
});

const catalogItems = [
  item('digdir/felles', platformScope),
  item('digdir/kun-nav', platformScope, { tenants: [other] }),
  item(`${digdir}/filer`, digdir),
  item(`${other}/hemmelig`, other),
];

const boot = async (
  options: {
    timeoutMs?: number;
    fail?: (request: SearchRequest) => Error | undefined;
    clock?: () => number;
    pages?: Record<string, Record<string, number>>;
    refuse?: Error;
    blobs?: InMemoryBlobStore;
    ingestion?: DatasetSearchDeps['ingestion'];
    documentCount?: DatasetSearchDeps['documentCount'];
  } = {},
) => {
  const engine = memoryEngine();
  const searches: SearchRequest[] = [];
  const connects: { timeoutMs: number }[] = [];
  const adapter: KnowledgeAdapter = {
    ...engine.adapter,
    connect: (endpoint) => {
      connects.push({ timeoutMs: endpoint.timeoutMs });
      const connection = engine.adapter.connect(endpoint as never);
      return {
        ...connection,
        search: async (dataset, requests, s) => {
          searches.push(...requests);
          for (const request of requests) {
            const failure = options.fail?.(request);
            if (failure) throw failure;
          }
          const results = await connection.search(dataset as never, requests, s);
          return results.map((r) => ({
            ...r,
            hits: r.hits.map((h) => ({ ...h, fields: { ...h.fields, ...options.pages?.[h.id] } })),
          }));
        },
      };
    },
  } as KnowledgeAdapter;
  const knowledge = new KnowledgeRouter({
    catalog: {
      endpoints: { local: { engine: 'memory' } },
      datasets: [
        { id: 'digdir/felles', endpoint: 'local', residency: 'norway', filters: fixtureFilters },
        {
          id: 'digdir/kun-nav',
          endpoint: 'local',
          residency: 'norway',
          filters: fixtureFilters,
          tenants: [other],
        },
        {
          id: `${digdir}/filer`,
          endpoint: 'local',
          residency: 'norway',
          filters: fixtureFilters,
          tenants: [digdir],
        },
        {
          id: `${other}/hemmelig`,
          endpoint: 'local',
          residency: 'norway',
          filters: fixtureFilters,
          tenants: [other],
        },
      ],
    },
    adapters: [adapter],
    secrets: envSecrets({}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const writer = engine.writer.connect({ options: {}, timeoutMs: 1000 }, { signal });
  for (const id of ['digdir/felles', 'digdir/kun-nav', `${digdir}/filer`, `${other}/hemmelig`])
    await seedCorpus(writer, { id, filters: fixtureFilters, options: {} } as never);
  const configEntries = new InMemoryConfigEntryStore();
  await configEntries.append({
    kind: policyKind,
    scope: platformScope,
    id: 'default',
    version: 1,
    spec: { rules: [] },
    deleted: false,
    by: 'drift',
    at: '2026-10-07T08:00:00Z',
    reason: 'Ingen regler i testen',
  });
  const logged: { message: string; fields: Record<string, unknown> }[] = [];
  const tracked: { principal: Principal; metered: unknown[] }[] = [];
  const searchTask = async <T>(principal: Principal, work: (ctx: PortContext) => Promise<T>) => {
    const entry = { principal, metered: [] as unknown[] };
    tracked.push(entry);
    if (options.refuse) throw options.refuse;
    const value = await work({
      tenant: principal.tenant ?? '',
      principal,
      task: `task-${tracked.length}`,
      signal,
      meter: async (usage) => {
        entry.metered.push(usage);
      },
    });
    return { value, task: `task-${tracked.length}` };
  };
  const access: Access = (principal, tenant) => {
    if (principal.kind === 'operator') return { ...principal, tenant, actor: principal };
    return principal.tenant === tenant ? principal : undefined;
  };
  const app = new Hono();
  mountDatasetSearch(app, {
    knowledge,
    catalog: {
      get: (_kind, id) => catalogItems.find((i) => i.id === id),
      visibleTo: (tenant) =>
        catalogItems.filter(
          (i) =>
            i.scope === tenant ||
            (i.scope === platformScope &&
              (!(i.spec.tenants as string[] | undefined) ||
                (i.spec.tenants as string[]).includes(tenant))),
        ),
      qualify: (scope, id) => (id.startsWith(`${scope}/`) ? id : `${scope}/${id}`),
    },
    configEntries,
    platformTenant: digdir,
    authenticate: async (request) =>
      people[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''],
    access,
    searchTask,
    logger: (message, fields) => logged.push({ message, fields }),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.blobs ? { blobs: options.blobs } : {}),
    ...(options.ingestion ? { ingestion: options.ingestion } : {}),
    ...(options.documentCount ? { documentCount: options.documentCount } : {}),
  });
  const search = (path: string, as: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${as}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, search, knowledge, configEntries, searches, connects, logged, tracked };
};

const tenantPath = (dataset: string, tenant = digdir) =>
  `/tenants/${tenant}/datasets/${encodeURIComponent(dataset)}/search`;
const operatorPath = (dataset: string) =>
  `/operator/datasets/${encodeURIComponent(dataset)}/search`;

describe('searching a dataset directly', () => {
  it("answers a dataset's hits with their document, chunk, page, score and fields", async () => {
    const { search } = await boot();

    const response = await search(tenantPath('filer'), 'kari', { query: 'tilskudd fristen' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as DatasetSearchAnswer;
    expect(body.hits.length).toBeGreaterThan(0);
    const [first] = body.hits;
    expect(first).toMatchObject({
      id: 'dok-1-1',
      document: 'dok-1',
      title: 'Tilskudd til digitalisering i kommunene',
      position: 1,
      text: 'Søknaden om tilskudd sendes inn innen fristen 1. mars.',
      fields: { kategori: 'Veiledning', virksomheter: ['Digdir', 'KS'] },
    });
    expect(typeof first?.score).toBe('number');
    const scores = body.hits.map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('lifts the page of a hit out of its fields', async () => {
    const { search } = await boot({ pages: { 'dok-1-1': { page: 4, pageEnd: 5 } } });

    const body = (await (
      await search(tenantPath('filer'), 'kari', { query: 'tilskudd' })
    ).json()) as DatasetSearchAnswer;

    expect(body.hits.find((h) => h.id === 'dok-1-1')).toMatchObject({ page: 4, pageEnd: 5 });
    expect(body.hits.find((h) => h.id === 'dok-1-0')).not.toHaveProperty('page');
  });

  it('answers what was searched: the dataset, profile, filters, limit and time taken', async () => {
    let tick = 0;
    const { search } = await boot({ clock: () => (tick++ === 0 ? 1000 : 1042) });

    const response = await search(tenantPath('filer'), 'kari', {
      query: 'tilskudd',
      filters: { kategori: 'Veiledning' },
      profile: 'content',
      limit: 3,
    });

    expect(await response.json()).toMatchObject({
      dataset: `${digdir}/filer`,
      profile: 'content',
      filters: { kategori: 'Veiledning' },
      limit: 3,
      tookMs: 42,
    });
  });

  it('keeps a filter that finds nothing and answers no hits', async () => {
    const { search, searches } = await boot();

    const response = await search(tenantPath('filer'), 'kari', {
      query: 'tilskudd',
      filters: { kategori: 'Finnes ikke' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ hits: [] });
    expect(searches).toHaveLength(1);
    expect(searches[0]?.filters).toEqual({ kategori: 'Finnes ikke' });
  });

  it('refuses a filter on a field the dataset does not declare', async () => {
    const { search, searches } = await boot();

    const response = await search(tenantPath('filer'), 'kari', {
      query: 'tilskudd',
      filters: { owner_orgnr: '991825827' },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      errors: [
        {
          path: 'filters.owner_orgnr',
          message: `Dokumentsamlingen ${digdir}/filer har ikke feltet «owner_orgnr» som filter`,
        },
      ],
    });
    expect(searches).toHaveLength(0);
  });

  it('refuses a filter value of a type the field cannot run', async () => {
    const { search } = await boot();

    const response = await search(tenantPath('filer'), 'kari', {
      query: 'tilskudd',
      filters: { arkivert: { gte: 2020 } },
    });

    expect(response.status).toBe(422);
  });

  it('refuses a profile the dataset does not declare', async () => {
    const { search } = await boot();

    const response = await search(tenantPath('filer'), 'kari', {
      query: 'tilskudd',
      profile: 'finnes-ikke',
    });

    expect(response.status).toBe(422);
  });

  it("refuses a search of a dataset the tenant's catalogue does not hold", async () => {
    const { search, searches } = await boot();

    for (const dataset of [`${other}/hemmelig`, 'digdir/kun-nav', 'digdir/finnes-ikke'])
      expect((await search(tenantPath(dataset), 'kari', { query: 'tilskudd' })).status).toBe(404);
    expect((await search(tenantPath('filer', other), 'kari', { query: 'tilskudd' })).status).toBe(
      404,
    );
    expect(searches).toHaveLength(0);
  });

  it('lets a tenant search a platform dataset its catalogue holds', async () => {
    const { search } = await boot();

    const response = await search(tenantPath('digdir/felles'), 'kari', { query: 'tilskudd' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dataset: 'digdir/felles' });
  });

  it('refuses a member without manage-services or manage-datasets', async () => {
    const { search, searches } = await boot();

    const refused = await search(tenantPath('filer'), 'erik', { query: 'tilskudd' });
    const allowed = await search(tenantPath('filer'), 'ingrid', { query: 'tilskudd' });

    expect(refused.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(searches).toHaveLength(1);
  });

  it("refuses a dataset the tenant's block policy does not allow", async () => {
    const { search, configEntries, searches } = await boot();
    await configEntries.append({
      kind: policyKind,
      scope: digdir,
      id: 'ingen-felles',
      version: 1,
      spec: {
        rules: [
          {
            id: 'ingen-felles',
            match: { kind: 'dataset', id: 'digdir/felles' },
            effect: 'not_allowed',
            ownedBy: digdir,
            text: 'Vi bruker ikke felles-datasettet.',
          },
        ],
      },
      deleted: false,
      by: 'kari',
      at: '2026-10-07T09:00:00Z',
      reason: 'Ikke i bruk hos oss',
    });

    const response = await search(tenantPath('digdir/felles'), 'kari', { query: 'tilskudd' });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      policy: { block: 'digdir/felles', rule: 'Vi bruker ikke felles-datasettet.' },
    });
    expect(searches).toHaveLength(0);
  });

  it('lets only an operator search a platform dataset through the operator route', async () => {
    const { search } = await boot();

    expect(
      (await search(operatorPath('digdir/felles'), 'drift', { query: 'tilskudd' })).status,
    ).toBe(200);
    expect(
      (await search(operatorPath('digdir/felles'), 'kari', { query: 'tilskudd' })).status,
    ).toBe(403);
    expect(
      (await search(operatorPath(`${digdir}/filer`), 'drift', { query: 'tilskudd' })).status,
    ).toBe(404);
  });

  it('answers 403 with the reason when the kernel refuses the search task', async () => {
    const { search } = await boot({
      refuse: new KernelError('forbidden', 'the authorization service is unavailable'),
    });

    const response = await search(tenantPath('filer'), 'kari', { query: 'tilskudd' });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      errors: [{ path: 'kernel', message: 'the authorization service is unavailable' }],
    });
  });

  it('lets an operator search a platform dataset shared only with listed tenants', async () => {
    const { search } = await boot();

    const response = await search(operatorPath('digdir/kun-nav'), 'drift', { query: 'tilskudd' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dataset: 'digdir/kun-nav' });
  });

  it('gives the search task model admission in lockdown only when the person may use models', async () => {
    const { search, tracked } = await boot();

    await search(tenantPath('filer'), 'admitted', { query: 'tilskudd' });
    await search(tenantPath('filer'), 'kari', { query: 'tilskudd' });

    expect(tracked.map((t) => t.principal.scopes?.includes(configuredCredentialScope))).toEqual([
      true,
      false,
    ]);
  });

  it("searches with the same limits and timeout as a service's search", async () => {
    const { search, knowledge, connects } = await boot({ timeoutMs: 7_000 });
    const request = { query: 'tilskudd', filters: { kategori: 'Veiledning' }, limit: 2 };
    const service = await knowledge
      .open(
        { kind: 'dataset', id: `${digdir}/filer`, tenant: digdir },
        {
          tenant: digdir,
          principal: people.kari as Principal,
          task: 'run-1',
          signal,
          meter: async () => undefined,
        },
      )
      .search(request);

    const body = (await (
      await search(tenantPath('filer'), 'kari', request)
    ).json()) as DatasetSearchAnswer;

    expect(body.hits.map((h) => [h.id, h.score])).toEqual(service.hits.map((h) => [h.id, h.score]));
    expect(new Set(connects.map((c) => c.timeoutMs))).toEqual(new Set([7_000]));
    expect(
      (await search(tenantPath('filer'), 'kari', { query: 'tilskudd', limit: 101 })).status,
    ).toBe(422);
  });

  it("counts a search's model use against the tenant's budget, as a run does", async () => {
    const { search, tracked, searches } = await boot();

    await search(tenantPath('filer'), 'kari', { query: 'tilskudd' });
    await search(operatorPath('digdir/felles'), 'drift', { query: 'tilskudd' });

    expect(
      tracked.map((t) => [t.principal.kind, t.principal.tenant, t.principal.actor?.subject]),
    ).toEqual([
      ['agency-system', digdir, 'kari'],
      ['agency-system', digdir, 'drift'],
    ]);
    expect(searches).toHaveLength(2);
  });

  it("answers 429 when the tenant's monthly quota is used up", async () => {
    const { search, searches } = await boot({
      refuse: new KernelError('quota_exhausted', 'monthly token quota used up'),
    });

    const response = await search(tenantPath('filer'), 'kari', { query: 'tilskudd' });

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ type: 'urn:genai:problem:quota-exhausted' });
    expect(searches).toHaveLength(0);
  });

  it('answers 504 and no hits when the search times out', async () => {
    const { search } = await boot({
      fail: () =>
        new KnowledgeError('timeout', `the search on ${digdir}/filer took longer than 15000 ms`),
    });

    const response = await search(tenantPath('filer'), 'kari', { query: 'tilskudd' });

    expect(response.status).toBe(504);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('hits');
    expect(body).toMatchObject({
      errors: [
        { path: 'knowledge', message: `the search on ${digdir}/filer took longer than 15000 ms` },
      ],
    });
  });

  it('keeps the query out of the logs', async () => {
    const { search, logged } = await boot({
      fail: () => new KnowledgeError('timeout', 'took too long'),
    });

    await search(tenantPath('filer'), 'kari', { query: 'Kari Nordmanns lønn 2023' });

    expect(logged).toHaveLength(1);
    expect(logged[0]?.fields).toMatchObject({ dataset: `${digdir}/filer`, code: 'timeout' });
    expect(JSON.stringify(logged)).not.toContain('Nordmann');
  });

  it('refuses a search with no query', async () => {
    const { search } = await boot();

    expect((await search(tenantPath('filer'), 'kari', { query: '' })).status).toBe(422);
    expect((await search(tenantPath('filer'), 'kari', {})).status).toBe(422);
  });
});

describe('the dataset search on the platform', () => {
  const closedPort = {
    endpoints: {
      search: {
        engine: 'typesense',
        baseURL: 'http://127.0.0.1:9',
        auth: { kind: 'api-key', secret: 'secret://env/search-key' },
      },
    },
    datasets: [
      {
        id: 'digdir/kudos',
        endpoint: 'search',
        residency: 'norway',
        options: {
          collections: { docs: 'docs', chunks: 'chunks' },
          profiles: { content: { collection: 'chunks', queryBy: ['text'], textField: 'text' } },
        },
      },
    ],
  };
  const platformPeople: Record<string, Principal> = {
    kari: people.kari as Principal,
    drift: people.drift as Principal,
  };

  it('reaches the search engine for an operator and for a dataset manager without use-services', async () => {
    const { send } = await bootPlatform({
      people: {
        ...platformPeople,
        ingrid: people.ingrid as Principal,
      },
      knowledge: closedPort,
    });
    const body = { query: 'tilskudd' };

    const answers = [
      await send(operatorPath('digdir/kudos'), 'drift', { body }),
      await send(tenantPath('digdir/kudos'), 'ingrid', { body }),
    ];

    // Nothing listens on the port: a search that got past the kernel fails at the engine.
    for (const answer of answers) {
      expect(answer.status).toBe(502);
      expect(await answer.json()).toMatchObject({ errors: [{ path: 'knowledge' }] });
    }
  });

  it('refuses an API key on both routes, since only people search a dataset directly', async () => {
    const { send } = await bootPlatform({
      people: {
        key: {
          kind: 'agency-system',
          issuer: LEGACY_KEY_ISSUER,
          subject: 'key-1',
          tenant: digdir,
          scopes: ['legacy:admin'],
        },
      },
      knowledge: closedPort,
    });
    const body = { query: 'tilskudd' };

    const tenant = await send(tenantPath('digdir/kudos'), 'key', { body });
    const operator = await send(operatorPath('digdir/kudos'), 'key', { body });

    expect([tenant.status, operator.status]).toEqual([403, 403]);
  });

  it('mounts both routes on the platform', async () => {
    const { send } = await bootPlatform({ people: platformPeople });
    const body = { query: 'tilskudd' };

    const tenant = await send(tenantPath('digdir/finnes-ikke'), 'kari', { body });
    const operator = await send(operatorPath('finnes-ikke'), 'drift', { body });

    expect([tenant.status, operator.status]).toEqual([404, 404]);
    expect(await tenant.json()).toMatchObject({ title: 'Fant ikke datasettet' });
  });

  it('mounts the document listing on the platform, also for a dataset id with a slash', async () => {
    const { send } = await bootPlatform({ people: platformPeople });

    const response = await send(
      `/tenants/${digdir}/datasets/${encodeURIComponent('digdir/finnes-ikke')}/documents`,
      'kari',
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ title: 'Fant ikke datasettet' });
  });

  it('is closed in lockdown like a model run, since it embeds the query', () => {
    expect(modelRunRoutes).toContain('POST /tenants/:tenant/datasets/:id/search');
    expect(modelRunRoutes).toContain('POST /operator/datasets/:id/search');
  });
});

describe("listing a dataset's documents", () => {
  const documentsPath = (dataset: string, tenant = digdir, query = '') =>
    `/tenants/${tenant}/datasets/${encodeURIComponent(dataset)}/documents${query}`;
  const get = (app: Hono, path: string, as: string) =>
    app.request(path, { headers: { authorization: `Bearer ${as}` } });

  it("pages through a dataset's documents with their title and fields", async () => {
    const { app } = await boot();

    const first = (await (
      await get(app, documentsPath('filer', digdir, '?limit=2'), 'erik')
    ).json()) as DatasetDocumentsPage;
    const second = (await (
      await get(app, documentsPath('filer', digdir, '?limit=2&offset=2'), 'erik')
    ).json()) as DatasetDocumentsPage;

    expect(first).toMatchObject({ dataset: `${digdir}/filer`, limit: 2, offset: 0 });
    expect(first.documents).toHaveLength(2);
    expect(first.documents[0]).toMatchObject({
      id: 'dok-1',
      title: 'Tilskudd til digitalisering i kommunene',
      fields: { kategori: 'Veiledning' },
    });
    expect(second.offset).toBe(2);
    expect(second.documents.map((d) => d.id)).not.toContain('dok-1');
    expect(first.found).toBeGreaterThan(2);
  });

  it('lists a platform dataset shared with the tenant', async () => {
    const { app } = await boot();

    const response = await get(app, documentsPath('digdir/felles'), 'kari');

    expect(response.status).toBe(200);
  });

  it("never lists another tenant's dataset, nor a platform dataset shared only with others", async () => {
    const { app } = await boot();

    const own = await get(app, documentsPath(`${other}/hemmelig`), 'kari');
    const notShared = await get(app, documentsPath('digdir/kun-nav'), 'kari');
    const outsider = await get(app, documentsPath('filer'), 'ola');

    expect([own.status, notShared.status, outsider.status]).toEqual([404, 404, 404]);
  });

  it('refuses an API key with a typed problem, since only people list documents here', async () => {
    const { app } = await boot();

    const response = await get(app, documentsPath('filer'), 'nokkel');

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ type: datasetDocumentsPeopleOnlyType });
  });

  it('refuses a page size above the limit instead of cutting it', async () => {
    const { app } = await boot();

    const response = await get(app, documentsPath('filer', digdir, '?limit=101'), 'kari');

    expect(response.status).toBe(422);
  });

  it('refuses an offset that is not a multiple of the page size, since engines read whole pages', async () => {
    const { app } = await boot();

    const response = await get(app, documentsPath('filer', digdir, '?offset=10&limit=50'), 'kari');

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ errors: [{ path: 'offset' }] });
  });

  it('applies filters across all documents, not only the page, and counts the matches', async () => {
    const { app } = await boot();
    const filters = encodeURIComponent(JSON.stringify({ kategori: 'Veiledning' }));

    const page = (await (
      await get(app, documentsPath('filer', digdir, `?limit=1&filters=${filters}`), 'kari')
    ).json()) as DatasetDocumentsPage;
    const all = (await (
      await get(app, documentsPath('filer', digdir, '?limit=100'), 'kari')
    ).json()) as DatasetDocumentsPage;

    const matching = all.documents.filter((d) => d.fields.kategori === 'Veiledning');
    expect(page.filters).toEqual({ kategori: 'Veiledning' });
    expect(page.found).toBe(matching.length);
    expect(page.documents.every((d) => d.fields.kategori === 'Veiledning')).toBe(true);
  });

  it('refuses filters on a field the dataset does not declare, and filters that are not a JSON object', async () => {
    const { app } = await boot();

    const undeclared = await get(
      app,
      documentsPath('filer', digdir, `?filters=${encodeURIComponent('{"hemmelig":"x"}')}`),
      'kari',
    );
    const notObject = await get(app, documentsPath('filer', digdir, '?filters=%5B1%5D'), 'kari');

    expect(undeclared.status).toBe(422);
    expect(await undeclared.json()).toMatchObject({ errors: [{ path: 'filters.hemmelig' }] });
    expect(notObject.status).toBe(422);
    expect(await notObject.json()).toMatchObject({ errors: [{ path: 'filters' }] });
  });

  it('reads one document with the start of its text', async () => {
    const { app } = await boot();

    const response = await get(app, `${documentsPath('filer')}/dok-1`, 'kari');
    const doc = (await response.json()) as DatasetDocumentDetail;

    expect(response.status).toBe(200);
    expect(doc).toMatchObject({ id: 'dok-1', title: 'Tilskudd til digitalisering i kommunene' });
    expect(doc.excerpt?.length).toBeGreaterThan(0);
    expect(doc.excerpt?.length).toBeLessThanOrEqual(documentExcerptLength);
  });

  it("names the uploaded original of a document in the organisation's own dataset, and never in a shared one", async () => {
    const blobs = new InMemoryBlobStore();
    const prefix = uploadPrefix(`${digdir}/filer`, digdir);
    await blobs.put(
      { tenant: digdir, path: `${prefix}veileder.pdf` },
      new Uint8Array(4),
      'application/pdf',
    );
    const uploaded = uploadDocumentId(digdir, `${prefix}veileder.pdf`);
    const { app, knowledge } = await boot({ blobs });
    const open = knowledge.open.bind(knowledge);
    knowledge.open = (ref, ctx) => ({
      ...open(ref, ctx),
      documents: async () => ({ documents: [{ id: uploaded, fields: {} }], found: 1 }),
    });

    const own = (await (
      await get(app, documentsPath('filer'), 'kari')
    ).json()) as DatasetDocumentsPage;
    const shared = (await (
      await get(app, documentsPath('digdir/felles'), 'kari')
    ).json()) as DatasetDocumentsPage;

    expect(own.documents[0]?.original).toEqual({
      name: 'veileder.pdf',
      size: 4,
      type: 'application/pdf',
    });
    expect(shared.documents[0]?.original).toBeUndefined();
  });

  it('answers an unknown document with a typed 404', async () => {
    const { app } = await boot();

    const response = await get(app, `${documentsPath('filer')}/finnes-ikke`, 'kari');

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ type: datasetDocumentNotFoundType });
  });

  it("never reads a document of another tenant's dataset, and only people read one", async () => {
    const { app } = await boot();

    const own = await get(app, `${documentsPath(`${other}/hemmelig`)}/dok-1`, 'kari');
    const outsider = await get(app, `${documentsPath('filer')}/dok-1`, 'ola');
    const key = await get(app, `${documentsPath('filer')}/dok-1`, 'nokkel');

    expect([own.status, outsider.status, key.status]).toEqual([404, 404, 403]);
    expect(await own.text()).not.toContain('Tilskudd');
  });

  it('answers a failing engine with a typed problem and never its error text', async () => {
    const { app, knowledge } = await boot();
    const open = knowledge.open.bind(knowledge);
    knowledge.open = (ref, ctx) => ({
      ...open(ref, ctx),
      documents: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.7:8108 api-key=hemmelig');
      },
    });

    const response = await get(app, documentsPath('filer'), 'kari');
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toMatchObject({ type: datasetDocumentsFailedType });
    expect(text).not.toContain('hemmelig');
    expect(text).not.toContain('10.0.0.7');
  });

  const lastRun = (report: Record<string, unknown>): DatasetSearchDeps['ingestion'] => ({
    list: async () => [{ id: 'filer-pipeline' }] as never,
    executions: async () =>
      [
        {
          id: 'run-1',
          status: 'succeeded',
          startedAt: '2026-11-18T08:00:00Z',
          report: { stored: 3, skipped: 1, failed: [], ...report },
        },
      ] as never,
  });

  const page = async (app: Hono, path: string, as = 'kari') =>
    (await (await get(app, path, as)).json()) as DatasetDocumentsPage;

  it("always answers a total, from the dataset's document count when the engine does not count", async () => {
    const { app, knowledge } = await boot({ documentCount: async () => 7 });
    const open = knowledge.open.bind(knowledge);
    knowledge.open = (ref, ctx) => ({
      ...open(ref, ctx),
      documents: async () => ({ documents: [{ id: 'dok-1', fields: {} }] }),
    });

    const answer = await page(app, documentsPath('filer'));

    expect(answer).toMatchObject({ total: 7, totalExact: true });
    expect(answer.found).toBeUndefined();
  });

  it('estimates the total from the pages read when nothing counts, and says it is an estimate', async () => {
    const { app, knowledge } = await boot();
    const open = knowledge.open.bind(knowledge);
    knowledge.open = (ref, ctx) => ({
      ...open(ref, ctx),
      documents: async () => ({ documents: [{ id: 'dok-1', fields: {} }] }),
    });

    const answer = await page(app, documentsPath('filer', digdir, '?limit=25&offset=25'));

    expect(answer).toMatchObject({ total: 26, totalExact: false });
  });

  it('refuses a title search or a sort the engine cannot do, so a screen can hide them', async () => {
    const { app } = await boot();

    const listing = await page(app, documentsPath('filer'));
    const query = await get(app, documentsPath('filer', digdir, '?query=tilskudd'), 'kari');
    const sort = await get(app, documentsPath('filer', digdir, '?sort=title'), 'kari');

    expect(listing.listing).toEqual({ query: false, sort: [] });
    expect([query.status, sort.status]).toEqual([422, 422]);
    expect(await query.json()).toMatchObject({ errors: [{ path: 'query' }] });
    expect(await sort.json()).toMatchObject({ errors: [{ path: 'sort' }] });
  });

  it('passes a title search and a sort the engine offers on to it', async () => {
    const { app, knowledge } = await boot();
    const asked: unknown[] = [];
    const open = knowledge.open.bind(knowledge);
    knowledge.open = (ref, ctx) => {
      const port = open(ref, ctx);
      return {
        ...port,
        info: () => ({ ...port.info(), documentListing: { query: true, sort: ['title'] } }),
        documents: async (request) => {
          asked.push(request);
          return { documents: [], found: 0 };
        },
      };
    };

    const answer = await page(
      app,
      documentsPath('filer', digdir, '?query=tilskudd&sort=title&order=desc'),
    );

    expect(asked[0]).toMatchObject({
      query: 'tilskudd',
      sort: { key: 'title', direction: 'desc' },
    });
    expect(answer).toMatchObject({
      query: 'tilskudd',
      sort: { key: 'title', order: 'desc' },
      listing: { query: true, sort: ['title'] },
    });
  });

  it("lists the documents the organisation's own dataset failed or skipped in its latest run", async () => {
    const { app } = await boot({
      ingestion: lastRun({
        failed: ['brev-7'],
        skippedDocuments: [{ document: 'skann-3', reason: 'no_text' }],
      }),
    });

    const answer = await page(app, documentsPath('filer', digdir, '?status=failed'));

    expect(answer.status).toBe('failed');
    expect(answer.documents).toEqual([
      { id: 'skann-3', fields: {}, status: 'failed', reason: 'no_text' },
      { id: 'brev-7', fields: {}, status: 'failed', reason: 'failed' },
    ]);
    expect(answer).toMatchObject({ total: 2, totalExact: true });
  });

  it('lists the failures of every pipeline, also when another pipeline ran later', async () => {
    const run = (id: string, startedAt: string, failed: string[]) => ({
      id,
      status: 'succeeded',
      startedAt,
      report: { stored: 1, skipped: 0, failed },
    });
    const { app } = await boot({
      ingestion: {
        list: async () => [{ id: 'opplasting' }, { id: 'nettsted' }] as never,
        executions: async (_dataset: string, pipeline: string) =>
          (pipeline === 'opplasting'
            ? [run('run-1', '2026-11-18T08:00:00Z', ['brev-7'])]
            : [run('run-2', '2026-11-18T09:00:00Z', [])]) as never,
      },
    });

    const answer = await page(app, documentsPath('filer', digdir, '?status=failed'));

    expect(answer.documents.map((d) => d.id)).toEqual(['brev-7']);
    expect(answer.statusCounts.failed).toBe(1);
  });

  it("never shows another owner's failed or pending documents, such as a shared platform dataset's", async () => {
    const { app } = await boot({
      ingestion: lastRun({ failed: ['hemmelig-1'] }),
    });

    const answer = await page(app, documentsPath('digdir/felles', digdir, '?status=failed'));

    expect(answer.documents).toEqual([]);
    expect(answer.statusCounts).toMatchObject({ failed: 0, pending: 0 });
  });

  it('lists an uploaded file that is not indexed yet as pending', async () => {
    const blobs = new InMemoryBlobStore();
    const prefix = uploadPrefix(`${digdir}/filer`, digdir);
    await blobs.put(
      { tenant: digdir, path: `${prefix}ny-veileder.pdf` },
      new Uint8Array(4),
      'application/pdf',
    );
    const { app } = await boot({ blobs });

    const answer = await page(app, documentsPath('filer', digdir, '?status=pending'));

    expect(answer.documents).toEqual([
      {
        id: uploadDocumentId(digdir, `${prefix}ny-veileder.pdf`),
        title: 'ny-veileder.pdf',
        fields: {},
        original: { name: 'ny-veileder.pdf', size: 4, type: 'application/pdf' },
        status: 'pending',
      },
    ]);
  });

  it('counts each status over the whole dataset, whatever page or status is listed', async () => {
    const { app } = await boot({
      ingestion: lastRun({ failed: ['brev-7'] }),
      documentCount: async () => 5,
    });

    const answer = await page(app, documentsPath('filer', digdir, '?status=failed'));

    expect(answer.statusCounts).toEqual({ indexed: 5, failed: 1, pending: 0 });
  });

  it('refuses filters or a sort on failed and pending documents', async () => {
    const { app } = await boot();
    const filters = encodeURIComponent(JSON.stringify({ kategori: 'Veiledning' }));

    const response = await get(
      app,
      documentsPath('filer', digdir, `?status=pending&filters=${filters}`),
      'kari',
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ errors: [{ path: 'filters' }] });
  });

  const indexedOnly = (knowledge: { open: (...a: never[]) => unknown }, count: number) => {
    const asked: { limit?: number; offset?: number; filters?: unknown }[] = [];
    const open = (knowledge.open as (ref: never, ctx: never) => Record<string, unknown>).bind(
      knowledge,
    );
    knowledge.open = ((ref: never, ctx: never) => ({
      ...open(ref, ctx),
      documents: async (request: { limit?: number; offset?: number; filters?: unknown }) => {
        asked.push(request);
        const all = Array.from({ length: count }, (_, i) => ({ id: `ind-${i}`, fields: {} }));
        const at = request.offset ?? 0;
        return { documents: all.slice(at, at + (request.limit ?? 50)), found: count };
      },
    })) as never;
    return asked;
  };

  it('lists failed, then pending, then indexed documents as one list with status all', async () => {
    const blobs = new InMemoryBlobStore();
    const prefix = uploadPrefix(`${digdir}/filer`, digdir);
    await blobs.put(
      { tenant: digdir, path: `${prefix}ny.pdf` },
      new Uint8Array(4),
      'application/pdf',
    );
    const { app, knowledge } = await boot({
      blobs,
      ingestion: lastRun({ failed: ['brev-7'] }),
    });
    indexedOnly(knowledge as never, 3);

    const answer = await page(app, documentsPath('filer', digdir, '?status=all'));

    expect(answer.status).toBe('all');
    expect(answer.documents.map((d) => d.status)).toEqual([
      'failed',
      'pending',
      'indexed',
      'indexed',
      'indexed',
    ]);
    expect(answer).toMatchObject({ total: 5, totalExact: true });
  });

  it('pages status all across the border between failed and indexed documents', async () => {
    const { app, knowledge } = await boot({
      ingestion: lastRun({ failed: ['brev-7', 'brev-8', 'brev-9'] }),
    });
    const asked = indexedOnly(knowledge as never, 10);

    const second = await page(app, documentsPath('filer', digdir, '?status=all&limit=2&offset=2'));
    const third = await page(app, documentsPath('filer', digdir, '?status=all&limit=2&offset=4'));

    expect(second.documents.map((d) => d.id)).toEqual(['brev-9', 'ind-0']);
    expect(third.documents.map((d) => d.id)).toEqual(['ind-1', 'ind-2']);
    expect(third.total).toBe(13);
    expect(asked.every((r) => (r.offset ?? 0) % (r.limit ?? 1) === 0)).toBe(true);
  });

  it('leaves failed and pending documents out of status all when filters are set', async () => {
    const { app, knowledge } = await boot({ ingestion: lastRun({ failed: ['brev-7'] }) });
    const asked = indexedOnly(knowledge as never, 2);
    const filters = encodeURIComponent(JSON.stringify({ kategori: 'Veiledning' }));

    const answer = await page(
      app,
      documentsPath('filer', digdir, `?status=all&filters=${filters}`),
    );

    expect(answer.documents.map((d) => d.status)).toEqual(['indexed', 'indexed']);
    expect(answer.statusCounts.failed).toBe(1);
    expect(asked).toContainEqual(expect.objectContaining({ filters: { kategori: 'Veiledning' } }));
  });

  it("never shows another owner's failed documents in status all", async () => {
    const { app, knowledge } = await boot({ ingestion: lastRun({ failed: ['hemmelig-1'] }) });
    indexedOnly(knowledge as never, 1);

    const answer = await page(app, documentsPath('digdir/felles', digdir, '?status=all'));

    expect(answer.documents.map((d) => d.id)).toEqual(['ind-0']);
  });

  it('gives each listed document its chunk count when the engine keeps it', async () => {
    const { app } = await boot();

    const answer = await page(app, documentsPath('filer'));

    expect(answer.documents[0]?.chunkCount).toBeGreaterThan(0);
    expect(answer.documents.every((d) => d.status === 'indexed')).toBe(true);
  });

  it('reads the chunks asked for by position and keeps the excerpt', async () => {
    const { app } = await boot();

    const response = await get(app, `${documentsPath('filer')}/dok-1?chunks=0-1`, 'kari');
    const doc = (await response.json()) as DatasetDocumentDetail;

    expect(response.status).toBe(200);
    expect(doc.chunks?.map((c) => c.position)).toEqual([0, 1]);
    expect(doc.chunks?.every((c) => c.text.length > 0)).toBe(true);
    expect(doc.excerpt?.length).toBeGreaterThan(0);
  });

  it('refuses a chunks range that is not from-to or spans more than 50 positions', async () => {
    const { app } = await boot();

    const wide = await get(app, `${documentsPath('filer')}/dok-1?chunks=0-50`, 'kari');
    const garbled = await get(app, `${documentsPath('filer')}/dok-1?chunks=alle`, 'kari');

    expect([wide.status, garbled.status]).toEqual([422, 422]);
    expect(await wide.json()).toMatchObject({ errors: [{ path: 'chunks' }] });
  });

  it("never reads chunks of another tenant's dataset", async () => {
    const { app } = await boot();

    const response = await get(
      app,
      `${documentsPath(`${other}/hemmelig`)}/dok-1?chunks=0-1`,
      'kari',
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Tilskudd');
  });
});
