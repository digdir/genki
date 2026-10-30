import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Event, Principal, Task } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { fakeEmbeddingAdapter, testContext } from '@genai/port-embedding/testing';
import { knowledgeProfiles } from '@genai/port-knowledge';
import { defaultPgvectorProfiles } from '@genai/providers-pgvector';
import { createPool } from '@genai/providers-postgres';
import { createAdmin } from './admin.js';
import { loadCatalog } from './catalogs.js';
import { createPlatform, type PlatformInput } from './composition.js';
import { toTimeline } from './timeline.js';
import { stopPostgres } from '@genai/providers-postgres/testing';

const digdir = '991825827';

const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createPool>;
let folder: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  pool = createPool({ connectionString: container.getConnectionUri() });
  folder = await mkdtemp(join(tmpdir(), 'genai-ingest-'));
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await stopPostgres(container);
  if (folder) await rm(folder, { recursive: true, force: true });
});

const embedding = { model: 'fake/embed', dimensions: 8 };
const platformPg = {
  engine: 'pgvector',
  options: { connection: 'platform' },
  sharing: { tenants: '*' },
};

const boot = async (input: Partial<PlatformInput> = {}, { database = true } = {}) => {
  const warnings: string[] = [];
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: {
        endpoints: { 'platform-pg': platformPg },
        datasets: [],
      },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ EMBED_KEY: 'k' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
    onWarning: (message) => warnings.push(message),
    ...(database ? { knowledgePool: pool } : {}),
    ...input,
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (path: string, as: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        'change-reason': 'Testendring',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { platform, call, warnings };
};

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

describe('pluggable search engines over the API', () => {
  it('the API keeps and saves `knowledge` endpoints only when it has a knowledge server', async () => {
    const knowledgePg = { engine: 'pgvector', options: { connection: 'knowledge' } };
    const catalogs = {
      models: { endpoints: {}, models: [] },
      knowledge: {
        endpoints: { 'platform-pg': platformPg, 'knowledge-pg': knowledgePg },
        datasets: [],
      },
      rerank: { endpoints: {}, rerankers: [] },
    };
    const save = (call: Awaited<ReturnType<typeof boot>>['call']) =>
      call('/operator/catalog/knowledge-endpoint/kunnskap-pg', 'drift', {
        method: 'PUT',
        body: knowledgePg,
      });

    const withServer = await boot({ catalogs, knowledgeServer: { reader: pool } });
    expect(withServer.warnings.filter((w) => w.includes('knowledge-pg'))).toEqual([]);
    expect((await save(withServer.call)).status).toBe(200);

    const without = await boot({ catalogs });
    expect(without.warnings).toEqual([expect.stringContaining('knowledge-pg')]);
    const refused = await save(without.call);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await json(refused))).toContain('no knowledge server configured');
  });

  describe('generations of datasets on the knowledge database', () => {
    const knowledgeCatalogs = {
      models: { endpoints: {}, models: [] },
      knowledge: {
        endpoints: {
          'platform-pg': platformPg,
          'knowledge-pg': { engine: 'pgvector', options: { connection: 'knowledge' } },
        },
        datasets: [],
      },
      rerank: { endpoints: {}, rerankers: [] },
    };
    const dataset = (endpoint: string, extra: Record<string, unknown> = {}) => ({
      name: 'Kudos',
      endpoint,
      residency: 'norway',
      filters: { type: 'multiselect' },
      ...extra,
    });
    const publish = async (
      call: Awaited<ReturnType<typeof boot>>['call'],
      id: string,
      body: unknown,
    ) => {
      const res = await call(`/operator/catalog/dataset/${encodeURIComponent(id)}`, 'drift', {
        method: 'PUT',
        body,
      });
      return { status: res.status, body: await json<{ spec?: { generation?: string } }>(res) };
    };

    it('a dataset published onto the knowledge database names a new generation', async () => {
      const { call } = await boot({
        catalogs: knowledgeCatalogs,
        knowledgeServer: { reader: pool },
      });
      const saved = await publish(call, 'digdir/kudos-next', dataset('knowledge-pg'));
      expect(saved.status).toBe(200);
      expect(saved.body.spec?.generation).toEqual(expect.any(String));
      const other = await publish(call, 'digdir/altinn-docs', dataset('knowledge-pg'));
      expect(other.body.spec?.generation).not.toBe(saved.body.spec?.generation);
      const onPlatform = await publish(call, 'digdir/notes', dataset('platform-pg'));
      expect(onPlatform.body.spec?.generation).toBeUndefined();
    });

    it('a generation id is a date and a short random part', async () => {
      const { call } = await boot({
        catalogs: knowledgeCatalogs,
        knowledgeServer: { reader: pool },
      });
      const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
      const saved = await publish(call, 'digdir/kudos-next', dataset('knowledge-pg'));
      expect(saved.body.spec?.generation).toMatch(new RegExp(`^g-${today}-[0-9a-f]{6}$`));
    });

    it('an edit of a knowledge dataset that names no generation keeps the one it had', async () => {
      const { call } = await boot({
        catalogs: knowledgeCatalogs,
        knowledgeServer: { reader: pool },
      });
      const first = await publish(call, 'digdir/kudos-next', dataset('knowledge-pg'));
      const edited = await publish(
        call,
        'digdir/kudos-next',
        dataset('knowledge-pg', { description: 'Rapporter og evalueringer fra Kudos' }),
      );
      expect(edited.status).toBe(200);
      expect(edited.body.spec?.generation).toBe(first.body.spec?.generation);
      const named = await publish(
        call,
        'digdir/kudos-next',
        dataset('knowledge-pg', { generation: 'g-20261101-a1b2' }),
      );
      expect(named.body.spec?.generation).toBe('g-20261101-a1b2');
    });

    it("a generation another dataset's entry names is refused", async () => {
      const { call } = await boot({
        catalogs: knowledgeCatalogs,
        knowledgeServer: { reader: pool },
      });
      const first = await publish(call, 'digdir/kudos-next', dataset('knowledge-pg'));
      const taken = await publish(
        call,
        'digdir/altinn-docs',
        dataset('knowledge-pg', { generation: first.body.spec?.generation }),
      );
      expect(taken.status).toBe(400);
      expect(JSON.stringify(taken.body)).toContain('generation of another dataset');
    });

    it('a plain publish that moves a dataset from another endpoint onto the knowledge database is refused', async () => {
      const { call } = await boot({
        catalogs: knowledgeCatalogs,
        knowledgeServer: { reader: pool },
      });
      expect((await publish(call, 'digdir/notes', dataset('platform-pg'))).status).toBe(200);
      const moved = await publish(call, 'digdir/notes', dataset('knowledge-pg'));
      expect(moved.status).toBe(400);
      expect(JSON.stringify(moved.body)).toContain('engine switch');
      const switched = await publish(
        call,
        'digdir/notes',
        dataset('knowledge-pg', { generation: 'g-20261101-c3d4' }),
      );
      expect(switched.status).toBe(200);
    });
  });

  it('a pgvector endpoint needs no baseURL', async () => {
    const { call } = await boot();
    const pg = await call('/operator/catalog/knowledge-endpoint/annen-pg', 'drift', {
      method: 'PUT',
      body: { engine: 'pgvector' },
    });
    expect(pg.status).toBe(200);
    const typesense = await call('/operator/catalog/knowledge-endpoint/sok', 'drift', {
      method: 'PUT',
      body: { engine: 'typesense' },
    });
    expect(typesense.status).toBe(400);
    expect(JSON.stringify(await json(typesense))).toContain('typesense needs a baseURL');
  });

  it("creating a dataset uses the engine's default profiles", async () => {
    const { call } = await boot();
    const created = await call('/operator/datasets', 'drift', {
      body: {
        id: 'digdir/veiledning',
        name: 'Veiledning',
        residency: 'norway',
        index: { endpoint: 'platform-pg' },
      },
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      index: { endpoint: 'platform-pg', options: { profiles: defaultPgvectorProfiles(false) } },
    });

    const embedded = await call('/operator/datasets', 'drift', {
      body: {
        id: 'digdir/vektor',
        name: 'Vektor',
        residency: 'norway',
        collection: { endpoint: 'platform-pg' },
        embedding,
      },
    });
    expect(embedded.status).toBe(201);
    const view = await json<{ embedding: unknown; index: { options: { profiles: unknown } } }>(
      embedded,
    );
    expect(view.embedding).toEqual(embedding);
    expect(view.index.options.profiles).toEqual(defaultPgvectorProfiles(true));
  });

  it('the engines route lists pgvector and typesense with option schemas and capabilities', async () => {
    const { call } = await boot();
    const response = await call('/operator/knowledge/engines', 'drift');
    expect(response.status).toBe(200);
    const { data } = await json<{
      data: {
        engine: string;
        requiresBaseURL: boolean;
        endpointOptions: { properties?: Record<string, unknown> };
        datasetOptions: { properties?: Record<string, unknown> };
        capabilities: string[];
        writer?: { needsVectors: boolean };
      }[];
    }>(response);
    const pgvector = data.find((e) => e.engine === 'pgvector');
    const typesense = data.find((e) => e.engine === 'typesense');
    expect(pgvector).toMatchObject({ requiresBaseURL: false, writer: { needsVectors: true } });
    expect(pgvector?.endpointOptions.properties).toHaveProperty('connection');
    expect(pgvector?.datasetOptions.properties).toHaveProperty('profiles');
    expect(pgvector?.capabilities).toEqual(expect.arrayContaining(['search.text', 'facets']));
    expect(pgvector?.capabilities).not.toContain('search.vector');
    expect(typesense).toMatchObject({ requiresBaseURL: true, writer: { needsVectors: false } });
    expect(typesense?.datasetOptions.properties).toHaveProperty('collections');
    expect(typesense?.capabilities).toEqual(expect.arrayContaining(['search.hybrid', 'range']));
    expect(data.find((e) => e.engine === 'http-search')?.capabilities).not.toContain('facets');

    const tenant = await call(`/tenants/${digdir}/knowledge/engines`, 'kari');
    expect(tenant.status).toBe(200);
    expect(
      (await json<{ data: { engine: string }[] }>(tenant)).data.map((e) => e.engine),
    ).toContain('pgvector');
    expect((await call(`/tenants/999888777/knowledge/engines`, 'kari')).status).toBe(404);
  });

  it('a tenant cannot point pgvector at an external connection', async () => {
    const { call } = await boot();
    const endpoint = (body: Record<string, unknown>) =>
      call(`/tenants/${digdir}/catalog/knowledge-endpoint/egen-pg`, 'kari', {
        method: 'PUT',
        body: { engine: 'pgvector', ...body },
      });
    const external = await endpoint({ options: { connection: 'postgres://db.example.no/x' } });
    expect(external.status).toBe(400);
    expect(JSON.stringify(await json(external))).toContain('external connections');
    const withHost = await endpoint({
      baseURL: 'https://db.example.no',
      auth: { kind: 'api-key', secret: `secret://tenant/${digdir}/db` },
    });
    expect(withHost.status).toBe(400);
    expect(JSON.stringify(await json(withHost))).toContain('takes no baseURL');
    expect((await endpoint({ options: { connection: 'platform' } })).status).toBe(200);
  });

  it('ingestion into a pgvector dataset stores, embeds with a fake embedder and becomes searchable', async () => {
    const adapter = fakeEmbeddingAdapter('fake-embeddings');
    const docs = join(folder, 'veiledning');
    await rm(docs, { recursive: true, force: true });
    await mkdir(docs, { recursive: true });
    await writeFile(
      join(docs, 'tilskudd.md'),
      '# Tilskudd\n\nKommunen gir tilskudd til lag og foreninger hvert år.',
    );
    await writeFile(
      join(docs, 'skyplattform.md'),
      '# Skyplattform\n\nEtaten flytter tjenestene sine til en skyplattform.',
    );
    const { call, platform } = await boot({
      ingestFolderRoot: folder,
      embeddingAdapters: [adapter],
      catalogs: {
        models: { endpoints: {}, models: [] },
        knowledge: {
          endpoints: {
            'platform-pg': platformPg,
          },
          datasets: [],
        },
        rerank: { endpoints: {}, rerankers: [] },
        embeddings: {
          endpoints: {
            fake: {
              protocol: 'fake-embeddings',
              baseURL: 'https://embed.invalid',
              auth: { kind: 'api-key', secret: 'secret://env/embed-key' },
            },
          },
          models: [
            {
              id: 'fake/embed',
              endpoint: 'fake',
              deployment: 'e',
              residency: 'norway',
              dimensions: 8,
            },
          ],
        },
      },
    });
    expect(
      (
        await call(`/tenants/${digdir}/datasets`, 'kari', {
          body: {
            id: 'veiledning',
            name: 'Veiledning',
            residency: 'norway',
            index: { endpoint: 'platform-pg' },
            embedding,
          },
        })
      ).status,
    ).toBe(201);
    const base = `/tenants/${digdir}/datasets/veiledning/pipelines`;
    expect(
      (
        await call(base, 'kari', {
          body: {
            id: 'mappe',
            name: 'Mappe',
            source: { kind: 'folder', path: 'veiledning' },
            chunking: { minimumLength: 1 },
          },
        })
      ).status,
    ).toBe(201);
    expect((await json<{ backend: unknown }>(await call(base, 'kari'))).backend).toMatchObject({
      available: true,
    });

    const started = await call(`${base}/mappe/execute`, 'kari', { body: {} });
    expect(started.status).toBe(202);
    type Run = { status: string; report?: Record<string, unknown>; error?: string };
    let run: Run | undefined;
    for (let i = 0; i < 300; i++) {
      run = (await json<{ data: Run[] }>(await call(`${base}/mappe/executions`, 'kari'))).data[0];
      if (run?.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(run).toMatchObject({ status: 'succeeded', report: { stored: 2, promoted: true } });
    expect(run?.report?.usage).toHaveProperty(['embedder:fake/embed']);
    expect(adapter.calls.length).toBeGreaterThan(0);

    const { ctx, metered } = testContext();
    const port = platform.knowledge.open(
      { kind: 'dataset', id: `${digdir}/veiledning`, tenant: digdir },
      { ...ctx, tenant: digdir },
    );
    expect(port.info().capabilities).toContain('search.hybrid');
    const result = await port.search({ query: 'tilskudd', profile: knowledgeProfiles.content });
    expect(result.hits[0]?.text).toContain('tilskudd');
    expect(metered.some((m) => m.model?.kind === 'embedder')).toBe(true);
  });

  it('a pipeline cannot read a folder outside the folder root', async () => {
    const { call } = await boot({ ingestFolderRoot: folder });
    await call('/operator/datasets', 'drift', {
      body: {
        id: 'digdir/mappe',
        name: 'Mappe',
        residency: 'norway',
        index: { endpoint: 'platform-pg' },
      },
    });
    const base = `/operator/datasets/${encodeURIComponent('digdir/mappe')}/pipelines`;
    await call(base, 'drift', {
      body: { id: 'ut', name: 'Ut', source: { kind: 'folder', path: '../../etc' } },
    });
    const run = await call(`${base}/ut/execute`, 'drift', { body: {} });
    expect(run.status).toBe(409);
    expect(JSON.stringify(await json(run))).toContain('outside the folder root');
  });

  it('the API starts without embedding configuration', async () => {
    const config = join(import.meta.dirname, '..', 'config', 'local');
    const catalogs = {
      models: { endpoints: {}, models: [] },
      knowledge: loadCatalog(config, 'knowledge.yaml', 'datasets', {}).catalog,
      rerank: { endpoints: {}, rerankers: [] },
      embeddings: loadCatalog(config, 'embeddings.yaml', 'models', {}).catalog,
    };
    const withDatabase = await boot({ catalogs });
    expect(withDatabase.platform.embedders.describe()).toEqual([]);
    const engines = await json<{ data: { engine: string; capabilities: string[] }[] }>(
      await withDatabase.call('/operator/knowledge/engines', 'drift'),
    );
    expect(engines.data.find((e) => e.engine === 'pgvector')?.capabilities).not.toContain(
      'search.vector',
    );

    const memory = await boot({ catalogs }, { database: false });
    expect(memory.warnings.join(' ')).toContain('platform-pg');
  });
});

describe('retrieval notices in the run timeline', () => {
  it('shows skipped search strategies as notices', () => {
    const task = {
      id: 't1',
      service: { capability: { id: 'digdir/svar', version: '1' } },
      status: 'completed',
      principal: { kind: 'employee', issuer: 'test', subject: 'kari' },
      createdAt: '2026-10-07T10:00:00.000Z',
      endedAt: '2026-10-07T10:00:02.000Z',
      usage: {},
    } as unknown as Task;
    const events = [
      {
        seq: 1,
        ts: '2026-10-07T10:00:01.000Z',
        type: 'kernel.result',
        data: [
          {
            mime: 'application/vnd.genai.retrieval+json',
            body: {
              kind: 'json',
              json: { attribution: { warnings: ['skipped phrase: no profile phrase'] } },
            },
          },
        ],
      },
    ] as unknown as Event[];
    const timeline = toTimeline(task, events, new Date('2026-10-07T10:00:03.000Z'));
    expect(timeline.steps).toContainEqual(
      expect.objectContaining({
        type: 'note',
        summary: 'Søket ble justert underveis.',
        blocks: [{ kind: 'quote', text: 'skipped phrase: no profile phrase' }],
      }),
    );
  });
});
