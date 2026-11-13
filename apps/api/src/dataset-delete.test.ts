import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { onePage, type DocumentConverter } from '@genai/ingest';
import { InMemoryBlobStore, type BlobKey, type BlobStore } from '@genai/port-blob';
import { fakeEmbeddingAdapter } from '@genai/port-embedding/testing';
import { createPool } from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { InMemoryConfigEntryStore, type ConfigEntryStore } from './config-store.js';
import {
  datasetInUseType,
  datasetRunOpenType,
  type DatasetDeleteResult,
} from './dataset-delete.js';
import { deleteHoldMessage } from './ingestion.js';
import { digdir, fakeModels, files, testService } from './testkit.js';

const other = '999888777';
const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};
const embedding = { model: 'fake/embed', dimensions: 8 };
const reason = 'Datasettet ble satt opp med feil modell';

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createPool>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  pool = createPool({ connectionString: container.getConnectionUri() });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await stopPostgres(container);
});

const boot = async (
  options: {
    blobs?: BlobStore;
    converter?: DocumentConverter;
    store?: ConfigEntryStore;
    now?: () => Date;
  } = {},
) => {
  const blobs = options.blobs ?? new InMemoryBlobStore();
  const platform = await createPlatform({
    catalogs: {
      models: fakeModels,
      knowledge: {
        endpoints: {
          'platform-pg': {
            engine: 'pgvector',
            options: { connection: 'platform' },
            sharing: { tenants: '*' },
          },
          'knowledge-pg': {
            engine: 'pgvector',
            options: { connection: 'knowledge' },
            sharing: { tenants: '*' },
          },
        },
        datasets: [],
      },
      rerank: { endpoints: {}, rerankers: [] },
      embeddings: {
        endpoints: {
          fake: {
            protocol: 'fake',
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
    secrets: envSecrets({ FAKE_KEY: 'k', EMBED_KEY: 'k' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
    knowledgePool: pool,
    knowledgeServer: { reader: pool },
    embeddingAdapters: [fakeEmbeddingAdapter()],
    blobStore: blobs,
    ...(options.converter ? { documentConverter: options.converter } : {}),
    configurables: {
      scheduleIntervalMs: 0,
      ...(options.store ? { store: options.store } : {}),
      ...(options.now ? { now: options.now } : {}),
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
    init: { method?: string; body?: unknown; reason?: string } = {},
  ) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        ...(init.reason === ''
          ? {}
          : { 'change-reason': encodeURIComponent(init.reason ?? reason) }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const upload = (dataset: string, name: string, text: string) => {
    const form = new FormData();
    form.append('files', new File([text], name));
    return app.request(`/tenants/${digdir}/datasets/${dataset}/uploads`, {
      method: 'POST',
      headers: { authorization: 'Bearer kari', 'change-reason': encodeURIComponent(reason) },
      body: form,
    });
  };
  return { platform, admin, app, call, upload, blobs };
};

type Booted = Awaited<ReturnType<typeof boot>>;
const json = async <T>(response: Response) => (await response.json()) as T;
const base = (id: string, tenant = digdir) => `/tenants/${tenant}/datasets/${id}`;

const createDataset = async ({ call }: Booted, id: string, endpoint = 'platform-pg') => {
  const created = await call(`/tenants/${digdir}/datasets`, 'kari', {
    body: { id, name: 'Veiledere', residency: 'norway', index: { endpoint }, embedding },
  });
  expect(created.status).toBe(201);
};

const prepared = async (booted: Booted, id: string, file = 'notat.md') => {
  const { call, upload } = booted;
  const saved = await call(`${base(id)}/pipelines`, 'kari', {
    body: {
      id: 'filer',
      name: 'Filer',
      source: { kind: 'upload' },
      chunking: { minimumLength: 1 },
    },
  });
  expect(saved.status).toBe(201);
  expect((await upload(id, file, '# Notat\n\nSlik søker du tilskudd.')).status).toBe(201);
};

const filled = async (booted: Booted, id: string, file = 'notat.md') => {
  await prepared(booted, id, file);
  return ran(booted, id);
};

const ranAgain = async (booted: Booted, id: string, file: string) => {
  expect((await booted.upload(id, file, '# Annet\n\nSlik klager du.')).status).toBe(201);
  return ran(booted, id);
};

const ran = async (booted: Booted, id: string) => {
  const { call } = booted;
  const started = await call(`${base(id)}/pipelines/filer/execute`, 'kari', { body: {} });
  expect(started.status).toBe(202);
  const run = (await json<{ id: string }>(started)).id;
  for (let i = 0; i < 200; i++) {
    const runs = await json<{ data: { id: string; status: string }[] }>(
      await call(`${base(id)}/pipelines/filer/executions`, 'kari'),
    );
    const status = runs.data.find((r) => r.id === run)?.status;
    if (status && status !== 'running') {
      expect(status).toBe('succeeded');
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the run did not finish');
};

const gatedBlobs = (store: InMemoryBlobStore, onDelete: (key: BlobKey) => Promise<void>) => {
  const blobs: BlobStore = {
    put: (...args) => store.put(...args),
    get: (...args) => store.get(...args),
    head: (key) => store.head(key),
    list: (...args) => store.list(...args),
    delete: async (key) => {
      await onDelete(key);
      return store.delete(key);
    },
  };
  return blobs;
};

const documentsOf = async (dataset: string) =>
  Number(
    (
      await pool.query<{ n: string }>('select count(*) as n from kn_docs where dataset = $1', [
        dataset,
      ])
    ).rows[0]?.n,
  );

const reads = (dataset: string) => ({
  ...testService('leser'),
  spec: { ...testService('leser').spec, knowledge: { datasets: [{ dataset }] } },
});

describe('deleting a dataset', () => {
  it('refuses while a published service reads the dataset, and names it on the dataset', async () => {
    const booted = await boot();
    await createDataset(booted, 'veiledere');
    const published = await booted.platform.definitions.publish(
      reads(`${digdir}/veiledere`),
      'test',
      'Leser veilederne',
      files,
    );
    expect(published.ok).toBe(true);

    const detail = await json<{ usedBy: unknown[] }>(await booted.call(base('veiledere'), 'kari'));
    expect(detail.usedBy).toEqual([
      { kind: 'service', tenant: digdir, id: 'leser', name: 'Klarspråk' },
    ]);
    const refused = await booted.call(base('veiledere'), 'kari', { method: 'DELETE' });
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({
      type: datasetInUseType,
      errors: [{ path: 'usedBy', message: `service ${digdir}/leser bruker datasettet` }],
    });
    expect((await booted.call(base('veiledere'), 'kari')).status).toBe(200);
  });

  it('deletes the pipelines, generations, uploads and the catalog entry of a tenant dataset', async () => {
    const booted = await boot();
    const { call, blobs } = booted;
    await createDataset(booted, 'veiledere');
    const run = await filled(booted, 'veiledere');
    expect(await documentsOf(`${digdir}/veiledere`)).toBe(1);

    const deleted = await call(base('veiledere'), 'kari', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await json<DatasetDeleteResult>(deleted)).toEqual({
      deleted: `${digdir}/veiledere`,
      removed: {
        catalogEntry: true,
        pipelines: ['filer'],
        uploads: ['notat.md'],
        generations: [run],
      },
      kept: { knowledgeRecords: false, generations: [] },
    });
    expect((await call(base('veiledere'), 'kari')).status).toBe(404);
    expect(await blobs.list(digdir)).toEqual([]);
    expect(await documentsOf(`${digdir}/veiledere`)).toBe(0);
    expect(
      (await pool.query('select 1 from kn_active where dataset = $1', [`${digdir}/veiledere`]))
        .rowCount,
    ).toBe(0);
    const versions = await json<{ data: { deleted?: boolean }[] }>(
      await call(`/tenants/${digdir}/catalog/dataset/veiledere/versions`, 'kari'),
    );
    expect(versions.data.at(-1)).toMatchObject({ deleted: true });

    await createDataset(booted, 'veiledere');
    expect((await call(base('veiledere'), 'kari')).status).toBe(200);
  });

  it('a dataset on the knowledge database keeps its records until the drop job exists, and its id is held', async () => {
    const booted = await boot();
    const { call } = booted;
    await createDataset(booted, 'arkitektur', 'knowledge-pg');

    const deleted = await call(base('arkitektur'), 'kari', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await json<DatasetDeleteResult>(deleted)).toMatchObject({
      deleted: `${digdir}/arkitektur`,
      kept: { knowledgeRecords: true, generations: [] },
    });
    expect((await call(base('arkitektur'), 'kari')).status).toBe(404);

    const again = await call(`/tenants/${digdir}/datasets`, 'kari', {
      body: {
        id: 'arkitektur',
        name: 'Arkitektur',
        residency: 'norway',
        index: { endpoint: 'platform-pg' },
        embedding,
      },
    });
    expect(again.status).toBe(409);
    expect(JSON.stringify(await json(again))).toContain('until they are dropped');
    const viaCatalog = await call(`/tenants/${digdir}/catalog/dataset/arkitektur`, 'kari', {
      method: 'PUT',
      body: { name: 'Arkitektur', residency: 'norway', endpoint: 'platform-pg', embedding },
    });
    expect(viaCatalog.status).toBe(409);
  });

  it('refuses while a run of the dataset is in progress', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const booted = await boot({
      converter: {
        convert: async () => {
          await gate;
          return onePage('# Notat\n\nTekst fra PDF-en.');
        },
      },
    });
    const { call, upload } = booted;
    await createDataset(booted, 'veiledere');
    const saved = await call(`${base('veiledere')}/pipelines`, 'kari', {
      body: {
        id: 'filer',
        name: 'Filer',
        source: { kind: 'upload' },
        chunking: { minimumLength: 1 },
      },
    });
    expect(saved.status).toBe(201);
    expect((await upload('veiledere', 'notat.pdf', '%PDF-1.7')).status).toBe(201);
    expect(
      (await call(`${base('veiledere')}/pipelines/filer/execute`, 'kari', { body: {} })).status,
    ).toBe(202);

    const refused = await call(base('veiledere'), 'kari', { method: 'DELETE' });
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({
      type: datasetRunOpenType,
      errors: [{ path: 'executions', message: expect.stringContaining('pågår') }],
    });
    release();
    for (let i = 0; i < 200; i++) {
      const runs = await json<{ data: { status: string }[] }>(
        await call(`${base('veiledere')}/pipelines/filer/executions`, 'kari'),
      );
      if (runs.data[0] && runs.data[0].status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await call(base('veiledere'), 'kari', { method: 'DELETE' })).status).toBe(200);
    expect(await documentsOf(`${digdir}/veiledere`)).toBe(0);
  });

  it('a step that fails leaves the dataset in place, and a second delete finishes the job', async () => {
    const store = new InMemoryBlobStore();
    let down = false;
    const blobs = gatedBlobs(store, async () => {
      if (down) throw new Error('blob store down');
    });
    const booted = await boot({ blobs });
    const { call } = booted;
    await createDataset(booted, 'veiledere');
    const run = await filled(booted, 'veiledere');

    down = true;
    const failed = await call(base('veiledere'), 'kari', { method: 'DELETE' });
    expect(failed.status).toBe(500);
    expect((await call(base('veiledere'), 'kari')).status).toBe(200);
    expect(await documentsOf(`${digdir}/veiledere`)).toBe(1);

    down = false;
    const deleted = await call(base('veiledere'), 'kari', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await json<DatasetDeleteResult>(deleted)).toMatchObject({
      removed: { uploads: ['notat.md'], generations: [run] },
      kept: { knowledgeRecords: false, generations: [] },
    });
    expect((await call(base('veiledere'), 'kari')).status).toBe(404);
    expect(await store.list(digdir)).toEqual([]);
    expect(await documentsOf(`${digdir}/veiledere`)).toBe(0);
  });

  it('a drop that fails before the catalog version is written leaves the dataset in place, and a second delete finishes the job', async () => {
    const booted = await boot();
    const { call, platform } = booted;
    await createDataset(booted, 'veiledere');
    const first = await filled(booted, 'veiledere');
    const second = await ranAgain(booted, 'veiledere', 'annet.md');
    let down = true;
    const open = platform.writers.open.bind(platform.writers);
    vi.spyOn(platform.writers, 'open').mockImplementation((id, context) => {
      const route = open(id, context);
      const drop = route.writer.drop.bind(route.writer);
      vi.spyOn(route.writer, 'drop').mockImplementation(async (dataset, generation, options) => {
        if (down && generation === first) throw new Error('engine down');
        return drop(dataset, generation, options);
      });
      return route;
    });

    const failed = await call(base('veiledere'), 'kari', { method: 'DELETE' });
    expect(failed.status).toBe(500);
    expect((await call(base('veiledere'), 'kari')).status).toBe(200);
    expect(await documentsOf(`${digdir}/veiledere`)).toBeGreaterThan(0);

    down = false;
    const deleted = await call(base('veiledere'), 'kari', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await json<DatasetDeleteResult>(deleted)).toMatchObject({
      removed: { generations: expect.arrayContaining([second]) },
      kept: { knowledgeRecords: false, generations: [] },
    });
    expect((await call(base('veiledere'), 'kari')).status).toBe(404);
    expect(await documentsOf(`${digdir}/veiledere`)).toBe(0);
  });

  it('a run started on another replica while the delete is going is refused, and nothing is left serving', async () => {
    const entries = new InMemoryConfigEntryStore();
    let reached: () => void = () => undefined;
    let release: () => void = () => undefined;
    const atDelete = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blobs = gatedBlobs(new InMemoryBlobStore(), async () => {
      reached();
      await gate;
    });
    const first = await boot({ blobs, store: entries });
    await createDataset(first, 'veiledere');
    await filled(first, 'veiledere');
    const second = await boot({ blobs, store: entries });
    expect((await second.call(base('veiledere'), 'kari')).status).toBe(200);

    const deleting = first.call(base('veiledere'), 'kari', { method: 'DELETE' });
    await atDelete;
    const started = await second.call(`${base('veiledere')}/pipelines/filer/execute`, 'kari', {
      body: {},
    });
    expect(started.status).toBe(409);
    expect(await json(started)).toMatchObject({
      errors: [{ path: 'dataset', message: deleteHoldMessage(`${digdir}/veiledere`) }],
    });
    const again = await second.call(base('veiledere'), 'kari', { method: 'DELETE' });
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ type: datasetInUseType });
    release();
    const deleted = await deleting;
    expect(deleted.status).toBe(200);
    expect(await json<DatasetDeleteResult>(deleted)).toMatchObject({
      kept: { knowledgeRecords: false, generations: [] },
    });
    expect((await first.call(base('veiledere'), 'kari')).status).toBe(404);
    expect(await documentsOf(`${digdir}/veiledere`)).toBe(0);
  });

  it('a delete whose process died stops holding the dataset two minutes after its last beat', async () => {
    let clock = new Date('2026-11-10T10:00:00Z');
    const entries = new InMemoryConfigEntryStore();
    const first = await boot({ store: entries, now: () => clock });
    await createDataset(first, 'veiledere');
    await prepared(first, 'veiledere');
    expect(
      await first.platform.ingestion.hold(`${digdir}/veiledere`, 'kari', reason),
    ).toBeDefined();
    const second = await boot({ store: entries, now: () => clock });

    const refused = await second.call(`${base('veiledere')}/pipelines/filer/execute`, 'kari', {
      body: {},
    });
    expect(refused.status).toBe(409);
    clock = new Date('2026-11-10T10:02:30Z');
    await ran(second, 'veiledere');
    expect((await second.call(base('veiledere'), 'kari', { method: 'DELETE' })).status).toBe(200);
    expect(await documentsOf(`${digdir}/veiledere`)).toBe(0);
  });

  it("an operator's delete of a platform dataset leaves a tenant's uploads under the same id alone", async () => {
    const booted = await boot();
    const { call, upload, blobs } = booted;
    await createDataset(booted, 'felles');
    expect((await upload('felles', 'notat.md', '# Notat')).status).toBe(201);
    const created = await call('/operator/datasets', 'drift', {
      body: {
        id: 'felles',
        name: 'Felles',
        residency: 'norway',
        index: { endpoint: 'platform-pg' },
        embedding,
      },
    });
    expect(created.status).toBe(201);

    const deleted = await call('/operator/datasets/felles', 'drift', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await json<DatasetDeleteResult>(deleted)).toMatchObject({ removed: { uploads: [] } });
    expect((await blobs.list(digdir)).map((b) => b.path)).toEqual([
      'datasets/felles/uploads/notat.md',
    ]);
    expect((await call(base('felles'), 'kari')).status).toBe(200);
  });

  it('a served generation that no run of the dataset wrote is left in place and reported', async () => {
    const booted = await boot();
    const { call, platform } = booted;
    await createDataset(booted, 'veiledere');
    const route = platform.writers.open(`${digdir}/veiledere`, {
      signal: new AbortController().signal,
    });
    await route.writer.prepare(route.dataset, 'fremmed');
    await route.writer.store(route.dataset, 'fremmed', {
      id: 'ekstern',
      fields: {},
      chunks: [{ id: 'ekstern#0', position: 0, text: 'Skrevet utenfor plattformen' }],
      phrases: [],
    });
    await route.writer.promote(route.dataset, 'fremmed');

    const deleted = await call(base('veiledere'), 'kari', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await json<DatasetDeleteResult>(deleted)).toMatchObject({
      removed: { generations: [] },
      kept: { knowledgeRecords: false, generations: ['fremmed'] },
    });
    expect(await documentsOf(`${digdir}/veiledere`)).toBe(1);
  });

  it('records the delete as an audited task with the reason', async () => {
    const booted = await boot();
    const { call, admin } = booted;
    await createDataset(booted, 'veiledere');

    const deleted = await call(base('veiledere'), 'kari', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await admin.audit(digdir)).at(-1)).toMatchObject({
      action: 'platform.dataset.delete',
      outcome: 'applied',
      reason,
      target: `dataset:${digdir}/veiledere`,
      task: deleted.headers.get('genai-task'),
    });
    expect((await call(base('veiledere'), 'kari', { method: 'DELETE' })).status).toBe(404);
  });

  it('needs a reason, the right manage-datasets, and membership of the tenant', async () => {
    const booted = await boot();
    const { call } = booted;
    await createDataset(booted, 'veiledere');

    expect((await call(base('veiledere'), 'kari', { method: 'DELETE', reason: '' })).status).toBe(
      400,
    );
    expect((await call(base('veiledere'), 'erik', { method: 'DELETE' })).status).toBe(403);
    expect((await call(base('veiledere'), 'ola', { method: 'DELETE' })).status).toBe(404);
    expect((await call(base('veiledere', other), 'ola', { method: 'DELETE' })).status).toBe(404);
    expect((await call(base('veiledere'), 'kari')).status).toBe(200);
  });

  it('an operator deletes a platform dataset under /operator/datasets, and nobody else does', async () => {
    const booted = await boot();
    const { call } = booted;
    const created = await call('/operator/datasets', 'drift', {
      body: {
        id: 'felles',
        name: 'Felles',
        residency: 'norway',
        index: { endpoint: 'platform-pg' },
        embedding,
      },
    });
    expect(created.status).toBe(201);

    expect((await call('/operator/datasets/felles', 'kari', { method: 'DELETE' })).status).toBe(
      403,
    );
    expect((await call(base('felles'), 'kari', { method: 'DELETE' })).status).toBe(404);
    const deleted = await call('/operator/datasets/felles', 'drift', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await json<DatasetDeleteResult>(deleted)).toMatchObject({ deleted: 'felles' });
    expect((await call('/operator/datasets/felles', 'drift')).status).toBe(404);
  });
});
