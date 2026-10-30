import { defineQueue, JobQueueError, type JobTransaction, type QueueDefinition } from '@genai/jobs';
import { describeJobQueueContract, waitFor } from '@genai/jobs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { installJobQueue, PgBossJobQueue, PgBossJobReads } from './index.js';

const RUNTIME = 'genai_runtime';
const WORKER = 'genai_worker';
const roles = { worker: WORKER, readers: [RUNTIME] };
const ORG_A = '991825827';

let container: StartedPostgreSqlContainer;
const pools: pg.Pool[] = [];

const login = (options: { database?: string; user?: string; role?: string } = {}) => {
  const pool = new pg.Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: options.database ?? container.getDatabase(),
    user: options.user ?? 'genai_owner',
    password: options.user === undefined ? 'owner-pw' : container.getPassword(),
    ...(options.role ? { options: `-c role=${options.role}` } : {}),
  });
  pool.on('error', () => undefined);
  pools.push(pool);
  return pool;
};

const superuser = () => login({ user: container.getUsername() });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin = superuser();
  await admin.query(`create role genai_owner login password 'owner-pw'`);
  await admin.query(`grant create on database ${container.getDatabase()} to genai_owner`);
  await admin.query(`create role ${RUNTIME} nologin nosuperuser nobypassrls`);
  await admin.query(`create role ${WORKER} nologin nosuperuser nobypassrls`);
  await admin.query(`grant ${RUNTIME} to ${WORKER}`);
  await admin.query(`grant ${RUNTIME}, ${WORKER} to genai_owner`);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(pools.map((pool) => pool.end()));
  await container?.stop();
});

const inTransaction = async (pool: pg.Pool) => {
  const client = await pool.connect();
  await client.query('begin');
  const end = async (sql: string) => {
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  };
  return { transaction: client, commit: () => end('commit'), rollback: () => end('rollback') };
};

const withPlatformAccess = async <T>(
  pool: pg.Pool,
  read: (transaction?: JobTransaction) => Promise<T>,
) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.platform_access', 'job queue test', true)`);
    const result = await read(client);
    await client.query('commit');
    return result;
  } finally {
    client.release();
  }
};

const start = (pool: pg.Pool, options: Partial<Parameters<typeof PgBossJobQueue.start>[1]> = {}) =>
  PgBossJobQueue.start(pool, {
    works: true,
    pollingIntervalSeconds: 0.5,
    superviseIntervalSeconds: 1,
    ...options,
  });

describeJobQueueContract('pg-boss as genai_worker', async (queues) => {
  await installJobQueue(login(), queues, roles);
  const worker = login({ role: WORKER });
  const queue = await start(worker);
  return {
    queue,
    transaction: () => inTransaction(worker),
    withPlatformAccess: (read) => withPlatformAccess(worker, read),
  };
});

const payload = z.strictObject({ tenant: z.string() });

const testQueue = (
  name: string,
  overrides: Partial<Omit<QueueDefinition, 'payload'>> = {},
  schema: QueueDefinition['payload'] = payload,
) =>
  defineQueue({
    name: `test.${name}`,
    policy: 'standard',
    payload: schema,
    expireInSeconds: 60,
    heartbeatSeconds: 10,
    retryLimit: 1,
    deadLetter: true,
    ...overrides,
  });

describe('pg-boss on the platform server', () => {
  const crashed = testQueue('crashed');
  const nightly = testQueue('nightly', { policy: 'singleton' }, z.strictObject({}));
  const guarded = testQueue('guarded');
  const denied = testQueue('denied');
  const asWorker = testQueue('as-worker');
  const ending = testQueue('ending');
  const dropping = testQueue('dropping');
  const waiting = testQueue('waiting');

  beforeAll(async () => {
    await installJobQueue(
      login(),
      [crashed, nightly, guarded, asWorker, ending, dropping, waiting],
      roles,
    );
  }, 60_000);

  it("only the owner installs pgboss, and the worker's instance runs with migrate and createSchema off", async () => {
    const admin = superuser();
    await admin.query('create database fresh');
    await admin.query('grant connect on database fresh to genai_owner');
    const fresh = login({ database: 'fresh', role: WORKER });
    await expect(installJobQueue(fresh, [], roles)).rejects.toThrow(/permission denied/);
    await expect(start(fresh, { works: false })).rejects.toThrow();
    const { rows } = await fresh.query(
      `select count(*)::int as n from pg_namespace where nspname = 'pgboss'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('two workers that start at once both install the job queue', async () => {
    const together = testQueue('together');
    const installs = await Promise.allSettled(
      Array.from({ length: 4 }, () => installJobQueue(login(), [together], roles)),
    );
    expect(installs.map((install) => install.status)).toEqual(Array(4).fill('fulfilled'));
  });

  it('genai_runtime cannot read, change or delete a job', async () => {
    const owner = login();
    await owner.query(
      `grant select, insert, update, delete on all tables in schema pgboss to ${RUNTIME}`,
    );
    await installJobQueue(owner, [denied], roles);
    const worker = await start(login({ role: WORKER }), { works: false });
    await worker.send(denied, { tenant: ORG_A });
    const runtime = login({ role: RUNTIME });
    for (const sql of [
      `select * from pgboss.job`,
      `update pgboss.job set priority = 1`,
      `delete from pgboss.job`,
      `insert into pgboss.job (name, data) values ('${denied.name}', '{}')`,
      `select * from pgboss.queue`,
    ])
      await expect(runtime.query(sql), sql).rejects.toThrow(/permission denied/);
    await expect(start(runtime, { works: false })).rejects.toThrow(/permission denied/);
    const { rows } = await runtime.query<{ name: string }>(
      `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'pgboss' and has_function_privilege(p.oid, 'execute') order by 1`,
    );
    expect(rows.map((row) => row.name)).toEqual(['genai_dead_letters', 'genai_queue_counts']);
    await worker.stop();
  });

  it('the worker sends and works jobs as genai_worker', async () => {
    const pool = login({ role: WORKER });
    const queue = await start(pool);
    const done: string[] = [];
    await queue.work(asWorker, async (job) => {
      const { rows } = await pool.query<{ role: string }>('select current_user as role');
      done.push(`${rows[0]?.role}:${job.data.tenant}`);
    });
    const open = await inTransaction(pool);
    const { rows } = await open.transaction.query<{ role: string }>('select current_user as role');
    await queue.send(asWorker, { tenant: ORG_A }, { transaction: open.transaction });
    await open.commit();
    await waitFor(() => done.length === 1);
    expect(rows[0]?.role).toBe(WORKER);
    expect(done).toEqual([`${WORKER}:${ORG_A}`]);
    await queue.stop();
  });

  it('the console reads jobs as genai_runtime, only with platform access', async () => {
    const runtime = login({ role: RUNTIME });
    const queue = new PgBossJobReads(runtime);
    await expect(queue.deadLetters(guarded)).rejects.toThrow(/platform access/);
    await expect(queue.counts([guarded])).rejects.toThrow(/platform access/);
    const tenantClient = await runtime.connect();
    try {
      await tenantClient.query('begin');
      await tenantClient.query(`select set_config('app.platform_access', 'x', true)`);
      await tenantClient.query(`select set_config('app.tenant', $1, true)`, [ORG_A]);
      await expect(queue.deadLetters(guarded, { transaction: tenantClient })).rejects.toThrow(
        /tenant transaction/,
      );
      await tenantClient.query('rollback');
    } finally {
      tenantClient.release();
    }
    expect(
      await withPlatformAccess(runtime, (t) =>
        queue.deadLetters(guarded, t ? { transaction: t } : {}),
      ),
    ).toEqual([]);
    expect(
      await withPlatformAccess(runtime, (t) =>
        queue.counts([guarded], t ? { transaction: t } : {}),
      ),
    ).toEqual([{ queue: guarded.name, queued: 0, active: 0, failed: 0, deadLetters: 0 }]);
  });

  it('an ended job is deleted after 7 days, and one nobody takes after 14', async () => {
    const admin = superuser();
    const queue = await start(login({ role: WORKER }));
    const [ended, recentlyEnded] = [
      await queue.send(ending, { tenant: ORG_A }),
      await queue.send(ending, { tenant: ORG_A }),
    ];
    await queue.work(ending, async () => undefined);
    await queue.work(dropping, async () => {
      throw new Error('broken');
    });
    await queue.send(dropping, { tenant: ORG_A });
    const [untaken, recentlyUntaken] = [
      await queue.send(waiting, { tenant: ORG_A }),
      await queue.send(waiting, { tenant: ORG_A }),
    ];
    const jobs = async (name: string) =>
      (
        await admin.query<{ id: string; state: string }>(
          `select id, state from pgboss.job where name = $1`,
          [name],
        )
      ).rows;
    await waitFor(async () => (await jobs(ending.name)).every((job) => job.state === 'completed'));
    const [deadLetter] = await waitFor(async () => {
      const dead = await jobs(`${dropping.name}.dead`);
      return dead.length === 1 ? dead : undefined;
    });
    // Moves each job back in time, as if that long had passed since it ended or was sent.
    const age = (ids: (string | null | undefined)[], column: string, by: string) =>
      admin.query(
        `update pgboss.job set ${column} = ${column} - $2::interval${
          column === 'keep_until' ? `, created_on = created_on - $2::interval` : ''
        } where id = any($1)`,
        [ids, by],
      );
    await age([ended], 'completed_on', '7 days 1 minute');
    await age([recentlyEnded], 'completed_on', '6 days');
    await age([untaken, deadLetter?.id], 'keep_until', '14 days 1 minute');
    await age([recentlyUntaken], 'keep_until', '13 days');
    const left = async () =>
      new Set(
        (
          await admin.query<{ id: string }>(`select id from pgboss.job where id = any($1)`, [
            [ended, recentlyEnded, untaken, recentlyUntaken, deadLetter?.id],
          ])
        ).rows.map((row) => row.id),
      );
    const old = [ended, untaken, deadLetter?.id];
    await waitFor(async () => {
      const ids = await left();
      return old.every((id) => !ids.has(id as string));
    }, 30_000);
    // One more maintenance pass, so a recent job that should be kept has had its chance to go.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await left()).toEqual(new Set([recentlyEnded, recentlyUntaken]));
    await queue.stop();
  }, 60_000);

  it('refuses to change a queue policy in place', async () => {
    await expect(
      installJobQueue(login(), [{ ...guarded, policy: 'exclusive' }], roles),
    ).rejects.toThrow(JobQueueError);
  });

  it("a killed worker's job is retried after its heartbeat", async () => {
    const doomedPool = login({ role: WORKER });
    const doomed = await start(doomedPool, { onError: () => undefined });
    const survivor = await start(login({ role: WORKER }));
    let release: () => void = () => undefined;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    await doomed.work(crashed, async () => {
      started.push('doomed');
      await hanging;
    });
    const id = await survivor.send(crashed, { tenant: ORG_A });
    await waitFor(() => started.length === 1);
    await doomedPool.end();
    const done: string[] = [];
    await survivor.work(crashed, async (job) => {
      done.push(`${job.id}#${job.retryCount}`);
    });
    await waitFor(() => done.length === 1, 60_000);
    expect(done).toEqual([`${id}#1`]);
    release();
    await survivor.stop();
    await doomed.stop().catch(() => undefined);
  }, 90_000);

  it('a nightly schedule sends one job per occurrence with two instances', async () => {
    const runtime = login({ role: WORKER });
    const first = await start(runtime, { cronIntervalSeconds: 1 });
    const second = await start(login({ role: WORKER }), { cronIntervalSeconds: 1 });
    await first.schedule(nightly, '* * * * *', {}, { tz: 'Europe/Oslo' });
    await second.schedule(nightly, '* * * * *', {}, { tz: 'Europe/Oslo' });
    const perMinute = () =>
      runtime
        .query<{ minute: string; n: number }>(
          `select date_trunc('minute', created_on)::text as minute, count(*)::int as n
               from pgboss.job where name = $1 group by 1 order by 1`,
          [nightly.name],
        )
        .then((result) => result.rows);
    await waitFor(async () => (await perMinute()).length >= 1, 75_000);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect((await perMinute()).every((row) => row.n === 1)).toBe(true);
    await first.unschedule(nightly);
    await first.stop();
    await second.stop();
  }, 100_000);
});
