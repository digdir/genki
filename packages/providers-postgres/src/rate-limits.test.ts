import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresStores, LocalKeyWrapper, PostgresRateLimiter } from './index.js';

let container: StartedPostgreSqlContainer;
let stores: Awaited<ReturnType<typeof createPostgresStores>>;
const pools: pg.Pool[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const owner = new pg.Pool({ connectionString: container.getConnectionUri() });
  pools.push(owner);
  stores = await createPostgresStores(owner, new LocalKeyWrapper(randomBytes(32)));
  pools.push(stores.runtimePool);
}, 120_000);

afterAll(async () => {
  await stores?.close();
  await Promise.all(pools.map((p) => p.end()));
  await container?.stop();
});

describe('the shared rate limit', () => {
  it('holds one per-key limit across API replicas', async () => {
    const replicaA = new PostgresRateLimiter(stores.runtimePool);
    const replicaB = new PostgresRateLimiter(stores.runtimePool);
    const decisions = [];
    for (let i = 0; i < 3; i++) {
      decisions.push(await replicaA.take('key:shared', 4));
      decisions.push(await replicaB.take('key:shared', 4));
    }
    expect(decisions.filter((d) => d.ok)).toHaveLength(4);
    expect(decisions.at(-1)).toMatchObject({ ok: false });
    expect(await replicaA.take('key:other', 4)).toEqual({ ok: true });
  });

  it('counts concurrent calls exactly once each', async () => {
    const limiter = new PostgresRateLimiter(stores.runtimePool);
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => limiter.take('key:burst', 7)),
    );
    expect(decisions.filter((d) => d.ok)).toHaveLength(7);
  });

  it('says when to retry once the oldest call leaves the window', async () => {
    const limiter = new PostgresRateLimiter(stores.runtimePool, 2_000);
    await limiter.take('key:retry', 1);
    const refused = await limiter.take('key:retry', 1);
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 2 });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(await limiter.take('key:retry', 1)).toEqual({ ok: true });
  });
});

describe('API key grants in postgres', () => {
  it('stores skill-graph and config-key grants and loads the access policy with the key', async () => {
    const tenant = '991825827';
    await stores.apiKeys.addPolicy({
      id: 'policy-1',
      tenant,
      name: 'KA',
      scopes: ['query'],
      agents: ['kunnskapsassistenten'],
      skillGraphs: ['builtin/agent-rag-graph-bundled'],
      allowedConfigKeys: ['dataset:kudos'],
    });
    const digest = 'cd'.repeat(32);
    await stores.apiKeys.add({
      id: 'key-grants',
      name: 'n',
      digest,
      tenant,
      scopes: [],
      datasets: [],
      agents: [],
      skillGraphs: ['builtin/retrieve-only'],
      allowedConfigKeys: ['runtime:default'],
      policy: { id: 'policy-1' },
    });

    expect(await stores.apiKeys.findByDigest(digest)).toMatchObject({
      skillGraphs: ['builtin/retrieve-only'],
      allowedConfigKeys: ['runtime:default'],
      policy: {
        id: 'policy-1',
        scopes: ['query'],
        agents: ['kunnskapsassistenten'],
        skillGraphs: ['builtin/agent-rag-graph-bundled'],
        allowedConfigKeys: ['dataset:kudos'],
      },
    });
  });
});
