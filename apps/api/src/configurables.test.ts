import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { textPart, type Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { InMemoryConfigEntryStore, type ConfigEntryStore } from './config-store.js';
import { InMemoryIngestionBackend, type IngestionBackend } from './ingestion.js';

const digdir = '991825827';
const other = '999888777';

const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const chunk = (delta: Record<string, unknown>, usage?: Record<string, number>) => ({
  data: {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-test',
    choices: usage ? [] : [{ index: 0, delta, finish_reason: 'stop' }],
    ...(usage ? { usage } : {}),
  },
});

const completion = (content: string, stream: boolean) =>
  stream
    ? {
        status: 200,
        sse: [
          chunk({ content }),
          chunk({}, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
          { data: '[DONE]' },
        ],
      }
    : {
        status: 200,
        json: {
          id: 'c1',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-test',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      };

const kudosOptions = {
  collections: { docs: 'kudos_docs', chunks: 'kudos_chunks' },
  profiles: {
    content: { collection: 'chunks', queryBy: ['content_markdown'], textField: 'content_markdown' },
  },
};

export const boot = async (
  options: {
    store?: ConfigEntryStore;
    ingestion?: IngestionBackend;
    answer?: string;
    searchOnlyClusters?: string[];
  } = {},
) => {
  const model = await fakeHttp((body) =>
    completion(options.answer ?? 'Et kort svar.', Boolean(body.stream)),
  );
  servers.push(model);
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: `${model.url}/v1`,
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [
          {
            id: 'fake/gpt',
            endpoint: 'fake',
            deployment: 'gpt',
            residency: 'norway',
            capabilities: ['stream', 'json-schema'],
          },
        ],
      },
      knowledge: {
        endpoints: {
          search: {
            engine: 'typesense',
            baseURL: 'https://search.example.no',
            auth: { kind: 'api-key', secret: 'secret://env/search-key' },
          },
        },
        datasets: [
          { id: 'digdir/kudos', endpoint: 'search', residency: 'norway', options: kudosOptions },
        ],
      },
      rerank: { endpoints: {}, rerankers: [] },
    },
    prices: { 'fake/gpt': { inputPerThousand: 0.01, outputPerThousand: 0.02 } },
    ...(options.searchOnlyClusters ? { searchOnlyClusters: options.searchOnlyClusters } : {}),
    secrets: envSecrets({ FAKE_KEY: 'k', SEARCH_KEY: 's' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    configurables: {
      ...(options.store ? { store: options.store } : {}),
      ...(options.ingestion ? { ingestion: options.ingestion } : {}),
    },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (
    path: string,
    as: string,
    init: { method?: string; body?: unknown; reason?: string | null; ifMatch?: number } = {},
  ) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        ...(init.reason === null ? {} : { 'change-reason': init.reason ?? 'Testendring' }),
        ...(init.ifMatch !== undefined ? { 'if-match': String(init.ifMatch) } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { platform, admin, app, call, model };
};

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

const service = (
  patch: { tenant?: string; id?: string; model?: string; spec?: Record<string, unknown> } = {},
) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: patch.tenant ?? digdir, id: patch.id ?? 'svar', name: 'Svar' },
  spec: {
    purpose: 'Svarer kort på spørsmål',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'prompts/svar.md' } },
    model: { primary: patch.model ?? 'fake/gpt', residency: 'global' },
    exposure: { rest: true },
    ...patch.spec,
  },
});
const files = { 'prompts/svar.md': 'Svar kort.' };

const ask = async (platform: Awaited<ReturnType<typeof boot>>['platform'], query: string) => {
  const capability = (await platform.definitions.capabilities())[0]?.capability.descriptor.id;
  const run = await platform.kernel.invoke(principals.kari as Principal, capability ?? '', {
    data: { query },
    parts: [textPart(query)],
  });
  const parts = await run.result;
  return parts.find((p) => p.mime.startsWith('text/') && p.body.kind === 'text')?.body as
    { text: string } | undefined;
};

const tenantEndpoint = {
  engine: 'http-search',
  baseURL: 'https://sok.testetaten.example.no',
  auth: { kind: 'bearer', secret: `secret://tenant/${digdir}/search-token` },
};

describe('model, price and endpoint catalog over the API', () => {
  it('lets an operator add a model endpoint and model, versions and audits it, and refuses others', async () => {
    const { call, platform, admin } = await boot();
    const endpoint = {
      protocol: 'openai-chat',
      baseURL: 'https://modeller.example.no/v1',
      auth: { kind: 'api-key', secret: 'secret://env/other-key' },
    };

    expect(
      (
        await call('/operator/catalog/model-endpoint/norsk', 'kari', {
          method: 'PUT',
          body: endpoint,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('/operator/catalog/model-endpoint/norsk', 'drift', {
          method: 'PUT',
          body: endpoint,
        })
      ).status,
    ).toBe(200);
    const added = await call(
      `/operator/catalog/model/${encodeURIComponent('norsk/llm')}`,
      'drift',
      {
        method: 'PUT',
        body: {
          endpoint: 'norsk',
          deployment: 'llm',
          residency: 'norway',
          capabilities: ['stream'],
        },
      },
    );
    expect(added.status).toBe(200);
    expect(platform.plugins.models.has('norsk/llm')).toBe(true);
    expect(platform.models.describe().map((m) => m.id)).toContain('norsk/llm');

    const changed = await call(
      `/operator/catalog/model/${encodeURIComponent('norsk/llm')}`,
      'drift',
      {
        method: 'PUT',
        ifMatch: 1,
        body: {
          endpoint: 'norsk',
          deployment: 'llm-2',
          residency: 'norway',
          capabilities: ['stream'],
        },
      },
    );
    expect(await json(changed)).toMatchObject({ version: 2, spec: { deployment: 'llm-2' } });
    const stale = await call(
      `/operator/catalog/model/${encodeURIComponent('norsk/llm')}`,
      'drift',
      {
        method: 'PUT',
        ifMatch: 1,
        body: { endpoint: 'norsk', deployment: 'llm-3', residency: 'norway' },
      },
    );
    expect(stale.status).toBe(409);
    const versions = await json<{ data: unknown[] }>(
      await call(`/operator/catalog/model/${encodeURIComponent('norsk/llm')}/versions`, 'drift'),
    );
    expect(versions.data).toHaveLength(2);
    expect((await admin.audit(digdir)).map((a) => a.action)).toContain('platform.catalog.publish');

    const dangling = await call(`/operator/catalog/model/${encodeURIComponent('x/y')}`, 'drift', {
      method: 'PUT',
      body: { endpoint: 'missing', deployment: 'y', residency: 'eu' },
    });
    expect(dangling.status).toBe(400);
    expect(
      (await call('/operator/catalog/model-endpoint/norsk', 'drift', { method: 'DELETE' })).status,
    ).toBe(400);
    expect(
      (
        await call('/operator/catalog/model-endpoint/norsk', 'drift', {
          reason: null,
          method: 'PUT',
          body: endpoint,
        })
      ).status,
    ).toBe(400);
  });

  it('changes prices live and lists seeded entries next to API entries', async () => {
    const { call, platform } = await boot();

    const saved = await call(`/operator/catalog/price/${encodeURIComponent('fake/gpt')}`, 'drift', {
      method: 'PUT',
      body: { inputPerThousand: 0.5, outputPerThousand: 1 },
    });
    expect(saved.status).toBe(200);
    expect(platform.prices['fake/gpt']).toEqual({ inputPerThousand: 0.5, outputPerThousand: 1 });
    expect(
      (
        await call(`/operator/catalog/price/${encodeURIComponent('fake/gpt')}`, 'drift', {
          method: 'PUT',
          body: { inputPerThousand: -1, outputPerThousand: 1 },
        })
      ).status,
    ).toBe(400);

    const listed = await json<{ data: { kind: string; id: string; origin: string }[] }>(
      await call('/operator/catalog/entries', 'drift'),
    );
    expect(listed.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'model', id: 'fake/gpt', origin: 'seed' }),
        expect.objectContaining({ kind: 'price', id: 'fake/gpt', origin: 'api' }),
      ]),
    );
  });

  it('keeps API entries across a restart on the same store and falls back to the seed after a delete', async () => {
    const store = new InMemoryConfigEntryStore();
    const first = await boot({ store });
    await first.call('/operator/catalog/model-endpoint/norsk', 'drift', {
      method: 'PUT',
      body: {
        protocol: 'openai-chat',
        baseURL: 'https://modeller.example.no/v1',
        auth: { kind: 'api-key', secret: 'secret://env/other-key' },
      },
    });
    await first.call(`/operator/catalog/price/${encodeURIComponent('fake/gpt')}`, 'drift', {
      method: 'PUT',
      body: { inputPerThousand: 9, outputPerThousand: 9 },
    });

    const second = await boot({ store });
    expect(second.platform.catalog.get('model-endpoint', 'norsk')?.version).toBe(1);
    expect(second.platform.prices['fake/gpt']?.inputPerThousand).toBe(9);

    await second.call(`/operator/catalog/price/${encodeURIComponent('fake/gpt')}`, 'drift', {
      method: 'DELETE',
    });
    expect(second.platform.prices['fake/gpt']).toBeUndefined();
  });
});

describe('tenant catalog entries', () => {
  it('lets a tenant bring its own search endpoint with its own secret and keeps the dataset private', async () => {
    const { call, platform } = await boot();

    expect(
      (
        await call(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, 'kari', {
          method: 'PUT',
          body: tenantEndpoint,
        })
      ).status,
    ).toBe(200);
    const created = await call(`/tenants/${digdir}/datasets`, 'kari', {
      body: {
        id: 'interne-sider',
        name: 'Interne sider',
        residency: 'norway',
        aliases: ['intern'],
        collection: { endpoint: 'sok', options: { index: 'intranett' } },
        facets: ['kategori'],
        maxFacetValues: 50,
        links: 'kudos-legacy',
      },
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      id: 'interne-sider',
      fullId: `${digdir}/interne-sider`,
      aliases: [`${digdir}/intern`],
      collection: { endpoint: `${digdir}/sok`, options: { index: 'intranett' } },
      facets: ['kategori'],
      filters: { kategori: 'multiselect' },
      maxFacetValues: 50,
      links: 'kudos-legacy',
    });
    expect(platform.knowledge.datasets().get(`${digdir}/interne-sider`)?.tenants).toEqual([digdir]);
    expect(platform.catalog.effective().knowledge.endpoints[`${digdir}/sok`]).toMatchObject({
      auth: { secret: `secret://tenant-${digdir}/search-token` },
    });

    const mine = await json<{ data: { id: string; editable: boolean }[] }>(
      await call(`/tenants/${digdir}/datasets`, 'kari'),
    );
    expect(mine.data.map((d) => [d.id, d.editable])).toEqual(
      expect.arrayContaining([
        ['digdir/kudos', false],
        ['interne-sider', true],
      ]),
    );
    const shared = (
      await json<{ data: { id: string; state: string }[] }>(
        await call(`/tenants/${digdir}/datasets`, 'kari'),
      )
    ).data.find((d) => d.id === 'digdir/kudos');
    expect(shared?.state).toBe('external');

    const theirs = await json<{ data: { id: string }[] }>(
      await call(`/tenants/${other}/datasets`, 'ola'),
    );
    expect(theirs.data.map((d) => d.id)).toEqual(['digdir/kudos']);
    expect((await call(`/tenants/${digdir}/datasets`, 'ola')).status).toBe(404);

    const updated = await call(`/tenants/${digdir}/datasets/interne-sider`, 'kari', {
      method: 'PUT',
      body: { maxFacetValues: 80 },
    });
    expect(await json(updated)).toMatchObject({
      version: 2,
      maxFacetValues: 80,
      name: 'Interne sider',
    });
  });

  it('refuses tenant endpoints that use platform secrets, plain HTTP or private hosts', async () => {
    const { call } = await boot();
    const put = (body: unknown) =>
      call(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, 'kari', { method: 'PUT', body });

    const envSecret = await put({
      ...tenantEndpoint,
      auth: { kind: 'bearer', secret: 'secret://env/search-key' },
    });
    expect(envSecret.status).toBe(400);
    expect(JSON.stringify(await json(envSecret))).toContain('tenant secret');
    expect(
      (
        await put({
          ...tenantEndpoint,
          auth: { kind: 'bearer', secret: `secret://tenant/${other}/x` },
        })
      ).status,
    ).toBe(400);
    expect(
      (await put({ ...tenantEndpoint, baseURL: 'http://sok.testetaten.example.no' })).status,
    ).toBe(400);
    expect((await put({ ...tenantEndpoint, baseURL: 'https://10.0.0.5' })).status).toBe(400);
    expect((await put({ ...tenantEndpoint, baseURL: 'https://search.internal' })).status).toBe(400);
    expect(
      (
        await call(`/tenants/${digdir}/catalog/price/x`, 'kari', {
          method: 'PUT',
          body: { inputPerThousand: 0, outputPerThousand: 0 },
        })
      ).status,
    ).toBe(400);
  });

  it('lets a tenant point at an existing collection only on an endpoint the operator shares, within its prefixes', async () => {
    const { call } = await boot();
    const dataset = (collections: Record<string, string>) =>
      call(`/tenants/${digdir}/datasets`, 'kari', {
        body: {
          id: 'egne',
          name: 'Egne dokumenter',
          residency: 'norway',
          collection: { endpoint: 'search', collections },
        },
      });

    expect((await dataset({ docs: 'digdir_docs', chunks: 'digdir_chunks' })).status).toBe(400);

    const shared = await call('/operator/catalog/knowledge-endpoint/search', 'drift', {
      method: 'PUT',
      body: {
        engine: 'typesense',
        baseURL: 'https://search.example.no',
        auth: { kind: 'api-key', secret: 'secret://env/search-key' },
        sharing: { tenants: [digdir], collectionPrefixes: ['digdir_'] },
      },
    });
    expect(shared.status).toBe(200);
    expect((await dataset({ docs: 'kudos_docs', chunks: 'kudos_chunks' })).status).toBe(400);
    const ok = await dataset({ docs: 'digdir_docs', chunks: 'digdir_chunks' });
    expect(ok.status).toBe(201);
    expect(await json(ok)).toMatchObject({
      collection: {
        endpoint: 'search',
        options: { profiles: { content: { collection: 'chunks' } } },
      },
    });
  });

  it('keeps a tenant model private: another tenant cannot publish a service on it, and a used model cannot be removed', async () => {
    const { call, platform } = await boot();
    await call(`/tenants/${digdir}/catalog/model-endpoint/egen`, 'kari', {
      method: 'PUT',
      body: {
        protocol: 'openai-chat',
        baseURL: 'https://llm.testetaten.example.no/v1',
        auth: { kind: 'api-key', secret: `secret://tenant/${digdir}/llm-key` },
      },
    });
    const model = await call(`/tenants/${digdir}/catalog/model/egen-gpt`, 'kari', {
      method: 'PUT',
      body: { endpoint: 'egen', deployment: 'gpt', residency: 'norway', capabilities: ['stream'] },
    });
    expect(await json(model)).toMatchObject({ id: `${digdir}/egen-gpt`, scope: digdir });

    const theirs = await platform.definitions.publish(
      service({ tenant: other, model: `${digdir}/egen-gpt` }),
      'test',
      'test',
      files,
    );
    expect(theirs.ok).toBe(false);
    expect(JSON.stringify(theirs)).toContain('belongs to another tenant');
    const ours = await platform.definitions.publish(
      service({ model: `${digdir}/egen-gpt` }),
      'test',
      'test',
      files,
    );
    expect(ours.ok).toBe(true);
    const removed = await call(`/tenants/${digdir}/catalog/model/egen-gpt`, 'kari', {
      method: 'DELETE',
    });
    expect(removed.status).toBe(400);
    expect(JSON.stringify(await json(removed))).toContain('used by a published service');
  });
});

describe('ingestion pipelines', () => {
  const pipeline = {
    id: 'nettsider',
    name: 'Nettsidene',
    source: { kind: 'website', sitemap: 'https://www.digdir.no/sitemap.xml' },
    chunking: { minimumLength: 10, maximumLength: 20 },
  };

  it('creating a pipeline answers 201 and unknown pipelines answer 404 to execute and delete', async () => {
    const { call } = await boot();
    const base = `/operator/datasets/${encodeURIComponent('digdir/kudos')}/pipelines`;

    const created = await call(base, 'drift', { body: pipeline });
    const executed = await call(`${base}/finnes-ikke/execute`, 'drift', { method: 'POST' });
    const removed = await call(`${base}/finnes-ikke`, 'drift', { method: 'DELETE' });

    expect(created.status).toBe(201);
    expect([executed.status, removed.status]).toEqual([404, 404]);
    expect(executed.headers.get('content-type')).toContain('application/problem+json');
  });

  it('pipeline versions mark the version that removed the pipeline as deleted', async () => {
    const { call } = await boot();
    const base = `/operator/datasets/${encodeURIComponent('digdir/kudos')}/pipelines`;
    await call(base, 'drift', { body: pipeline });
    await call(`${base}/nettsider`, 'drift', { method: 'DELETE' });

    const versions = await json<{ data: { version: number; deleted: boolean }[] }>(
      await call(`${base}/nettsider/versions`, 'drift'),
    );

    expect(versions.data.map((v) => [v.version, v.deleted])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it('ingestion refuses the shared search-only Typesense cluster', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { call } = await boot({ searchOnlyClusters: ['https://search.example.no'] });
    const base = `/operator/datasets/${encodeURIComponent('digdir/kudos')}/pipelines`;

    expect((await call(base, 'drift', { body: pipeline })).status).toBe(201);
    expect((await call(base, 'drift', { body: pipeline })).status).toBe(409);
    expect(
      (
        await call(`${base}/nettsider`, 'drift', {
          method: 'PUT',
          body: { ...pipeline, parallelism: 4 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`${base}/nettsider`, 'drift', {
          method: 'PUT',
          body: { name: 'x', source: { kind: 'ftp' } },
        })
      ).status,
    ).toBe(400);
    const listed = await json<{
      data: { id: string; version: number }[];
      backend: { available: boolean; reason: string };
    }>(await call(base, 'drift'));
    expect(listed.data).toEqual([expect.objectContaining({ id: 'nettsider', version: 2 })]);
    expect(listed.backend).toMatchObject({ available: false });
    expect(listed.backend.reason).toMatch(/search-only/);

    const run = await call(`${base}/nettsider/execute`, 'drift', { body: {} });
    expect(run.status).toBe(409);
    expect(JSON.stringify(await json(run))).toMatch(/shared, search-only Typesense cluster/);
    expect((await call(base, 'kari')).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('refuses a Kudos pipeline that would read the whole archive, and tells when a scheduled one runs', async () => {
    const { call } = await boot();
    const base = `/operator/datasets/${encodeURIComponent('digdir/kudos')}/pipelines`;

    const unbounded = await call(base, 'drift', {
      body: { id: 'kudos', name: 'Kudos', source: { kind: 'kudos' } },
    });
    expect(unbounded.status).toBe(422);
    expect(await json(unbounded)).toMatchObject({
      title: expect.stringContaining('dokumenttyper eller en startdato'),
    });

    const saved = await call(base, 'drift', {
      body: {
        id: 'kudos',
        name: 'Kudos',
        source: { kind: 'kudos', types: ['Tildelingsbrev'], orgs: ['Digdir'] },
        schedule: 'weekly',
      },
    });
    expect(saved.status).toBe(201);
    const nextRunAt = (await json<{ nextRunAt: string }>(saved)).nextRunAt;
    expect(nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T0[12]:00:00\.000Z$/);
    expect(await json(await call(`${base}/kudos`, 'drift'))).toMatchObject({
      spec: { schedule: 'weekly' },
      nextRunAt,
    });
    expect(await json(await call(base, 'drift'))).toMatchObject({ data: [{ nextRunAt }] });
    expect(await json(await call(`${base}/kudos/executions`, 'drift'))).toMatchObject({
      data: [],
      nextRunAt,
    });
  });

  it('creates a dataset from the portal shape with a slug id and merges name and description on PUT', async () => {
    const { call } = await boot();
    await call(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, 'kari', {
      method: 'PUT',
      body: tenantEndpoint,
    });
    const created = await call(`/tenants/${digdir}/datasets`, 'kari', {
      body: { name: 'Søknader og veiledere', endpoint: 'sok', residency: 'eu' },
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      id: 'soknader-og-veiledere',
      fullId: `${digdir}/soknader-og-veiledere`,
      index: { endpoint: `${digdir}/sok` },
    });
    const again = await call(`/tenants/${digdir}/datasets`, 'kari', {
      body: { name: 'Søknader og veiledere', endpoint: 'sok', residency: 'eu' },
    });
    expect(await json(again)).toMatchObject({ id: 'soknader-og-veiledere-2' });

    const renamed = await call(`/tenants/${digdir}/datasets/soknader-og-veiledere`, 'kari', {
      method: 'PUT',
      body: { name: 'Veiledere', description: 'Veiledere for søkere' },
    });
    expect(renamed.status).toBe(200);
    expect(
      await json(await call(`/tenants/${digdir}/datasets/soknader-og-veiledere`, 'kari')),
    ).toMatchObject({
      name: 'Veiledere',
      description: 'Veiledere for søkere',
      residency: 'eu',
      index: { endpoint: `${digdir}/sok` },
      source: 'none',
      lastExecution: null,
    });
    expect(
      (
        await call(`/tenants/${digdir}/datasets/soknader-og-veiledere`, 'kari', {
          method: 'PUT',
          body: { name: 'Uten grunn' },
          reason: null,
        })
      ).status,
    ).toBe(400);
  });

  it('runs a pipeline on the pluggable backend and records the execution', async () => {
    const backend = new InMemoryIngestionBackend(() => [
      { key: 'a', text: 'Digdir har ansvar for felles løsninger.' },
      { key: 'b', text: 'kort' },
    ]);
    const { call, platform } = await boot({ ingestion: backend });
    await call(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, 'kari', {
      method: 'PUT',
      body: { ...tenantEndpoint, engine: 'typesense' },
    });
    const dataset = await call(`/tenants/${digdir}/datasets`, 'kari', {
      body: {
        id: 'sider',
        name: 'Sider',
        residency: 'norway',
        collection: {
          endpoint: 'sok',
          collections: { docs: 'sider_docs', chunks: 'sider_chunks' },
        },
      },
    });
    expect(dataset.status).toBe(201);
    const base = `/tenants/${digdir}/datasets/sider/pipelines`;
    await call(base, 'kari', { body: pipeline });

    const started = await call(`${base}/nettsider/execute`, 'kari', { body: {} });
    expect(started.status).toBe(202);
    const execution = await json<{ id: string; status: string }>(started);
    expect(execution.status).toBe('running');
    await new Promise((r) => setTimeout(r, 10));

    const runs = await json<{ data: { status: string; report: unknown }[] }>(
      await call(`${base}/nettsider/executions`, 'kari'),
    );
    expect(runs.data[0]).toMatchObject({ status: 'succeeded', report: { stored: 1, skipped: 1 } });
    expect(backend.indexes.get('sider_chunks')?.size).toBe(2);
    expect(backend.jobs[0]?.target).toEqual({
      dataset: `${digdir}/sider`,
      endpoint: `${digdir}/sok`,
      collections: { docs: 'sider_docs', chunks: 'sider_chunks' },
    });
    expect(platform.ingestion.backend.available).toBe(true);
    expect((await call(`/tenants/${other}/datasets/sider/pipelines`, 'ola')).status).toBe(404);
  });

  it('refuses a tenant pipeline whose phrase models are unreleased', async () => {
    const { call, platform } = await boot();
    await platform.catalog.publish({
      kind: 'model',
      scope: 'platform',
      id: 'fake/ny',
      spec: { endpoint: 'fake', deployment: 'ny', residency: 'norway', release: 'candidate' },
      by: 'operator:test:drift',
      reason: 'ny modell',
    });
    await call(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, 'kari', {
      method: 'PUT',
      body: { ...tenantEndpoint, engine: 'typesense' },
    });
    await call(`/tenants/${digdir}/datasets`, 'kari', {
      body: {
        id: 'sider',
        name: 'Sider',
        residency: 'norway',
        collection: {
          endpoint: 'sok',
          collections: { docs: 'sider_docs', chunks: 'sider_chunks' },
        },
      },
    });
    const base = `/tenants/${digdir}/datasets/sider/pipelines`;

    const refused = await call(base, 'kari', {
      body: { ...pipeline, phrases: { model: 'fake/gpt', fallbackModel: 'fake/ny' } },
    });
    const saved = await call(base, 'kari', {
      body: { ...pipeline, phrases: { model: 'fake/gpt' } },
    });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      errors: [{ path: 'spec.phrases.fallbackModel' }],
    });
    expect(saved.status).toBe(201);
  });
});

describe('test set write API', () => {
  const firstCase = {
    split: 'validation',
    input: 'Hva er Digdir?',
    expected: { answerPattern: 'Digdir' },
  };

  it('creates a test set, upserts and removes cases as new versions, and validates', async () => {
    const { call, platform } = await boot();
    const created = await call(`/tenants/${digdir}/test-sets`, 'kari', {
      body: {
        id: 'grunnleggende',
        name: 'Grunnleggende',
        service: 'svar',
        cases: [{ id: 'c1', ...firstCase }],
      },
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({ id: 'grunnleggende', metadata: { version: 1 } });
    expect(
      (
        await call(`/tenants/${digdir}/test-sets`, 'kari', {
          body: { id: 'grunnleggende', name: 'x', cases: [] },
        })
      ).status,
    ).toBe(400);

    const added = await call(`/tenants/${digdir}/test-sets/grunnleggende/cases/c2`, 'kari', {
      method: 'PUT',
      body: { split: 'train', input: 'Hva gjør Altinn?' },
    });
    expect(await json(added)).toMatchObject({
      metadata: { version: 2 },
      spec: { cases: [{ id: 'c1' }, { id: 'c2' }] },
    });
    const bad = await call(`/tenants/${digdir}/test-sets/grunnleggende/cases/c3`, 'kari', {
      method: 'PUT',
      body: { split: 'sometimes', input: 'x' },
    });
    expect(bad.status).toBe(400);
    const removed = await call(`/tenants/${digdir}/test-sets/grunnleggende/cases/c1`, 'kari', {
      method: 'DELETE',
    });
    expect(await json(removed)).toMatchObject({
      metadata: { version: 3 },
      spec: { cases: [{ id: 'c2' }] },
    });
    const emptied = await call(`/tenants/${digdir}/test-sets/grunnleggende/cases/c2`, 'kari', {
      method: 'DELETE',
    });
    expect(emptied.status).toBe(200);
    expect(await json(emptied)).toMatchObject({ metadata: { version: 4 }, spec: { cases: [] } });
    const renamed = await call(`/tenants/${digdir}/test-sets/grunnleggende`, 'kari', {
      method: 'PUT',
      body: { name: 'Basis' },
    });
    expect(await json(renamed)).toMatchObject({ metadata: { name: 'Basis', version: 5 } });

    expect(
      await json(await call(`/tenants/${digdir}/test-sets/grunnleggende?version=1`, 'kari')),
    ).toMatchObject({
      spec: { cases: [{ id: 'c1' }] },
    });
    expect(
      (await platform.evalStores.testSets.list(digdir)).map((s) => s.metadata.version),
    ).toEqual([5]);
    expect((await call(`/tenants/${digdir}/test-sets`, 'ola', { body: { id: 'x' } })).status).toBe(
      404,
    );
  });
});

describe('gates', () => {
  const gate = { metric: 'judge.helpfulness', kind: 'threshold', threshold: 0.7 };

  it('lets a tenant define its own gate, keeps built-ins fixed and refuses unknown gates at publish', async () => {
    const { call, platform } = await boot();
    expect(
      (await call(`/tenants/${digdir}/gates/hjelpsom`, 'kari', { method: 'PUT', body: gate }))
        .status,
    ).toBe(200);
    expect(
      (await call(`/tenants/${digdir}/gates/recall-at-10`, 'kari', { method: 'PUT', body: gate }))
        .status,
    ).toBe(400);
    expect((await call('/operator/gates/recall-at-10', 'drift', { method: 'DELETE' })).status).toBe(
      400,
    );
    expect(
      (
        await call(`/tenants/${digdir}/gates/streng`, 'kari', {
          method: 'PUT',
          body: { ...gate, mandatory: true },
        })
      ).status,
    ).toBe(400);

    const listed = await json<{ data: { id: string; builtin: boolean; editable: boolean }[] }>(
      await call(`/tenants/${digdir}/gates`, 'kari'),
    );
    expect(listed.data.find((g) => g.id === 'hjelpsom')).toMatchObject({
      editable: true,
      builtin: false,
    });
    expect(listed.data.find((g) => g.id === 'recall-at-10')).toMatchObject({
      builtin: true,
      editable: false,
    });
    expect(
      (
        await json<{ data: { id: string }[] }>(await call(`/tenants/${other}/gates`, 'ola'))
      ).data.map((g) => g.id),
    ).not.toContain('hjelpsom');

    const known = await platform.definitions.publish(
      service({ spec: { evaluation: { testSets: [], gates: ['hjelpsom'] } } }),
      'test',
      'test',
      files,
    );
    expect(known.ok).toBe(true);
    const unknown = await platform.definitions.publish(
      service({ tenant: other, spec: { evaluation: { testSets: [], gates: ['hjelpsom'] } } }),
      'test',
      'test',
      files,
    );
    expect(JSON.stringify(unknown)).toContain('unknown gate hjelpsom');
  });

  it('applies a mandatory platform gate to every evaluated service, which the service cannot drop', async () => {
    const { call, platform } = await boot();
    await platform.definitions.publish(service(), 'test', 'first', files);
    expect(
      (
        await call('/operator/gates/kvalitet', 'drift', {
          method: 'PUT',
          body: { ...gate, mandatory: true },
        })
      ).status,
    ).toBe(200);

    const evaluated = await platform.definitions.publish(
      service({ spec: { evaluation: { testSets: ['grunnleggende'], gates: [] } } }),
      'test',
      'second',
      files,
    );
    expect(JSON.stringify(evaluated)).toContain('kvalitet on grunnleggende');
    const unevaluated = await platform.definitions.publish(
      service({ spec: { purpose: 'Svarer veldig kort' } }),
      'test',
      'third',
      files,
    );
    expect(unevaluated.ok).toBe(true);
  });
});

describe('guardrail rules', () => {
  it('runs a tenant regex rule referenced by the service and refuses unknown rule references at publish', async () => {
    const { call, platform } = await boot();
    const saved = await call(`/tenants/${digdir}/guardrail-rules/saksnummer`, 'kari', {
      method: 'PUT',
      body: {
        kind: 'regex',
        pattern: 'sak \\d{4}/\\d+',
        message: 'Vi svarer ikke om enkeltsaker.',
      },
    });
    expect(saved.status).toBe(200);
    expect(
      (
        await call(`/tenants/${digdir}/guardrail-rules/x`, 'kari', {
          method: 'PUT',
          body: { kind: 'regex', pattern: '(' },
        })
      ).status,
    ).toBe(400);

    const unknown = await platform.definitions.publish(
      service({ spec: { guardrails: { 'custom-rules': ['finnes-ikke'] } } }),
      'test',
      'test',
      files,
    );
    expect(JSON.stringify(unknown)).toContain('unknown guardrail rule finnes-ikke');
    const published = await platform.definitions.publish(
      service({ spec: { guardrails: { 'custom-rules': ['saksnummer'] } } }),
      'test',
      'test',
      files,
    );
    expect(published.ok).toBe(true);

    expect((await ask(platform, 'Hva skjedde i sak 2024/113?'))?.text).toBe(
      'Vi svarer ikke om enkeltsaker.',
    );
    expect((await ask(platform, 'Hva er Digdir?'))?.text).toBe('Et kort svar.');
  });

  it('applies a mandatory platform rule to services that do not list it, and only operators make rules mandatory', async () => {
    const { call, platform } = await boot({ answer: 'Ring 22 22 22 22 for hjelp.' });
    expect(
      (
        await call(`/tenants/${digdir}/guardrail-rules/telefon`, 'kari', {
          method: 'PUT',
          body: { kind: 'regex', pattern: 'x', mandatory: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('/operator/guardrail-rules/telefon', 'drift', {
          method: 'PUT',
          body: {
            kind: 'regex',
            pattern: '\\d{2} \\d{2} \\d{2} \\d{2}',
            stage: 'output',
            action: 'mask',
            mandatory: true,
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(`/tenants/${digdir}/guardrail-rules/telefon`, 'kari', { method: 'DELETE' }))
        .status,
    ).toBe(400);
    await platform.definitions.publish(service(), 'test', 'test', files);

    expect((await ask(platform, 'Hvem kan jeg ringe?'))?.text).toBe('Ring [fjernet] for hjelp.');
    const listed = await json<{
      data: { id: string; mandatory: boolean }[];
      kinds: string[];
      builtins: string[];
    }>(await call(`/tenants/${digdir}/guardrail-rules`, 'kari'));
    expect(listed.data).toEqual([expect.objectContaining({ id: 'telefon', mandatory: true })]);
    expect(listed.kinds).toEqual(['regex', 'denylist', 'llm-judge', 'mcp-check']);
    expect(listed.builtins).toContain('pii-before-model');
  });
});
