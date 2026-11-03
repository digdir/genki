import { randomBytes } from 'node:crypto';
import { knowledgePlatformQueues } from '@genai/jobs';
import { installJobQueue, PgBossJobQueue } from '@genai/providers-pgboss';
import {
  createPostgresStores,
  ingestSender,
  LocalKeyWrapper,
  PostgresJobRuns,
  runtimeRole,
  workerRole,
  type IngestSender,
} from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import {
  IngestionService,
  type ExecutionStore,
  type IngestionBackend,
  type Pipeline,
} from './ingestion.js';

const tenant = '991825827';
const target = (dataset: string) => ({ dataset, endpoint: `${tenant}/sok`, collections: {} });

const notInProcess: IngestionBackend = {
  name: 'index-writer',
  available: true,
  run: async () => {
    throw new Error('a run that runs as jobs never runs in the API process');
  },
};

let container: StartedPostgreSqlContainer;
let db: Awaited<ReturnType<typeof createPostgresStores>>;
let api: PgBossJobQueue;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  db = await createPostgresStores(
    { connectionString: container.getConnectionUri() },
    new LocalKeyWrapper(randomBytes(32)),
  );
  await installJobQueue(db.pool, knowledgePlatformQueues, {
    worker: workerRole,
    readers: [runtimeRole],
    senders: [runtimeRole],
  });
  api = await PgBossJobQueue.start(db.runtimePool, { works: false });
}, 180_000);

afterAll(async () => {
  await api?.stop();
  await db?.close();
  await db?.runtimePool.end();
  await db?.pool.end();
  await stopPostgres(container);
});

const ingestJobs = async (run: string) => {
  const { rows } = await db.pool.query<{ singleton_key: string }>(
    `select singleton_key from pgboss.job where name = 'knowledge.ingest' and data ->> 'run' = $1`,
    [run],
  );
  return rows;
};

const recordOf = async (id: string) => {
  const { rows } = await db.pool.query<{ status: string; runs_as_jobs: boolean }>(
    `select status, runs_as_jobs from ingestion_executions where id = $1`,
    [id],
  );
  return rows[0];
};

let datasets = 0;

const boot = (
  options: {
    clock?: { now: Date };
    sender?: IngestSender;
    admits?: () => boolean;
  } = {},
) => {
  const dataset = `${tenant}/jobs-${(datasets += 1)}`;
  const service = new IngestionService({
    store: new InMemoryConfigEntryStore(),
    executions: db.ingestionExecutions as ExecutionStore,
    backend: notInProcess,
    ...(options.clock ? { now: () => options.clock?.now ?? new Date() } : {}),
    ...(options.admits ? { admits: options.admits } : {}),
    jobs: {
      runsAsJobs: (id) => id === dataset,
      runs: new PostgresJobRuns(db.runtimePool, options.sender ?? ingestSender(api)),
    },
  });
  const save = async (schedule = 'none'): Promise<Pipeline> => {
    const saved = await service.save({
      scope: tenant,
      dataset,
      id: 'kudos',
      spec: {
        name: 'Kudos',
        source: { kind: 'kudos', types: ['Årsrapport'] },
        chunking: { minimumLength: 1 },
        schedule,
      },
      by: 'kari',
      reason: 'Test',
    });
    if (!saved.ok) throw new Error(JSON.stringify(saved.errors));
    return saved.value;
  };
  const start = async (pipeline: Pipeline) =>
    service.execute({ pipeline, target: target(dataset), by: 'employee:test:kari' });
  return { service, dataset, save, start };
};

describe('ingestion runs as jobs', () => {
  it("a run's ingest job commits with its record", async () => {
    const { save, start } = boot();
    const pipeline = await save();
    const started = await start(pipeline);
    if (!started.ok) throw new Error(JSON.stringify(started.errors));
    expect(await recordOf(started.value.id)).toEqual({ status: 'running', runs_as_jobs: true });
    expect(await ingestJobs(started.value.id)).toEqual([
      { singleton_key: `${pipeline.dataset}#kudos` },
    ]);

    let lost = '';
    const failing = boot({
      sender: {
        send: async (run, transaction) => {
          lost = run.id;
          await ingestSender(api).send(run, transaction);
          throw new Error('the connection dropped before commit');
        },
      },
    });
    await expect(failing.start(await failing.save())).rejects.toThrow(/connection dropped/);
    expect(lost).not.toBe('');
    expect(await recordOf(lost)).toBeUndefined();
    expect(await ingestJobs(lost)).toEqual([]);
  });

  it('one run per pipeline is open at a time and at most one waits, as queued', async () => {
    const { save, start } = boot();
    const pipeline = await save();
    const open = await start(pipeline);
    const waiting = await start(pipeline);
    if (!open.ok || !waiting.ok) throw new Error('both runs should be accepted');
    expect(open.value.status).toBe('running');
    expect(waiting.value.status).toBe('queued');
    expect(await ingestJobs(waiting.value.id)).toEqual([]);

    const insert = (id: string, status: string) =>
      db.pool.query(
        `insert into ingestion_executions (id, scope, dataset, pipeline, pipeline_version, backend,
           status, started_by, started_at, runs_as_jobs)
         values ($1, $2, $3, 'kudos', 1, 'index-writer', $4, 'test', '2026-11-02T00:00:00Z', true)`,
        [id, tenant, pipeline.dataset, status],
      );
    await expect(insert(crypto.randomUUID(), 'queued')).rejects.toThrow(/duplicate key/);
    await expect(insert(crypto.randomUUID(), 'running')).rejects.toThrow(/duplicate key/);
  });

  it('a start or an approval while a run is queued is refused', async () => {
    const clock = { now: new Date('2026-10-07T10:00:00Z') };
    const { save, start, service } = boot({ clock });
    const pipeline = await save('daily');
    await start(pipeline);
    await start(pipeline);
    const third = await start(pipeline);
    expect(third).toMatchObject({
      ok: false,
      conflict: true,
      errors: [{ message: expect.stringMatching(/already waits for the open one/) }],
    });

    clock.now = new Date('2026-10-08T01:00:30Z');
    const [fired] = await service.runDue(() => target(pipeline.dataset), 'platform');
    expect(fired).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/already waits for the open one/),
    });
    expect(await ingestJobs(fired?.id ?? '')).toEqual([]);
  });

  it('a scheduled run in lockdown sends no job and is recorded as failed', async () => {
    const clock = { now: new Date('2026-10-07T10:00:00Z') };
    const { save, service } = boot({ clock, admits: () => false });
    const pipeline = await save('daily');
    clock.now = new Date('2026-10-08T01:00:30Z');
    const [fired] = await service.runDue(() => target(pipeline.dataset), 'platform');
    expect(fired).toMatchObject({ status: 'failed', error: expect.stringMatching(/locked/) });
    const { rows } = await db.pool.query(
      `select j.id from pgboss.job j join ingestion_executions e on e.id = j.data ->> 'run'
        where e.dataset = $1`,
      [pipeline.dataset],
    );
    expect(rows).toEqual([]);
  });

  it('the check for stopped runs leaves a run that runs as jobs alone', async () => {
    const clock = { now: new Date('2026-11-02T10:00:00Z') };
    const { save, start, service } = boot({ clock });
    const started = await start(await save());
    if (!started.ok) throw new Error(JSON.stringify(started.errors));
    clock.now = new Date('2026-11-03T10:00:00Z');
    await service.failStaleRuns();
    expect(await recordOf(started.value.id)).toEqual({ status: 'running', runs_as_jobs: true });
  });
});
