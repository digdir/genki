import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  createPostgresStores,
  LocalKeyWrapper,
  withTenant,
} from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { sessionIdHash } from './sessions.js';

const ORG_A = '991825827';
const ORG_B = '889640782';
const wrapper = new LocalKeyWrapper(randomBytes(32));

let container: StartedPostgreSqlContainer;
const pools: ReturnType<typeof createPool>[] = [];
const opened: { close(): Promise<void> }[] = [];

const open = async () => {
  const pool = createPool({ connectionString: container.getConnectionUri() });
  pools.push(pool);
  const stores = await createPostgresStores(pool, wrapper, { pollMs: 60_000 });
  pools.push(stores.runtimePool);
  opened.push(stores);
  return stores.bffSessions;
};

const row = (payload = '{"accessToken":"a","accessExpiresAt":1,"organisations":[]}') => ({
  hostname: 'ka.example.no',
  client: 'ka-host',
  expiresAt: Date.now() + 3600_000,
  payload,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
}, 120_000);

afterAll(async () => {
  for (const stores of opened) await stores.close();
  await stopPostgres(container, pools);
});

describe('BFF sessions in Postgres', () => {
  it('keeps a session through a restart, read by a new process with the same store', async () => {
    const id = sessionIdHash('first');
    await (await open()).create(ORG_A, id, row());
    const restarted = await open();
    expect((await restarted.get(ORG_A, id))?.payload).toContain('"accessToken":"a"');
  });

  it('keeps one tenant from reading, changing or deleting another tenant session', async () => {
    const sessions = await open();
    const id = sessionIdHash('isolated');
    await sessions.create(ORG_A, id, row());
    expect(await sessions.get(ORG_B, id)).toBeUndefined();
    expect(await sessions.update(ORG_B, id, async (r) => r)).toBeUndefined();
    expect(await sessions.delete(ORG_B, id)).toBe(false);
    expect(await sessions.get(ORG_A, id)).toBeDefined();
  });

  it('stores the tokens sealed, not in clear text', async () => {
    const sessions = await open();
    const id = sessionIdHash('sealed');
    await sessions.create(ORG_A, id, row('{"accessToken":"plain-token-value"}'));
    const pool = pools[0];
    if (!pool) throw new Error('no pool');
    const raw = await withTenant(pool, ORG_A, (client) =>
      client.query<{ sealed: Buffer }>('select sealed from bff_sessions where id_hash = $1', [id]),
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]?.sealed.toString('latin1')).not.toContain('plain-token-value');
  });

  it('forgets an expired session and deletes a session on logout', async () => {
    const sessions = await open();
    const old = sessionIdHash('old');
    await sessions.create(ORG_A, old, { ...row(), expiresAt: Date.now() - 1000 });
    expect(await sessions.get(ORG_A, old)).toBeUndefined();
    const live = sessionIdHash('live');
    await sessions.create(ORG_A, live, row());
    expect(await sessions.delete(ORG_A, live)).toBe(true);
    expect(await sessions.get(ORG_A, live)).toBeUndefined();
  });

  it('a back-channel logout ends the sessions carrying its key in every tenant and no others', async () => {
    const sessions = await open();
    const [a, b, other] = ['logout-a', 'logout-b', 'logout-other'].map(sessionIdHash) as [
      string,
      string,
      string,
    ];
    await sessions.create(ORG_A, a, { ...row(), logoutKeys: ['sid-1', 'sub-1'] });
    await sessions.create(ORG_B, b, { ...row(), logoutKeys: ['sid-2', 'sub-1'] });
    await sessions.create(ORG_A, other, { ...row(), logoutKeys: ['sid-3', 'sub-3'] });
    expect(await sessions.endByLogoutKeys(['sub-1'])).toBe(2);
    expect(await sessions.get(ORG_A, a)).toBeUndefined();
    expect(await sessions.get(ORG_B, b)).toBeUndefined();
    expect(await sessions.get(ORG_A, other)).toBeDefined();
  });

  it('claims a row only once, so a logout token’s jti cannot be replayed', async () => {
    const sessions = await open();
    const jti = sessionIdHash('logout-jti:1');
    expect(await sessions.claim(ORG_A, jti, row())).toBe(true);
    expect(await sessions.claim(ORG_A, jti, row())).toBe(false);
    expect(await (await open()).claim(ORG_A, jti, row())).toBe(false);
  });
});
