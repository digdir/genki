import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { testSet } from '@genai/eval';
import { envSecrets } from '@genai/kernel';
import { fakeEmbeddingAdapter } from '@genai/port-embedding/testing';
import type { KnowledgePort } from '@genai/port-knowledge';
import { createPool } from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { PLATFORM_RIGHTS, trustedEntraScope } from '@genai/identity';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import {
  createEngineSwitchesModule,
  type DatasetEngineView,
  type EngineSwitchesModule,
  type EngineSwitchView,
  type SwitchEstimate,
} from './engine-switches.js';
import {
  InMemoryExecutionStore,
  type Execution,
  type IngestionReport,
  type JobRunStore,
} from './ingestion.js';
import { translateMessage } from './i18n/index.js';
import { knowledgeEndpointsModule } from './knowledge-endpoints.js';

const digdir = '991825827';
const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  // A Digdir login with Entra ID, which may use models in lockdown.
  entra: {
    kind: 'employee',
    issuer: 'test',
    subject: 'entra',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: [...PLATFORM_RIGHTS] }],
    scopes: [trustedEntraScope],
  },
};
const embedding = { model: 'fake/embed', dimensions: 8 };

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createPool>;
let folder: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  pool = createPool({ connectionString: container.getConnectionUri() });
  folder = await mkdtemp(join(tmpdir(), 'genai-switch-'));
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await stopPostgres(container);
  if (folder) await rm(folder, { recursive: true, force: true });
});

/** The worker's side, faked: run records the test ends, and the drop jobs the API sends. */
const fakeWorker = () => {
  const executions = new InMemoryExecutionStore();
  const started: Execution[] = [];
  const drops: { tenant: string; dataset: string; generation: string }[] = [];
  const hooks: { onStart?: (run: Execution) => Promise<void> } = {};
  const runs: JobRunStore = {
    start: async (input) => {
      const run: Execution = { ...input, status: 'running', runsAsJobs: true };
      await executions.save(run);
      started.push(run);
      const onStart = hooks.onStart;
      delete hooks.onStart;
      await onStart?.(run);
      return { ok: true, value: run };
    },
    cancel: async (input) => {
      const run = await executions.get(input.execution);
      if (!run || run.status !== 'running') return undefined;
      const marked = { ...run, cancelRequestedAt: input.at, cancelledBy: input.by };
      await executions.save(marked);
      return marked;
    },
    redrive: async () => ({ ok: false, message: 'not here' }),
  };
  const end = async (
    run: Execution | undefined,
    status: 'succeeded' | 'failed' | 'cancelled',
    report: Partial<IngestionReport> = {},
    error?: string,
  ) => {
    if (!run) throw new Error('no run');
    const found = (await executions.get(run.id)) as Execution;
    await executions.save({
      ...found,
      status,
      endedAt: new Date().toISOString(),
      report: { stored: 0, skipped: 0, failed: [], ...report },
      ...(error ? { error } : {}),
    });
  };
  return {
    executions,
    started,
    drops,
    end,
    hooks,
    jobRuns: {
      runsAsJobs: () => false,
      runs,
      drop: async (input: { tenant: string; dataset: string; generation: string }) => {
        drops.push(input);
      },
    },
  };
};

type Worker = ReturnType<typeof fakeWorker>;

const boot = async (
  shared: {
    entries?: InMemoryConfigEntryStore;
    worker?: Worker;
    clock?: { now: Date };
    /** A comparison whose searches never answer, as on an instance that stopped. */
    hang?: boolean;
    lockdown?: boolean;
    as?: string;
  } = {},
) => {
  const entries = shared.entries ?? new InMemoryConfigEntryStore();
  const worker = shared.worker ?? fakeWorker();
  const secrets = envSecrets({ EMBED_KEY: 'k' });
  const late: { platform?: Awaited<ReturnType<typeof createPlatform>> } = {};
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
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
    secrets,
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
    knowledgePool: pool,
    knowledgeServer: { reader: pool },
    ingestFolderRoot: folder,
    ...(shared.lockdown ? { lockdown: { configuredKeys: new Set<string>() } } : {}),
    embeddingAdapters: [fakeEmbeddingAdapter('fake-embeddings')],
    ingestionExecutions: worker.executions,
    configurables: { store: entries, jobRuns: worker.jobRuns },
    modules: [
      knowledgeEndpointsModule,
      createEngineSwitchesModule({
        embedders: {
          has: (model) => Boolean(late.platform?.embedders.describe().some((e) => e.id === model)),
          open: (...args) =>
            (late.platform as NonNullable<typeof late.platform>).embedders.open(...args),
        },
        sweepIntervalMs: 0,
        ...(shared.clock ? { now: () => (shared.clock as { now: Date }).now } : {}),
      }),
    ],
  });
  late.platform = platform;
  // The knowledge server's read functions, faked: what the comparison asked for, and hits.
  const reads: { endpoint: string; generation?: string }[] = [];
  const openAt = platform.knowledge.openAt.bind(platform.knowledge);
  platform.knowledge.openAt = ((ref, endpoint, ctx, overrides) => {
    if (endpoint !== 'knowledge-pg') return openAt(ref, endpoint, ctx, overrides);
    return {
      search: async () => {
        reads.push({
          endpoint,
          ...(overrides?.generation ? { generation: overrides.generation } : {}),
        });
        if (shared.hang) return new Promise(() => undefined);
        return {
          hits: [{ id: 'veileder#0', document: 'veileder', position: 0, text: 'x', score: 1 }],
        };
      },
    } as unknown as KnowledgePort;
  }) as typeof platform.knowledge.openAt;
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${shared.as ?? 'kari'}`,
        'content-type': 'application/json',
        'change-reason': encodeURIComponent('Flytter til kunnskapsdatabasen'),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const module = platform.modules.find(
    (m) => m.id === 'engine-switches',
  ) as unknown as EngineSwitchesModule;
  return { platform, call, admin, worker, entries, reads, module };
};

type Booted = Awaited<ReturnType<typeof boot>>;
const json = async <T>(response: Response) => (await response.json()) as T;
const base = (dataset: string) => `/tenants/${digdir}/datasets/${dataset}`;

const folderDataset = async (
  { call, platform }: Booted,
  id: string,
  pipeline: Record<string, unknown> = {},
) => {
  const created = await call(`/tenants/${digdir}/datasets`, {
    body: {
      id,
      name: 'Veiledning',
      residency: 'norway',
      index: { endpoint: 'platform-pg' },
      embedding,
    },
  });
  expect(created.status).toBe(201);
  const saved = await call(`${base(id)}/pipelines`, {
    body: {
      id: 'filer',
      name: 'Filer',
      source: { kind: 'folder', path: 'veiledning' },
      ...pipeline,
    },
  });
  expect(saved.status).toBe(201);
  await platform.evalStores.testSets.put(
    testSet.parse({
      apiVersion: 'genai/v1',
      kind: 'TestSet',
      metadata: { tenant: digdir, id: `${id}-sporsmal`, name: 'Spørsmål', version: 1 },
      spec: {
        corpus: id,
        cases: [
          {
            id: 'veileder',
            split: 'validation',
            input: 'Hva sier veilederen?',
            expected: { sources: [{ document: 'veileder' }] },
          },
        ],
      },
    }),
  );
};

const startSwitch = async (booted: Booted, dataset: string, method = 'reingest') =>
  booted.call(`${base(dataset)}/engine-switches`, {
    body: { to: 'knowledge-pg', method, embedding },
  });

const started = async (booted: Booted, dataset: string) => {
  const response = await startSwitch(booted, dataset);
  expect(response.status).toBe(202);
  return json<EngineSwitchView>(response);
};

const view = async (booted: Booted, dataset: string, sid: string) =>
  json<EngineSwitchView & { generation?: string; failedDocuments?: number }>(
    await booted.call(`${base(dataset)}/engine-switches/${sid}`),
  );

/** Follows until the switch leaves `comparing`, as the minute timer would. */
const followed = async (booted: Booted, dataset: string, sid: string) => {
  await booted.module.follow();
  let seen = await view(booted, dataset, sid);
  for (let i = 0; i < 200 && seen.state === 'comparing'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    seen = await view(booted, dataset, sid);
  }
  return seen;
};

const engineView = async (booted: Booted, dataset: string) =>
  json<DatasetEngineView>(await booted.call(`${base(dataset)}/engine`));

const runOf = (worker: Worker, engineSwitch: string, n = 0) =>
  worker.started.filter((r) => r.engineSwitch === engineSwitch)[n];

const toReady = async (booted: Booted, dataset: string) => {
  const opened = await started(booted, dataset);
  await booted.worker.end(runOf(booted.worker, opened.id), 'succeeded', { stored: 3 });
  const ready = await followed(booted, dataset, opened.sid);
  expect(ready.state).toBe('ready');
  return opened;
};

describe('switching a dataset into the knowledge database', () => {
  it('a switch into the knowledge database fills its generation through ingestion runs', async () => {
    const booted = await boot();
    await folderDataset(booted, 'veiledning');
    const opened = await started(booted, 'veiledning');
    expect(opened.state).toBe('running');
    const run = runOf(booted.worker, opened.id);
    expect(run).toMatchObject({
      dataset: `${digdir}/veiledning`,
      pipeline: 'filer',
      engineSwitch: opened.id,
      generation: expect.stringMatching(/^g-\d{8}-[0-9a-f]{6}$/),
      admittedAt: expect.any(String),
    });
    expect((await view(booted, 'veiledning', opened.sid)).generation).toBe(run?.generation);
  });

  it('copy into the knowledge database is refused', async () => {
    const booted = await boot();
    await folderDataset(booted, 'kopi');
    const estimate = await json<SwitchEstimate>(
      await booted.call(`${base('kopi')}/engine-switches/estimate?to=knowledge-pg`),
    );
    expect(estimate.copy).toMatchObject({
      available: false,
      reason: expect.stringContaining('dokumentposter'),
    });
    expect(estimate.reingest.available).toBe(true);
    const refused = await startSwitch(booted, 'kopi', 'copy');
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await json(refused))).toContain('dokumentposter');
    expect(booted.worker.started).toEqual([]);
  });

  it('a switch into the knowledge database is refused for a dataset with a second pipeline or search phrases', async () => {
    const booted = await boot();
    await folderDataset(booted, 'to-kilder');
    const second = await booted.call(`${base('to-kilder')}/pipelines`, {
      body: { id: 'flere', name: 'Flere', source: { kind: 'folder', path: 'flere' } },
    });
    expect(second.status).toBe(201);
    const twice = await startSwitch(booted, 'to-kilder');
    expect(twice.status).toBe(409);
    expect(JSON.stringify(await json(twice))).toContain('én innlesing');

    await folderDataset(booted, 'fraser', {
      phrases: { model: 'fake/chat', perChunk: 2 },
    });
    const estimate = await json<SwitchEstimate>(
      await booted.call(`${base('fraser')}/engine-switches/estimate?to=knowledge-pg`),
    );
    expect(estimate.reingest).toMatchObject({
      available: false,
      reason: expect.stringContaining('Søkefraser'),
    });
    expect((await startSwitch(booted, 'fraser')).status).toBe(409);
    expect(booted.worker.started).toEqual([]);
  });

  it('two datasets switched onto the knowledge database get different generations', async () => {
    const booted = await boot();
    await folderDataset(booted, 'forste');
    await folderDataset(booted, 'andre');
    const first = await started(booted, 'forste');
    const second = await started(booted, 'andre');
    const generations = [runOf(booted.worker, first.id), runOf(booted.worker, second.id)].map(
      (r) => r?.generation,
    );
    expect(generations[0]).not.toBe(generations[1]);
    for (const g of generations) expect(g).toMatch(/^g-\d{8}-[0-9a-f]{6}$/);
  });

  it('a switch into the knowledge database survives an API restart', async () => {
    const worker = fakeWorker();
    const entries = new InMemoryConfigEntryStore();
    const first = await boot({ worker, entries });
    await folderDataset(first, 'omstart');
    const opened = await started(first, 'omstart');
    // Another instance takes over; the one that started the switch is never asked again.
    const second = await boot({ worker, entries });
    await second.platform.evalStores.testSets.put(
      (await first.platform.evalStores.testSets.list(digdir))[0] as never,
    );
    await worker.end(runOf(worker, opened.id), 'succeeded', { stored: 2, new: 2 });
    const ready = await followed(second, 'omstart', opened.sid);
    expect(ready).toMatchObject({ state: 'ready' });
    expect(second.reads.length).toBeGreaterThan(0);
  });

  it('a failed or cancelled run fails its switch', async () => {
    const booted = await boot();
    await folderDataset(booted, 'feil');
    const failing = await started(booted, 'feil');
    await booted.worker.end(
      runOf(booted.worker, failing.id),
      'failed',
      {},
      'the generation g-20261104-aa11bb was not built: its build job ended without attaching it; retry the switch',
    );
    await booted.module.follow();
    expect(await view(booted, 'feil', failing.sid)).toMatchObject({
      state: 'failed',
      // The switch keeps its messages in bokmål, as it does when it stalls.
      error: {
        message:
          'generasjonen g-20261104-aa11bb ble ikke bygget: byggejobben sluttet uten å koble den til; prøv byttet på nytt',
      },
    });

    await folderDataset(booted, 'avbrutt');
    const cancelled = await started(booted, 'avbrutt');
    await booted.worker.end(runOf(booted.worker, cancelled.id), 'cancelled');
    await booted.module.follow();
    expect((await view(booted, 'avbrutt', cancelled.sid)).state).toBe('failed');
  });

  it("a switch's generation is built and attached before it is compared", async () => {
    const booted = await boot();
    await folderDataset(booted, 'bygget');
    const opened = await started(booted, 'bygget');
    const run = runOf(booted.worker, opened.id);
    // The worker ends a run on a standalone generation only once its build has attached it.
    await booted.module.follow();
    expect((await view(booted, 'bygget', opened.sid)).state).toBe('running');
    expect(booted.reads).toEqual([]);
    await booted.worker.end(run, 'succeeded', { stored: 1, buildSent: 1 });
    expect((await followed(booted, 'bygget', opened.sid)).state).toBe('ready');
    expect(booted.reads.length).toBeGreaterThan(0);
    expect(booted.reads.every((r) => r.generation === run?.generation)).toBe(true);
  });

  it('a fill with failed documents goes on to comparing and shows the count', async () => {
    const booted = await boot();
    await folderDataset(booted, 'delvis');
    const opened = await started(booted, 'delvis');
    await booted.worker.end(runOf(booted.worker, opened.id), 'succeeded', {
      stored: 8,
      failedDocuments: 2,
    });
    expect(await followed(booted, 'delvis', opened.sid)).toMatchObject({
      state: 'ready',
      failedDocuments: 2,
    });
  });

  it('services read the previous engine until the switch is activated', async () => {
    const booted = await boot();
    await folderDataset(booted, 'tjenester');
    const opened = await toReady(booted, 'tjenester');
    expect((await engineView(booted, 'tjenester')).endpoint).toBe('platform-pg');
    const activating = await booted.call(
      `${base('tjenester')}/engine-switches/${opened.sid}/activate`,
      {
        body: {},
      },
    );
    expect(activating.status).toBe(202);
    expect((await json<EngineSwitchView>(activating)).state).toBe('activating');
    expect((await engineView(booted, 'tjenester')).endpoint).toBe('platform-pg');
    await booted.worker.end(runOf(booted.worker, opened.id, 1), 'succeeded');
    await booted.module.follow();
    expect((await engineView(booted, 'tjenester')).endpoint).toBe('knowledge-pg');
  });

  it('activating a switch names its generation as active in the catalog', async () => {
    const booted = await boot();
    await folderDataset(booted, 'aktiv');
    const opened = await toReady(booted, 'aktiv');
    const generation = runOf(booted.worker, opened.id)?.generation;
    await booted.call(`${base('aktiv')}/engine-switches/${opened.sid}/activate`, { body: {} });
    await booted.worker.end(runOf(booted.worker, opened.id, 1), 'succeeded');
    await booted.module.follow();
    expect(booted.platform.catalog.get('dataset', `${digdir}/aktiv`)?.spec).toMatchObject({
      endpoint: 'knowledge-pg',
      generation,
      embedding,
    });
    expect((await view(booted, 'aktiv', opened.sid)).state).toBe('active');
    // From then on the dataset's runs write in place: they run as jobs and name no generation.
    const ran = await booted.call(`${base('aktiv')}/pipelines/filer/execute`, { body: {} });
    expect(ran.status).toBe(202);
    expect(booted.worker.started.at(-1)).toMatchObject({ dataset: `${digdir}/aktiv` });
    expect(booted.worker.started.at(-1)?.generation).toBeUndefined();
    expect(booted.worker.started.at(-1)?.engineSwitch).toBeUndefined();
  });

  it('activating a switch first applies what changed in the source since its fill', async () => {
    const booted = await boot();
    await folderDataset(booted, 'oppfrisket');
    const opened = await toReady(booted, 'oppfrisket');
    const fill = runOf(booted.worker, opened.id);
    await booted.call(`${base('oppfrisket')}/engine-switches/${opened.sid}/activate`, { body: {} });
    const refresh = runOf(booted.worker, opened.id, 1);
    expect(refresh).toMatchObject({ generation: fill?.generation, engineSwitch: opened.id });
    await booted.module.follow();
    expect((await view(booted, 'oppfrisket', opened.sid)).state).toBe('activating');
    expect((await engineView(booted, 'oppfrisket')).endpoint).toBe('platform-pg');
    await booted.worker.end(refresh, 'succeeded', { changed: 1, stored: 1 });
    await booted.module.follow();
    expect((await view(booted, 'oppfrisket', opened.sid)).state).toBe('active');
  });

  it('a refresh run that fails puts the switch back to ready with its error', async () => {
    const booted = await boot();
    await folderDataset(booted, 'tilbake');
    const opened = await toReady(booted, 'tilbake');
    await booted.call(`${base('tilbake')}/engine-switches/${opened.sid}/activate`, { body: {} });
    await booted.worker.end(runOf(booted.worker, opened.id, 1), 'failed', {}, 'the source is down');
    await booted.module.follow();
    expect(await view(booted, 'tilbake', opened.sid)).toMatchObject({
      state: 'ready',
      error: { message: 'the source is down' },
    });
    expect((await engineView(booted, 'tilbake')).endpoint).toBe('platform-pg');
  });

  it('a retry after a failed comparison does not fill again', async () => {
    const worker = fakeWorker();
    const entries = new InMemoryConfigEntryStore();
    const clock = { now: new Date() };
    // The instance that compares stops answering mid-way, as one that went away would.
    const first = await boot({ worker, entries, clock, hang: true });
    await folderDataset(first, 'sammenlign');
    const opened = await started(first, 'sammenlign');
    await worker.end(runOf(worker, opened.id), 'succeeded', { stored: 1 });
    await first.module.follow();
    expect((await view(first, 'sammenlign', opened.sid)).state).toBe('comparing');
    clock.now = new Date(clock.now.getTime() + 3 * 60_000);
    const second = await boot({ worker, entries, clock });
    await second.module.follow();
    expect((await view(second, 'sammenlign', opened.sid)).state).toBe('failed');
    await second.platform.evalStores.testSets.put(
      (await first.platform.evalStores.testSets.list(digdir))[0] as never,
    );
    const retried = await second.call(`${base('sammenlign')}/engine-switches/${opened.sid}/retry`, {
      body: {},
    });
    expect(retried.status).toBe(202);
    expect((await followed(second, 'sammenlign', opened.sid)).state).toBe('ready');
    expect(worker.started.filter((r) => r.engineSwitch === opened.id)).toHaveLength(1);
  });

  it('a retry after a failed fill writes on into the same generation', async () => {
    const booted = await boot();
    await folderDataset(booted, 'videre');
    const opened = await started(booted, 'videre');
    const fill = runOf(booted.worker, opened.id);
    await booted.worker.end(fill, 'failed', {}, 'the source is down');
    await booted.module.follow();
    const retried = await booted.call(`${base('videre')}/engine-switches/${opened.sid}/retry`, {
      body: {},
    });
    expect(retried.status).toBe(202);
    expect(runOf(booted.worker, opened.id, 1)).toMatchObject({ generation: fill?.generation });
    await booted.module.sweep();
    expect(booted.worker.drops).toEqual([]);
  });

  it("a cancelled switch's generation is dropped by a drop job", async () => {
    const booted = await boot();
    await folderDataset(booted, 'avlyst');
    const opened = await started(booted, 'avlyst');
    const run = runOf(booted.worker, opened.id);
    const cancelled = await booted.call(`${base('avlyst')}/engine-switches/${opened.sid}/cancel`, {
      body: {},
    });
    expect(cancelled.status).toBe(200);
    expect((await booted.worker.executions.get(run?.id ?? ''))?.cancelRequestedAt).toEqual(
      expect.any(String),
    );
    await booted.module.sweep();
    expect(booted.worker.drops).toEqual([
      { tenant: digdir, dataset: `${digdir}/avlyst`, generation: run?.generation },
    ]);
    await booted.module.sweep();
    expect(booted.worker.drops).toHaveLength(1);
  });

  it('an engine switch holds every pipeline of its dataset while its runs are open', async () => {
    const booted = await boot();
    await folderDataset(booted, 'holdt');
    const execute = () => booted.call(`${base('holdt')}/pipelines/filer/execute`, { body: {} });
    const opened = await started(booted, 'holdt');
    const held = await execute();
    expect(held.status).toBe(409);
    const { errors } = await json<{ errors: { message: string }[] }>(held);
    expect(errors[0]?.message).toContain(opened.id);
    expect(translateMessage(errors[0]?.message ?? '', 'nb')).toContain(
      'byttes til en annen søkemotor',
    );
    await booted.worker.end(runOf(booted.worker, opened.id), 'succeeded', { stored: 1 });
    await followed(booted, 'holdt', opened.sid);
    // Ready waits for a person: runs go on into the current engine.
    expect((await execute()).status).toBe(202);
    await booted.call(`${base('holdt')}/engine-switches/${opened.sid}/activate`, { body: {} });
    expect((await execute()).status).toBe(409);
  });

  it("a switch's own runs are not held by it", async () => {
    const booted = await boot();
    await folderDataset(booted, 'egne');
    const opened = await toReady(booted, 'egne');
    const activating = await booted.call(`${base('egne')}/engine-switches/${opened.sid}/activate`, {
      body: {},
    });
    expect(activating.status).toBe(202);
    expect(runOf(booted.worker, opened.id, 1)).toMatchObject({ engineSwitch: opened.id });
  });

  it('an instance that loses the publish to another finishes the activation', async () => {
    const worker = fakeWorker();
    const entries = new InMemoryConfigEntryStore();
    const first = await boot({ worker, entries });
    await folderDataset(first, 'to-instanser');
    const opened = await toReady(first, 'to-instanser');
    const generation = runOf(worker, opened.id)?.generation;
    // The second instance has not seen the catalog change the first is about to make.
    const second = await boot({ worker, entries });
    await first.call(`${base('to-instanser')}/engine-switches/${opened.sid}/activate`, {
      body: {},
    });
    await worker.end(runOf(worker, opened.id, 1), 'succeeded');
    const before = first.platform.catalog.get('dataset', `${digdir}/to-instanser`);
    await first.platform.catalog.publish({
      kind: 'dataset',
      scope: digdir,
      id: 'to-instanser',
      spec: { ...before?.spec, endpoint: 'knowledge-pg', generation },
      by: 'workload:platform:engine-switch',
      reason: 'Flytter til kunnskapsdatabasen',
      ifVersion: before?.version ?? 0,
      movedBySwitch: true,
    });
    await second.module.follow();
    expect(await view(second, 'to-instanser', opened.sid)).toMatchObject({ state: 'active' });
  });

  it('an activation another instance published is finished by the next follow', async () => {
    const booted = await boot();
    await folderDataset(booted, 'halvveis');
    const opened = await toReady(booted, 'halvveis');
    const generation = runOf(booted.worker, opened.id)?.generation;
    await booted.call(`${base('halvveis')}/engine-switches/${opened.sid}/activate`, { body: {} });
    await booted.worker.end(runOf(booted.worker, opened.id, 1), 'succeeded');
    // The instance that published stopped before it saved the switch.
    const before = booted.platform.catalog.get('dataset', `${digdir}/halvveis`);
    await booted.platform.catalog.publish({
      kind: 'dataset',
      scope: digdir,
      id: 'halvveis',
      spec: { ...before?.spec, endpoint: 'knowledge-pg', generation },
      by: 'workload:platform:engine-switch',
      reason: 'Flytter til kunnskapsdatabasen',
      movedBySwitch: true,
    });
    await booted.module.follow();
    expect(await view(booted, 'halvveis', opened.sid)).toMatchObject({ state: 'active' });
  });

  it('runs a switch started while it was cancelled are cancelled too', async () => {
    const booted = await boot();
    await folderDataset(booted, 'avlyst-tidlig');
    let sid = '';
    booted.worker.hooks.onStart = async () => {
      const [entry] = await booted.entries.latest({ kind: 'engine-switch' });
      sid = String(entry?.id.split(':').pop());
      await booted.call(`${base('avlyst-tidlig')}/engine-switches/${sid}/cancel`, { body: {} });
    };
    await startSwitch(booted, 'avlyst-tidlig');
    const run = booted.worker.started.at(-1);
    expect((await booted.worker.executions.get(run?.id ?? ''))?.cancelRequestedAt).toEqual(
      expect.any(String),
    );
    expect((await view(booted, 'avlyst-tidlig', sid)).state).toBe('cancelled');
  });

  it('a switch shows the documents its fill wrote, even when it ends between two ticks', async () => {
    const booted = await boot();
    await folderDataset(booted, 'telling');
    const opened = await started(booted, 'telling');
    await booted.worker.end(runOf(booted.worker, opened.id), 'succeeded', {
      new: 3,
      stored: 2,
      skipped: 1,
    });
    const ready = await followed(booted, 'telling', opened.sid);
    expect(ready.progress).toMatchObject({ percent: 100, documents: 3, total: 3 });
  });

  it("an admitted login in lockdown starts a switch's runs", async () => {
    const booted = await boot({ lockdown: true, as: 'entra' });
    await folderDataset(booted, 'laast');
    const opened = await started(booted, 'laast');
    expect(opened.state).toBe('running');
    expect(runOf(booted.worker, opened.id)).toMatchObject({ engineSwitch: opened.id });
  });
});
