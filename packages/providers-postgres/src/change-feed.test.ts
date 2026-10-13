import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ContentKeys,
  createPool,
  createPostgresStores,
  grantRuntimeRole,
  LocalKeyWrapper,
  migrate,
  PostgresChangeFeed,
  PostgresSettingsStore,
  withTenant,
} from './index.js';

let container: StartedPostgreSqlContainer;
let admin: pg.Pool;
let runtime: pg.Pool;
const pools: pg.Pool[] = [];
const feeds: PostgresChangeFeed[] = [];
const wrapper = new LocalKeyWrapper(randomBytes(32));

const runtimePool = () => {
  const created = createPool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: 'genai_api',
    password: 'runtime-pw',
  });
  pools.push(created);
  return created;
};

const feedOn = async (options: { reconnectMs?: number } = {}) => {
  const feed = new PostgresChangeFeed(runtimePool(), { pollMs: 60_000, ...options });
  feeds.push(feed);
  await feed.start();
  return feed;
};

let entry = 0;
const writeConfigEntry = (pool: pg.Pool) =>
  withTenant(pool, 'platform', (client) =>
    client.query(
      `insert into config_entries (kind, scope, id, version, spec, deleted, by, at, reason)
       values ('catalog', 'platform', $1, 1, '{}', false, 'operator:x', '2026-10-07T08:00:00.000Z', 'test')`,
      [`entry-${(entry += 1)}`],
    ),
  );

const versionOf = async (topic: string) =>
  Number(
    (
      await admin.query<{ version: string }>(
        'select version from change_versions where topic = $1',
        [topic],
      )
    ).rows[0]?.version ?? 0,
  );

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  pools.push(admin);
  await migrate(admin);
  await admin.query(`create role genai_api login password 'runtime-pw' nosuperuser nobypassrls`);
  await grantRuntimeRole(admin, 'genai_api');
  runtime = runtimePool();
}, 120_000);

afterAll(async () => {
  await Promise.all(feeds.map((f) => f.close()));
  await Promise.all(pools.map((p) => p.end()));
  await container?.stop();
});

describe('postgres change feed', () => {
  it('tells another connection about a settings write through LISTEN/NOTIFY', async () => {
    const feed = await feedOn();
    const heard = vi.fn();
    feed.on('settings', heard);

    await new PostgresSettingsStore(runtime, new ContentKeys(runtime, wrapper)).saveLock(
      'model.default',
      { reason: 'låst av Digdir' },
    );

    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it('bumps a topic once per statement, not per row', async () => {
    const before = await versionOf('settings');

    await runtime.query(
      `insert into setting_locks (key, reason) values ('a', 'x'), ('b', 'x'), ('c', 'x')`,
    );

    expect(await versionOf('settings')).toBe(before + 1);
  });

  it('catches up on topics changed while the listener was disconnected', async () => {
    const feed = await feedOn({ reconnectMs: 300 });
    const heard = vi.fn();
    feed.on('config-entries', heard);

    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where query = 'listen genai_changes'`,
    );
    await writeConfigEntry(runtime);

    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('coalesces a burst of changes into one listener run per topic', async () => {
    const feed = await feedOn();
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs = vi.fn(() => blocked);
    feed.on('config-entries', runs);

    await writeConfigEntry(runtime);
    await vi.waitFor(() => expect(runs).toHaveBeenCalledTimes(1), { timeout: 3000 });
    for (let i = 0; i < 5; i += 1) await writeConfigEntry(runtime);
    await feed.poll();
    expect(runs).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(runs).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await feed.poll();
    expect(runs).toHaveBeenCalledTimes(2);
  });

  it('starts with the stores and stops when they close', async () => {
    const owner = new pg.Pool({ connectionString: container.getConnectionUri() });
    pools.push(owner);
    const stores = await createPostgresStores(owner, wrapper, { changePollMs: 60_000 });
    pools.push(stores.runtimePool);
    const heard = vi.fn();
    stores.changes.on('model-classifications', heard);

    await stores.modelClassifications.save('foundry-openai/gpt-4o', { residency: 'eu' });
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await stores.close();
    await stores.modelClassifications.save('foundry-openai/gpt-4o', { residency: 'norway' });
    await stores.changes.poll();

    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('reports dropped connections instead of crashing, and recovers on new connections', async () => {
    const owner = new pg.Pool({
      connectionString: container.getConnectionUri(),
      application_name: 'dropped-by-server',
    });
    pools.push(owner);
    const errors: unknown[] = [];
    const stores = await createPostgresStores(owner, wrapper, {
      changePollMs: 60_000,
      onError: (error) => errors.push(error),
    });
    pools.push(stores.runtimePool);
    await stores.modelClassifications.save('foundry-openai/gpt-4o', { residency: 'eu' });

    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where application_name = 'dropped-by-server'`,
    );
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 3000 });
    await vi.waitFor(
      () => stores.modelClassifications.save('foundry-openai/gpt-4o', { residency: 'norway' }),
      { timeout: 5000 },
    );

    expect(owner.listenerCount('error')).toBe(1);
    expect((await stores.modelClassifications.load())['foundry-openai/gpt-4o']).toEqual(
      expect.objectContaining({ residency: 'norway' }),
    );
    await stores.close();
  });
});
