import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeBranch } from '@genai/conversations';
import { apiKeyDigest, legacyCredential, verifyApiKey } from '@genai/identity';
import {
  ContentKeys,
  createPool,
  grantRuntimeRole,
  LocalKeyWrapper,
  migrate,
  PostgresApiKeys,
  PostgresConversationStore,
} from './index.js';

let container: StartedPostgreSqlContainer;
let admin: pg.Pool;
let runtime: pg.Pool;
const ORG = '991825827';
const OTHER = '889640782';
const plaintext = `rag_${'ab'.repeat(32)}`;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  await migrate(admin);
  await admin.query(`create role genai_api login password 'runtime-pw' nosuperuser nobypassrls`);
  await grantRuntimeRole(admin, 'genai_api');
  runtime = createPool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: 'genai_api',
    password: 'runtime-pw',
  });
}, 120_000);

afterAll(async () => {
  await runtime?.end();
  await admin?.end();
  await container?.stop();
});

const base = (id: string, digest: string) => ({
  id,
  name: id,
  digest,
  tenant: ORG,
  scopes: ['query' as const],
  datasets: [],
  agents: [],
});

describe('restoring headless-rag keys', () => {
  it('keeps grants, policy union, usage and revocation, and authenticates the original plaintext', async () => {
    const keys = new PostgresApiKeys(runtime);
    const credential = legacyCredential({ plaintext });
    if (!credential) throw new Error('no credential');
    const policy = {
      id: 'pol-1',
      tenant: ORG,
      name: 'Ingest',
      scopes: ['ingest' as const],
      datasets: ['digdir/kudos'],
      agents: ['kunnskapsassistenten'],
    };
    await keys.restore(
      {
        ...base('ka-prod', credential.digest),
        ...credential,
        skillGraphs: ['builtin/agent-rag-graph-faithful'],
        allowedConfigKeys: ['runtime:default'],
        policy,
        usageCount: 42,
        lastUsedAt: '2026-09-21T14:13:20.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      policy,
    );
    await keys.restore({
      ...base('gone', apiKeyDigest('rag_other')),
      revokedAt: '2026-02-01T00:00:00.000Z',
    });

    const identity = await verifyApiKey(keys, plaintext, new Date('2026-10-09T00:00:00Z'));
    const usage = await keys.usage(ORG, 'ka-prod');

    expect(identity.grants).toMatchObject({
      scopes: ['ingest', 'query'],
      datasets: ['digdir/kudos'],
      agents: ['kunnskapsassistenten'],
      skillGraphs: ['builtin/agent-rag-graph-faithful'],
      allowedConfigKeys: ['runtime:default'],
    });
    expect(usage?.count).toBe(43);
    await expect(verifyApiKey(keys, 'rag_other', new Date())).rejects.toThrow(/revoked/);
    expect((await keys.list(ORG)).find((k) => k.id === 'gone')?.revokedAt).toBeDefined();
  });

  it('keeps the service a restored key is bound to', async () => {
    const keys = new PostgresApiKeys(runtime);
    await keys.restore({
      ...base('local-dev-ka', apiKeyDigest('dev-ka-key')),
      service: 'kunnskapsassistenten',
    });

    const identity = await verifyApiKey(keys, 'dev-ka-key');
    expect(identity.principal.confinedTo).toEqual({ tenant: ORG, service: 'kunnskapsassistenten' });
  });

  it('does not let a restore overwrite another tenant key with the same id', async () => {
    const keys = new PostgresApiKeys(runtime);
    await keys.restore({ ...base('shared-id', apiKeyDigest('rag_one')) });

    const changed = await keys
      .restore({ ...base('shared-id', apiKeyDigest('rag_two')), tenant: OTHER })
      .catch(() => false);

    expect(changed).toBe(false);
    expect((await keys.list(ORG)).find((k) => k.id === 'shared-id')?.digest).toBe(
      apiKeyDigest('rag_one'),
    );
  });
});

describe('conversations stored before branches existed', () => {
  const owner = { tenant: ORG, user: 'urn:genai:legacy-api-key|ka-prod#user-1' };

  it('reads rows stored before branches existed as one chain', async () => {
    const conversations = new PostgresConversationStore(
      runtime,
      new ContentKeys(runtime, new LocalKeyWrapper(randomBytes(32))),
    );
    const created = await conversations.create(owner, {
      agentId: 'kunnskapsassistenten',
      userId: 'user-1',
    });
    await conversations.append(owner, created.id, { role: 'user', text: 'Hei' });
    await conversations.append(owner, created.id, { role: 'assistant', text: 'Svar [1]' });
    await admin.query(
      `update conversation_messages set parent_seq = null where conversation = $1`,
      [created.id],
    );

    const old = (await conversations.messages(owner, created.id)) ?? [];
    await conversations.append(owner, created.id, { role: 'user', text: 'after' });
    const later = (await conversations.messages(owner, created.id)) ?? [];

    expect(old.map((m) => m.parentId)).toEqual([undefined, `${created.id}.0`, `${created.id}.1`]);
    expect(activeBranch(later).map((m) => m.text)).toEqual([
      old[0]?.text,
      'Hei',
      'Svar [1]',
      'after',
    ]);
  });
});

describe('managing access policies in Postgres', () => {
  it('lists, updates, attaches, detaches and deletes policies per tenant and enforces the edited union', async () => {
    const keys = new PostgresApiKeys(runtime);
    const credential = legacyCredential({ plaintext: 'rag_policy_admin_key' });
    if (!credential) throw new Error('no credential');
    await keys.add({ ...base('pol-key', credential.digest), ...credential });
    await keys.addPolicy({ id: 'pa', tenant: ORG, name: 'Første', agents: ['a'] });

    await keys.updatePolicy({
      id: 'pa',
      tenant: ORG,
      name: 'Andre',
      agents: ['a', 'b'],
      scopes: ['ingest'],
    });
    const otherTenant = await keys.updatePolicy({ id: 'pa', tenant: OTHER, name: 'Stjålet' });
    const attached = await keys.setKeyPolicy(ORG, 'pol-key', 'pa');
    const identity = await verifyApiKey(keys, 'rag_policy_admin_key', new Date());
    const listed = await keys.listPolicies(ORG);
    const listedKey = (await keys.list(ORG)).find((k) => k.id === 'pol-key');
    const detached = await keys.setKeyPolicy(ORG, 'pol-key', null);
    const deletedByOther = await keys.deletePolicy(OTHER, 'pa');
    const deleted = await keys.deletePolicy(ORG, 'pa');

    expect(otherTenant).toBe(false);
    expect(attached).toBe(true);
    expect(identity.grants).toMatchObject({ agents: ['a', 'b'], scopes: ['ingest', 'query'] });
    expect(listed.find((p) => p.id === 'pa')).toMatchObject({ name: 'Andre', agents: ['a', 'b'] });
    expect(listedKey?.policy?.id).toBe('pa');
    expect(detached).toBe(true);
    expect([deletedByOther, deleted]).toEqual([false, true]);
    expect((await keys.listPolicies(ORG)).some((p) => p.id === 'pa')).toBe(false);
    expect(await keys.listPolicies(OTHER)).toEqual([]);
  });
});
