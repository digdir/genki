import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresLeases } from './index.js';
import { stopPostgres } from './testing/index.js';

let container: StartedPostgreSqlContainer;
const pools: pg.Pool[] = [];

const newPool = (options: pg.PoolConfig = {}) => {
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), ...options });
  pools.push(pool);
  return pool;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
}, 120_000);

afterAll(async () => {
  await stopPostgres(container, pools);
});

describe('leader leases', () => {
  it('holds every lease of a process on one connection', async () => {
    const pool = newPool({ max: 2 });
    const leases = new PostgresLeases(pool);
    const names = ['triggers', 'retention', 'rates', 'register', 'sweep', 'stopped', 'knowledge'];

    const acquired = await Promise.all(names.map((name) => leases.lease(name).tryAcquire()));

    expect(acquired).toEqual(names.map(() => true));
    expect(pool.totalCount).toBe(1);
    expect((await pool.query<{ ok: number }>('select 1 as ok')).rows[0]?.ok).toBe(1);
    await Promise.all(names.map((name) => leases.lease(name).release()));
  });

  it('gives a lease to one process at a time, and to another once it is released', async () => {
    const first = new PostgresLeases(newPool()).lease('one-at-a-time');
    const second = new PostgresLeases(newPool()).lease('one-at-a-time');

    expect(await first.tryAcquire()).toBe(true);
    expect(await second.tryAcquire()).toBe(false);
    expect(second.held).toBe(false);
    await first.release();
    expect(first.held).toBe(false);
    expect(await second.tryAcquire()).toBe(true);
    await second.release();
  });

  it('loses every lease when its connection drops, and takes them again on a new one', async () => {
    const pool = newPool({ application_name: 'lease-dropped' });
    const leases = new PostgresLeases(pool);
    const a = leases.lease('dropped-a');
    const b = leases.lease('dropped-b');
    await a.tryAcquire();
    await b.tryAcquire();

    await newPool().query(
      `select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'lease-dropped'`,
    );
    await expect.poll(() => a.held || b.held).toBe(false);

    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(true);
    await a.release();
    await b.release();
  });
});

describe('leader leases on a connection that stops answering', () => {
  const fakeClient = (answers: { alive: boolean }) => {
    const client = Object.assign(new EventEmitter(), {
      timeouts: [] as unknown[],
      released: [] as unknown[],
      query: async (config: { text: string; query_timeout?: number }) => {
        client.timeouts.push(config.query_timeout);
        if (config.text === 'select 1' && !answers.alive) throw new Error('Query read timeout');
        return { rows: [{ ok: true }] };
      },
      release: (destroy?: boolean) => client.released.push(destroy),
    });
    return client;
  };

  it('checks a held lease within its timeout, and takes it again on a new connection when the old one does not answer', async () => {
    let now = 0;
    const first = fakeClient({ alive: false });
    const second = fakeClient({ alive: true });
    const clients = [first, second];
    const pool = { connect: async () => clients.shift() } as unknown as pg.Pool;
    const lease = new PostgresLeases(pool, {
      queryTimeoutMs: 5_000,
      checkEveryMs: 30_000,
      now: () => now,
    }).lease('answers');

    expect(await lease.tryAcquire()).toBe(true);
    now = 10_000;
    expect(await lease.tryAcquire()).toBe(true);
    expect(first.timeouts).toEqual([5_000]);

    now = 40_000;
    expect(await lease.tryAcquire()).toBe(true);
    expect(first.released).toEqual([true]);
    expect(second.timeouts).toEqual([5_000]);
    expect(lease.held).toBe(true);
  });
});

describe('leader leases on a stalled connection', () => {
  const stalled = () => {
    const state = { answers: true };
    const client = Object.assign(new EventEmitter(), {
      released: [] as unknown[],
      query: async (config: { text: string; query_timeout?: number }) => {
        if (!state.answers) throw new Error(`Query read timeout after ${config.query_timeout} ms`);
        return { rows: [{ ok: true }] };
      },
      release: (destroy?: boolean) => client.released.push(destroy),
    });
    return { state, client };
  };

  it('stops leading on its own clock, well before the server would let another session take the lock', async () => {
    let now = 0;
    const { state, client } = stalled();
    const leases = new PostgresLeases({ connect: async () => client } as unknown as pg.Pool, {
      now: () => now,
    });
    const lease = leases.lease('stalled');

    expect(await lease.tryAcquire()).toBe(true);
    state.answers = false;
    now = leases.validForMs - 1;
    expect(lease.held).toBe(true);
    now = leases.validForMs;
    expect(lease.held).toBe(false);
    expect(leases.validForMs).toBeLessThan(120_000);
  });

  it('gives up the lease as soon as a check on the stalled connection fails', async () => {
    let now = 0;
    const first = stalled();
    const second = stalled();
    const clients = [first.client, second.client];
    const busy = {
      connect: async () => clients.shift(),
    } as unknown as pg.Pool;
    const lease = new PostgresLeases(busy, { now: () => now }).lease('check');
    await lease.tryAcquire();
    first.state.answers = false;
    second.client.query = async () => ({ rows: [{ ok: false }] });

    now = 10_000;
    expect(await lease.tryAcquire()).toBe(false);
    expect(lease.held).toBe(false);
    expect(first.client.released).toEqual([true]);
  });
});
