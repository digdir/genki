import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { textPart, type Event, type Task } from '@genai/contracts';
import {
  createPostgresStores,
  erased,
  LocalKeyWrapper,
  threadScope,
  withPlatformAccess,
} from './index.js';
import { stopPostgres } from './testing/index.js';

let container: StartedPostgreSqlContainer;
let stores: Awaited<ReturnType<typeof createPostgresStores>>;
let pool: pg.Pool;

const tenant = '991825827';
const other = '889640782';
const capability = `${tenant}/svar/default`;
const now = new Date('2026-10-12T03:17:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

const taskScope = (id: string) => JSON.stringify(['task', id]);

const seed = async (id: string, owner: string, endedDaysAgo: number | undefined) => {
  const scope = { tenant: owner, key: taskScope(id) };
  const task: Task = {
    id,
    tenant: owner,
    owner: 'kernel',
    status: endedDaysAgo === undefined ? 'running' : 'completed',
    principal: { kind: 'employee', id: 'kari' },
    service: {
      capability: { id: owner === tenant ? capability : `${owner}/svar/default`, version: '1' },
      strategy: { id: 'single-call', version: '1' },
      configHash: 'x',
    },
    result: [textPart('hemmelig svar')],
    artifacts: [],
    usage: {},
    createdAt: daysAgo((endedDaysAgo ?? 0) + 1).toISOString(),
    ...(endedDaysAgo === undefined ? {} : { endedAt: daysAgo(endedDaysAgo).toISOString() }),
  };
  const base = { v: 1, task: id, ts: now.toISOString(), actor: 'kernel' as const };
  await stores.log.append({ ...base, type: 'kernel.task.status', data: { status: 'done' } }, scope);
  await stores.log.append({ ...base, type: 'kernel.result', data: [textPart('hemmelig')] }, scope);
  await stores.state.put(JSON.stringify(['task', id, 'notes']), { secret: true }, scope);
  await stores.tasks.put(
    { task, principal: { kind: 'employee', issuer: 'test', subject: 'kari' }, lastSeq: 1 },
    scope,
  );
};

const collect = async (task: string) => {
  const all: Event[] = [];
  for await (const e of stores.log.read(task, 0, () => false)) all.push(e);
  return all;
};

const cutoff = (owner = tenant) => ({
  tenant: owner,
  capability: owner === tenant ? capability : `${owner}/svar/default`,
  payloadBefore: daysAgo(90),
  envelopeBefore: daysAgo(730),
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  stores = await createPostgresStores(pool, new LocalKeyWrapper(randomBytes(32)));
  await seed('fresh', tenant, 10);
  await seed('old', tenant, 100);
  await seed('ancient', tenant, 800);
  await seed('running', tenant, undefined);
  await seed('elsewhere', other, 100);
}, 120_000);

afterAll(async () => {
  await stores?.close();
  await stores?.runtimePool.end();
  await pool?.end();
  await stopPostgres(container);
});

describe('postgres retention', () => {
  it('lists each tenant and service that has ended tasks', async () => {
    expect(await stores.retention.groups()).toEqual([
      { tenant: other, capability: `${other}/svar/default` },
      { tenant, capability },
    ]);
  });

  it('drops payloads after the retention period, erases the task key and keeps the envelope', async () => {
    const count = await stores.retention.purge(cutoff());

    expect(count).toEqual({ payloads: 1, envelopes: 1 });
    expect((await collect('old')).map((e) => e.data)).toEqual([{ status: 'done' }, erased]);
    const raw = await pool.query<{ payload: Buffer | null; envelope: unknown }>(
      'select payload, envelope from events where task = $1 order by seq',
      ['old'],
    );
    expect(raw.rows.map((r) => r.payload)).toEqual([null, null]);
    expect(raw.rows[0]?.envelope).toEqual({ data: { status: 'done' } });
    const task = await stores.tasks.get('old');
    expect(task?.task.result).toBeUndefined();
    expect(task?.principal.subject).toBe('erased');
    expect(
      (await pool.query('select 1 from content_keys where scope = $1', [taskScope('old')]))
        .rowCount,
    ).toBe(0);
    expect(
      (await pool.query('select 1 from erased_scopes where scope = $1', [taskScope('old')]))
        .rowCount,
    ).toBe(1);
    expect(
      (await pool.query('select 1 from state where scope = $1', [taskScope('old')])).rowCount,
    ).toBe(0);
  });

  it('deletes the whole task after the audit period', async () => {
    expect(await stores.tasks.get('ancient')).toBeUndefined();
    expect(await collect('ancient')).toEqual([]);
    expect(
      (await pool.query('select 1 from content_keys where scope = $1', [taskScope('ancient')]))
        .rowCount,
    ).toBe(0);
  });

  it('keeps fresh and running tasks and other tenants untouched', async () => {
    expect((await collect('fresh')).at(-1)?.data).toEqual([textPart('hemmelig')]);
    expect((await collect('running')).at(-1)?.data).toEqual([textPart('hemmelig')]);
    expect((await collect('elsewhere')).at(-1)?.data).toEqual([textPart('hemmelig')]);
    expect((await stores.tasks.get('fresh'))?.task.result).toEqual([textPart('hemmelig svar')]);
  });

  it('purging twice changes nothing the second time', async () => {
    expect(await stores.retention.purge(cutoff())).toEqual({ payloads: 0, envelopes: 0 });
    expect(await stores.retention.purge(cutoff(other))).toEqual({ payloads: 1, envelopes: 0 });
    expect(await stores.retention.purge(cutoff(other))).toEqual({ payloads: 0, envelopes: 0 });
  });
});

describe('postgres conversation retention', () => {
  const owner = { tenant, user: 'kari' };
  const age = (id: string, days: number) =>
    withPlatformAccess(pool, 'retention-test', async (client) => {
      await client.query('update conversations set created = $2 where id = $1', [
        id,
        daysAgo(days).getTime(),
      ]);
      await client.query('update conversation_messages set created = $2 where conversation = $1', [
        id,
        daysAgo(days).getTime(),
      ]);
    });

  it('deletes conversations idle longer than the cutoff and erases their thread key', async () => {
    const idle = await stores.conversations.create(owner, { agentId: 'svar', userId: 'kari' });
    await stores.conversations.append(owner, idle.id, { role: 'user', text: 'hemmelig spørsmål' });
    const active = await stores.conversations.create(owner, { agentId: 'svar', userId: 'kari' });
    await age(idle.id, 100);

    expect(await stores.threadRetention.agents(tenant)).toEqual(['svar']);
    const purged = await stores.threadRetention.purge({
      tenant,
      agent: 'svar',
      before: daysAgo(90),
    });

    expect(purged).toBe(1);
    expect(await stores.conversations.get(owner, idle.id)).toBeUndefined();
    expect(await stores.conversations.get(owner, active.id)).toBeDefined();
    expect(
      (await pool.query('select 1 from content_keys where scope = $1', [threadScope(idle.id)]))
        .rowCount,
    ).toBe(0);
    expect(await stores.threadRetention.purge({ tenant, agent: 'svar', before: daysAgo(90) })).toBe(
      0,
    );
  });
});

describe('postgres thread erasure', () => {
  const seedTurn = async (id: string, owner: string, thread: string) => {
    const scope = {
      tenant: owner,
      key: JSON.stringify(['thread', JSON.stringify(['employee', 'test', 'kari', owner]), thread]),
    };
    const task: Task = {
      id,
      tenant: owner,
      owner: 'kernel',
      status: 'completed',
      principal: { kind: 'employee', id: 'kari' },
      service: {
        capability: { id: `${owner}/svar/default`, version: '1' },
        strategy: { id: 'single-call', version: '1' },
        configHash: 'x',
      },
      thread,
      result: [textPart('hemmelig svar')],
      artifacts: [],
      usage: {},
      createdAt: now.toISOString(),
      endedAt: now.toISOString(),
    };
    const base = { v: 1, task: id, ts: now.toISOString(), actor: 'kernel' as const };
    await stores.log.append(
      { ...base, type: 'kernel.task.input', data: { parts: [textPart('vedlagt brev')] } },
      scope,
    );
    await stores.tasks.put(
      { task, principal: { kind: 'employee', issuer: 'test', subject: 'kari' }, lastSeq: 0 },
      scope,
    );
    return scope.key;
  };

  it('erases the content key of every task in the thread, only in the owner tenant', async () => {
    const scope = await seedTurn('turn-1', tenant, 'samtale-1');
    await seedTurn('turn-2', tenant, 'samtale-2');
    await seedTurn('turn-3', other, 'samtale-1');

    expect(await stores.threadErasure.erase(tenant, 'samtale-1')).toBe(1);

    expect((await collect('turn-1'))[0]?.data).toEqual(erased);
    expect((await stores.tasks.get('turn-1'))?.task.result).toBeUndefined();
    expect(
      (
        await pool.query('select 1 from erased_scopes where tenant = $1 and scope = $2', [
          tenant,
          scope,
        ])
      ).rowCount,
    ).toBe(1);
    expect((await collect('turn-2'))[0]?.data).toEqual({ parts: [textPart('vedlagt brev')] });
    expect((await collect('turn-3'))[0]?.data).toEqual({ parts: [textPart('vedlagt brev')] });
  });
});
