import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { strategyKey, versionedRef, type PluginSchemas } from '@genai/definitions';
import { apiKeyDigest, verifyApiKey } from '@genai/identity';
import {
  ContentKeys,
  createPool,
  createPostgresStores,
  grantRuntimeRole,
  LocalKeyWrapper,
  migrate,
  PostgresAdminRecords,
  PostgresApiKeys,
  PostgresConnections,
  PostgresConversationStore,
  PostgresDefinitionStore,
  PostgresFeedbackStore,
  PostgresIdentities,
  PostgresTenants,
  PostgresTenantSecrets,
  PostgresTriggerRuns,
  PostgresWebhookDeliveries,
  threadScope,
  withTenant,
} from './index.js';
import { stopPostgres } from './testing/index.js';

let container: StartedPostgreSqlContainer;
let admin: pg.Pool;
let runtime: pg.Pool;
const pools: pg.Pool[] = [];
const wrapper = new LocalKeyWrapper(randomBytes(32));

const ORG_A = '991825827';
const ORG_B = '889640782';
const AGENT = 'kunnskapsassistenten__default';

const track = (pool: pg.Pool) => {
  pools.push(pool);
  return pool;
};

const runtimePool = (password: string | (() => Promise<string>) = 'runtime-pw') =>
  track(
    createPool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: 'genai_api',
      password,
    }),
  );

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = track(new pg.Pool({ connectionString: container.getConnectionUri() }));
  await migrate(admin);
  await admin.query(`create role genai_api login password 'runtime-pw' nosuperuser nobypassrls`);
  await grantRuntimeRole(admin, 'genai_api');
  runtime = runtimePool();
}, 120_000);

afterAll(async () => {
  await stopPostgres(container, pools);
});

const asTenant = async <T>(tenant: string | undefined, sql: string, params: unknown[] = []) => {
  const client = await runtime.connect();
  try {
    await client.query('begin');
    if (tenant) await client.query(`select set_config('app.tenant', $1, true)`, [tenant]);
    const result = await client.query<T & pg.QueryResultRow>(sql, params);
    await client.query('commit');
    return result.rows;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

describe('postgres conversations', () => {
  const store = () => new PostgresConversationStore(runtime, new ContentKeys(runtime, wrapper));
  const kari = { tenant: ORG_A, user: 'https://ansattporten.no|kari' };

  it('stores a thread with its seed messages and keeps content encrypted at rest', async () => {
    const conversations = store();
    const created = await conversations.create(kari, {
      agentId: AGENT,
      userId: 'kari',
      topic: 'Hemmelig tittel',
      tags: ['a', 'a', ' b '],
      filterValue: { fields: [] },
    });
    await conversations.append(kari, created.id, {
      role: 'user',
      text: 'Hva står i tildelingsbrevet?',
    });
    await conversations.append(kari, created.id, {
      role: 'assistant',
      text: 'Det står [1]',
      chunks: [
        { chunkId: 'c1', docTitle: 'Tildelingsbrev', docNum: 'd1', contentMarkdown: 'utdrag' },
      ],
    });

    const messages = await conversations.messages(kari, created.id);
    const raw = await admin.query(
      `select c.body::text as c, m.body::text as m from conversations c join conversation_messages m on m.conversation = c.id where c.id = $1`,
      [created.id],
    );

    expect(created).toMatchObject({ topic: 'Hemmelig tittel', tags: ['a', 'b'], userId: 'kari' });
    expect(messages?.map((m) => [m.role ?? null, m.text])).toEqual([
      ['system', 'You are a helpful assistant.'],
      [null, ''],
      ['user', 'Hva står i tildelingsbrevet?'],
      ['assistant', 'Det står [1]'],
    ]);
    expect(messages?.[1]?.filterValue).toEqual({ fields: [] });
    expect(messages?.[3]?.chunks[0]?.chunkId).toBe('c1');
    const created2 = messages?.map((m) => m.created) ?? [];
    expect([...created2].sort((x, y) => x - y)).toEqual(created2);
    expect(JSON.stringify(raw.rows)).not.toMatch(/Hemmelig|tildelingsbrevet|utdrag|kari/);
  });

  it('keeps the run an answer came from with the message', async () => {
    const conversations = store();
    const created = await conversations.create(kari, { agentId: AGENT, userId: 'kari' });
    await conversations.append(kari, created.id, { role: 'assistant', text: '', task: 'task-7' });

    expect((await conversations.messages(kari, created.id))?.at(-1)?.task).toBe('task-7');
  });

  it('keeps the sources of an answer with their index, title and url', async () => {
    const conversations = store();
    const created = await conversations.create(kari, { agentId: AGENT, userId: 'kari' });
    const sources = [
      { index: 1, title: 'Rapport', url: 'https://x.no/d1', document_id: 'd1', excerpts: [] },
    ];
    await conversations.append(kari, created.id, { role: 'assistant', text: '[1]', sources });

    expect((await conversations.messages(kari, created.id))?.at(-1)?.sources).toEqual(sources);
  });

  it('pages newest first with tag filters, renames, and refuses other owners', async () => {
    let clock = 1_000_000;
    const conversations = new PostgresConversationStore(
      runtime,
      new ContentKeys(runtime, wrapper),
      () => (clock += 10),
    );
    const ola = { tenant: ORG_A, user: 'https://ansattporten.no|ola' };
    const ids = [];
    for (const tags of [['x'], ['x', 'y'], ['y']])
      ids.push((await conversations.create(ola, { agentId: AGENT, userId: 'ola', tags })).id);

    const page = await conversations.list(ola, { pageSize: 2, pageIndex: 0 });
    const both = await conversations.list(ola, { pageSize: 10, pageIndex: 0, tags: ['x', 'y'] });
    const renamed = await conversations.update(ola, ids[0] as string, {
      topic: 'Ny tittel',
      tags: ['z'],
    });

    expect(page.total).toBe(3);
    expect(page.conversations.map((c) => c.tags)).toEqual([['y'], ['x', 'y']]);
    expect(both.total).toBe(1);
    expect(renamed).toMatchObject({ topic: 'Ny tittel', tags: ['z'] });
    expect(await conversations.get(kari, ids[0] as string)).toBeUndefined();
    expect(await conversations.messages(kari, ids[0] as string)).toBeUndefined();
    expect(await conversations.update(kari, ids[0] as string, { topic: 'x' })).toBeUndefined();
    expect(await conversations.append(kari, ids[0] as string, { text: 'x' })).toBeUndefined();
    expect(await conversations.delete(kari, ids[0] as string)).toBe(false);
    expect(
      await conversations.get({ tenant: ORG_B, user: ola.user }, ids[0] as string),
    ).toBeUndefined();
  });

  it('makes a thread unreadable when its key is erased, and erases the key on delete', async () => {
    const keys = new ContentKeys(runtime, wrapper);
    const conversations = new PostgresConversationStore(runtime, keys);
    const erasedOne = await conversations.create(kari, {
      agentId: AGENT,
      userId: 'kari',
      topic: 'Slettes',
    });
    await conversations.append(kari, erasedOne.id, { role: 'user', text: 'personopplysning' });

    await keys.erase(ORG_A, threadScope(erasedOne.id));
    const after = await new PostgresConversationStore(
      runtime,
      new ContentKeys(runtime, wrapper),
    ).get(kari, erasedOne.id);
    const messages = await new PostgresConversationStore(
      runtime,
      new ContentKeys(runtime, wrapper),
    ).messages(kari, erasedOne.id);

    expect(after?.topic).toBe('');
    expect(messages?.every((m) => m.text === '')).toBe(true);

    const deleted = await conversations.create(kari, { agentId: AGENT, userId: 'kari' });
    expect(await conversations.delete(kari, deleted.id)).toBe(true);
    expect(
      await admin.query('select 1 from content_keys where tenant = $1 and scope = $2', [
        ORG_A,
        threadScope(deleted.id),
      ]),
    ).toMatchObject({
      rowCount: 0,
    });
    expect(
      await admin.query('select 1 from conversation_messages where conversation = $1', [
        deleted.id,
      ]),
    ).toMatchObject({ rowCount: 0 });
  });
});

describe('row-level security', () => {
  it('keeps two organisations from seeing or writing each other’s rows, even with raw SQL', async () => {
    const conversations = new PostgresConversationStore(runtime, new ContentKeys(runtime, wrapper));
    const a = await conversations.create(
      { tenant: ORG_A, user: 'u' },
      { agentId: AGENT, userId: 'u' },
    );
    const b = await conversations.create(
      { tenant: ORG_B, user: 'u' },
      { agentId: AGENT, userId: 'u' },
    );

    const seenByA = await asTenant<{ id: string }>(ORG_A, 'select id from conversations');
    const messagesSeenByA = await asTenant<{ conversation: string }>(
      ORG_A,
      'select conversation from conversation_messages',
    );
    const seenWithoutTenant = await asTenant(undefined, 'select id from conversations');

    expect(seenByA.map((r) => r.id)).toContain(a.id);
    expect(seenByA.map((r) => r.id)).not.toContain(b.id);
    expect(messagesSeenByA.map((r) => r.conversation)).not.toContain(b.id);
    expect(seenWithoutTenant).toEqual([]);
    expect(
      await asTenant(ORG_A, 'update conversations set agent_id = $1 where id = $2 returning id', [
        'x',
        b.id,
      ]),
    ).toEqual([]);
    expect(
      await asTenant(ORG_A, 'delete from conversations where id = $1 returning id', [b.id]),
    ).toEqual([]);
    await expect(
      asTenant(
        ORG_A,
        `insert into conversations (id, tenant, owner_hash, agent_id, created, body) values ('forged', $1, 'h', 'a', 0, '\\x00')`,
        [ORG_B],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('creates a tenant once on first admin login and shows it only to itself', async () => {
    const tenants = new PostgresTenants(runtime);

    const first = await tenants.ensure(ORG_A, {
      createdBy: 'employee:ansattporten:kari',
      name: 'Digdir',
    });
    const again = await tenants.ensure(ORG_A, { createdBy: 'employee:ansattporten:ola' });
    await tenants.ensure(ORG_B, { createdBy: 'employee:ansattporten:per' });

    expect(first.created).toBe(true);
    expect(again).toMatchObject({
      created: false,
      tenant: { createdBy: 'employee:ansattporten:kari', name: 'Digdir' },
    });
    expect(
      (await asTenant<{ org_number: string }>(ORG_A, 'select org_number from tenants')).map(
        (r) => r.org_number,
      ),
    ).toEqual([ORG_A]);
    await expect(tenants.ensure('12345', { createdBy: 'x' })).rejects.toThrow(/nine digits/);
  });
});

describe('API keys', () => {
  const digest = (n: number) => n.toString(16).padStart(64, '0');

  it('finds a key by digest before the tenant is known, and counts its use', async () => {
    const keys = new PostgresApiKeys(runtime);
    await keys.add({
      id: 'key-ka',
      name: 'Kunnskapsassistenten',
      digest: digest(1),
      tenant: ORG_A,
      scopes: ['query'],
      datasets: [],
      agents: [AGENT],
      prefix: 'hr_',
      lastFour: 'abcd',
    });

    const found = await keys.findByDigest(digest(1));
    await keys.touch('key-ka', new Date('2026-10-06T12:00:00Z'));
    await keys.touch('key-ka', new Date('2026-10-06T12:05:00Z'));

    expect(found).toEqual({
      id: 'key-ka',
      name: 'Kunnskapsassistenten',
      digest: digest(1),
      tenant: ORG_A,
      scopes: ['query'],
      datasets: [],
      agents: [AGENT],
    });
    expect(await keys.usage(ORG_A, 'key-ka')).toEqual({
      count: 2,
      lastUsedAt: '2026-10-06T12:05:00.000Z',
    });
    expect(await keys.findByDigest(digest(999))).toBeUndefined();
    expect(await keys.findByDigest("' or 1=1 --")).toBeUndefined();
  });

  it('keeps the service binding and allowed overrides of a service key', async () => {
    const keys = new PostgresApiKeys(runtime);
    await keys.add({
      id: 'key-service',
      name: 'KA-server',
      digest: apiKeyDigest('gp_service_key'),
      tenant: ORG_A,
      scopes: ['query'],
      datasets: [],
      agents: [],
      service: 'kunnskapsassistenten',
      allowedOverrides: ['retrieval.*', 'answer.language'],
    });

    expect((await keys.list(ORG_A)).find((k) => k.id === 'key-service')).toMatchObject({
      service: 'kunnskapsassistenten',
      allowedOverrides: ['retrieval.*', 'answer.language'],
      agents: [],
    });
    const verified = await verifyApiKey(keys, 'gp_service_key');
    expect(verified.principal.confinedTo).toEqual({
      tenant: ORG_A,
      service: 'kunnskapsassistenten',
    });
    expect(verified.grants.allowedOverrides).toEqual(['retrieval.*', 'answer.language']);
  });

  it('keeps the calls per minute of a key', async () => {
    const keys = new PostgresApiKeys(runtime);
    const key = (id: string, n: number, callsPerMinute?: number) => ({
      id,
      name: id,
      digest: digest(n),
      tenant: ORG_A,
      scopes: ['query' as const],
      datasets: ['*'],
      agents: ['*'],
      ...(callsPerMinute ? { callsPerMinute } : {}),
    });
    await keys.add(key('key-slow', 10, 30));
    await keys.add(key('key-default', 11));

    const listed = await keys.list(ORG_A);
    expect(listed.find((k) => k.id === 'key-slow')?.callsPerMinute).toBe(30);
    expect(listed.find((k) => k.id === 'key-default')).not.toHaveProperty('callsPerMinute');
    expect((await keys.findByDigest(digest(10)))?.callsPerMinute).toBe(30);
  });

  it('turns keys made for everything, legacy ones included, into explicit all grants on migration', async () => {
    const keys = new PostgresApiKeys(runtime);
    const key = (id: string, n: number, fields: Record<string, unknown> = {}) => ({
      id,
      name: id,
      digest: digest(n),
      tenant: ORG_A,
      scopes: ['query' as const],
      datasets: [],
      agents: [],
      ...fields,
    });
    await keys.add(key('old-all', 20));
    await keys.add(key('old-legacy', 21));
    await admin.query(`update legacy_api_keys set legacy = true where id = 'old-legacy'`);
    await keys.add(key('old-service', 22, { service: 'kunnskapsassistenten' }));
    await keys.add(key('old-some', 23, { agents: [AGENT] }));

    await migrate(admin);
    await migrate(admin);

    const grants = Object.fromEntries(
      (await keys.list(ORG_A)).map((k) => [k.id, [k.agents, k.datasets]]),
    );
    expect(grants['old-all']).toEqual([['*'], ['*']]);
    expect(grants['old-legacy']).toEqual([['*'], ['*']]);
    expect(
      (await admin.query(`select count(*)::int as n from legacy_api_keys where legacy`)).rows[0],
    ).toEqual({ n: 0 });
    expect(grants['old-service']).toEqual([[], []]);
    expect(grants['old-some']).toEqual([[AGENT], []]);
  });

  it('keeps every other access to keys inside the tenant', async () => {
    const keys = new PostgresApiKeys(runtime);
    await keys.add({
      id: 'key-nav',
      name: 'NAV',
      digest: digest(2),
      tenant: ORG_B,
      scopes: ['query'],
      datasets: [],
      agents: [],
    });

    expect((await keys.list(ORG_A)).map((k) => k.id)).not.toContain('key-nav');
    expect(await keys.revoke(ORG_A, 'key-nav')).toBe(false);
    expect(await keys.usage(ORG_A, 'key-nav')).toBeUndefined();
    expect(await asTenant(undefined, 'select id from legacy_api_keys')).toEqual([]);
    await expect(
      keys
        .add({
          id: 'forged',
          name: 'x',
          digest: digest(3),
          tenant: ORG_B,
          scopes: ['admin'],
          datasets: [],
          agents: [],
        })
        .then(() =>
          asTenant(
            ORG_A,
            `insert into legacy_api_keys (id, digest, name, tenant, scopes, created_at) values ('f2', $1, 'x', $2, '{admin}', now())`,
            [digest(4), ORG_B],
          ),
        ),
    ).rejects.toThrow(/row-level security/);

    expect(await keys.revoke(ORG_B, 'key-nav')).toBe(true);
    expect((await keys.findByDigest(digest(2)))?.revokedAt).toBeDefined();
  });
});

describe('identity lookup', () => {
  it('remembers a person id encrypted and forgets it', async () => {
    const identities = new PostgresIdentities(runtime, new ContentKeys(runtime, wrapper));
    await identities.remember('https://ansattporten.no', 'pairwise-1', '01017012345');

    const raw = await admin.query('select person::text as p from identities');

    expect(await identities.personId('https://ansattporten.no', 'pairwise-1')).toBe('01017012345');
    expect(await identities.personId('https://ansattporten.no', 'other')).toBeUndefined();
    expect(JSON.stringify(raw.rows)).not.toContain('01017012345');
    await identities.forget('https://ansattporten.no', 'pairwise-1');
    expect(await identities.personId('https://ansattporten.no', 'pairwise-1')).toBeUndefined();
  });
});

describe('postgres definition store', () => {
  const plugins: PluginSchemas = {
    strategies: new Map<string, z.ZodType>([
      [strategyKey('single-call', 1), z.strictObject({ instructions: z.string() })],
      [strategyKey('step-flow', 1), z.strictObject({ flow: versionedRef })],
    ]),
    tools: new Map(),
    guardrails: new Map(),
    blocks: new Set(['classify@1']),
    models: new Map([
      ['foundry/gpt-4o', { residency: 'norway', capabilities: ['stream', 'tools', 'json-schema'] }],
    ]),
  };

  const service = (tenant: string, id: string, extra: Record<string, unknown> = {}) => ({
    apiVersion: 'genai/v1',
    kind: 'Service',
    metadata: { tenant, id, name: id },
    spec: {
      purpose: 'Skriv om tekst i klarspråk',
      riskClass: 'limited',
      input: { accepts: ['text/plain'] },
      output: { kind: 'answer' },
      strategy: { id: 'single-call', version: 1, config: { instructions: 'Skriv klart.' } },
      model: { primary: 'foundry/gpt-4o', residency: 'norway' },
      exposure: { rest: true },
      ...extra,
    },
  });

  const flow = (tenant: string, id: string) => ({
    apiVersion: 'genai/v1',
    kind: 'StepFlow',
    metadata: { tenant, id, name: id },
    spec: { purpose: 'Sorter post', steps: [{ id: 'sort', block: 'classify@1' }] },
  });

  it('a service publishes against a recipe shared from another tenant only while it is shared, and row-level security still keeps each tenant to its own rows', async () => {
    const recipePlugins: PluginSchemas = {
      ...plugins,
      strategies: new Map<string, z.ZodType>([
        [strategyKey('single-call', 1), z.strictObject({ instructions: z.string() })],
        [
          strategyKey('step-flow', 1),
          z.strictObject({
            flow: versionedRef,
            settings: z.record(z.string(), z.unknown()).optional(),
          }),
        ],
      ]),
    };
    let shared = false;
    const store: PostgresDefinitionStore = new PostgresDefinitionStore(
      runtime,
      recipePlugins,
      undefined,
      undefined,
      async (tenant, id, version) =>
        shared && tenant !== ORG_A
          ? ((await store.get('StepFlow', ORG_A, id, version))?.definition as never)
          : undefined,
    );
    const recipe = {
      ...flow(ORG_A, 'delt-sortering'),
      spec: {
        ...flow(ORG_A, 'delt-sortering').spec,
        recipe: { title: { nb: 'Sorter', en: 'Sort' }, summary: { nb: 'Velg', en: 'Pick' } },
      },
    };
    const using = service(ORG_B, 'post-b', {
      strategy: { id: 'step-flow', version: 1, config: { flow: 'delt-sortering@1', settings: {} } },
    });
    expect((await store.publish(recipe, 'employee:kari', 'oppskrift')).ok).toBe(true);

    const unshared = await store.publish(using, 'employee:ola', 'uten deling');
    shared = true;
    const published = await store.publish(using, 'employee:ola', 'med deling');

    expect(unshared.ok ? [] : unshared.errors.map((e) => e.message)).toEqual([
      'no published step flow delt-sortering@1',
    ]);
    expect(published.ok).toBe(true);
    const rows = await withTenant(
      runtime,
      ORG_B,
      async (client) =>
        (
          await client.query<{ tenant: string; id: string }>(
            `select tenant, id from definition_versions where id in ('delt-sortering', 'post-b') order by id`,
          )
        ).rows,
    );
    expect(rows).toEqual([
      { tenant: ORG_A, id: 'delt-sortering' },
      { tenant: ORG_B, id: 'post-b' },
    ]);
    await expect(
      withTenant(runtime, ORG_B, (client) =>
        client.query(
          `insert into definition_versions (kind, tenant, id, version, definition, published_by, published_at, reason)
           values ('StepFlow', $1, 'delt-sortering', 2, '{}', 'x', now(), 'r')`,
          [ORG_A],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(runtime, ORG_B, (client) =>
        client.query(`delete from definition_versions where tenant = $1 returning id`, [ORG_A]),
      ).then((r) => r.rows),
    ).resolves.toEqual([]);
  });

  it('versions publishes, lists per tenant and resolves public names and aliases', async () => {
    const store = new PostgresDefinitionStore(
      runtime,
      plugins,
      () => new Date('2026-10-06T10:00:00Z'),
    );
    const first = await store.publish(service(ORG_A, 'klarsprak'), 'employee:kari', 'first');
    const second = await store.publish(
      service(ORG_A, 'klarsprak', {
        variants: [{ id: 'default', aliases: ['klarsprak-alias'] }],
      }),
      'employee:kari',
      'add alias',
    );

    expect(first.ok && first.version.version).toBe(1);
    expect(second.ok && second.version).toMatchObject({
      version: 2,
      publishedBy: 'employee:kari',
      reason: 'add alias',
      publishedAt: '2026-10-06T10:00:00.000Z',
    });
    expect((await store.versions('Service', ORG_A, 'klarsprak')).map((v) => v.version)).toEqual([
      1, 2,
    ]);
    expect((await store.get('Service', ORG_A, 'klarsprak', 1))?.reason).toBe('first');
    expect(await store.list(ORG_A)).toContainEqual({ kind: 'Service', id: 'klarsprak' });
    expect(await store.list(ORG_B)).not.toContainEqual({ kind: 'Service', id: 'klarsprak' });
    expect((await store.resolve('klarsprak-alias'))?.service).toMatchObject({
      tenant: ORG_A,
      id: 'klarsprak',
      version: 2,
    });
    expect(await store.resolve('klarsprak-alias', 1)).toBeUndefined();
    expect((await store.capabilities()).some((c) => c.service.id === 'klarsprak')).toBe(true);
  });

  it('refuses a public name another tenant uses, a missing step flow, and an empty reason', async () => {
    const store = new PostgresDefinitionStore(runtime, plugins);
    await store.publish(
      service(ORG_A, 'unik', { variants: [{ id: 'default', aliases: ['delt-navn'] }] }),
      'a',
      'r',
    );

    const clash = await store.publish(
      service(ORG_B, 'annen', { variants: [{ id: 'default', aliases: ['delt-navn'] }] }),
      'b',
      'r',
    );
    const noFlow = await store.publish(
      service(ORG_A, 'sortering', {
        strategy: { id: 'step-flow', version: 1, config: { flow: 'sorter@1' } },
      }),
      'a',
      'r',
    );
    expect((await store.publish(flow(ORG_A, 'sorter'), 'a', 'r')).ok).toBe(true);
    const withFlow = await store.publish(
      service(ORG_A, 'sortering', {
        strategy: { id: 'step-flow', version: 1, config: { flow: 'sorter@1' } },
      }),
      'a',
      'r',
    );

    expect(!clash.ok && clash.errors[0]?.message).toMatch(
      /delt-navn is used by Service:991825827\/unik/,
    );
    expect(!noFlow.ok && noFlow.errors[0]?.message).toBe('no published step flow sorter@1');
    expect(withFlow.ok).toBe(true);
    expect((await store.publish(service(ORG_A, 'x'), 'a', '  ')).ok).toBe(false);
  });

  it('refuses to publish a service whose step flow calls a tool the service does not list in spec.tools', async () => {
    const store = new PostgresDefinitionStore(runtime, {
      ...plugins,
      tools: new Map([['saker.sok@1', z.strictObject({})]]),
      blocks: new Set(['classify@1', 'tool@1']),
    });
    const lookup = {
      ...flow(ORG_A, 'saksflyt'),
      spec: {
        purpose: 'Slå opp en sak',
        steps: [{ id: 'oppslag', block: 'tool@1', params: { source: 'saker', tool: 'sok' } }],
      },
    };
    expect((await store.publish(lookup, 'a', 'r')).ok).toBe(true);
    const using = (tools: string[]) =>
      service(ORG_A, 'saksoppslag', {
        tools,
        strategy: { id: 'step-flow', version: 1, config: { flow: 'saksflyt@1' } },
      });

    const missing = await store.publish(using([]), 'a', 'r');
    const listed = await store.publish(using(['saker.sok@1']), 'a', 'r');

    expect(missing.ok ? [] : missing.errors).toEqual([
      {
        path: 'spec.tools',
        message:
          'step oppslag in saksflyt@1 calls the tool saker.sok, which the service does not have in spec.tools',
      },
    ]);
    expect(listed.ok ? [] : listed.errors).toEqual([]);
  });

  it('round-trips a Skill with whole-number versions and lets a service pin only a published one', async () => {
    const store = new PostgresDefinitionStore(runtime, plugins);
    const skill = {
      apiVersion: 'genai/v1',
      kind: 'Skill',
      metadata: { tenant: ORG_A, id: 'klarsprak-sjekk', name: 'Klarspråksjekk' },
      spec: {
        description: 'Bruk når teksten skal sjekkes for klarspråk.',
        instructions: 'Pek på lange setninger.',
        testset: { cases: [{ input: 'Skriv et dikt', expected: 'Avvis', type: 'must_reject' }] },
      },
    };

    const early = await store.publish(
      service(ORG_A, 'med-ferdighet', { skills: ['klarsprak-sjekk@1'] }),
      'a',
      'r',
    );
    const published = await store.publish(skill, 'employee:kari', 'første versjon');
    const pinned = await store.publish(
      service(ORG_A, 'med-ferdighet', { skills: ['klarsprak-sjekk@1'] }),
      'a',
      'r',
    );

    expect(!early.ok && early.errors[0]?.message).toBe('no published skill klarsprak-sjekk@1');
    expect(published.ok && published.capabilities).toEqual([]);
    expect(await store.get('Skill', ORG_A, 'klarsprak-sjekk')).toMatchObject({
      version: 1,
      reason: 'første versjon',
      definition: {
        kind: 'Skill',
        spec: { tools: [], testset: { cases: [{ type: 'must_reject' }] } },
      },
    });
    expect(await store.list(ORG_A)).toContainEqual({ kind: 'Skill', id: 'klarsprak-sjekk' });
    expect(pinned.ok).toBe(true);
    expect(await store.resolve('klarsprak-sjekk')).toBeUndefined();
  });

  it('gives concurrent publishes of the same service distinct version numbers', async () => {
    const store = new PostgresDefinitionStore(runtime, plugins);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => store.publish(service(ORG_B, 'samtidig'), 'b', `r${i}`)),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect((await store.versions('Service', ORG_B, 'samtidig')).map((v) => v.version)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });
});

describe('admin stores under row-level security', () => {
  it('keeps tenant secrets, connections, test sets and feedback inside their tenant', async () => {
    const keys = new ContentKeys(runtime, wrapper);
    await new PostgresTenantSecrets(runtime, keys).set(ORG_A, 'token', 'verdi');
    await new PostgresConnections(runtime).register({
      id: 'kilde',
      tenant: ORG_A,
      name: 'Kilde',
      endpoint: 'https://mcp.example.no/mcp',
      version: '1',
      allow: [{ host: 'mcp.example.no' }],
    });
    await new PostgresFeedbackStore(runtime, keys).save({
      tenant: ORG_A,
      task: 't1',
      rating: 'up',
      by: { kind: 'person', id: 'p' },
      at: '2026-10-07T08:00:00.000Z',
    });

    for (const table of ['tenant_secrets', 'tool_connections', 'eval_feedback']) {
      expect(await asTenant(ORG_B, `select * from ${table}`)).toEqual([]);
      expect(await asTenant(undefined, `select * from ${table}`)).toEqual([]);
      expect(await asTenant(ORG_A, `select * from ${table}`)).toHaveLength(1);
    }
    expect(await new PostgresTenantSecrets(runtime, keys).get(ORG_B, 'token')).toBeUndefined();
    await expect(
      asTenant(ORG_B, `insert into tenant_secrets (tenant, name, value) values ($1, 'x', 'y')`, [
        ORG_A,
      ]),
    ).rejects.toThrow(/row-level security/);
  });

  it('lists the secret names of one tenant and never their values', async () => {
    const secrets = new PostgresTenantSecrets(runtime, new ContentKeys(runtime, wrapper));
    await secrets.set(ORG_A, 'lovdata-token', 'hemmelig-verdi');
    await secrets.set(ORG_A, 'api-key', 'hemmelig-verdi');
    await secrets.set(ORG_B, 'annen', 'hemmelig-verdi');

    const names = await secrets.list(ORG_A);

    expect(names).toEqual(expect.arrayContaining(['api-key', 'lovdata-token']));
    expect(names).not.toContain('annen');
    expect(JSON.stringify(names)).not.toContain('hemmelig-verdi');
    expect(await secrets.list(ORG_B)).toEqual(['annen']);
  });

  it('loads support sessions at startup and reads audit for every tenant through definer functions', async () => {
    const records = await PostgresAdminRecords.open(runtime);
    await records.saveSession({
      id: 'rls-session',
      operator: 'operator:x',
      tenant: ORG_B,
      reason: 'feilsøking',
      openedAt: '2026-10-07T08:00:00.000Z',
      expiresAt: '2026-10-07T09:00:00.000Z',
    });
    await records.appendAudit({
      task: 'rls-task',
      tenant: ORG_A,
      action: 'platform.support.open',
      actor: 'operator:x',
      at: '2026-10-07T08:00:00.000Z',
      outcome: 'applied',
      target: 'support',
      reason: 'feilsøking',
    });

    const reopened = await PostgresAdminRecords.open(runtime);

    expect(reopened.sessions().map((s) => s.id)).toContain('rls-session');
    expect((await reopened.audit(ORG_A)).map((a) => a.task)).toContain('rls-task');
    expect((await reopened.audit(ORG_B)).map((a) => a.task)).not.toContain('rls-task');
    expect((await reopened.audit()).map((a) => a.task)).toContain('rls-task');
    expect(await asTenant(ORG_B, 'select * from admin_audit')).toEqual([]);
  });
});

describe('webhook deliveries', () => {
  it('keeps delivery history inside the tenant, newest first', async () => {
    const deliveries = new PostgresWebhookDeliveries(runtime);
    for (const [id, at, ok] of [
      ['d1', '2026-10-07T08:00:00.000Z', true],
      ['d2', '2026-10-07T09:00:00.000Z', false],
    ] as const)
      await deliveries.record({
        id,
        tenant: ORG_A,
        client: 'ka-web',
        event: 'task.completed',
        at,
        ok,
        ...(ok ? { status: 204 } : { error: 'timeout' }),
      });

    expect((await deliveries.recent(ORG_A, 'ka-web', 10)).map((d) => d.id)).toEqual(['d2', 'd1']);
    expect(await deliveries.recent(ORG_A, 'ka-web', 1)).toEqual([
      {
        id: 'd2',
        tenant: ORG_A,
        client: 'ka-web',
        event: 'task.completed',
        at: '2026-10-07T09:00:00.000Z',
        ok: false,
        error: 'timeout',
      },
    ]);
    expect(await deliveries.recent(ORG_B, 'ka-web', 10)).toEqual([]);
    expect(await asTenant(ORG_B, 'select * from webhook_deliveries')).toEqual([]);
    expect(await asTenant(undefined, 'select * from webhook_deliveries')).toEqual([]);
    await expect(
      asTenant(
        ORG_B,
        `insert into webhook_deliveries (id, tenant, client, event, at, ok)
         values ('x', $1, 'c', 'ping', now(), true)`,
        [ORG_A],
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
describe('trigger runs', () => {
  it('counts runs since a time and keeps the newest run per trigger inside the tenant', async () => {
    const runs = new PostgresTriggerRuns(runtime);
    const base = { tenant: ORG_A, service: 'post', kind: 'queue-message' as const, target: 'inn' };
    await runs.record({
      ...base,
      id: 'r1',
      trigger: 't1',
      outcome: 'completed',
      task: 'a',
      at: '2026-10-01T08:00:00.000Z',
    });
    await runs.record({
      ...base,
      id: 'r2',
      trigger: 't1',
      outcome: 'failed',
      error: 'nede',
      code: 'quota_exhausted',
      usage: { inputTokens: 300, outputTokens: 50 },
      costMicroNok: 4500,
      at: '2026-10-08T08:00:00.000Z',
    });
    await runs.record({
      ...base,
      id: 'r3',
      trigger: 't2',
      outcome: 'completed',
      at: '2026-10-08T09:00:00.000Z',
    });

    const tally = await runs.tally(ORG_A, '2026-10-02T00:00:00.000Z');
    expect(tally.find((t) => t.trigger === 't1')).toMatchObject({
      runs: 1,
      failed: 1,
      last: {
        id: 'r2',
        error: 'nede',
        code: 'quota_exhausted',
        usage: { inputTokens: 300, outputTokens: 50 },
        costMicroNok: 4500,
      },
    });
    expect((await runs.recent(ORG_A, 't1', 10)).map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(await runs.recent(ORG_B, 't1', 10)).toEqual([]);
    expect(await runs.tally(ORG_B, '2026-01-01T00:00:00.000Z')).toEqual([]);
    expect(await asTenant(ORG_B, 'select * from trigger_runs')).toEqual([]);
  });
});

describe('connection credentials', () => {
  it('asks the token provider for a password on every new connection', async () => {
    let calls = 0;
    const pool = runtimePool(async () => {
      calls += 1;
      return 'runtime-pw';
    });

    const clients = await Promise.all([pool.connect(), pool.connect()]);
    clients.forEach((c) => c.release());
    await pool.query('select 1');

    expect(calls).toBe(2);
  });

  it('accepts pool options in place of a pool', async () => {
    const stores = await createPostgresStores(
      {
        connectionString: container.getConnectionUri(),
        password: async () => container.getPassword(),
      },
      wrapper,
    );
    track(stores.pool as pg.Pool);
    track(stores.runtimePool);
    await stores.close();
    expect(await stores.tenants.get(ORG_A)).toBeDefined();
  });
});
