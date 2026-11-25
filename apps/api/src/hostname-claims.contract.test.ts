import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryHostnameClaims, type HostnameClaim, type HostnameClaimStore } from '@genai/kernel';
import { createPostgresStores, LocalKeyWrapper } from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';

const ORG_A = '991825827';
const ORG_B = '889640782';

let container: StartedPostgreSqlContainer;
type Database = Awaited<ReturnType<typeof createPostgresStores>>;
const databases: Database[] = [];
const wrapper = new LocalKeyWrapper(randomBytes(32));

const connect = async () => {
  const db = await createPostgresStores(
    { connectionString: container.getConnectionUri() },
    wrapper,
  );
  databases.push(db);
  return db;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
}, 120_000);

afterAll(async () => {
  for (const db of databases) {
    await db.close();
    await db.runtimePool.end();
    await db.pool.end();
  }
  await stopPostgres(container);
});

let counter = 0;
const claimOf = (over: Partial<HostnameClaim>): HostnameClaim => {
  counter += 1;
  return {
    id: `claim-${counter}-${randomBytes(4).toString('hex')}`,
    tenant: ORG_A,
    client: 'klarsprak-host',
    service: 'klarsprak',
    hostname: `ka-${counter}.example.no`,
    environment: 'prod',
    apex: false,
    assigned: false,
    token: 'token-0123456789',
    state: 'pending-dns',
    step: 'add',
    stateSince: '2026-11-25T10:00:00.000Z',
    createdAt: '2026-11-25T10:00:00.000Z',
    createdBy: 'person:a',
    updatedAt: '2026-11-25T10:00:00.000Z',
    version: 1,
    ...over,
  };
};

const bump = (claim: HostnameClaim, patch: Partial<HostnameClaim>): HostnameClaim => ({
  ...claim,
  ...patch,
  version: claim.version + 1,
});

const stores: Record<string, () => Promise<HostnameClaimStore>> = {
  memory: async () => new InMemoryHostnameClaims(),
  postgres: async () => (await connect()).hostnameClaims,
};

describe.each(Object.keys(stores))('%s hostname claims', (name) => {
  const open = () => (stores[name] as () => Promise<HostnameClaimStore>)();

  it('keeps a claim with every field and lists it only for its own tenant', async () => {
    const claims = await open();
    const claim = claimOf({
      redirectTo: 'qa.example.no',
      check: { at: '2026-11-25T10:05:00.000Z', challenge: true, asuid: false, target: true },
      missingSince: '2026-11-25T10:05:00.000Z',
      certificateId: '/subscriptions/x/certificates/y',
      message: 'venter',
    });

    expect(await claims.create(claim)).toBe('ok');

    expect(await claims.get(ORG_A, claim.id)).toEqual(claim);
    expect(await claims.get(ORG_B, claim.id)).toBeUndefined();
    expect((await claims.list(ORG_A)).map((c) => c.id)).toContain(claim.id);
    expect((await claims.list(ORG_B)).map((c) => c.id)).not.toContain(claim.id);
    expect(await claims.find(claim.id)).toEqual(claim);
  });

  it('lets pending claims share a name and gives it to the first that is held', async () => {
    const claims = await open();
    const hostname = `delt-${randomBytes(3).toString('hex')}.example.no`;
    const a = claimOf({ hostname });
    const b = claimOf({ hostname, tenant: ORG_B });
    expect(await claims.create(a)).toBe('ok');
    expect(await claims.create(b)).toBe('ok');

    expect(await claims.update(bump(a, { state: 'binding' }))).toBe('ok');
    expect(await claims.update(bump(b, { state: 'binding' }))).toBe('taken');

    expect((await claims.holder(hostname))?.id).toBe(a.id);
    expect((await claims.get(ORG_B, b.id))?.state).toBe('pending-dns');
  });

  it('frees a name once its holder lapses', async () => {
    const claims = await open();
    const hostname = `fri-${randomBytes(3).toString('hex')}.example.no`;
    const a = claimOf({ hostname, state: 'active' });
    expect(await claims.create(a)).toBe('ok');
    expect(await claims.create(claimOf({ hostname, state: 'binding', tenant: ORG_B }))).toBe(
      'taken',
    );

    expect(await claims.update(bump(a, { state: 'lapsed' }))).toBe('ok');

    expect(await claims.create(claimOf({ hostname, state: 'binding', tenant: ORG_B }))).toBe('ok');
  });

  it('refuses a write from a stale version or another tenant', async () => {
    const claims = await open();
    const a = claimOf({});
    await claims.create(a);

    expect(await claims.update({ ...a, state: 'binding' })).toBe('stale');
    expect(await claims.update(bump({ ...a, tenant: ORG_B }, { state: 'binding' }))).toBe('stale');
    expect(await claims.update(bump(a, { state: 'binding' }))).toBe('ok');
    expect(await claims.update(bump(a, { state: 'failed' }))).toBe('stale');
  });

  it('lists claims across tenants by state for the worker and the binder', async () => {
    const claims = await open();
    const a = claimOf({ state: 'removing', step: 'unbind' });
    const b = claimOf({ state: 'removing', step: 'unbind', tenant: ORG_B });
    await claims.create(a);
    await claims.create(b);

    const ids = (await claims.inStates(['removing'], 1000)).map((c) => c.id);

    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
  });
});
