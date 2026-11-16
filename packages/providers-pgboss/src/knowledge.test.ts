import {
  defineQueue,
  convertPriority,
  knowledgeConvertQueue,
  knowledgeIngestQueue,
  knowledgeKeys,
  knowledgePlatformQueues,
  knowledgeServerQueues,
} from '@genai/jobs';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { installJobQueue, PgBossJobQueue, PgBossJobReads, PgBossRunJobs } from './index.js';

const RUNTIME = 'genai_runtime';
const WORKER = 'genai_worker';
const WRITER = 'genai_knowledge_writer';
const READER = 'genai_knowledge_reader';
const ORG = '991825827';
const markerTimeoutMs = 6 * 60 * 60 * 1000;
const knowledgeQueues = knowledgeServerQueues(markerTimeoutMs);
const convert = knowledgeConvertQueue(markerTimeoutMs);

let container: StartedPostgreSqlContainer;
const pools: pg.Pool[] = [];

const login = (database: string, role?: string) => {
  const pool = new pg.Pool({
    host: container.getHost(),
    port: container.getPort(),
    database,
    user: 'genai_owner',
    password: 'owner-pw',
    ...(role ? { options: `-c role=${role}` } : {}),
  });
  pool.on('error', () => undefined);
  pools.push(pool);
  return pool;
};

const platform = (role?: string) => login('platform', role);
const knowledge = (role?: string) => login('knowledge', role);

const start = (pool: pg.Pool, works = false) =>
  PgBossJobQueue.start(pool, { works, pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 1 });

const platformRoles = { worker: WORKER, readers: [RUNTIME], senders: [RUNTIME] };
const knowledgeRoles = { worker: WRITER, readers: [READER] };

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  const admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  pools.push(admin);
  await admin.query(`create role genai_owner login password 'owner-pw'`);
  for (const role of [RUNTIME, WORKER, WRITER, READER])
    await admin.query(`create role ${role} nologin nosuperuser nobypassrls`);
  await admin.query(`grant ${RUNTIME} to ${WORKER}`);
  await admin.query(`grant ${RUNTIME}, ${WORKER}, ${WRITER}, ${READER} to genai_owner`);
  for (const database of ['platform', 'knowledge']) {
    await admin.query(`create database ${database} owner genai_owner`);
  }
  await installJobQueue(platform(), knowledgePlatformQueues, platformRoles);
  await installJobQueue(knowledge(), knowledgeQueues, knowledgeRoles);
}, 180_000);

afterAll(async () => {
  await Promise.allSettled(pools.map((pool) => pool.end()));
  await container?.stop();
});

const inTransaction = async <T>(pool: pg.Pool, run: (client: pg.PoolClient) => Promise<T>) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

const run = () => crypto.randomUUID();

describe('the knowledge job queues', () => {
  it('a file is never converted twice at once', async () => {
    const writer = await start(knowledge(WRITER));
    const file = { sha256: 'a'.repeat(64), converter: 'marker', version: '1', settings: 'default' };
    const key = knowledgeKeys.convert(file);
    const first = await writer.send(
      convert,
      { run: run(), tenant: ORG, file: file.sha256, dataset: 'kudos', record: '1', tenants: ORG },
      { key, priority: convertPriority.run },
    );
    const second = await writer.send(
      convert,
      { run: run(), tenant: ORG, file: file.sha256, dataset: 'kudos', record: '1', tenants: ORG },
      { key, priority: convertPriority.upload },
    );
    expect(first).toEqual(expect.any(String));
    expect(second).toBeNull();
    const other = await writer.send(
      convert,
      {
        run: run(),
        tenant: ORG,
        file: 'b'.repeat(64),
        dataset: 'kudos',
        record: '2',
        tenants: ORG,
      },
      { key: knowledgeKeys.convert({ ...file, sha256: 'b'.repeat(64) }) },
    );
    expect(other).toEqual(expect.any(String));
    await writer.stop();
  });

  it("the API sends knowledge jobs only to the platform server and has no rights on the knowledge server's job tables", async () => {
    const api = await start(platform(RUNTIME));
    const sent = await inTransaction(platform(RUNTIME), (client) =>
      api.send(
        knowledgeIngestQueue,
        { run: run(), tenant: ORG },
        {
          key: knowledgeKeys.ingest({ dataset: `${ORG}/kudos`, id: 'nightly' }),
          transaction: client,
        },
      ),
    );
    expect(sent).toEqual(expect.any(String));
    const runtime = platform(RUNTIME);
    for (const sql of [
      `select data from pgboss.job`,
      `update pgboss.job set priority = 1`,
      `delete from pgboss.job`,
    ])
      await expect(runtime.query(sql), sql).rejects.toThrow(/permission denied/);
    await api.stop();

    const reader = knowledge(READER);
    for (const sql of [
      `select * from pgboss.job`,
      `insert into pgboss.job (name, data) values ('knowledge.index', '{}')`,
      `update pgboss.job set priority = 1`,
      `delete from pgboss.job`,
      `select * from pgboss.queue`,
    ])
      await expect(reader.query(sql), sql).rejects.toThrow(/permission denied/);
    await expect(start(reader)).rejects.toThrow(/permission denied/);
  });

  it("the console reads the knowledge server's jobs only with platform access", async () => {
    const reads = new PgBossJobReads(knowledge(READER));
    await expect(reads.counts(knowledgeQueues)).rejects.toThrow(/platform access/);
    const counts = await inTransaction(knowledge(READER), async (client) => {
      await client.query(`select set_config('app.platform_access', 'console jobs', true)`);
      return reads.counts(knowledgeQueues, { transaction: client });
    });
    expect(counts.map((c) => c.queue)).toEqual(knowledgeQueues.map((q) => q.name));
  });

  it("finds, cancels and sends back a run's jobs on a server", async () => {
    const failing = defineQueue({
      name: 'test.run-jobs',
      policy: 'standard',
      payload: z.strictObject({ run: z.string(), tenant: z.string() }),
      expireInSeconds: 60,
      heartbeatSeconds: 10,
      retryLimit: 0,
      deadLetter: true,
    });
    await installJobQueue(knowledge(), [...knowledgeQueues, failing], knowledgeRoles);
    const writer = await start(knowledge(WRITER), true);
    const jobs = new PgBossRunJobs(knowledge(WRITER), writer, [...knowledgeQueues, failing]);
    const [index] = knowledgeQueues.filter((q) => q.name === 'knowledge.index');
    if (!index) throw new Error('no index queue');
    const mine = run();
    await writer.send(index, { run: mine, tenant: ORG, generation: 'g-1', record: 'r-1' });
    expect(await jobs.open(mine)).toBe(1);
    expect(await jobs.runs()).toContain(mine);
    expect(await jobs.cancel(mine, { except: ['knowledge.index'] })).toBe(0);
    expect(await jobs.cancel(mine)).toBe(1);
    expect(await jobs.open(mine)).toBe(0);

    const broken = run();
    await writer.send(failing, { run: broken, tenant: ORG });
    const stop = await writer.work(failing, async () => {
      throw new Error('embedding service down');
    });
    await expect
      .poll(() => jobs.deadLetters(broken), { timeout: 30_000 })
      .toEqual({ 'test.run-jobs': 1 });
    await stop();
    expect(await jobs.redrive(broken)).toBe(1);
    expect(await jobs.deadLetters(broken)).toEqual({});
    expect(await jobs.open(broken)).toBe(1);
    await writer.stop();
  }, 60_000);
});
