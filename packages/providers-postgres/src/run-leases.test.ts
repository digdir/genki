import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Event, Principal } from '@genai/contracts';
import { failStoppedRuns } from '@genai/jobs';
import {
  createKernel,
  type Run,
  type StoppableKernel,
  type Strategy,
  type TaskStore,
} from '@genai/kernel';
import { createPostgresStores, LocalKeyWrapper, type PostgresTaskStore } from './index.js';
import { stopPostgres } from './testing/index.js';

let container: StartedPostgreSqlContainer;
let stores: Awaited<ReturnType<typeof createPostgresStores>>;
let pool: pg.Pool;
let clock = new Date('2026-11-18T10:00:00Z');
const now = () => clock;
const minutes = (n: number) => new Date(Date.parse('2026-11-18T10:00:00Z') + n * 60_000);

const tenant = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };

const replica = (instance: string) => stores.tasks.withLease({ instance, now });

const answers: Strategy['run'] = async function* (ctx) {
  await ctx.budget.charge({ inputTokens: 40, outputTokens: 5, requests: 1 });
  yield { type: 'kernel.part.delta', data: { text: 'Svaret kommer' } };
  await new Promise<never>(() => undefined);
};

const kernelOn = (tasks: TaskStore, run = answers): StoppableKernel =>
  createKernel({
    strategies: [
      { id: 'answers', version: '1', requires: { kernel: 1, ports: [], features: [] }, run },
    ],
    capabilities: [
      {
        descriptor: {
          id: 'ka',
          version: '1',
          tenant,
          title: 'ka',
          description: 'ka',
          input: {},
          interaction: ['stream'],
          accepts: ['text/plain'],
          produces: ['text/plain'],
          emits: [],
          oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: 'KI-generert' },
        },
        strategy: { id: 'answers', version: '1' },
        config: {},
        grants: [],
      },
    ],
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
    log: stores.log,
    tasks,
    now,
    limits: { cancelPollMs: 10, leaseRenewMs: 0 },
  });

const stoppedReplica = (store: PostgresTaskStore): TaskStore => ({
  put: (stored, scope) => store.put(stored, scope),
  get: (id) => store.get(id),
  pendingFor: (who) => store.pendingFor(who),
});

const started = async (kernel: StoppableKernel) => {
  const run = await kernel.invoke(kari, 'ka', {});
  for await (const e of run.events) if (e.type === 'kernel.part.delta') break;
  return run;
};

const leaseUntil = async (task: string) =>
  (await pool.query<{ lease_until: Date }>('select lease_until from tasks where id = $1', [task]))
    .rows[0]?.lease_until;

const sweep = (instance = 'sweep') =>
  failStoppedRuns({ tasks: replica(instance), events: stores.log, now });

const eventsOf = async (task: string) => {
  const events: Event[] = [];
  for await (const e of stores.log.read(task, 0, () => false)) events.push(e);
  return events;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  stores = await createPostgresStores(pool, new LocalKeyWrapper(randomBytes(32)));
}, 120_000);

afterAll(async () => {
  await stores?.close();
  await stores?.runtimePool.end();
  await pool?.end();
  await stopPostgres(container);
});

describe('run leases across API replicas', () => {
  it('a run that still renews its lease is left running while a stopped replica run is failed', async () => {
    clock = minutes(0);
    const live = kernelOn(replica('replica-a'));
    const gone = kernelOn(stoppedReplica(replica('replica-b')));
    const kept: Run = await started(live);
    const lost: Run = await started(gone);

    clock = minutes(3);
    await expect
      .poll(async () => (await leaseUntil(kept.task))?.getTime())
      .toBe(minutes(5).getTime());
    const failed = await sweep();

    expect(failed).toContain(lost.task);
    expect(failed).not.toContain(kept.task);
    expect((await replica('reader').get(kept.task))?.task.status).toBe('running');
    expect(live.running()).toBe(1);
    const stored = await replica('reader').get(lost.task);
    expect(stored?.task).toMatchObject({
      status: 'failed',
      endedAt: minutes(3).toISOString(),
      usage: { inputTokens: 40, outputTokens: 5, requests: 1 },
    });
    expect((await eventsOf(lost.task)).filter((e) => e.type === 'kernel.error')).toMatchObject([
      { audience: 'audit', data: { code: 'server_stopped' } },
      { data: { code: 'server_stopped', message: 'the server stopped during the run' } },
    ]);
    await live.cancel(kari, kept.task);
    await gone.cancel(kari, lost.task);
  });

  it('a replica whose lease was taken can neither renew it nor write over the failed run', async () => {
    clock = minutes(0);
    const stale = replica('replica-c');
    const gone = kernelOn(stoppedReplica(stale));
    const lost = await started(gone);
    clock = minutes(3);
    await sweep();

    const stored = await stale.get(lost.task);
    if (!stored) throw new Error('the run is gone');
    const scope = { tenant, key: JSON.stringify(['task', lost.task]) };
    clock = minutes(4);
    await stale.put({ ...stored, task: { ...stored.task, status: 'completed' } }, scope);
    await stale.put(
      { ...stored, task: { ...stored.task, endedAt: minutes(4).toISOString() }, lastSeq: 99 },
      scope,
    );

    expect(await stale.renewLeases([lost.task])).toEqual([]);
    expect(await stale.get(lost.task)).toEqual(stored);
    await gone.cancel(kari, lost.task);
  });

  it('a replica that comes back after its lease ran out stops the run it lost', async () => {
    clock = minutes(0);
    const store = replica('replica-d');
    let resume: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    const kernel = kernelOn({
      ...stoppedReplica(store),
      renewLeases: async (ids) => {
        await paused;
        return store.renewLeases(ids);
      },
    });
    const run = await started(kernel);
    clock = minutes(3);
    expect(await sweep()).toContain(run.task);
    resume();

    await expect(run.result).rejects.toMatchObject({ code: 'server_stopped' });
    expect(kernel.running()).toBe(0);
    expect((await replica('reader').get(run.task))?.task.status).toBe('failed');
  });

  it('a stale replica that fails its run after the sweep failed it changes nothing', async () => {
    clock = minutes(0);
    const store = replica('replica-g');
    let fail: (error: Error) => void = () => undefined;
    let partitioned = true;
    const kernel = kernelOn(
      {
        ...stoppedReplica(store),
        renewLeases: async (ids) => {
          if (partitioned) throw new Error('the database is out of reach');
          return store.renewLeases(ids);
        },
      },
      async function* () {
        yield { type: 'kernel.part.delta', data: { text: 'Svaret kommer' } };
        await new Promise<never>((_, reject) => (fail = reject));
      },
    );
    const run = await started(kernel);
    clock = minutes(3);
    expect(await sweep()).toContain(run.task);
    const before = await eventsOf(run.task);
    const swept = await replica('reader').get(run.task);

    clock = minutes(4);
    partitioned = false;
    fail(new Error('the model went away'));
    await expect(run.result).rejects.toMatchObject({ code: 'server_stopped' });

    expect(await eventsOf(run.task)).toEqual(before);
    expect((await replica('reader').get(run.task))?.task).toEqual(swept?.task);
  });

  it('two sweepers at once fail each stopped run once', async () => {
    clock = minutes(0);
    const gone = kernelOn(stoppedReplica(replica('replica-e')));
    const lost = await started(gone);
    clock = minutes(3);

    const [first, second] = await Promise.all([sweep('sweep-1'), sweep('sweep-2')]);

    expect([...first, ...second].filter((id) => id === lost.task)).toEqual([lost.task]);
    expect((await eventsOf(lost.task)).filter((e) => e.type === 'kernel.error')).toHaveLength(2);
    expect(await sweep('sweep-3')).not.toContain(lost.task);
    await gone.cancel(kari, lost.task);
  });

  it('a run from before leases is failed once it is an hour old', async () => {
    clock = minutes(0);
    const gone = kernelOn(stoppedReplica(replica('replica-f')));
    const old = await started(gone);
    await pool.query('update tasks set lease_owner = null, lease_until = null where id = $1', [
      old.task,
    ]);

    clock = minutes(30);
    expect(await sweep()).not.toContain(old.task);
    clock = minutes(61);
    expect(await sweep()).toContain(old.task);
    await gone.cancel(kari, old.task);
  });
});
