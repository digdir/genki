import { randomBytes } from 'node:crypto';
import { configuredCredentialScope, openKnowledgePools } from '@genai/composition';
import {
  admitPayload,
  JobQueueError,
  knowledgeIndexQueue,
  knowledgeIngestQueue,
  knowledgeKeys,
  knowledgePlatformQueues,
  knowledgeServerQueues,
  type JobQueue,
  type QueueDefinition,
} from '@genai/jobs';
import {
  installJobQueue,
  openJobQueue,
  PgBossJobQueue,
  PgBossRunJobs,
} from '@genai/providers-pgboss';
import {
  createPostgresStores,
  ingestSender,
  ingestStillEndingMessage,
  LocalKeyWrapper,
  PostgresJobRunRecords,
  PostgresJobRuns,
  runtimeRole,
  workerRole,
} from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admissionRanOutMessage,
  admittedWork,
  expiredQueuedRunMessage,
  knowledgeReaderRole,
  knowledgeWriterRole,
  notAdmittedMessage,
  openWorkerJobs,
  type WorkerJobs,
} from './knowledge-jobs.js';
import {
  failureBudgetMessage,
  listingFailedMessage,
  reconcileKnowledgeRuns,
} from './reconciler.js';

const ORG = '991825827';
const OTHER_ORG = '889640782';
const markerTimeoutMs = 6 * 60 * 60 * 1000;
const hour = 3_600_000;

let container: StartedPostgreSqlContainer;
let api: Awaited<ReturnType<typeof createPostgresStores>>;
let worker: Awaited<ReturnType<typeof createPostgresStores>>;
let jobs: WorkerJobs;
let apiQueue: PgBossJobQueue;
let apiRuns: PostgresJobRuns;
let records: PostgresJobRunRecords;
type Pool = NonNullable<ReturnType<typeof openKnowledgePools>['pools']['owner']>;
let knowledgeServer: ReturnType<typeof openKnowledgePools>;
const knowledgeOwner = () => knowledgeServer.pools.owner as Pool;
const knowledgeWriter = () => knowledgeServer.pools.writer as Pool;
const knowledgeDb = knowledgeOwner;

/** The same contracts with no retries, so a failing handler's job is a dead letter at once. */
const withoutRetries = (queues: QueueDefinition[]) =>
  queues.map((queue) => ({ ...queue, retryLimit: 0 }));

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  const wrapper = new LocalKeyWrapper(randomBytes(32));
  api = await createPostgresStores({ connectionString: container.getConnectionUri() }, wrapper);
  worker = await createPostgresStores({ connectionString: container.getConnectionUri() }, wrapper, {
    role: workerRole,
  });
  await api.pool.query('create database knowledge');
  for (const role of ['genai_knowledge_owner', knowledgeWriterRole, knowledgeReaderRole])
    await api.pool.query(`create role ${role} nologin nosuperuser nobypassrls`);
  await api.pool.query('grant create on database knowledge to genai_knowledge_owner');
  knowledgeServer = openKnowledgePools(
    { connectionString: container.getConnectionUri().replace(/\/[^/]+$/, '/knowledge') },
    'worker',
  );
  jobs = await openWorkerJobs({
    platform: { owner: worker.pool, worker: worker.runtimePool },
    knowledge: { owner: knowledgeOwner(), writer: knowledgeWriter() },
    markerTimeoutMs,
    work: [],
    open: openJobQueue,
    runJobs: (pool, queue, queues) => new PgBossRunJobs(pool, queue, queues),
    log: () => undefined,
  });
  // Only retries change here: the API's right to send comes from openWorkerJobs alone.
  await installJobQueue(worker.pool, withoutRetries(knowledgePlatformQueues), {
    worker: workerRole,
  });
  await installJobQueue(knowledgeOwner(), withoutRetries(knowledgeServerQueues(markerTimeoutMs)), {
    worker: knowledgeWriterRole,
    readers: [knowledgeReaderRole],
  });
  apiQueue = await PgBossJobQueue.start(api.runtimePool, { works: false });
  apiRuns = new PostgresJobRuns(api.runtimePool, ingestSender(apiQueue));
  records = new PostgresJobRunRecords(worker.runtimePool, ingestSender(jobs.platform));
}, 240_000);

afterAll(async () => {
  await apiQueue?.stop();
  await jobs?.platform.stop();
  await jobs?.knowledge?.stop();
  await knowledgeServer?.close();
  for (const db of [api, worker]) {
    await db?.close();
    await db?.runtimePool.end();
    await db?.pool.end();
  }
  await stopPostgres(container);
});

const knowledge = () => {
  if (!jobs.knowledge) throw new Error('no knowledge server');
  return jobs.knowledge;
};

let pipelines = 0;
const pipeline = () => ({ dataset: `${ORG}/kudos-${(pipelines += 1)}`, pipeline: 'kudos' });

const start = async (
  at: { dataset: string; pipeline: string },
  admittedAt = new Date().toISOString(),
) => {
  const started = await apiRuns.start({
    id: crypto.randomUUID(),
    ...at,
    pipelineVersion: 1,
    backend: 'index-writer',
    startedBy: 'employee:test:kari',
    startedAt: new Date().toISOString(),
    admittedAt,
  });
  if (!started.ok) throw new Error(started.message);
  return started.value;
};

const insertRun = async (
  at: { dataset: string; pipeline: string },
  fields: { status: string; admittedAt: string | null },
) => {
  const id = crypto.randomUUID();
  await api.pool.query(
    `insert into ingestion_executions (id, scope, dataset, pipeline, pipeline_version, backend,
       status, started_by, started_at, runs_as_jobs, admitted_at)
     values ($1, $2, $3, $4, 1, 'index-writer', $5, 'test', $6, true, $7)`,
    [id, ORG, at.dataset, at.pipeline, fields.status, new Date().toISOString(), fields.admittedAt],
  );
  return id;
};

const run = async (id: string) => {
  const { rows } = await api.pool.query<{
    status: string;
    error: string | null;
    report: { failedDocuments?: number } | null;
    admitted_at: string | null;
  }>(`select status, error, report, admitted_at from ingestion_executions where id = $1`, [id]);
  return rows[0];
};

const jobStates = async (pool: Pool, id: string, queue: string) => {
  const { rows } = await pool.query<{ state: string }>(
    `select state from pgboss.job where name = $1 and data ->> 'run' = $2 order by created_on`,
    [queue, id],
  );
  return rows.map((row) => row.state);
};

const platformStates = (id: string, queue = 'knowledge.ingest') => jobStates(api.pool, id, queue);
const knowledgeStates = (id: string, queue = 'knowledge.index') =>
  jobStates(knowledgeDb(), id, queue);

const reconcile = (options: { lockdown?: boolean; now?: Date } = {}) =>
  reconcileKnowledgeRuns({
    records,
    servers: jobs.runJobs,
    lockdown: options.lockdown ?? false,
    ...(options.now ? { now: () => options.now as Date } : {}),
  });

const sendIndex = (id: string, record = 'r-1', tenant = ORG) =>
  knowledge().send(
    knowledgeIndexQueue,
    { run: id, tenant, generation: 'g-1', record: `${id}-${record}` },
    { key: knowledgeKeys.index('g-1', `${id}-${record}`) },
  );

const work = async <T extends { run: string }>(
  queue: JobQueue,
  definition: QueueDefinition<T & Record<string, string>>,
  handler: Parameters<typeof admittedWork<T & Record<string, string>>>[1],
  lockdown = false,
) => {
  const entry = admittedWork(definition, handler, {
    records,
    platformTenant: ORG,
    lockdown,
  });
  return queue.work(entry.queue, (job) => entry.handler(job));
};

describe('the worker and the knowledge queues', () => {
  it('the worker installs the knowledge queues on both servers and works none of them', async () => {
    const names = async (pool: Pool) =>
      (
        await pool.query<{ name: string }>(
          `select name from pgboss.queue where name like 'knowledge.%' and name not like '%.dead'
            order by name`,
        )
      ).rows.map((row) => row.name);
    expect(await names(api.pool)).toEqual([
      'knowledge.activate',
      'knowledge.drop',
      'knowledge.ingest',
      'knowledge.push',
    ]);
    expect(await names(knowledgeDb())).toEqual([
      'knowledge.build',
      'knowledge.check',
      'knowledge.cleanup',
      'knowledge.convert',
      'knowledge.export',
      'knowledge.fill',
      'knowledge.index',
      'knowledge.seed',
    ]);
    const id = crypto.randomUUID();
    await sendIndex(id);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await knowledgeStates(id)).toEqual(['created']);
    await knowledge().cancel(knowledgeIndexQueue, (await jobIds(id))[0] ?? '');
  }, 90_000);

  it('the worker cannot admit a run', async () => {
    const at = pipeline();
    const id = await insertRun(at, { status: 'running', admittedAt: null });
    const asWorker = async (sql: string, values: unknown[]) => {
      const client = await worker.runtimePool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant', $1, true)`, [ORG]);
        return await client.query(sql, values);
      } finally {
        await client.query('rollback');
        client.release();
      }
    };
    await expect(
      asWorker(`update ingestion_executions set admitted_at = $2 where id = $1`, [
        id,
        new Date().toISOString(),
      ]),
    ).rejects.toThrow(/only the API admits/);
    expect(
      (await asWorker(`update ingestion_executions set error = 'checked' where id = $1`, [id]))
        .rowCount,
    ).toBe(1);
    const client = await worker.runtimePool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant', $1, true)`, [ORG]);
      await expect(
        client.query(
          `insert into ingestion_executions (id, scope, dataset, pipeline, pipeline_version, backend,
             status, started_by, started_at, runs_as_jobs, admitted_at)
           values ($1, $2, $3, 'other', 1, 'x', 'running', 'worker', '2026-11-02T00:00:00Z', true,
             '2026-11-02T00:00:00Z')`,
          [crypto.randomUUID(), ORG, at.dataset],
        ),
      ).rejects.toThrow(/only the API admits/);
      await client.query('rollback');
    } finally {
      client.release();
    }
    expect((await run(id))?.admitted_at).toBeNull();
  });

  it('only the API sets the generation and the switch a run names', async () => {
    const at = pipeline();
    const started = await apiRuns.start({
      id: crypto.randomUUID(),
      ...at,
      pipelineVersion: 1,
      backend: 'index-writer',
      startedBy: 'employee:test:kari',
      startedAt: new Date().toISOString(),
      admittedAt: new Date().toISOString(),
      generation: 'g-20261104-7f3c2a',
      engineSwitch: 'kudos-1:1',
    });
    if (!started.ok) throw new Error(started.message);
    expect(started.value).toMatchObject({
      generation: 'g-20261104-7f3c2a',
      engineSwitch: 'kudos-1:1',
    });
    expect(await records.find(started.value.id)).toMatchObject({
      generation: 'g-20261104-7f3c2a',
      engineSwitch: 'kudos-1:1',
    });
    const asWorker = async (sql: string, values: unknown[]) => {
      const client = await worker.runtimePool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant', $1, true)`, [ORG]);
        return await client.query(sql, values);
      } finally {
        await client.query('rollback');
        client.release();
      }
    };
    await expect(
      asWorker(`update ingestion_executions set generation = 'g-20261104-000000' where id = $1`, [
        started.value.id,
      ]),
    ).rejects.toThrow(/only the API names/);
    await expect(
      asWorker(`update ingestion_executions set engine_switch = 'other:1' where id = $1`, [
        started.value.id,
      ]),
    ).rejects.toThrow(/only the API names/);
    await expect(
      asWorker(
        `insert into ingestion_executions (id, scope, dataset, pipeline, pipeline_version, backend,
           status, started_by, started_at, runs_as_jobs, generation)
         values ($1, $2, $3, 'other', 1, 'x', 'queued', 'worker', '2026-11-02T00:00:00Z', true,
           'g-20261104-000000')`,
        [crypto.randomUUID(), ORG, at.dataset],
      ),
    ).rejects.toThrow(/only the API names/);
  });

  it("the end of a run starts its pipeline's queued run", async () => {
    const at = pipeline();
    const first = await start(at);
    const second = await start(at);
    expect(second.status).toBe('queued');
    const stop = await work(jobs.platform, knowledgeIngestQueue, async () => undefined);
    await expect.poll(() => platformStates(first.id), { timeout: 20_000 }).toEqual(['completed']);
    await stop();
    const ended = await records.end(first, { status: 'succeeded' }, new Date().toISOString(), {
      expiredError: 'expired',
    });
    expect(ended.ended?.id).toBe(first.id);
    expect(ended.started?.id).toBe(second.id);
    expect(await run(first.id)).toMatchObject({ status: 'succeeded' });
    expect(await run(second.id)).toMatchObject({ status: 'running' });
    expect(await platformStates(second.id)).toEqual(['created']);
  }, 90_000);

  it('the reconciler starts a queued run whose pipeline has no open run, and leaves a run waiting for approval alone', async () => {
    const queued = await insertRun(pipeline(), {
      status: 'queued',
      admittedAt: new Date().toISOString(),
    });
    const waiting = await insertRun(pipeline(), {
      status: 'waiting',
      admittedAt: new Date().toISOString(),
    });
    await reconcile();
    expect(await run(queued)).toMatchObject({ status: 'running' });
    expect(await platformStates(queued)).toEqual(['created']);
    expect(await run(waiting)).toMatchObject({ status: 'waiting' });
  });

  it('a run whose last handler died is ended by the reconciler', async () => {
    const started = await start(pipeline());
    const ingest = await work(jobs.platform, knowledgeIngestQueue, async ({ run: r }) => {
      await sendIndex(r.id);
    });
    const index = await work(knowledge(), knowledgeIndexQueue, async () => {
      throw new Error('the embedding host went away mid-document');
    });
    await expect
      .poll(() => knowledgeStates(started.id, 'knowledge.index.dead'), { timeout: 30_000 })
      .toEqual(['created']);
    await ingest();
    await index();
    await expect.poll(() => platformStates(started.id), { timeout: 20_000 }).toEqual(['completed']);
    expect(await run(started.id)).toMatchObject({ status: 'running' });
    await reconcile();
    expect(await run(started.id)).toMatchObject({
      status: 'succeeded',
      report: { failedDocuments: 1 },
    });
  }, 90_000);

  it('a run fails only when its ingest job is a dead letter, and counts its failed documents', async () => {
    const started = await start(pipeline());
    await sendIndex(started.id);
    const index = await work(knowledge(), knowledgeIndexQueue, async () => {
      throw new Error('the embedding host went away');
    });
    const ingest = await work(jobs.platform, knowledgeIngestQueue, async () => {
      throw new Error('Kudos answered 503 on page 412');
    });
    await expect
      .poll(() => platformStates(started.id, 'knowledge.ingest.dead'), { timeout: 30_000 })
      .toEqual(['created']);
    await expect
      .poll(() => knowledgeStates(started.id, 'knowledge.index.dead'), { timeout: 30_000 })
      .toEqual(['created']);
    await ingest();
    await index();
    await reconcile();
    expect(await run(started.id)).toMatchObject({
      status: 'failed',
      error: listingFailedMessage,
      report: { failedDocuments: 1 },
    });
  }, 90_000);

  it('a run over its failure budget stops and keeps the documents it replaced', async () => {
    const started = await start(pipeline());
    await sendIndex(started.id, 'r-1');
    await sendIndex(started.id, 'r-2');
    await sendIndex(started.id, 'r-3');
    const replaced: string[] = [];
    const index = await work(knowledge(), knowledgeIndexQueue, async ({ job }) => {
      if (job.data.record.endsWith('r-3')) {
        replaced.push(job.data.record);
        return;
      }
      throw new Error('the text layer could not be read');
    });
    await expect
      .poll(async () => (await knowledgeStates(started.id, 'knowledge.index.dead')).length, {
        timeout: 30_000,
      })
      .toBe(2);
    await expect.poll(() => replaced.length, { timeout: 30_000 }).toBe(1);
    await index();
    await sendIndex(started.id, 'r-4');
    const budget = async () => 2;
    await reconcileKnowledgeRuns({
      records,
      servers: jobs.runJobs,
      lockdown: false,
      failureBudget: budget,
    });
    expect(await run(started.id)).toMatchObject({
      status: 'cancelled',
      error: failureBudgetMessage(2),
      report: { failedDocuments: 2 },
    });
    expect(replaced).toEqual([`${started.id}-r-3`]);
    expect(await knowledgeStates(started.id, 'knowledge.index')).toEqual(
      expect.arrayContaining(['cancelled']),
    );
  }, 90_000);

  it('the reconciler drops the jobs of a finished run', async () => {
    const started = await start(pipeline());
    await sendIndex(started.id);
    const gone = crypto.randomUUID();
    await sendIndex(gone);
    await records.end(
      started,
      { status: 'failed', error: 'ended by hand' },
      new Date().toISOString(),
      { expiredError: 'expired' },
    );
    await reconcile();
    expect(await knowledgeStates(started.id)).toEqual(['cancelled']);
    expect(await platformStates(started.id)).toEqual(['cancelled']);
    expect(await knowledgeStates(gone)).toEqual(['cancelled']);
  });

  it('cancelling a run cancels its queued jobs', async () => {
    const at = pipeline();
    const started = await start(at);
    await sendIndex(started.id, 'r-1');
    await sendIndex(started.id, 'r-2');
    const cancelled = await apiRuns.cancel({
      dataset: at.dataset,
      execution: started.id,
      by: 'employee:test:kari',
      at: new Date().toISOString(),
    });
    expect(cancelled).toMatchObject({ status: 'running', cancelledBy: 'employee:test:kari' });
    await reconcile();
    expect(await knowledgeStates(started.id)).toEqual(['cancelled', 'cancelled']);
    expect(await run(started.id)).toMatchObject({ status: 'cancelled' });
  });

  it("a cancel or a send-back from the API reaches the knowledge server's queue through the worker", async () => {
    const at = pipeline();
    const cancelled = await start(at);
    await sendIndex(cancelled.id);
    await apiRuns.cancel({
      dataset: at.dataset,
      execution: cancelled.id,
      by: 'employee:test:kari',
      at: new Date().toISOString(),
    });
    expect(await knowledgeStates(cancelled.id)).toEqual(['created']);
    await reconcile();
    expect(await knowledgeStates(cancelled.id)).toEqual(['cancelled']);

    const failed = await start(pipeline());
    const ingest = await work(jobs.platform, knowledgeIngestQueue, async ({ run: r }) => {
      await sendIndex(r.id);
    });
    const index = await work(knowledge(), knowledgeIndexQueue, async () => {
      throw new Error('the embedding host went away');
    });
    await expect
      .poll(() => knowledgeStates(failed.id, 'knowledge.index.dead'), { timeout: 30_000 })
      .toEqual(['created']);
    await ingest();
    await index();
    await expect.poll(() => platformStates(failed.id), { timeout: 20_000 }).toEqual(['completed']);
    await reconcile();
    const sent = await apiRuns.redrive({
      dataset: failed.dataset,
      pipeline: failed.pipeline,
      execution: failed.id,
      by: 'employee:test:kari',
      reason: 'the embedding host is back',
      at: new Date().toISOString(),
    });
    expect(sent.ok).toBe(true);
    expect(await knowledgeStates(failed.id)).toEqual(['failed']);
    const pass = await reconcile();
    expect(pass.sentBack).toBe(1);
    expect(await knowledgeStates(failed.id)).toEqual(['failed', 'created']);
    expect(await run(failed.id)).toMatchObject({ status: 'running' });
  }, 90_000);

  it('sending a dead letter back reopens its run', async () => {
    const started = await start(pipeline());
    const ingest = await work(jobs.platform, knowledgeIngestQueue, async () => {
      throw new Error('Kudos answered 503');
    });
    await expect
      .poll(() => platformStates(started.id, 'knowledge.ingest.dead'), { timeout: 30_000 })
      .toEqual(['created']);
    await ingest();
    await reconcile();
    expect(await run(started.id)).toMatchObject({ status: 'failed' });
    const sent = await apiRuns.redrive({
      dataset: started.dataset,
      pipeline: started.pipeline,
      execution: started.id,
      by: 'employee:test:kari',
      reason: 'Kudos answers again',
      at: new Date().toISOString(),
    });
    expect(sent).toMatchObject({ ok: true, value: { status: 'running' } });
    await reconcile();
    expect(await run(started.id)).toMatchObject({ status: 'running', error: null });
    expect(await platformStates(started.id)).toEqual(['failed', 'created']);
  }, 90_000);

  it('in lockdown, a job that was not admitted, or was admitted more than 24 hours ago, fetches, converts and embeds nothing', async () => {
    const now = Date.now();
    const notAdmitted = await insertRun(pipeline(), { status: 'running', admittedAt: null });
    const tooOld = await insertRun(pipeline(), {
      status: 'running',
      admittedAt: new Date(now - 25 * hour).toISOString(),
    });
    const fresh = await insertRun(pipeline(), {
      status: 'running',
      admittedAt: new Date(now - hour).toISOString(),
    });
    for (const id of [notAdmitted, tooOld, fresh]) await sendIndex(id);
    const embedded: { run: string; scopes: string[] }[] = [];
    const stop = await work(
      knowledge(),
      knowledgeIndexQueue,
      async ({ run: r, principal }) => {
        embedded.push({ run: r.id, scopes: principal.scopes ?? [] });
      },
      true,
    );
    for (const id of [notAdmitted, tooOld, fresh])
      await expect.poll(() => knowledgeStates(id), { timeout: 20_000 }).toEqual(['completed']);
    await stop();
    expect(
      embedded.filter((e) => ([notAdmitted, tooOld, fresh] as string[]).includes(e.run)),
    ).toEqual([{ run: fresh, scopes: [configuredCredentialScope] }]);
    expect(await run(notAdmitted)).toMatchObject({ status: 'failed', error: notAdmittedMessage });
    expect(await run(tooOld)).toMatchObject({ status: 'failed', error: admissionRanOutMessage });
    expect(await run(fresh)).toMatchObject({ status: 'running' });
  }, 90_000);

  it('approving or sending back admits a run again from that moment, and a queued run whose admission ran out fails without starting', async () => {
    const started = await start(pipeline());
    const failing = await work(jobs.platform, knowledgeIngestQueue, async () => {
      throw new Error('Kudos answered 503');
    });
    await expect
      .poll(() => platformStates(started.id, 'knowledge.ingest.dead'), { timeout: 30_000 })
      .toEqual(['created']);
    await failing();
    await reconcile({ lockdown: true });
    await api.pool.query(`update ingestion_executions set admitted_at = $2 where id = $1`, [
      started.id,
      new Date(Date.now() - 30 * hour).toISOString(),
    ]);
    const sent = await apiRuns.redrive({
      dataset: started.dataset,
      pipeline: started.pipeline,
      execution: started.id,
      by: 'employee:test:kari',
      reason: 'Kudos answers again',
      at: new Date().toISOString(),
    });
    expect(sent.ok).toBe(true);
    await reconcile({ lockdown: true });
    const listed: string[] = [];
    const stop = await work(
      jobs.platform,
      knowledgeIngestQueue,
      async ({ run: r }) => {
        listed.push(r.id);
      },
      true,
    );
    await expect.poll(() => listed, { timeout: 20_000 }).toEqual([started.id]);
    await stop();

    const at = pipeline();
    const expired = await insertRun(at, {
      status: 'queued',
      admittedAt: new Date(Date.now() - 25 * hour).toISOString(),
    });
    await reconcile({ lockdown: true });
    expect(await run(expired)).toMatchObject({ status: 'failed', error: expiredQueuedRunMessage });
    expect(await platformStates(expired)).toEqual([]);
  }, 90_000);

  it("a job's data never admits it in lockdown", async () => {
    const id = await insertRun(pipeline(), { status: 'running', admittedAt: null });
    expect(() =>
      admitPayload(knowledgeIngestQueue, { run: id, tenant: ORG, admitted: true }),
    ).toThrow(JobQueueError);

    const admitted = await insertRun(pipeline(), {
      status: 'running',
      admittedAt: new Date().toISOString(),
    });
    await sendIndex(id, 'r-1', OTHER_ORG);
    await sendIndex(admitted, 'r-1', OTHER_ORG);
    const actedFor: string[] = [];
    const stop = await work(
      knowledge(),
      knowledgeIndexQueue,
      async ({ run: r, principal }) => {
        if (r.id === admitted || r.id === id) actedFor.push(principal.tenant ?? '');
      },
      true,
    );
    for (const run of [id, admitted])
      await expect.poll(() => knowledgeStates(run), { timeout: 20_000 }).toEqual(['completed']);
    await stop();
    expect(actedFor).toEqual([ORG]);
  }, 90_000);
  it("the API sends a run's ingest job to the platform queues the worker installed", async () => {
    const { rows } = await api.pool.query<{ insert: boolean }>(
      `select has_table_privilege('${runtimeRole}', 'pgboss.job', 'insert') as insert`,
    );
    expect(rows[0]?.insert).toBe(true);
    const started = await start(pipeline());
    expect(await platformStates(started.id)).toEqual(['created']);
  });

  it("a queued run stays queued while its pipeline's last ingest job still runs", async () => {
    const at = pipeline();
    const refused = await start(at, new Date(Date.now() - 25 * hour).toISOString());
    const waiting = await start(at);
    const stop = await work(jobs.platform, knowledgeIngestQueue, async () => undefined, true);
    await expect.poll(() => platformStates(refused.id), { timeout: 20_000 }).toEqual(['completed']);
    await stop();
    expect(await run(refused.id)).toMatchObject({ status: 'failed' });
    expect((await run(waiting.id))?.status).toMatch(/queued|running/);
    if ((await run(waiting.id))?.status === 'running')
      expect(await platformStates(waiting.id)).toEqual(['created']);
    await reconcile({ lockdown: true });
    expect(await run(waiting.id)).toMatchObject({ status: 'running' });
    expect(await platformStates(waiting.id)).toEqual(['created']);
  }, 90_000);

  it('a send-back with no dead letters leaves the run as it ended', async () => {
    const succeeded = await insertRun(pipeline(), {
      status: 'succeeded',
      admittedAt: new Date().toISOString(),
    });
    const failed = await insertRun(pipeline(), {
      status: 'failed',
      admittedAt: new Date().toISOString(),
    });
    await api.pool.query(`update ingestion_executions set error = $2 where id = $1`, [
      failed,
      admissionRanOutMessage,
    ]);
    for (const id of [succeeded, failed]) {
      const { rows } = await api.pool.query<{ dataset: string; pipeline: string }>(
        `select dataset, pipeline from ingestion_executions where id = $1`,
        [id],
      );
      const sent = await apiRuns.redrive({
        dataset: rows[0]?.dataset ?? '',
        pipeline: rows[0]?.pipeline ?? '',
        execution: id,
        by: 'employee:test:kari',
        reason: 'try again',
        at: new Date().toISOString(),
      });
      expect(sent.ok).toBe(true);
    }
    await reconcile();
    expect(await run(succeeded)).toMatchObject({ status: 'succeeded', error: null });
    expect(await run(failed)).toMatchObject({ status: 'failed', error: admissionRanOutMessage });
  });

  it("a start while the pipeline's last ingest job still holds its key is refused", async () => {
    const at = pipeline();
    await jobs.platform.send(
      knowledgeIngestQueue,
      { run: crypto.randomUUID(), tenant: ORG },
      { key: knowledgeKeys.ingest({ dataset: at.dataset, id: at.pipeline }) },
    );
    const started = await apiRuns.start({
      id: crypto.randomUUID(),
      ...at,
      pipelineVersion: 1,
      backend: 'index-writer',
      startedBy: 'employee:test:kari',
      startedAt: new Date().toISOString(),
      admittedAt: new Date().toISOString(),
    });
    expect(started).toEqual({
      ok: false,
      conflict: true,
      message: ingestStillEndingMessage(at.dataset, at.pipeline),
    });
    const { rows } = await api.pool.query(
      `select id from ingestion_executions where dataset = $1`,
      [at.dataset],
    );
    expect(rows).toEqual([]);
  });

  it('sending back refuses a run of another pipeline', async () => {
    const at = pipeline();
    const id = await insertRun(at, { status: 'failed', admittedAt: new Date().toISOString() });
    const sent = await apiRuns.redrive({
      dataset: at.dataset,
      pipeline: 'another',
      execution: id,
      by: 'employee:test:kari',
      reason: 'try again',
      at: new Date().toISOString(),
    });
    expect(sent.ok).toBe(false);
    expect(await run(id)).toMatchObject({ status: 'failed' });
  });
});

const jobIds = async (id: string) =>
  (
    await knowledgeDb().query<{ id: string }>(
      `select id from pgboss.job where data ->> 'run' = $1`,
      [id],
    )
  ).rows.map((row) => row.id);
