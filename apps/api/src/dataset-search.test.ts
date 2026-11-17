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
import type { PortContext } from '@genai/kernel';
import type { Access } from './access.js';
import { policyKind } from './building-blocks.js';
import type { CatalogItem } from './catalog-registry.js';
import { InMemoryConfigEntryStore, platformScope } from './config-store.js';
import { mountDatasetSearch, type DatasetSearchAnswer } from './dataset-search.js';
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
          message: `Datasettet ${digdir}/filer har ikke feltet «owner_orgnr» som filter`,
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

  it('is closed in lockdown like a model run, since it embeds the query', () => {
    expect(modelRunRoutes).toContain('POST /tenants/:tenant/datasets/:id/search');
    expect(modelRunRoutes).toContain('POST /operator/datasets/:id/search');
  });
});
