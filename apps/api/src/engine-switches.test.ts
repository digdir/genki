import { createHash } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { testSet } from '@genai/eval';
import { onePage } from '@genai/ingest';
import { envSecrets } from '@genai/kernel';
import { fakeEmbeddingAdapter, testContext } from '@genai/port-embedding/testing';
import type {
  DatasetConfig,
  Hit,
  IndexDocument,
  IndexWriterAdapter,
  KnowledgeAdapter,
} from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import { createPool } from '@genai/providers-postgres';
import { PLATFORM_RIGHTS, trustedEntraScope } from '@genai/identity';
import { createAdmin } from './admin.js';
import { followChanges, LocalChangeFeed } from './change-feed.js';
import { createPlatform } from './composition.js';
import { appendVersion, InMemoryConfigEntryStore } from './config-store.js';
import {
  createEngineSwitchesModule,
  type DatasetEngineView,
  type EngineSwitchesModule,
  type EngineSwitchSpec,
  type EngineSwitchView,
  type SwitchEstimate,
} from './engine-switches.js';
import { knowledgeEndpointsModule } from './knowledge-endpoints.js';
import { stopPostgres } from '@genai/providers-postgres/testing';

const digdir = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir };
const principals: Record<string, Principal> = {
  kari,
  ingrid: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ingrid',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
  entra: {
    kind: 'employee',
    issuer: 'test',
    subject: 'entra',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: [...PLATFORM_RIGHTS] }],
    scopes: [trustedEntraScope],
  },
};

const kudosPage = {
  data: [
    {
      id: 7,
      title: 'Tildelingsbrev 2025',
      type: 'Tildelingsbrev',
      publish_date: '2025-01-15',
      files: [
        {
          url: 'https://93.184.216.34/filer/7.pdf',
          mimetype: 'application/pdf',
          sha256: createHash('sha256').update('%PDF-1.7').digest('hex'),
        },
      ],
    },
    { id: 8, title: 'Årsrapport', type: 'Årsrapport', publish_date: '2025-03-01', files: [] },
  ],
  meta: { current_page: 1, last_page: 1, total: 2 },
};
// The estimate reads the first page in KUDOS's own order; a listing names its order.
const kudosPages: Record<string, unknown> = {
  'https://kudos.dfo.no/api/v0/documents?page=1&per_page=50&type=Tildelingsbrev': kudosPage,
  'https://kudos.dfo.no/api/v0/documents?page=1&per_page=50&type=Tildelingsbrev&sort=newest':
    kudosPage,
};
const kudosFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url in kudosPages) return Response.json(kudosPages[url]);
  if (url === 'https://93.184.216.34/filer/7.pdf') return new Response('%PDF-1.7');
  return new Response('', { status: 404 });
}) as typeof fetch;

const docs = [
  { id: '1', doc_num: 'tilskudd', title: 'Tilskudd', url: 'https://ka.example/tilskudd' },
  { id: '2', doc_num: 'sky', title: 'Skyplattform', url: 'https://ka.example/sky' },
];
const chunks = [
  {
    id: 'c1',
    chunk_id: 'tilskudd-0',
    doc_num: 'tilskudd',
    chunk_index: 0,
    content_markdown: 'Kommunen gir tilskudd til lag og foreninger hvert år.',
  },
  {
    id: 'c2',
    chunk_id: 'sky-0',
    doc_num: 'sky',
    chunk_index: 0,
    content_markdown: 'Etaten flytter tjenestene sine til en skyplattform.',
  },
];

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createPool>;

const sourceDocuments = (): IndexDocument[] =>
  docs.map((d) => ({
    id: d.doc_num,
    title: d.title,
    url: d.url,
    fields: {},
    chunks: chunks
      .filter((c) => c.doc_num === d.doc_num)
      .map((c) => ({ id: c.chunk_id, position: c.chunk_index, text: c.content_markdown })),
    phrases: [],
  }));

const ghost: Hit = {
  id: 'spokelse-0',
  score: 99,
  text: 'x',
  document: 'spokelse',
  position: 0,
  fields: {},
};

const remote = memoryEngine({ engine: 'kilde' });
const remoteStore = remote.writer.connect({ engine: 'kilde' } as never, {
  signal: new AbortController().signal,
});
const sourceAdapter: KnowledgeAdapter = {
  ...(remote.adapter as KnowledgeAdapter),
  title: 'Kildesøk',
  requiresBaseURL: true,
  connect: (endpoint) => {
    const inner = (remote.adapter as KnowledgeAdapter).connect(endpoint);
    const indexOf = (dataset: DatasetConfig) =>
      (dataset.options as { index?: string }).index ?? dataset.id;
    return {
      ...inner,
      search: async (dataset, requests, signal) => {
        const results = await inner.search(dataset, requests, signal);
        return indexOf(dataset) === 'ghost'
          ? results.map((r) => ({ ...r, hits: [ghost, ...r.hits] }))
          : results;
      },
      export: {
        vectors: false,
        documents: (dataset) => {
          if (!remoteStore.read) throw new Error('the memory engine reads its index back');
          return remoteStore.read({ ...dataset, options: { index: 'ka' } } as DatasetConfig<never>);
        },
        count: async (_dataset, cap) => Math.min(docs.length, cap),
      },
    };
  },
};
const writes: string[] = [];
const recordingSource: IndexWriterAdapter = {
  ...remote.writer,
  connect: (endpoint, context) => {
    const inner = (remote.writer as IndexWriterAdapter).connect(endpoint, context);
    return {
      ...inner,
      prepare: async (dataset, generation) => {
        writes.push(`prepare ${generation}`);
        return inner.prepare(dataset, generation);
      },
      store: async (dataset, generation, doc) => {
        writes.push(`store ${doc.id}`);
        return inner.store(dataset, generation, doc);
      },
      promote: async (dataset, generation) => {
        writes.push(`promote ${generation}`);
        return inner.promote(dataset, generation);
      },
      drop: async (dataset, generation, options) => {
        writes.push(`drop ${generation}`);
        return inner.drop(dataset, generation, options);
      },
    };
  },
};

const readOnly = memoryEngine({ engine: 'lesekilde' });
const readOnlyEngine = {
  adapter: { ...(readOnly.adapter as KnowledgeAdapter), title: 'Lesekilde' },
  writer: { ...readOnly.writer, engine: 'lesekilde-uten-skriving' },
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  pool = createPool({ connectionString: container.getConnectionUri() });
}, 120_000);

beforeEach(async () => {
  for (const index of ['ka', 'ghost']) {
    const dataset = { id: index, filters: {}, options: { index } } as DatasetConfig<never>;
    if ((await remoteStore.active(dataset)) !== undefined) continue;
    const generation = `g${crypto.randomUUID()}`;
    await remoteStore.prepare(dataset, generation);
    for (const doc of sourceDocuments()) await remoteStore.store(dataset, generation, doc);
    await remoteStore.promote(dataset, generation);
  }
  writes.length = 0;
});

afterAll(async () => {
  await pool?.end();
  await stopPostgres(container);
});

/** The engine datasets switch to, kept across boots as a database would be. */
const localEngine = memoryEngine();

const embeddingModel = (id: string) => ({
  id,
  endpoint: 'fake',
  deployment: id,
  residency: 'norway',
  dimensions: 8,
});

const boot = async (
  shared: { entries?: InMemoryConfigEntryStore; clock?: { now: Date }; lockdown?: boolean } = {},
) => {
  const secrets = envSecrets({ SOURCE_KEY: 'k', EMBED_KEY: 'k' });
  const clock = shared.clock ?? { now: new Date('2026-10-07T10:00:00Z') };
  const late: { platform?: Awaited<ReturnType<typeof createPlatform>> } = {};
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: {
        endpoints: {
          'ka-kilde': {
            engine: 'kilde',
            baseURL: 'http://127.0.0.1:9',
            auth: { kind: 'api-key', secret: 'secret://env/source-key' },
            sharing: { tenants: '*' },
          },
          'ka-lesekilde': { engine: 'lesekilde', sharing: { tenants: '*' } },
          // The engine datasets switch to and from: an in-memory one, as platform-pg went with issue 151.
          lokal: { engine: 'memory', sharing: { tenants: '*' } },
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
        models: [embeddingModel('fake/embed'), embeddingModel('fake/other')],
      },
    },
    secrets,
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
    knowledgeEngines: [
      localEngine,
      { adapter: sourceAdapter, writer: recordingSource },
      readOnlyEngine,
    ],
    knowledgeServer: { reader: pool },
    embeddingAdapters: [fakeEmbeddingAdapter()],
    documentConverter: {
      convert: async () =>
        onePage('# Tildelingsbrev\n\nDepartementet tildeler midler til skyplattformen.'),
    },
    kudos: { fetch: kudosFetch, sleep: async () => undefined },
    ...(shared.entries ? { configurables: { store: shared.entries } } : {}),
    ...(shared.lockdown ? { lockdown: { configuredKeys: new Set<string>() } } : {}),
    modules: [
      knowledgeEndpointsModule,
      createEngineSwitchesModule({
        secrets,
        embedders: {
          has: (model) => Boolean(late.platform?.embedders.describe().some((e) => e.id === model)),
          open: (...args) =>
            (late.platform as NonNullable<typeof late.platform>).embedders.open(...args),
        },
        now: () => clock.now,
        sweepIntervalMs: 0,
      }),
    ],
  });
  late.platform = platform;
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (path: string, init: { method?: string; body?: unknown; as?: string } = {}) => {
    const { reason, ...body } = (init.body ?? {}) as Record<string, unknown>;
    return app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${init.as ?? 'kari'}`,
        'content-type': 'application/json',
        'change-reason': encodeURIComponent(typeof reason === 'string' ? reason : 'Testendring'),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  return { platform, app, call, clock, admin };
};

type Booted = Awaited<ReturnType<typeof boot>>;
const json = async <T>(response: Response) => (await response.json()) as T;
const base = (dataset: string) => `/tenants/${digdir}/datasets/${dataset}`;

const createDataset = async (
  { call, platform }: Booted,
  id: string,
  index = 'ka',
  extra: Record<string, unknown> = {},
) => {
  const created = await call(`/tenants/${digdir}/datasets`, {
    body: {
      id,
      name: 'Kunnskapsassistenten',
      residency: 'norway',
      index: { endpoint: 'ka-kilde', options: { index } },
      ...extra,
    },
  });
  expect(created.status).toBe(201);
  await platform.evalStores.testSets.put(
    testSet.parse({
      apiVersion: 'genai/v1',
      kind: 'TestSet',
      metadata: { tenant: digdir, id: `${id}-sporsmal`, name: 'Spørsmål', version: 1 },
      spec: {
        corpus: id,
        cases: [
          {
            id: 'tilskudd',
            split: 'validation',
            input: 'Hvem gir tilskudd til foreninger?',
            expected: { sources: [{ document: 'tilskudd' }] },
          },
          {
            id: 'sky',
            split: 'validation',
            input: 'Hvorfor flytter etaten til skyplattform?',
            expected: {
              sources: [{ document: index === 'ghost' ? 'spokelse' : 'sky' }],
            },
          },
        ],
      },
    }),
  );
};

const settled = async ({ call }: Booted, dataset: string, sid: string) => {
  let view: EngineSwitchView | undefined;
  for (let i = 0; i < 400; i++) {
    view = await json<EngineSwitchView>(await call(`${base(dataset)}/engine-switches/${sid}`));
    if (view.state !== 'running' && view.state !== 'comparing') return view;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return view as EngineSwitchView;
};

const switchTo = async (booted: Booted, dataset: string) => {
  const started = await booted.call(`${base(dataset)}/engine-switches`, {
    body: {
      to: 'lokal',
      method: 'copy',
      embedding: { model: 'fake/embed', dimensions: 8 },
      reason: 'Flytter til plattformens database',
    },
  });
  expect(started.status).toBe(202);
  const view = await json<EngineSwitchView>(started);
  expect(view).toMatchObject({ state: 'running', from: 'ka-kilde', to: 'lokal' });
  return settled(booted, dataset, view.sid);
};

const engineOf = (platform: Booted['platform'], dataset: string) => {
  const { ctx } = testContext();
  return platform.knowledge
    .open(
      { kind: 'dataset', id: `${digdir}/${dataset}`, tenant: digdir },
      { ...ctx, tenant: digdir },
    )
    .info().engine;
};

const sweeper = (platform: Booted['platform']) =>
  platform.modules.find((m) => m.id === 'engine-switches') as unknown as EngineSwitchesModule;

const pgRoute = (platform: Booted['platform'], dataset: string) =>
  platform.writers.openAt(`${digdir}/${dataset}`, 'lokal', {
    signal: new AbortController().signal,
  });

const placeSwitch = async (
  { platform, clock }: Booted,
  dataset: string,
  change: Partial<EngineSwitchSpec>,
) => {
  const item = platform.catalog.get('dataset', `${digdir}/${dataset}`);
  const at = clock.now.toISOString();
  const spec: EngineSwitchSpec = {
    dataset: `${digdir}/${dataset}`,
    from: 'ka-kilde',
    to: 'lokal',
    method: 'copy',
    state: 'running',
    embedding: { model: 'fake/embed', dimensions: 8 },
    estimate: { costNok: { min: 1, max: 1 }, durationMinutes: { min: 1, max: 1 } },
    progress: { percent: 40, documents: 1, total: 2 },
    attempt: 1,
    generation: 'switch-1-1',
    startedAt: at,
    startedBy: 'employee:test:kari',
    updatedAt: at,
    heartbeatAt: at,
    datasetVersion: item?.version ?? 1,
    decisions: [],
    cleanup: [],
    ...change,
  };
  await appendVersion(platform.configEntries, {
    kind: 'engine-switch',
    scope: digdir,
    id: `${dataset}:1`,
    spec,
    deleted: false,
    by: 'platform:engine-switch',
    reason: 'Startet på en annen instans',
    at,
    ifVersion: 0,
  });
};

describe('switching the search engine of a dataset', () => {
  it('starting a switch takes its reason from the change-reason header and ignores a reason in the body', async () => {
    const booted = await boot();
    await createDataset(booted, 'ka-grunn');

    const started = await booted.app.request(`${base('ka-grunn')}/engine-switches`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer kari',
        'content-type': 'application/json',
        'change-reason': encodeURIComponent('Flytter til plattformens database'),
      },
      body: JSON.stringify({
        to: 'lokal',
        method: 'copy',
        embedding: { model: 'fake/embed', dimensions: 8 },
        reason: 'Teksten i kroppen brukes ikke',
      }),
    });

    expect(started.status).toBe(202);
    expect(await json<EngineSwitchView>(started)).toMatchObject({
      reason: 'Flytter til plattformens database',
    });
    expect((await booted.admin.audit(digdir)).at(-1)).toMatchObject({
      action: 'platform.engine-switch.start',
      reason: 'Flytter til plattformens database',
    });
  });

  it.each([
    { who: 'entra', admitted: true },
    { who: 'kari', admitted: undefined },
  ])(
    'carries whether $who may use models in lockdown into the re-ingestion of a switch',
    async ({ who, admitted }) => {
      const entries = new InMemoryConfigEntryStore();
      const booted = await boot({ entries, lockdown: true });
      const dataset = `ka-laast-${who}`;
      await createDataset(booted, dataset);

      const started = await booted.call(`${base(dataset)}/engine-switches`, {
        as: who,
        body: {
          to: 'lokal',
          method: 'copy',
          embedding: { model: 'fake/embed', dimensions: 8 },
        },
      });

      expect(started.status).toBe(202);
      await settled(booted, dataset, (await json<EngineSwitchView>(started)).sid);
      const [entry] = await entries.latest({ kind: 'engine-switch' });
      expect((entry?.spec as EngineSwitchSpec).modelsAdmitted).toBe(admitted);
    },
  );

  it('services keep the old engine until activate', async () => {
    const booted = await boot();
    const { call, platform } = booted;
    await createDataset(booted, 'ka-kopi');

    const estimate = await json<SwitchEstimate>(
      await call(`${base('ka-kopi')}/engine-switches/estimate?to=lokal&method=copy`),
    );
    expect(estimate).toMatchObject({
      estimate: true,
      basis: { documents: 2, counted: true },
      copy: { available: true },
      reingest: { available: false, reason: 'Datasettet har ingen innlesing å kjøre.' },
    });

    const ready = await switchTo(booted, 'ka-kopi');
    expect(ready).toMatchObject({
      state: 'ready',
      progress: { percent: 100, documents: 2, total: 2 },
      minimumReasonLength: 10,
      comparison: { cases: 2, testSets: ['ka-kopi-sporsmal'] },
    });
    expect(ready.comparison?.hitAt5[0]).toBe(1);
    expect(engineOf(platform, 'ka-kopi')).toBe('kilde');
    const before = await json<DatasetEngineView>(await call(`${base('ka-kopi')}/engine`));
    expect(before).toMatchObject({
      endpoint: 'ka-kilde',
      engine: 'kilde',
      runsAt: '127.0.0.1',
      embedding: null,
      canSwitch: true,
      activeSwitch: { state: 'ready' },
    });
    expect(before.capabilities.supported).toContain('ordered_passages');

    const activated = await call(`${base('ka-kopi')}/engine-switches/${ready.sid}/activate`, {
      body: { reason: 'Bedre treff i testsettet' },
    });
    expect(activated.status).toBe(200);
    const active = await json<EngineSwitchView>(activated);
    expect(active).toMatchObject({
      state: 'active',
      canRollback: true,
      previousKeptUntil: '2026-10-21T10:00:00.000Z',
      decision: { action: 'activate', reason: 'Bedre treff i testsettet' },
    });
    expect(engineOf(platform, 'ka-kopi')).toBe('memory');
    const { ctx } = testContext();
    const hits = await platform.knowledge
      .open(
        { kind: 'dataset', id: `${digdir}/ka-kopi`, tenant: digdir },
        { ...ctx, tenant: digdir },
      )
      .search({ query: 'tilskudd', profile: 'content' });
    expect(hits.hits[0]?.document).toBe('tilskudd');
    const after = await json<DatasetEngineView>(await call(`${base('ka-kopi')}/engine`));
    expect(after).toMatchObject({
      endpoint: 'lokal',
      engine: 'memory',
      runsAt: 'platform',
      embedding: { model: 'fake/embed', dimensions: 8 },
      retentionDays: 14,
      previous: {
        endpoint: 'ka-kilde',
        title: 'Kildesøk',
        keptUntil: '2026-10-21T10:00:00.000Z',
      },
    });
    expect(after.activeSwitch).toBeUndefined();
    expect(writes).toEqual([]);

    const back = await call(`${base('ka-kopi')}/engine-switches/${ready.sid}/rollback`, {
      body: { reason: 'Tjenestene svarer dårligere nå' },
    });
    expect(back.status).toBe(200);
    expect(engineOf(platform, 'ka-kopi')).toBe('kilde');
  });

  it('activating a worse engine needs a 20-character reason', async () => {
    const booted = await boot();
    await createDataset(booted, 'ka-svakere', 'ghost');
    const ready = await switchTo(booted, 'ka-svakere');
    expect(ready).toMatchObject({ state: 'ready', minimumReasonLength: 20 });
    expect(ready.comparison).toMatchObject({ verdict: 'worse', hitAt5: [1, 0.5] });

    const short = await booted.call(`${base('ka-svakere')}/engine-switches/${ready.sid}/activate`, {
      body: { reason: 'Godt nok her' },
    });
    expect(short.status).toBe(400);
    expect(JSON.stringify(await short.json())).toContain('minst 20 tegn');
    const enough = await booted.call(
      `${base('ka-svakere')}/engine-switches/${ready.sid}/activate`,
      {
        body: { reason: 'Vi godtar færre treff for å samle data i Norge' },
      },
    );
    expect(enough.status).toBe(200);
  });

  it('rollback after the retention period is refused', async () => {
    const booted = await boot();
    await createDataset(booted, 'ka-oppbevaring');
    const ready = await switchTo(booted, 'ka-oppbevaring');
    await booted.call(`${base('ka-oppbevaring')}/engine-switches/${ready.sid}/activate`, {
      body: { reason: 'Bedre treff i testsettet' },
    });
    booted.clock.now = new Date('2026-10-22T10:00:00Z');

    const refused = await booted.call(
      `${base('ka-oppbevaring')}/engine-switches/${ready.sid}/rollback`,
      {
        body: { reason: 'Vil tilbake til kilden' },
      },
    );
    expect(refused.status).toBe(409);
    expect(engineOf(booted.platform, 'ka-oppbevaring')).toBe('memory');
    expect(await sweeper(booted.platform).sweep()).toMatchObject({ ran: true, expired: 1 });
  });

  it('a switch whose job stopped is marked failed and can be retried', async () => {
    const booted = await boot();
    await createDataset(booted, 'ka-stopp');
    await placeSwitch(booted, 'ka-stopp', {});

    expect(await sweeper(booted.platform).sweep()).toMatchObject({ stalled: 0 });
    booted.clock.now = new Date(booted.clock.now.getTime() + 3 * 60_000);
    expect(await sweeper(booted.platform).sweep()).toMatchObject({ stalled: 1 });

    const failed = await json<EngineSwitchView>(
      await booted.call(`${base('ka-stopp')}/engine-switches/1`),
    );
    expect(failed).toMatchObject({
      state: 'failed',
      error: { message: 'Overføringen stoppet. Start den på nytt.', percent: 40 },
    });
    const retried = await booted.call(`${base('ka-stopp')}/engine-switches/1/retry`, {
      body: {},
    });
    expect(retried.status).toBe(202);
    expect(await settled(booted, 'ka-stopp', '1')).toMatchObject({ state: 'ready', attempt: 2 });
  });

  it('starting, retrying, cancelling, activating and rolling back a switch are audited admin tasks', async () => {
    const booted = await boot();
    const { call, admin, clock } = booted;
    await createDataset(booted, 'ka-revisjon');
    await placeSwitch(booted, 'ka-revisjon', {});
    clock.now = new Date(clock.now.getTime() + 3 * 60_000);
    await sweeper(booted.platform).sweep();
    const retried = await call(`${base('ka-revisjon')}/engine-switches/1/retry`, { body: {} });
    await settled(booted, 'ka-revisjon', '1');
    const cancelled = await call(`${base('ka-revisjon')}/engine-switches/1/cancel`, { body: {} });
    const started = await call(`${base('ka-revisjon')}/engine-switches`, {
      body: {
        to: 'lokal',
        method: 'copy',
        embedding: { model: 'fake/embed', dimensions: 8 },
        reason: 'Flytter til plattformens database',
      },
    });
    const sid = (await json<EngineSwitchView>(started)).sid;
    await settled(booted, 'ka-revisjon', sid);
    const activated = await call(`${base('ka-revisjon')}/engine-switches/${sid}/activate`, {
      body: { reason: 'Bedre treff i testsettet' },
    });
    const back = await call(`${base('ka-revisjon')}/engine-switches/${sid}/rollback`, {
      body: { reason: 'Tjenestene svarer dårligere nå' },
    });

    const tasks = (await admin.audit(digdir)).filter((a) => a.target.startsWith('engine-switch:'));
    expect(tasks.map((a) => [a.action, a.outcome, a.task])).toEqual([
      ['platform.engine-switch.retry', 'applied', retried.headers.get('genai-task')],
      ['platform.engine-switch.cancel', 'applied', cancelled.headers.get('genai-task')],
      ['platform.engine-switch.start', 'applied', started.headers.get('genai-task')],
    ]);
    const published = (await admin.audit(digdir)).filter(
      (a) => a.action === 'platform.catalog.publish',
    );
    expect(published.slice(-2).map((a) => a.task)).toEqual([
      activated.headers.get('genai-task'),
      back.headers.get('genai-task'),
    ]);
  });

  it('the sweep deletes an expired previous copy', async () => {
    const booted = await boot();
    await createDataset(booted, 'ka-gammel');
    const route = pgRoute(booted.platform, 'ka-gammel');
    const doc: IndexDocument = {
      id: 'tilskudd',
      title: 'Tilskudd',
      fields: {},
      chunks: [{ id: 'tilskudd-0', position: 0, text: 'Kommunen gir tilskudd.' }],
      phrases: [],
    };
    await route.writer.prepare(route.dataset, 'g-gammel');
    await route.writer.store(route.dataset, 'g-gammel', doc);
    await route.writer.promote(route.dataset, 'g-gammel');
    const item = booted.platform.catalog.get('dataset', `${digdir}/ka-gammel`);
    await placeSwitch(booted, 'ka-gammel', {
      from: 'lokal',
      to: 'ka-kilde',
      state: 'active',
      previous: {
        endpoint: 'lokal',
        keptUntil: '2026-10-06T10:00:00.000Z',
        catalogVersion: 1,
        spec: { ...item?.spec, endpoint: 'lokal', options: {} },
      },
    });

    expect(await sweeper(booted.platform).sweep()).toMatchObject({ dropped: 1, expired: 1 });
    expect(await route.writer.active(route.dataset)).toBeUndefined();
    await expect(route.writer.stats(route.dataset, 'g-gammel')).rejects.toMatchObject({
      code: 'bad_request',
    });
    const [entry] = await booted.platform.configEntries.latest({
      kind: 'engine-switch',
      scope: digdir,
    });
    expect((entry?.spec as EngineSwitchSpec).cleanup).toEqual([
      { endpoint: 'lokal', generation: 'g-gammel', dropped: expect.any(String) },
    ]);
    expect(await sweeper(booted.platform).sweep()).toMatchObject({ dropped: 0, expired: 0 });
  });

  it('the sweep deletes the copy a rollback left behind', async () => {
    const booted = await boot();
    await createDataset(booted, 'ka-angret');
    const ready = await switchTo(booted, 'ka-angret');
    await booted.call(`${base('ka-angret')}/engine-switches/${ready.sid}/activate`, {
      body: { reason: 'Bedre treff i testsettet' },
    });
    await booted.call(`${base('ka-angret')}/engine-switches/${ready.sid}/rollback`, {
      body: { reason: 'Tjenestene svarer dårligere nå' },
    });
    const route = pgRoute(booted.platform, 'ka-angret');
    expect(await route.writer.active(route.dataset)).toBe('switch-1-1');

    expect(await sweeper(booted.platform).sweep()).toMatchObject({ dropped: 1 });
    expect(await route.writer.active(route.dataset)).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it('copy is refused when embedding models differ', async () => {
    const booted = await boot();
    await createDataset(booted, 'ka-vektor', undefined, {
      embedding: { model: 'fake/embed', dimensions: 8 },
    });
    const estimate = await json<SwitchEstimate>(
      await booted.call(`${base('ka-vektor')}/engine-switches/estimate?to=lokal`),
    );
    expect(estimate.copy.available).toBe(true);

    const refused = await booted.call(`${base('ka-vektor')}/engine-switches`, {
      body: {
        to: 'lokal',
        method: 'copy',
        embedding: { model: 'fake/other', dimensions: 8 },
      },
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toContain('Kopiering krever samme vektormodell');
  });

  it('switching to an engine the platform cannot write to is refused', async () => {
    const booted = await boot();
    await createDataset(booted, 'ka-tilbake');
    const ready = await switchTo(booted, 'ka-tilbake');
    await booted.call(`${base('ka-tilbake')}/engine-switches/${ready.sid}/activate`, {
      body: { reason: 'Bedre treff i testsettet' },
    });
    const refused = await booted.call(`${base('ka-tilbake')}/engine-switches`, {
      body: { to: 'ka-lesekilde', method: 'copy' },
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      title: 'Plattformen kan ikke skrive til denne søkemotoren.',
    });
    expect(writes).toEqual([]);
  });

  it('switches need the right to manage datasets', async () => {
    const booted = await boot();
    await createDataset(booted, 'ka-rett');
    const refused = await booted.call(`${base('ka-rett')}/engine-switches`, {
      as: 'ingrid',
      body: { to: 'lokal', method: 'copy' },
    });
    expect(refused.status).toBe(403);
    expect((await booted.call(`${base('ka-rett')}/engine`, { as: 'ingrid' })).status).toBe(200);
  });

  it('a second registry sees the activated endpoint after a config-entries change', async () => {
    const entries = new InMemoryConfigEntryStore();
    const clock = { now: new Date('2026-10-07T10:00:00Z') };
    const feed = new LocalChangeFeed();
    const a = await boot({ entries, clock });
    await createDataset(a, 'ka-delt');
    const b = await boot({ entries, clock });
    const unused = { reload: async () => undefined, sync: async () => undefined };
    followChanges(feed, {
      settings: unused,
      contentReasons: unused,
      catalog: b.platform.catalog,
      definitions: unused,
      models: { loadDiscovered: async () => undefined },
      toolConnections: unused,
    });
    const ready = await switchTo(a, 'ka-delt');
    await a.call(`${base('ka-delt')}/engine-switches/${ready.sid}/activate`, {
      body: { reason: 'Bedre treff i testsettet' },
    });
    expect(engineOf(b.platform, 'ka-delt')).toBe('kilde');

    await feed.emit('config-entries');

    expect(engineOf(b.platform, 'ka-delt')).toBe('memory');
    expect(
      (await json<DatasetEngineView>(await b.call(`${base('ka-delt')}/engine`))).endpoint,
    ).toBe('lokal');
  });
});

describe('operators switching the engine of a platform dataset', () => {
  const operatorBase = (id: string) => `/operator/datasets/${encodeURIComponent(id)}`;
  const createPlatformDataset = async ({ call }: Booted, id: string) => {
    const created = await call('/operator/datasets', {
      as: 'drift',
      body: {
        id,
        name: 'Kudos',
        residency: 'norway',
        index: { endpoint: 'ka-kilde', options: { index: 'ka' } },
      },
    });
    expect(created.status).toBe(201);
  };
  const settledAt = async ({ call }: Booted, id: string, sid: string) => {
    let view: EngineSwitchView | undefined;
    for (let i = 0; i < 400; i++) {
      view = await json<EngineSwitchView>(
        await call(`${operatorBase(id)}/engine-switches/${sid}`, { as: 'drift' }),
      );
      if (view.state !== 'running' && view.state !== 'comparing') return view;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return view as EngineSwitchView;
  };
  const platformEngineOf = (platform: Booted['platform'], id: string) => {
    const { ctx } = testContext();
    return platform.knowledge
      .open({ kind: 'dataset', id, tenant: digdir }, { ...ctx, tenant: digdir })
      .info().engine;
  };

  it('copies a platform dataset from a read-only engine to another engine, activates and rolls back', async () => {
    const booted = await boot();
    const { call, platform } = booted;
    await createPlatformDataset(booted, 'digdir/kudos-kopi');
    const id = 'digdir/kudos-kopi';

    expect((await call(`${operatorBase(id)}/engine-switches`, { as: 'kari' })).status).toBe(403);
    expect(
      (
        await call(`/tenants/${digdir}/datasets/${encodeURIComponent(id)}/engine-switches`, {
          body: { to: 'lokal', method: 'copy' },
        })
      ).status,
    ).toBe(404);

    const started = await call(`${operatorBase(id)}/engine-switches`, {
      as: 'drift',
      body: {
        to: 'lokal',
        method: 'copy',
        embedding: { model: 'fake/embed', dimensions: 8 },
        reason: 'Flytter Kudos til plattformens database',
      },
    });
    expect(started.status).toBe(202);
    const view = await json<EngineSwitchView>(started);
    const ready = await settledAt(booted, id, view.sid);
    expect(ready).toMatchObject({ state: 'ready', progress: { percent: 100, documents: 2 } });
    expect(platformEngineOf(platform, id)).toBe('kilde');

    const activated = await call(`${operatorBase(id)}/engine-switches/${ready.sid}/activate`, {
      as: 'drift',
      body: { reason: 'Kudos skal ligge i Norge' },
    });
    expect(activated.status).toBe(200);
    expect(platformEngineOf(platform, id)).toBe('memory');
    expect(await json(await call(`${operatorBase(id)}/engine`, { as: 'drift' }))).toMatchObject({
      endpoint: 'lokal',
      canSwitch: true,
    });

    const back = await call(`${operatorBase(id)}/engine-switches/${ready.sid}/rollback`, {
      as: 'drift',
      body: { reason: 'Tilbake til kilden for nå' },
    });
    expect(back.status).toBe(200);
    expect(platformEngineOf(platform, id)).toBe('kilde');
    expect(writes).toEqual([]);
  });

  it("compares a platform dataset's switch with the platform organisation's test sets", async () => {
    const booted = await boot();
    const id = 'digdir/kudos-sammenlign';
    await createPlatformDataset(booted, id);
    await booted.platform.evalStores.testSets.put(
      testSet.parse({
        apiVersion: 'genai/v1',
        kind: 'TestSet',
        metadata: { tenant: digdir, id: 'kudos-sporsmal', name: 'Spørsmål', version: 1 },
        spec: {
          corpus: id,
          cases: [
            {
              id: 'tilskudd',
              split: 'validation',
              input: 'Hvem gir tilskudd til foreninger?',
              expected: { sources: [{ document: 'tilskudd' }] },
            },
          ],
        },
      }),
    );

    const started = await booted.call(`${operatorBase(id)}/engine-switches`, {
      as: 'drift',
      body: {
        to: 'lokal',
        method: 'copy',
        embedding: { model: 'fake/embed', dimensions: 8 },
        reason: 'Sammenligner før Kudos flytter',
      },
    });
    expect(started.status).toBe(202);
    const ready = await settledAt(booted, id, (await json<EngineSwitchView>(started)).sid);

    expect(ready.comparison).toMatchObject({ cases: 1, testSets: ['kudos-sporsmal'] });
  });

  it('tells the portal the default embedding model for new pgvector datasets', async () => {
    const { call } = await boot();
    const endpoints = await json<{ defaultEmbedding: unknown }>(
      await call(`/tenants/${digdir}/knowledge/endpoints`),
    );
    expect(endpoints.defaultEmbedding).toEqual({
      model: 'fake/embed',
      dimensions: 8,
      residency: expect.any(String),
    });

    const created = await call(`/tenants/${digdir}/datasets`, {
      body: {
        name: 'Nye filer',
        endpoint: 'knowledge-pg',
        residency: 'eu',
        embedding: endpoints.defaultEmbedding,
      },
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      id: 'nye-filer',
      index: { endpoint: 'knowledge-pg' },
      embedding: { model: 'fake/embed', dimensions: 8 },
    });
  });

  it('a switch to an engine other than the knowledge database cannot re-ingest or copy a parts pipeline', async () => {
    const entries = new InMemoryConfigEntryStore();
    const booted = await boot({ entries });
    const { call } = booted;
    const id = 'digdir/kudos-deler';
    await createPlatformDataset(booted, id);
    const saved = await call(`${operatorBase(id)}/pipelines`, {
      as: 'drift',
      body: {
        id: 'kudos',
        name: 'Kudos',
        source: { kind: 'kudos', types: ['Tildelingsbrev'] },
        chunking: { minimumLength: 1 },
      },
    });
    expect(saved.status).toBe(201);
    // A pipeline saved with a parts chunking before the refusal, or written past the API.
    const [entry] = (await entries.latest({ kind: 'ingestion-pipeline' })).filter((e) =>
      e.id.startsWith(`${id}#`),
    );
    if (!entry) throw new Error('no pipeline entry');
    const spec = entry.spec as { chunking: Record<string, unknown> };
    await appendVersion(entries, {
      ...entry,
      spec: {
        ...spec,
        chunking: { ...spec.chunking, strategy: { kind: 'parts-unit', splitMaxLength: 4000 } },
      },
      by: 'drift',
      reason: 'test',
      at: new Date().toISOString(),
    });

    const estimate = await json<SwitchEstimate>(
      await call(`${operatorBase(id)}/engine-switches/estimate?to=lokal&method=reingest`, {
        as: 'drift',
      }),
    );

    // A copy would leave a pipeline whose every document fails to chunk.
    expect(estimate.copy).toMatchObject({
      available: false,
      reason:
        'Innlesingen kudos deler opp etter konverteringens deler, som bare finnes i kunnskapsdatabasen.',
    });

    expect(estimate.reingest).toMatchObject({
      available: false,
      reason:
        'Innlesingen kudos deler opp etter konverteringens deler, som bare finnes i kunnskapsdatabasen.',
    });
  });

  it('re-ingests Kudos into another engine through the converter', async () => {
    const booted = await boot();
    const { call, platform } = booted;
    const id = 'digdir/kudos-ny';
    await createPlatformDataset(booted, id);
    const saved = await call(`${operatorBase(id)}/pipelines`, {
      as: 'drift',
      body: {
        id: 'kudos',
        name: 'Kudos',
        source: { kind: 'kudos', types: ['Tildelingsbrev'] },
        chunking: { minimumLength: 1 },
      },
    });
    expect(saved.status).toBe(201);
    expect(
      await json(await call(`${operatorBase(id)}/pipelines/kudos/estimate`, { as: 'drift' })),
    ).toMatchObject({ source: 'kudos', documents: 1, exact: true });

    const started = await call(`${operatorBase(id)}/engine-switches`, {
      as: 'drift',
      body: {
        to: 'lokal',
        method: 'reingest',
        embedding: { model: 'fake/embed', dimensions: 8 },
      },
    });
    expect(started.status).toBe(202);
    const ready = await settledAt(booted, id, (await json<EngineSwitchView>(started)).sid);
    expect(ready).toMatchObject({ state: 'ready', progress: { percent: 100 } });

    const route = platform.writers.openAt(
      id,
      'lokal',
      {
        signal: new AbortController().signal,
      },
      { embedding: { model: 'fake/embed', dimensions: 8 } },
    );
    const generation = await route.writer.active(route.dataset);
    expect(generation).toBeDefined();
    expect(await route.writer.stats(route.dataset, generation as string)).toMatchObject({
      documents: 1,
    });
    expect(writes).toEqual([]);
  });
});
