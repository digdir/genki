import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  knowledgeListingOf,
  pipelineSpec,
  type IngestSourceOptions,
  type PipelineSpec,
} from '@genai/ingest';
import {
  knowledgeFillQueue,
  knowledgeIndexQueue,
  knowledgeIngestQueue,
  knowledgeServerQueues,
  type Job,
  type JobData,
  type QueueWork,
} from '@genai/jobs';
import type { EmbeddingPort } from '@genai/port-embedding';
import type { DatasetConfig } from '@genai/port-knowledge';
import {
  attachGeneration,
  generationLockSpace,
  knowledgeRecordsOf,
  migrateKnowledgeServer,
  openKnowledgePools,
  partitionOf,
  prepareGeneration,
  setUpKnowledgeServer,
} from '@genai/providers-pgvector';
import { installJobQueue, PgBossJobQueue } from '@genai/providers-pgboss';
import {
  createPool,
  createPostgresStores,
  ingestSender,
  LocalKeyWrapper,
  PostgresJobRunRecords,
  workerRole,
} from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knowledgeWork } from './knowledge-handlers.js';

const ORG = '991825827';
const signal = new AbortController().signal;

let platformContainer: StartedPostgreSqlContainer;
let knowledgeContainer: StartedPostgreSqlContainer;
let platform: Awaited<ReturnType<typeof createPostgresStores>>;
let workerStores: Awaited<ReturnType<typeof createPostgresStores>>;
type Pool = ReturnType<typeof createPool>;
let admin: Pool;
let knowledgeServer: ReturnType<typeof openKnowledgePools>;
let knowledgeQueue: PgBossJobQueue;
let runRecords: PostgresJobRunRecords;
let folderRoot: string;

const owner = () => knowledgeServer.pools.owner as Pool;
const writer = () => knowledgeServer.pools.writer as Pool;

beforeAll(async () => {
  [platformContainer, knowledgeContainer] = await Promise.all([
    new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start(),
    new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start(),
  ]);
  const wrapper = new LocalKeyWrapper(randomBytes(32));
  platform = await createPostgresStores(
    { connectionString: platformContainer.getConnectionUri() },
    wrapper,
  );
  workerStores = await createPostgresStores(
    { connectionString: platformContainer.getConnectionUri() },
    wrapper,
    { role: workerRole },
  );
  admin = createPool({ connectionString: knowledgeContainer.getConnectionUri() });
  for (const login of ['knowledge_api', 'knowledge_worker'])
    await admin.query(`create role ${login} login password 'login-pw'`);
  await setUpKnowledgeServer(admin, {
    apiLogin: 'knowledge_api',
    workerLogin: 'knowledge_worker',
    platformId: '7f3c0d4e-1b2a-4c5d-8e9f-0a1b2c3d4e5f',
  });
  knowledgeServer = openKnowledgePools(
    {
      host: knowledgeContainer.getHost(),
      port: knowledgeContainer.getPort(),
      database: knowledgeContainer.getDatabase(),
      user: 'knowledge_worker',
      password: 'login-pw',
    },
    'worker',
  );
  await migrateKnowledgeServer(owner());
  await installJobQueue(owner(), knowledgeServerQueues(60_000), {
    worker: 'genai_knowledge_writer',
  });
  knowledgeQueue = await PgBossJobQueue.start(writer(), { works: false });
  runRecords = new PostgresJobRunRecords(
    workerStores.runtimePool,
    ingestSender({ send: async () => null }),
  );
  folderRoot = await mkdtemp(join(tmpdir(), 'knowledge-handlers-'));
}, 240_000);

afterAll(async () => {
  await knowledgeQueue?.stop();
  await knowledgeServer?.close();
  await admin?.end();
  for (const db of [platform, workerStores]) {
    await db?.close();
    await db?.runtimePool.end();
    await db?.pool.end();
  }
  await stopPostgres(platformContainer);
  await stopPostgres(knowledgeContainer);
});

let datasets = 0;

/** A dataset on the knowledge database with an attached generation, a folder and its pipeline. */
const scenario = async (
  source: Record<string, unknown> = {},
  sourceOptions?: IngestSourceOptions,
  extra: {
    /** The embedding the generation is built with; the catalog's dataset may name another. */
    builtWith?: DatasetConfig['embedding'];
    catalogEmbedding?: DatasetConfig['embedding'];
    embedded?: string[];
    bound?: () => void;
    /** `knowledge.heavyThreshold` and `knowledge.nightWindow` as the worker reads them. */
    heavy?: { threshold: number; window: string; now?: Date };
  } = {},
) => {
  datasets += 1;
  const dataset: DatasetConfig = {
    id: `${ORG}/docs-${datasets}`,
    filters: {},
    options: {},
    generation: `g-handlers-${datasets}`,
    ...(extra.catalogEmbedding ? { embedding: extra.catalogEmbedding } : {}),
  };
  const built = { ...dataset, ...(extra.builtWith ? { embedding: extra.builtWith } : {}) };
  await prepareGeneration(owner(), built, dataset.generation as string);
  await attachGeneration(owner(), built, dataset.generation as string);
  const folder = `docs-${datasets}`;
  await mkdir(join(folderRoot, folder));
  const spec = pipelineSpec.parse({
    name: 'Docs',
    source: source.kind ? source : { kind: 'folder', path: folder, ...source },
    chunking: { minimumLength: 1 },
  });
  const sent: Record<string, string>[] = [];
  const sentTo: { queue: string; data: Record<string, string>; startAfter?: Date }[] = [];
  const sentAgain: { queue: string; data: Record<string, string>; startAfter: Date }[] = [];
  const failing = { load: false };
  const work = knowledgeWork({
    records: knowledgeRecordsOf(writer()),
    knowledge: {
      send: async (queue, data, options) => {
        sent.push(data as Record<string, string>);
        sentTo.push({
          queue: queue.name,
          data: data as Record<string, string>,
          ...(options?.startAfter ? { startAfter: options.startAfter } : {}),
        });
        return knowledgeQueue.send(queue, data, options);
      },
      sendAgain: async (queue, j, options) => {
        sentAgain.push({
          queue: queue.name,
          data: j.data as Record<string, string>,
          startAfter: options.startAfter,
        });
      },
    },
    heavy: {
      threshold: () => extra.heavy?.threshold ?? 100_000,
      window: () => extra.heavy?.window ?? '01:00-06:00',
      ...(extra.heavy?.now ? { now: () => extra.heavy?.now as Date } : {}),
    },
    runs: runRecords,
    pipeline: async () => spec,
    dataset: (id) => (id === dataset.id ? dataset : undefined),
    listingOf: async (pipeline: PipelineSpec, scope, s) => {
      const listing = await knowledgeListingOf(pipeline, sourceOptions ?? { folderRoot }, scope, s);
      return {
        ...listing,
        load: (record) =>
          failing.load
            ? Promise.reject(new Error('the file share went away'))
            : listing.load(record),
      };
    },
    embedder: (d) => {
      if (!d.embedding) return undefined;
      const { model, dimensions } = d.embedding;
      return {
        info: () => ({ id: model, dimensions }),
        embed: async (texts: string[]) => {
          extra.embedded?.push(model);
          return { vectors: texts.map(() => Array.from({ length: dimensions }, () => 0.5)) };
        },
      } as unknown as EmbeddingPort;
    },
    ...(extra.bound ? { bound: extra.bound } : {}),
    admission: { records: runRecords, platformTenant: ORG, lockdown: false },
  });
  const file = (name: string, text: string) => writeFile(join(folderRoot, folder, name), text);
  return {
    dataset,
    generation: dataset.generation as string,
    work,
    sent,
    sentTo,
    sentAgain,
    file,
    failing,
  };
};

const startRun = async (dataset: string) => {
  const id = crypto.randomUUID();
  await platform.pool.query(
    `insert into ingestion_executions (id, scope, dataset, pipeline, pipeline_version, backend,
       status, started_by, started_at, runs_as_jobs, admitted_at)
     values ($1, $2, $3, 'docs', 1, 'index-writer', 'running', 'test', $4, true, $4)`,
    [id, ORG, dataset, new Date().toISOString()],
  );
  return id;
};

const job = <T extends JobData>(queue: string, data: T): Job<T> => ({
  id: crypto.randomUUID(),
  queue,
  data,
  retryCount: 0,
  signal,
});

const handler = (work: QueueWork[], queue: string) => {
  const found = work.find((w) => w.queue.name === queue);
  if (!found) throw new Error(`no handler for ${queue}`);
  return found.handler;
};

/** Runs a run as the worker would: its ingest job, then each index job it sent. */
const runOnce = async (s: Awaited<ReturnType<typeof scenario>>) => {
  const run = await startRun(s.dataset.id);
  const before = s.sent.length;
  await handler(
    s.work.platform,
    knowledgeIngestQueue.name,
  )(job(knowledgeIngestQueue.name, { run, tenant: ORG }));
  for (const data of s.sent.slice(before))
    await handler(s.work.knowledge, knowledgeIndexQueue.name)(job(knowledgeIndexQueue.name, data));
  // Its jobs have ended, so the reconciler would end it now.
  const record = await runRecords.find(run);
  if (record)
    await runRecords.end(
      record,
      { status: 'succeeded', report: { failedDocuments: 0 } },
      new Date().toISOString(),
      { expiredError: 'expired' },
    );
  return { run, sent: s.sent.slice(before) };
};

const reportOf = async (run: string) =>
  (
    await platform.pool.query<{ report: Record<string, unknown> }>(
      `select report from ingestion_executions where id = $1`,
      [run],
    )
  ).rows[0]?.report;

const docsIn = async (generation: string) =>
  (
    await admin.query<{ id: string; title: string | null }>(
      `select id, title from ${partitionOf('kn_docs', generation)} order by id`,
    )
  ).rows;

const chunkTexts = async (generation: string) =>
  (
    await admin.query<{ text: string }>(
      `select text from ${partitionOf('kn_chunks', generation)} order by text`,
    )
  ).rows.map((r) => r.text);

const versions = async (dataset: string, generation: string) => {
  const { rows } = await admin.query<{ data_version: string; last_change: string }>(
    `select g.data_version::text, c.last_change::text
       from kn_generations g join src_changes c on c.dataset = g.dataset
      where g.generation = $1 and g.dataset = $2`,
    [generation, dataset],
  );
  return rows[0];
};

const ingestOnly = async (s: Awaited<ReturnType<typeof scenario>>) => {
  const run = await startRun(s.dataset.id);
  const before = s.sent.length;
  await handler(
    s.work.platform,
    knowledgeIngestQueue.name,
  )(job(knowledgeIngestQueue.name, { run, tenant: ORG }));
  return { run, sent: s.sent.slice(before) };
};

describe('heavy work and the VACUUM lock', () => {
  it("a writer that cannot get its generation's lock is sent again later", async () => {
    const s = await scenario();
    await s.file('a.md', '# A\n\nInnhold i a.');
    const { sent } = await ingestOnly(s);
    const vacuum = await owner().connect();
    await vacuum.query(`select pg_advisory_lock($1::int, hashtext($2))`, [
      generationLockSpace,
      s.generation,
    ]);
    const before = Date.now();
    try {
      await handler(
        s.work.knowledge,
        knowledgeIndexQueue.name,
      )(job(knowledgeIndexQueue.name, sent[0] as Record<string, string>));
    } finally {
      await vacuum.query(`select pg_advisory_unlock_all()`);
      vacuum.release();
    }
    expect(s.sentAgain).toHaveLength(1);
    expect(s.sentAgain[0]?.queue).toBe('knowledge.index');
    const wait = (s.sentAgain[0]?.startAfter.getTime() ?? 0) - before;
    expect(wait).toBeGreaterThanOrEqual(110_000);
    expect(wait).toBeLessThanOrEqual(130_000);
    expect(await docsIn(s.generation)).toEqual([]);
    const { rows } = await admin.query(`select state from src_documents where dataset = $1`, [
      s.dataset.id,
    ]);
    expect(rows[0]?.state).toBeNull();
  }, 60_000);

  it("a run's index jobs become fill jobs once it has written the heavy threshold", async () => {
    // Tuesday 3 November 2026 at 14:00 in Oslo: the next window starts at 01:00, 00:00 UTC.
    const s = await scenario({}, undefined, {
      heavy: { threshold: 2, window: '01:00-06:00', now: new Date('2026-11-03T13:00:00Z') },
    });
    for (const name of ['a', 'b', 'c'])
      await s.file(`${name}.md`, `# ${name}\n\nInnhold i ${name}.`);
    const { run, sent } = await ingestOnly(s);
    const index = handler(s.work.knowledge, knowledgeIndexQueue.name);
    for (const data of sent) await index(job(knowledgeIndexQueue.name, data));
    expect(await reportOf(run)).toMatchObject({ stored: 2, chunks: 2 });
    const fills = s.sentTo.filter((x) => x.queue === 'knowledge.fill');
    expect(fills).toEqual([
      { queue: 'knowledge.fill', data: sent[2], startAfter: new Date('2026-11-04T00:00:00Z') },
    ]);
    expect(await docsIn(s.generation)).toHaveLength(2);
    await handler(
      s.work.heavy,
      knowledgeFillQueue.name,
    )(job(knowledgeFillQueue.name, fills[0]?.data as Record<string, string>));
    expect(await docsIn(s.generation)).toHaveLength(3);
    expect(await reportOf(run)).toMatchObject({ stored: 3, chunks: 3 });
  }, 60_000);
});

describe('knowledge.ingest and knowledge.index', () => {
  it("a folder pipeline run twice with one file changed writes one document, reports 1 changed, and its generation's data version equals the dataset's last change", async () => {
    const s = await scenario();
    await s.file('a.md', '# A\n\nFørste versjon av a.');
    await s.file('b.md', '# B\n\nInnhold i b.');
    const first = await runOnce(s);
    expect(first.sent).toHaveLength(2);
    expect(await docsIn(s.generation)).toHaveLength(2);

    await s.file('a.md', '# A\n\nAndre versjon av a.');
    const second = await runOnce(s);
    expect(second.sent).toHaveLength(1);
    expect(await reportOf(second.run)).toMatchObject({ changed: 1, unchanged: 1, stored: 1 });
    expect((await chunkTexts(s.generation)).join(' ')).toContain('Andre versjon av a.');
    expect((await chunkTexts(s.generation)).join(' ')).not.toContain('Første versjon');
    const v = await versions(s.dataset.id, s.generation);
    expect(v?.data_version).toBe(v?.last_change);
    expect(v?.last_change).toBe('3');
  }, 60_000);

  it("a run's report counts new, changed, deleted, unchanged, stored, skipped and failed documents", async () => {
    const s = await scenario();
    await s.file('a.md', '# A\n\nInnhold i a.');
    await s.file('tom.md', '   ');
    await s.file('borte.md', '# Borte\n\nSnart borte.');
    const first = await runOnce(s);
    expect(await reportOf(first.run)).toMatchObject({
      new: 3,
      changed: 0,
      deleted: 0,
      unchanged: 0,
      stored: 2,
      skipped: 1,
      failed: [],
    });
    const { rm } = await import('node:fs/promises');
    await rm(join(folderRoot, `docs-${datasets}`, 'borte.md'));
    await runOnce(s);
    const third = await runOnce(s);
    expect(await reportOf(third.run)).toMatchObject({ deleted: 1, unchanged: 2 });
    expect((await docsIn(s.generation)).map((d) => d.title)).toEqual(['A']);
  }, 60_000);

  it('a handler run twice leaves the same result (knowledge.ingest and knowledge.index)', async () => {
    const s = await scenario();
    await s.file('a.md', '# A\n\nInnhold i a.');
    const run = await startRun(s.dataset.id);
    const ingest = handler(s.work.platform, knowledgeIngestQueue.name);
    await ingest(job(knowledgeIngestQueue.name, { run, tenant: ORG }));
    await ingest(job(knowledgeIngestQueue.name, { run, tenant: ORG }));
    const { rows: queued } = await admin.query(
      `select id from pgboss.job where name = 'knowledge.index' and data ->> 'run' = $1`,
      [run],
    );
    expect(queued).toHaveLength(1);
    const index = handler(s.work.knowledge, knowledgeIndexQueue.name);
    const data = s.sent.at(-1) as Record<string, string>;
    await index(job(knowledgeIndexQueue.name, data));
    const once = { docs: await docsIn(s.generation), chunks: await chunkTexts(s.generation) };
    await index(job(knowledgeIndexQueue.name, data));
    expect({ docs: await docsIn(s.generation), chunks: await chunkTexts(s.generation) }).toEqual(
      once,
    );
    const v = await versions(s.dataset.id, s.generation);
    expect(v?.data_version).toBe('1');
    expect(v?.last_change).toBe('1');
  }, 60_000);

  it("an index job names its document by the record's number, never its source id", async () => {
    const s = await scenario();
    await s.file('personnavn-ola-nordmann.md', '# Søknad\n\nInnhold.');
    const { sent } = await runOnce(s);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0] ?? {}).sort()).toEqual(['generation', 'record', 'run', 'tenant']);
    expect(sent[0]?.record).toMatch(/^\d+$/);
    expect(JSON.stringify(sent)).not.toContain('ola-nordmann');
  }, 60_000);
  it('a crawled page is deleted after a 404 or 410 seen twice', async () => {
    const pages: Record<string, string> = {
      'https://www.example.no/sitemap.xml':
        '<urlset><url><loc>https://www.example.no/side.md</loc><lastmod>2026-10-30</lastmod></url></urlset>',
      'https://www.example.no/side.md': '# Side\n\nInnhold.',
    };
    const s = await scenario(
      { kind: 'website', sitemap: 'https://www.example.no/sitemap.xml' },
      {
        web: {
          resolve: async () => ['93.184.216.34'],
          fetch: (async (url: string | URL | Request) => {
            const body = pages[String(url)];
            return body === undefined ? new Response('', { status: 404 }) : new Response(body);
          }) as typeof fetch,
        },
      },
    );
    await runOnce(s);
    expect(await docsIn(s.generation)).toHaveLength(1);
    delete pages['https://www.example.no/side.md'];
    const record = s.sent[0] as Record<string, string>;
    const index = handler(s.work.knowledge, knowledgeIndexQueue.name);
    const indexAgain = async () => {
      const run = await startRun(s.dataset.id);
      await index(job(knowledgeIndexQueue.name, { ...record, run }));
      const ended = await runRecords.find(run);
      if (ended)
        await runRecords.end(ended, { status: 'succeeded' }, new Date().toISOString(), {
          expiredError: 'expired',
        });
    };
    await indexAgain();
    expect(await docsIn(s.generation)).toHaveLength(1);
    await indexAgain();
    expect(await docsIn(s.generation)).toEqual([]);
    const { rows } = await admin.query(`select id_hash from src_tombstones where dataset = $1`, [
      s.dataset.id,
    ]);
    expect(rows).toHaveLength(1);
  }, 60_000);
  it('a failed index job keeps what its generation held and leaves the data version below its change', async () => {
    const s = await scenario();
    await s.file('a.md', '# A\n\nFørste versjon.');
    await s.file('b.md', '# B\n\nInnhold i b.');
    await runOnce(s);
    await s.file('a.md', '# A\n\nAndre versjon.');
    s.failing.load = true;
    const run = await startRun(s.dataset.id);
    await handler(
      s.work.platform,
      knowledgeIngestQueue.name,
    )(job(knowledgeIngestQueue.name, { run, tenant: ORG }));
    const data = s.sent.at(-1) as Record<string, string>;
    await expect(
      handler(s.work.knowledge, knowledgeIndexQueue.name)(job(knowledgeIndexQueue.name, data)),
    ).rejects.toThrow('the file share went away');
    expect((await chunkTexts(s.generation)).join(' ')).toContain('Første versjon.');
    const { rows } = await admin.query<{ state: string; reason: string }>(
      `select state, reason from src_documents where number = $1::bigint`,
      [data.record],
    );
    expect(rows[0]).toEqual({ state: 'failed', reason: 'Error' });
    const v = await versions(s.dataset.id, s.generation);
    expect(v).toEqual({ data_version: '2', last_change: '3' });
    const ended = await runRecords.find(run);
    if (ended)
      await runRecords.end(ended, { status: 'succeeded' }, new Date().toISOString(), {
        expiredError: 'expired',
      });
  }, 60_000);

  it("the next run writes a failed document again without a source change, and the data version reaches the dataset's last change", async () => {
    const s = await scenario();
    await s.file('a.md', '# A\n\nFørste versjon.');
    await runOnce(s);
    await s.file('a.md', '# A\n\nAndre versjon.');
    s.failing.load = true;
    await expect(runOnce(s)).rejects.toThrow('the file share went away');
    await platform.pool.query(
      `update ingestion_executions set status = 'succeeded', ended_at = $2
        where dataset = $1 and status = 'running'`,
      [s.dataset.id, new Date().toISOString()],
    );
    s.failing.load = false;
    const retry = await runOnce(s);
    expect(retry.sent).toHaveLength(1);
    expect(await reportOf(retry.run)).toMatchObject({ changed: 0, unchanged: 1, stored: 1 });
    expect((await chunkTexts(s.generation)).join(' ')).toContain('Andre versjon.');
    const v = await versions(s.dataset.id, s.generation);
    expect(v?.data_version).toBe(v?.last_change);
  }, 60_000);
  it("a redelivered ingest job keeps the run's first counts", async () => {
    const s = await scenario();
    await s.file('a.md', '# A\n\nInnhold i a.');
    const run = await startRun(s.dataset.id);
    const ingest = handler(s.work.platform, knowledgeIngestQueue.name);
    await ingest(job(knowledgeIngestQueue.name, { run, tenant: ORG }));
    const data = s.sent.at(-1) as Record<string, string>;
    await handler(s.work.knowledge, knowledgeIndexQueue.name)(job(knowledgeIndexQueue.name, data));
    await ingest(job(knowledgeIngestQueue.name, { run, tenant: ORG }));
    expect(await reportOf(run)).toMatchObject({ new: 1, unchanged: 0, stored: 1 });
  }, 60_000);

  it("index jobs embed with the generation's embedding model, not the catalog's", async () => {
    const embedded: string[] = [];
    const s = await scenario({}, undefined, {
      builtWith: { model: 'fake/old', dimensions: 3 },
      catalogEmbedding: { model: 'fake/new', dimensions: 3 },
      embedded,
    });
    await s.file('a.md', '# A\n\nInnhold i a.');
    await runOnce(s);
    expect(embedded.length).toBeGreaterThan(0);
    expect(new Set(embedded)).toEqual(new Set(['fake/old']));
  }, 60_000);

  it('an index job refuses a record of another dataset', async () => {
    const mine = await scenario();
    const other = await scenario();
    await other.file('b.md', '# B\n\nInnhold i b.');
    await runOnce(other);
    const foreign = other.sent.at(-1) as Record<string, string>;
    const run = await startRun(mine.dataset.id);
    await expect(
      handler(
        mine.work.knowledge,
        knowledgeIndexQueue.name,
      )(job(knowledgeIndexQueue.name, { ...foreign, run })),
    ).rejects.toThrow(`is not a record of ${mine.dataset.id}`);
  }, 60_000);

  it('a knowledge job does nothing while the knowledge server is bound to another platform server', async () => {
    const s = await scenario({}, undefined, {
      bound: () => {
        throw new Error('the knowledge server is bound to another platform server');
      },
    });
    await s.file('a.md', '# A\n\nInnhold i a.');
    const run = await startRun(s.dataset.id);
    await expect(
      handler(
        s.work.platform,
        knowledgeIngestQueue.name,
      )(job(knowledgeIngestQueue.name, { run, tenant: ORG })),
    ).rejects.toThrow('bound to another platform server');
    expect(s.sent).toEqual([]);
    const { rows } = await admin.query(`select 1 from src_documents where dataset = $1`, [
      s.dataset.id,
    ]);
    expect(rows).toEqual([]);
  }, 60_000);
});
