import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { textPart, type Event, type Principal } from '@genai/contracts';
import { createKernel, type Capability, type Strategy } from '@genai/kernel';
import { createPostgresStores, erased, LocalKeyWrapper, migrate } from './index.js';
import { stopPostgres } from './testing/index.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
const pools: pg.Pool[] = [];

const newPool = () => {
  const created = new pg.Pool({ connectionString: container.getConnectionUri() });
  pools.push(created);
  return created;
};
const wrapper = new LocalKeyWrapper(randomBytes(32));
const openStores = async (...args: Parameters<typeof createPostgresStores>) => {
  const stores = await createPostgresStores(...args);
  pools.push(stores.runtimePool);
  return stores;
};
const scope = { tenant: '999888777', key: 'thread:demo' };

const event = (task: string, type: string, data: unknown): Omit<Event, 'seq'> => ({
  type,
  v: 1,
  task,
  ts: new Date('2026-10-06T08:00:00Z').toISOString(),
  data,
  actor: 'kernel',
});

const collect = async (events: AsyncIterable<Event>) => {
  const all: Event[] = [];
  for await (const e of events) all.push(e);
  return all;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = newPool();
  await migrate(pool);
}, 120_000);

afterAll(async () => {
  await stopPostgres(container, pools);
});

describe('postgres event log', () => {
  it('keeps operator model classifications and replaces them on change', async () => {
    const stores = await openStores(newPool(), wrapper);

    await stores.modelClassifications.save('foundry-openai/gpt-4o-2m-tps', { residency: 'eu' });
    await stores.modelClassifications.save('foundry-openai/gpt-4o-2m-tps', {
      residency: 'norway',
      enabled: false,
    });

    const reopened = await openStores(newPool(), wrapper);
    expect(await reopened.modelClassifications.load()).toMatchObject({
      'foundry-openai/gpt-4o-2m-tps': { residency: 'norway', enabled: false },
    });
    await stores.close();
    await reopened.close();
  });

  it('runs its migrations more than once without failing', async () => {
    await expect(migrate(pool)).resolves.toBeUndefined();
  });

  it('numbers events per task, encrypts content at rest and keeps envelope events readable', async () => {
    const stores = await openStores(pool, wrapper);
    await stores.log.append(event('t-seq', 'kernel.task.status', { status: 'queued' }), scope);
    await stores.log.append(event('t-seq', 'kernel.result', [textPart('hemmelig svar')]), scope);

    const events = await collect(stores.log.read('t-seq', 0, () => false));
    const raw = await pool.query(
      'select envelope, payload::text as payload from events where task = $1 order by seq',
      ['t-seq'],
    );

    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [0, 'kernel.task.status'],
      [1, 'kernel.result'],
    ]);
    expect(events[1]?.data).toEqual([textPart('hemmelig svar')]);
    expect(raw.rows[0]?.envelope).toEqual({ data: { status: 'queued' } });
    expect(JSON.stringify(raw.rows)).not.toContain('hemmelig svar');
    await stores.close();
  });

  it('gives unique, gapless sequence numbers to concurrent writers on different connections', async () => {
    const a = await openStores(newPool(), wrapper);
    const b = await openStores(newPool(), wrapper);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).log.append(event('t-race', 'kernel.part', { i }), scope),
      ),
    );

    const seqs = (
      await pool.query<{ seq: number }>('select seq from events where task = $1 order by seq', [
        't-race',
      ])
    ).rows.map((r) => r.seq);

    expect(seqs).toEqual([...Array(20).keys()]);
    await a.close();
    await b.close();
  });

  it('wakes a live reader on another instance when an event is written', async () => {
    const writer = await openStores(newPool(), wrapper);
    const reader = await openStores(newPool(), wrapper, {
      pollMs: 60_000,
    });
    let live = true;
    const seen: string[] = [];
    const done = (async () => {
      for await (const e of reader.log.read('t-wake', 0, () => live)) {
        seen.push(e.type);
        if (e.type === 'kernel.result') live = false;
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 200));
    await writer.log.append(event('t-wake', 'kernel.result', []), scope);
    reader.log.wake('t-wake');
    await done;

    expect(seen).toEqual(['kernel.result']);
    await writer.close();
    await reader.close();
  });

  it('makes content unreadable after erasure, while the envelope survives', async () => {
    const stores = await openStores(pool, wrapper);
    const erasable = { tenant: '999888777', key: 'thread:erase-me' };
    await stores.log.append(
      event('t-erase', 'kernel.usage', { usage: { outputTokens: 12 } }),
      erasable,
    );
    await stores.log.append(
      event('t-erase', 'kernel.task.input', { input: { parts: [textPart('personnummer')] } }),
      erasable,
    );
    await stores.state.put('notes', 'notat om saken', erasable);

    await stores.erase(erasable.tenant, erasable.key);
    const events = await collect(stores.log.read('t-erase', 0, () => false));

    expect(events[0]?.data).toEqual({ usage: { outputTokens: 12 } });
    expect(events[1]?.data).toEqual(erased);
    expect((await stores.state.get('notes', erasable))?.value).toBeNull();
    await stores.close();
  });
});

describe('postgres task and state stores', () => {
  it('finds interrupted tasks for their owner and for their assignee', async () => {
    const stores = await openStores(pool, wrapper);
    const owner = { kind: 'employee', id: 'kari', tenant: '999888777' };
    const leader = { kind: 'employee', id: 'leder', tenant: '999888777' };
    const principal: Principal = {
      kind: 'employee',
      issuer: 'test',
      subject: 'kari',
      tenant: '999888777',
    };
    await stores.tasks.put(
      {
        task: {
          id: 't-pending',
          service: {
            capability: { id: 'c', version: '1' },
            strategy: { id: 's', version: '1' },
            configHash: 'h',
          },
          principal: owner,
          tenant: '999888777',
          owner: '999888777',
          status: 'interrupted',
          pendingInterrupt: {
            id: 'i1',
            reason: 'godkjenn',
            prompt: [textPart('Godkjenn?')],
            assignee: leader,
          },
          artifacts: [],
          usage: {},
          createdAt: '2026-10-06T08:00:00.000Z',
        },
        principal,
        lastSeq: 4,
        checkpoint: { draft: 'Utkast' },
      },
      scope,
    );

    expect((await stores.tasks.pendingFor(owner)).map((t) => t.id)).toEqual(['t-pending']);
    expect((await stores.tasks.pendingFor(leader)).map((t) => t.id)).toEqual(['t-pending']);
    expect((await stores.tasks.get('t-pending'))?.checkpoint).toEqual({ draft: 'Utkast' });
    await stores.close();
  });

  it('refuses a state write when the value changed since it was read', async () => {
    const stores = await openStores(pool, wrapper);
    const v = await stores.state.put('counter', 1, scope);

    await expect(stores.state.put('counter', 2, scope, v + 5)).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect((await stores.state.get('counter', scope))?.value).toBe(1);
    await stores.close();
  });
});

describe('the kernel on postgres', () => {
  const approval: Strategy = {
    id: 'approval',
    version: '1',
    requires: { kernel: 1, ports: [], features: ['interrupts', 'checkpoint'] },
    run: async function* (ctx) {
      await ctx.state.checkpoint({ draft: 'Utkast' });
      yield {
        type: 'kernel.interrupt',
        data: { id: 'i1', reason: 'høy risiko', prompt: [textPart('Godkjenn?')] },
      };
    },
    resume: async function* (_ctx, checkpoint) {
      yield { type: 'kernel.result', data: [textPart((checkpoint as { draft: string }).draft)] };
    },
  };
  const capability: Capability = {
    descriptor: {
      id: 'ka',
      version: '1',
      tenant: '999888777',
      title: 'ka',
      description: 'ka',
      input: {},
      interaction: ['unary'],
      accepts: [],
      produces: [],
      emits: [],
      oversight: { interrupts: true, riskClass: 'limited', aiDisclosure: 'KI' },
    },
    strategy: { id: 'approval', version: '1' },
    config: {},
    grants: [],
  };
  const kari: Principal = {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: '999888777',
  };

  it('resumes an approval on a new kernel instance after a restart', async () => {
    const first = await openStores(pool, wrapper);
    const options = {
      strategies: [approval],
      capabilities: [capability],
      ports: {},
      policy: { decide: async () => ({ allow: true as const }) },
    };
    const before = createKernel({
      ...options,
      log: first.log,
      tasks: first.tasks,
      state: first.state,
    });

    const run = await before.invoke(kari, 'ka', { parts: [textPart('hei')] });
    await collect(run.events);
    await first.close();

    const second = await openStores(pool, wrapper);
    const after = createKernel({
      ...options,
      log: second.log,
      tasks: second.tasks,
      state: second.state,
    });
    const resumed = await after.resume(kari, run.task, 'i1', { data: { approved: true } });

    expect(await resumed.result).toEqual([textPart('Utkast')]);
    const audit = await collect(await after.events(kari, run.task, { audience: 'audit' }));
    expect(audit.map((e) => e.seq)).toEqual([...audit.keys()]);
    await second.close();
  });
});
