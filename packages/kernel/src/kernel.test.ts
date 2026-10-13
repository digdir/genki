import { describe, expect, it } from 'vitest';
import { textPart, type CapabilityDescriptor, type Event, type Principal } from '@genai/contracts';
import {
  CapabilityRegistry,
  createKernel,
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryTaskStore,
  KernelError,
  type Capability,
  type Emitted,
  type EventLog,
  type InvocationContext,
  type KernelOptions,
  type PolicyDecisionPoint,
  type Strategy,
} from './index.js';

const kari: Principal = {
  kind: 'employee',
  issuer: 'ansattporten',
  subject: 'kari',
  tenant: '999888777',
};
const ola: Principal = {
  kind: 'employee',
  issuer: 'ansattporten',
  subject: 'ola',
  tenant: '111222333',
};
const kariElsewhere: Principal = { ...kari, tenant: '111222333' };
const leader: Principal = { ...kari, subject: 'leder' };

const allowAll: PolicyDecisionPoint = { decide: async () => ({ allow: true }) };

const descriptor = (
  id: string,
  extra: Partial<CapabilityDescriptor> = {},
): CapabilityDescriptor => ({
  id,
  version: '1',
  tenant: '999888777',
  title: id,
  description: id,
  input: {},
  interaction: ['stream'],
  accepts: ['text/plain'],
  produces: ['text/plain'],
  emits: [],
  oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: 'KI-generert' },
  ...extra,
});

const strategy = (
  id: string,
  run: (ctx: InvocationContext) => AsyncIterable<Emitted>,
  extra: Partial<Strategy> = {},
): Strategy => ({
  id,
  version: '1',
  requires: { kernel: 1, ports: [], features: [] },
  run,
  ...extra,
});

const capability = (
  id: string,
  strategyId: string,
  extra: Partial<Capability> = {},
): Capability => ({
  descriptor: descriptor(id),
  strategy: { id: strategyId, version: '1' },
  config: {},
  grants: [],
  ...extra,
});

const kernelWith = (overrides: Partial<KernelOptions>) => {
  let n = 0;
  return createKernel({
    strategies: [],
    capabilities: [],
    ports: {},
    policy: allowAll,
    newId: () => `t${++n}`,
    now: () => new Date('2026-10-06T08:00:00Z'),
    ...overrides,
  });
};

const collect = async (events: AsyncIterable<Event>) => {
  const all: Event[] = [];
  for await (const e of events) all.push(e);
  return all;
};

const statuses = (events: Event[]) =>
  events
    .filter((e) => e.type === 'kernel.task.status')
    .map((e) => (e.data as { status: string }).status);

const never = () => new Promise<never>(() => undefined);

class SlowLog implements EventLog {
  readonly inner = new InMemoryEventLog();
  async append(event: Omit<Event, 'seq'>) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return this.inner.append(event);
  }
  read(task: string, fromSeq: number, isLive: () => boolean) {
    return this.inner.read(task, fromSeq, isLive);
  }
  wake(task: string) {
    this.inner.wake(task);
  }
}

describe('kernel: running a task', () => {
  it('stamps strategy events and completes with the result, hiding audit events from the client stream', async () => {
    const echo = strategy('echo', async function* () {
      yield { type: 'kernel.part.delta', data: { text: 'He' } };
      yield { type: 'kernel.result', data: [textPart('Hei')] };
    });
    const kernel = kernelWith({ strategies: [echo], capabilities: [capability('ka', 'echo')] });

    const run = await kernel.invoke(kari, 'ka', { parts: [textPart('hei')] });
    const events = await collect(run.events);

    expect(events.map((e) => e.type)).toEqual([
      'kernel.task.status',
      'kernel.task.status',
      'kernel.part.delta',
      'kernel.result',
      'kernel.task.status',
    ]);
    expect(events.find((e) => e.type === 'kernel.part.delta')?.actor).toBe('strategy');
    expect(await run.result).toEqual([textPart('Hei')]);
    expect((await kernel.task(kari, run.task)).status).toBe('completed');
  });

  it('records the input and the service provenance for audit', async () => {
    const echo = strategy('echo', async function* () {
      yield { type: 'kernel.result', data: [] };
    });
    const kernel = kernelWith({
      strategies: [echo],
      capabilities: [capability('ka', 'echo', { config: { b: 1, a: 2 } })],
    });

    const run = await kernel.invoke(kari, 'ka', { parts: [textPart('hei')] });
    await run.result;
    const audit = await collect(await kernel.events(kari, run.task, { audience: 'audit' }));
    const task = await kernel.task(kari, run.task);

    expect(audit.find((e) => e.type === 'kernel.task.input')?.data).toEqual({
      input: { parts: [textPart('hei')] },
    });
    expect(task.service.strategy).toEqual({ id: 'echo', version: '1' });
    expect(task.service.configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails a task whose strategy throws before it yields anything, and ends its readers', async () => {
    const broken = strategy('broken', () => {
      throw new Error('boom');
    });
    const kernel = kernelWith({ strategies: [broken], capabilities: [capability('ka', 'broken')] });

    const run = await kernel.invoke(kari, 'ka', {});
    const events = await collect(run.events);

    expect(statuses(events)).toEqual(['queued', 'running', 'failed']);
    await expect(run.result).rejects.toThrow('boom');
  });

  it('shows clients a generic error and keeps the detail for audit', async () => {
    const leaky = strategy('leaky', async function* () {
      yield* [];
      throw new Error('provider said: key sk-123 is invalid');
    });
    const kernel = kernelWith({ strategies: [leaky], capabilities: [capability('ka', 'leaky')] });

    const run = await kernel.invoke(kari, 'ka', {});
    const client = await collect(run.events);
    const audit = await collect(await kernel.events(kari, run.task, { audience: 'audit' }));

    const clientErrors = client.filter((e) => e.type === 'kernel.error').map((e) => e.data);
    expect(clientErrors).toEqual([{ code: 'strategy_error', message: 'the service failed' }]);
    expect(JSON.stringify(audit)).toContain('sk-123');
  });

  it('delivers the final status to a reader even when the event log is asynchronous', async () => {
    const echo = strategy('echo', async function* () {
      yield { type: 'kernel.result', data: [] };
    });
    const kernel = kernelWith({
      strategies: [echo],
      capabilities: [capability('ka', 'echo')],
      log: new SlowLog(),
    });

    const run = await kernel.invoke(kari, 'ka', {});
    await expect
      .poll(async () => (await kernel.task(kari, run.task)).status, { interval: 1 })
      .toBe('completed');
    const replay = await collect(await kernel.events(kari, run.task));

    expect(statuses(replay)).toEqual(['queued', 'running', 'completed']);
  });

  it('clamps a negative sequence number instead of replaying out of order', async () => {
    const echo = strategy('echo', async function* () {
      yield { type: 'kernel.result', data: [] };
    });
    const kernel = kernelWith({ strategies: [echo], capabilities: [capability('ka', 'echo')] });

    const run = await kernel.invoke(kari, 'ka', {});
    await run.result;
    const replay = await collect(
      await kernel.events(kari, run.task, { fromSeq: -1, audience: 'audit' }),
    );

    expect(replay.map((e) => e.seq)).toEqual([...replay.keys()]);
  });
});

describe('kernel: policy and tenants', () => {
  it('refuses an invocation the policy denies, before any task exists', async () => {
    const kernel = kernelWith({
      strategies: [strategy('noop', async function* () {})],
      capabilities: [capability('ka', 'noop')],
      policy: { decide: async () => ({ allow: false, reason: 'no access in Altinn' }) },
    });

    await expect(kernel.invoke(kari, 'ka', {})).rejects.toMatchObject({ code: 'forbidden' });
    await expect(kernel.task(kari, 't1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it("refuses another tenant's capability unless it is shared with that tenant", async () => {
    const kernel = kernelWith({
      strategies: [strategy('noop', async function* () {})],
      capabilities: [capability('ka', 'noop')],
    });

    await expect(kernel.invoke(ola, 'ka', {})).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('attributes a shared capability to the calling tenant and records the owner separately', async () => {
    const echo = strategy('echo', async function* () {
      yield { type: 'kernel.result', data: [] };
    });
    const shared = capability('klarsprak', 'echo', {
      descriptor: descriptor('klarsprak', { tenant: 'digdir', availableTo: '*' }),
    });
    const kernel = kernelWith({ strategies: [echo], capabilities: [shared] });

    const run = await kernel.invoke(ola, 'klarsprak', {});
    await run.result;
    const task = await kernel.task(ola, run.task);

    expect(task.tenant).toBe('111222333');
    expect(task.owner).toBe('digdir');
  });

  it('keeps thread state apart for different principals and tenants that send the same thread id', async () => {
    const notes = strategy('notes', async function* (ctx) {
      const before = await ctx.state.get<string>('thread', 'notes');
      if (!before) await ctx.state.put('thread', 'notes', `notat fra ${ctx.principal.subject}`);
      yield { type: 'kernel.result', data: [textPart(before?.value ?? 'tom')] };
    });
    const shared = capability('ka', 'notes', {
      descriptor: descriptor('ka', { availableTo: '*' }),
    });
    const kernel = kernelWith({ strategies: [notes], capabilities: [shared] });

    await (
      await kernel.invoke(kari, 'ka', {}, { thread: 'th1' })
    ).result;
    const olaRun = await kernel.invoke(ola, 'ka', {}, { thread: 'th1' });
    const kariAgain = await kernel.invoke(kari, 'ka', {}, { thread: 'th1' });

    expect(await olaRun.result).toEqual([textPart('tom')]);
    expect(await kariAgain.result).toEqual([textPart('notat fra kari')]);
  });

  it('keeps principal state apart when the same person acts for another tenant', async () => {
    const memo = strategy('memo', async function* (ctx) {
      const before = await ctx.state.get<string>('principal', 'memo');
      await ctx.state.put('principal', 'memo', ctx.tenant);
      yield { type: 'kernel.result', data: [textPart(before?.value ?? 'tom')] };
    });
    const shared = capability('ka', 'memo', { descriptor: descriptor('ka', { availableTo: '*' }) });
    const kernel = kernelWith({ strategies: [memo], capabilities: [shared] });

    await (
      await kernel.invoke(kari, 'ka', {})
    ).result;
    const elsewhere = await kernel.invoke(kariElsewhere, 'ka', {});

    expect(await elsewhere.result).toEqual([textPart('tom')]);
  });

  it('lets a strategy reach only the ports and refs its capability was granted, and gives providers a context', async () => {
    const kudos = { kind: 'dataset', id: 'kudos', tenant: '999888777' };
    const secret = { kind: 'dataset', id: 'secret', tenant: '999888777' };
    const opened: string[] = [];
    let denied: unknown;

    const reader = strategy(
      'reader',
      async function* (ctx) {
        const search = await ctx.use<{ search(): Promise<void> }>('knowledge', kudos);
        await search.search();
        try {
          await ctx.use('knowledge', secret);
        } catch (e) {
          denied = e;
        }
        yield { type: 'kernel.result', data: [] };
      },
      { requires: { kernel: 1, ports: ['knowledge'], features: [] } },
    );
    const kernel = kernelWith({
      strategies: [reader],
      capabilities: [capability('ka', 'reader', { grants: [{ port: 'knowledge', ref: kudos }] })],
      ports: {
        knowledge: {
          open: (ref, ctx) => ({
            search: async () => {
              opened.push(`${ctx.tenant}:${ref.id}`);
              await ctx.meter({ requests: 1 });
            },
          }),
        },
      },
    });

    const run = await kernel.invoke(kari, 'ka', {});
    await run.result;
    const audit = await collect(await kernel.events(kari, run.task, { audience: 'audit' }));

    expect(opened).toEqual(['999888777:kudos']);
    expect(denied).toBeInstanceOf(KernelError);
    expect(audit.filter((e) => e.type === 'kernel.resource.used').map((e) => e.data)).toEqual([
      { port: 'knowledge', ref: kudos },
    ]);
    expect((await kernel.task(kari, run.task)).usage).toEqual({ requests: 1 });
  });

  it('records each model deployment and index generation a port reports on the task, once each', async () => {
    const kudos = { kind: 'dataset', id: 'kudos', tenant: '999888777' };
    const reader = strategy(
      'reader',
      async function* (ctx) {
        const port = await ctx.use<{ search(): Promise<void> }>('knowledge', kudos);
        await port.search();
        await port.search();
        yield { type: 'kernel.result', data: [] };
      },
      { requires: { kernel: 1, ports: ['knowledge'], features: [] } },
    );
    const kernel = kernelWith({
      strategies: [reader],
      capabilities: [capability('ka', 'reader', { grants: [{ port: 'knowledge', ref: kudos }] })],
      ports: {
        knowledge: {
          open: (_ref, ctx) => ({
            search: async () => {
              await ctx.provenance?.({
                model: { id: 'foundry/gpt', endpoint: 'foundry', deployment: 'gpt-4o-2024' },
              });
              await ctx.provenance?.({
                index: { dataset: 'kudos', engine: 'pgvector', generation: 'g2' },
              });
            },
          }),
        },
      },
    });

    const run = await kernel.invoke(kari, 'ka', {});
    await run.result;
    const { service } = await kernel.task(kari, run.task);

    expect(service.models).toEqual([
      { id: 'foundry/gpt', endpoint: 'foundry', deployment: 'gpt-4o-2024' },
    ]);
    expect(service.indexes).toEqual([{ dataset: 'kudos', engine: 'pgvector', generation: 'g2' }]);
  });

  it('shows a task only to its owner, and the audit stream only with audit rights', async () => {
    const echo = strategy('echo', async function* () {
      yield { type: 'kernel.result', data: [] };
    });
    const kernel = kernelWith({
      strategies: [echo],
      capabilities: [capability('ka', 'echo')],
      policy: {
        decide: async (_p, action) =>
          action === 'read-audit' ? { allow: false, reason: 'no' } : { allow: true },
      },
    });

    const run = await kernel.invoke(kari, 'ka', {});
    await run.result;

    await expect(kernel.task(ola, run.task)).rejects.toMatchObject({ code: 'not_found' });
    await expect(kernel.events(kari, run.task, { audience: 'audit' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('kernel: what strategies may emit', () => {
  it('keeps extension event types, so new paradigms need no kernel change', async () => {
    const future = strategy('future', async function* () {
      yield {
        type: 'x.voice.turn',
        v: 2,
        data: { ms: 900 },
        fallback: [textPart('[taleinnslag]')],
      };
      yield { type: 'kernel.result', data: [] };
    });
    const kernel = kernelWith({ strategies: [future], capabilities: [capability('ka', 'future')] });

    const run = await kernel.invoke(kari, 'ka', {});
    const custom = (await collect(run.events)).find((e) => e.type === 'x.voice.turn');

    expect(custom).toMatchObject({
      v: 2,
      data: { ms: 900 },
      fallback: [textPart('[taleinnslag]')],
    });
  });

  it.each(['kernel.task.status', 'kernel.resource.used', 'kernel.usage', 'kernel.bogus', 'random'])(
    'fails a strategy that tries to emit %s',
    async (type) => {
      const forger = strategy('forger', async function* () {
        yield { type, data: { status: 'completed' } };
        yield { type: 'kernel.result', data: [] };
      });
      const kernel = kernelWith({
        strategies: [forger],
        capabilities: [capability('ka', 'forger')],
      });

      const run = await kernel.invoke(kari, 'ka', {});
      const events = await collect(run.events);

      await expect(run.result).rejects.toMatchObject({ code: 'invalid_event' });
      expect(statuses(events)).toEqual(['queued', 'running', 'failed']);
    },
  );
});

describe('kernel: budgets, deadlines and limits', () => {
  it('fails the task when the strategy spends more than the capability budget', async () => {
    const spender = strategy('spender', async function* (ctx) {
      await ctx.budget.charge({ outputTokens: 60 });
      await ctx.budget.charge({ outputTokens: 60 });
      yield { type: 'kernel.result', data: [] };
    });
    const kernel = kernelWith({
      strategies: [spender],
      capabilities: [capability('ka', 'spender', { budget: { outputTokens: 100 } })],
    });

    const run = await kernel.invoke(kari, 'ka', {});

    await expect(run.result).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect((await kernel.task(kari, run.task)).status).toBe('failed');
  });

  it('records the usage that passes the budget, so a failed task still counts what it spent', async () => {
    const spender = strategy('spender', async function* (ctx) {
      await ctx.budget.charge({ outputTokens: 60 });
      await ctx.budget.charge({ outputTokens: 16_384 });
      yield { type: 'kernel.result', data: [] };
    });
    const kernel = kernelWith({
      strategies: [spender],
      capabilities: [capability('ka', 'spender', { budget: { outputTokens: 100 } })],
    });

    const run = await kernel.invoke(kari, 'ka', {});
    await expect(run.result).rejects.toMatchObject({ code: 'budget_exceeded' });

    expect((await kernel.task(kari, run.task)).usage.outputTokens).toBe(16_444);
  });

  it('fails the task even when the strategy catches the budget error, and refuses refunds', async () => {
    let refund: unknown;
    const cheat = strategy('cheat', async function* (ctx) {
      try {
        await ctx.budget.charge({ outputTokens: 500 });
      } catch {
        /* keep going */
      }
      try {
        await ctx.budget.charge({ outputTokens: -10_000 });
      } catch (e) {
        refund = e;
      }
      yield { type: 'kernel.result', data: [] };
    });
    const kernel = kernelWith({
      strategies: [cheat],
      capabilities: [capability('ka', 'cheat', { budget: { outputTokens: 100 } })],
    });

    const run = await kernel.invoke(kari, 'ka', {});

    await expect(run.result).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(refund).toBeInstanceOf(KernelError);
  });

  it("enforces a child capability's own budget when a parent invokes it", async () => {
    const child = strategy('child', async function* (ctx) {
      await ctx.budget.charge({ outputTokens: 1000 });
      yield { type: 'kernel.result', data: [] };
    });
    const parent = strategy(
      'parent',
      async function* (ctx) {
        const sub = await ctx.invoke('helper', {});
        yield { type: 'kernel.result', data: await sub.result };
      },
      { requires: { kernel: 1, ports: [], features: ['subinvoke'] } },
    );
    const kernel = kernelWith({
      strategies: [child, parent],
      capabilities: [
        capability('ka', 'parent'),
        capability('helper', 'child', { budget: { outputTokens: 10 } }),
      ],
    });

    const run = await kernel.invoke(kari, 'ka', {});

    await expect(run.result).rejects.toMatchObject({ code: 'budget_exceeded' });
  });

  it('fails a task that passes its deadline, even if the strategy ignores the signal', async () => {
    const slow = strategy('slow', async function* () {
      await never();
      yield { type: 'kernel.result', data: [] };
    });
    const kernel = kernelWith({
      strategies: [slow],
      capabilities: [capability('ka', 'slow', { deadlineMs: 20 })],
    });

    const run = await kernel.invoke(kari, 'ka', {});

    await expect(run.result).rejects.toMatchObject({ code: 'deadline_exceeded' });
  });

  it('stops sub-invocations past the depth limit, and refuses them without the subinvoke feature', async () => {
    const recursive = strategy(
      'recursive',
      async function* (ctx) {
        const sub = await ctx.invoke('ka', {});
        yield { type: 'kernel.result', data: await sub.result };
      },
      { requires: { kernel: 1, ports: [], features: ['subinvoke'] } },
    );
    const undeclared = strategy('undeclared', async function* (ctx) {
      await ctx.invoke('ka', {});
      yield { type: 'kernel.result', data: [] };
    });
    const kernel = kernelWith({
      strategies: [recursive, undeclared],
      capabilities: [capability('ka', 'recursive'), capability('sneaky', 'undeclared')],
      limits: { maxDepth: 3 },
    });

    await expect((await kernel.invoke(kari, 'ka', {})).result).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
    await expect((await kernel.invoke(kari, 'sneaky', {})).result).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('refuses new tasks when a tenant has too many running', async () => {
    const slow = strategy('slow', async function* () {
      yield* [];
      await never();
    });
    const kernel = kernelWith({
      strategies: [slow],
      capabilities: [capability('ka', 'slow')],
      limits: { maxConcurrentPerTenant: 1 },
    });

    await kernel.invoke(kari, 'ka', {});

    await expect(kernel.invoke(kari, 'ka', {})).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('still fails a task that stores more events than the cap', async () => {
    const chatty = strategy('chatty', async function* () {
      for (let i = 0; i < 20; i += 1) yield { type: 'x.test.tick', data: i };
    });
    const kernel = kernelWith({
      strategies: [chatty],
      capabilities: [capability('ka', 'chatty')],
      limits: { maxEventsPerTask: 10 },
    });

    const run = await kernel.invoke(kari, 'ka', {});

    await expect(run.result).rejects.toMatchObject({ code: 'limit_exceeded' });
  });
});

describe('kernel: coalescing streamed text', () => {
  const deltaTexts = (events: Event[]) =>
    events
      .filter((e) => e.type === 'kernel.part.delta')
      .map((e) => (e.data as { text: string }).text);

  it('completes a 20,000-delta answer with far fewer stored events and identical text', async () => {
    const pieces = Array.from({ length: 20_000 }, (_, i) => `${i % 10}`);
    const runaway = strategy('runaway', async function* () {
      for (const text of pieces) yield { type: 'kernel.part.delta', data: { text } };
      yield { type: 'kernel.result', data: [textPart(pieces.join(''))] };
    });
    const kernel = kernelWith({
      strategies: [runaway],
      capabilities: [capability('ka', 'runaway')],
      limits: { deltaFlushMs: 600_000 },
    });

    const run = await kernel.invoke(kari, 'ka', {});
    const events = await collect(run.events);

    expect(await run.result).toEqual([textPart(pieces.join(''))]);
    const deltas = deltaTexts(events);
    expect(deltas.join('')).toBe(pieces.join(''));
    expect(deltas.length).toBeLessThan(100);
    expect(events.at(-2)?.type).toBe('kernel.result');
  }, 30_000);

  it('flushes buffered text before any other event and keeps the order', async () => {
    const mixed = strategy('mixed', async function* () {
      yield { type: 'kernel.part.delta', data: { text: 'a' } };
      yield { type: 'kernel.part.delta', data: { text: 'b' } };
      yield { type: 'kernel.part.delta', data: { text: 'c' } };
      yield { type: 'kernel.notice', data: { kind: 'step' } };
      yield { type: 'kernel.part.delta', data: { text: 'd' } };
      yield { type: 'kernel.part.delta', data: { text: 'e', extra: true } };
      yield { type: 'kernel.part.delta', data: { text: 'f' } };
    });
    const kernel = kernelWith({ strategies: [mixed], capabilities: [capability('ka', 'mixed')] });

    const run = await kernel.invoke(kari, 'ka', {});
    const events = (await collect(run.events)).filter(
      (e) => e.type === 'kernel.part.delta' || e.type === 'kernel.notice',
    );

    expect(events.map((e) => (e.type === 'kernel.notice' ? '|' : e.data))).toEqual([
      { text: 'a' },
      { text: 'bc' },
      '|',
      { text: 'd' },
      { text: 'e', extra: true },
      { text: 'f' },
    ]);
  });

  it('flushes held text after the window while the strategy is still working', async () => {
    let release: () => void = () => undefined;
    const paused = strategy('paused', async function* () {
      yield { type: 'kernel.part.delta', data: { text: 'a' } };
      yield { type: 'kernel.part.delta', data: { text: 'b' } };
      await new Promise<void>((resolve) => (release = resolve));
    });
    const kernel = kernelWith({
      strategies: [paused],
      capabilities: [capability('ka', 'paused')],
      limits: { deltaFlushMs: 20 },
    });

    const run = await kernel.invoke(kari, 'ka', {});
    const seen: string[] = [];
    for await (const e of run.events) {
      if (e.type !== 'kernel.part.delta') continue;
      seen.push((e.data as { text: string }).text);
      if (seen.join('') === 'ab') break;
    }
    release();

    expect(seen).toEqual(['a', 'b']);
  });
});

describe('kernel: cancelling', () => {
  it('cancels a running task at once, even if the strategy is stuck and ignores the signal', async () => {
    const stuck = strategy('stuck', async function* () {
      yield { type: 'kernel.part.delta', data: { text: '...' } };
      await never();
    });
    const kernel = kernelWith({ strategies: [stuck], capabilities: [capability('ka', 'stuck')] });

    const run = await kernel.invoke(kari, 'ka', {});
    for await (const e of run.events) if (e.type === 'kernel.part.delta') break;
    await kernel.cancel(kari, run.task);

    await expect(run.result).rejects.toMatchObject({ code: 'cancelled' });
    expect((await kernel.task(kari, run.task)).status).toBe('cancelled');
  });

  it('cancels the children when the parent is cancelled', async () => {
    let childTask = '';
    const child = strategy('child', async function* (ctx) {
      childTask = ctx.task;
      yield* [];
      await never();
    });
    const parent = strategy(
      'parent',
      async function* (ctx) {
        const sub = await ctx.invoke('helper', {});
        yield { type: 'kernel.part.delta', data: { text: 'started' } };
        yield { type: 'kernel.result', data: await sub.result };
      },
      { requires: { kernel: 1, ports: [], features: ['subinvoke'] } },
    );
    const kernel = kernelWith({
      strategies: [child, parent],
      capabilities: [capability('ka', 'parent'), capability('helper', 'child')],
    });

    const run = await kernel.invoke(kari, 'ka', {});
    for await (const e of run.events) if (e.type === 'kernel.part.delta') break;
    await kernel.cancel(kari, run.task);
    await expect(run.result).rejects.toBeInstanceOf(KernelError);

    await expect.poll(async () => (await kernel.task(kari, childTask)).status).toBe('cancelled');
    expect((await kernel.task(kari, childTask)).parent).toBe(run.task);
  });
});

describe('kernel: interrupts and approvals', () => {
  const approval = strategy(
    'approval',
    async function* (ctx) {
      await ctx.state.checkpoint({ draft: 'Utkast' });
      yield {
        type: 'kernel.interrupt',
        data: {
          id: 'i1',
          reason: 'høy risiko',
          prompt: [textPart('Godkjenn svaret?')],
          assignee: {
            kind: 'employee',
            id: JSON.stringify(['ansattporten', 'leder']),
            tenant: '999888777',
          },
        },
      };
    },
    {
      requires: { kernel: 1, ports: [], features: ['interrupts', 'checkpoint'] },
      resume: async function* (_ctx, checkpoint, response) {
        const { draft } = checkpoint as { draft: string };
        const ok = (response.data as { approved: boolean }).approved;
        yield { type: 'kernel.result', data: [textPart(ok ? draft : 'Avvist')] };
      },
    },
  );

  it('pauses on an interrupt and continues from the checkpoint when the assignee approves, recording who did', async () => {
    const kernel = kernelWith({
      strategies: [approval],
      capabilities: [capability('ka', 'approval')],
    });

    const first = await kernel.invoke(kari, 'ka', {});
    await collect(first.events);
    await expect(first.result).rejects.toMatchObject({ code: 'interrupted' });
    expect((await kernel.pending(leader)).map((t) => t.id)).toEqual([first.task]);

    await expect(kernel.resume(leader, first.task, 'wrong', {})).rejects.toMatchObject({
      code: 'invalid_state',
    });
    const second = await kernel.resume(leader, first.task, 'i1', { data: { approved: true } });
    await collect(second.events);

    expect(await second.result).toEqual([textPart('Utkast')]);
    const audit = await collect(await kernel.events(kari, first.task, { audience: 'audit' }));
    expect(audit.find((e) => e.type === 'kernel.interrupt.resolved')?.data).toMatchObject({
      interrupt: 'i1',
      response: { data: { approved: true } },
    });
  });

  it('refuses an interrupt from a strategy that did not declare the feature', async () => {
    const sneaky = strategy('sneaky', async function* () {
      yield { type: 'kernel.interrupt', data: { id: 'i1', reason: 'r', prompt: [] } };
    });
    const kernel = kernelWith({ strategies: [sneaky], capabilities: [capability('ka', 'sneaky')] });

    const run = await kernel.invoke(kari, 'ka', {});

    await expect(run.result).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('resumes a task on a fresh kernel that shares the stores, as after a redeploy', async () => {
    const log = new InMemoryEventLog();
    const tasks = new InMemoryTaskStore();
    const state = new InMemoryStateStore();
    const shared = {
      strategies: [approval],
      capabilities: [capability('ka', 'approval')],
      log,
      tasks,
      state,
    };
    const before = kernelWith(shared);

    const first = await before.invoke(kari, 'ka', {});
    await collect(first.events);

    const after = kernelWith(shared);
    const second = await after.resume(leader, first.task, 'i1', { data: { approved: true } });

    expect(await second.result).toEqual([textPart('Utkast')]);
  });
});

describe('kernel: annotations and boot checks', () => {
  it('accepts feedback on a finished task as an audit event', async () => {
    const echo = strategy('echo', async function* () {
      yield { type: 'kernel.result', data: [] };
    });
    const kernel = kernelWith({ strategies: [echo], capabilities: [capability('ka', 'echo')] });

    const run = await kernel.invoke(kari, 'ka', {});
    await run.result;
    await kernel.annotate(kari, run.task, { type: 'kernel.feedback', data: { thumb: 'up' } });
    const audit = await collect(await kernel.events(kari, run.task, { audience: 'audit' }));

    expect(audit.at(-1)).toMatchObject({ type: 'kernel.feedback', data: { thumb: 'up' } });
  });

  it('refuses to boot when a strategy needs a port nobody provides', () => {
    const needy = strategy('needy', async function* () {}, {
      requires: { kernel: 1, ports: ['knowledge'], features: [] },
    });

    expect(() =>
      kernelWith({ strategies: [needy], capabilities: [capability('ka', 'needy')] }),
    ).toThrow(/no provider for port knowledge/);
  });

  it('refuses to boot with two capabilities that share an id', () => {
    const noop = strategy('noop', async function* () {});

    expect(() =>
      kernelWith({
        strategies: [noop],
        capabilities: [capability('ka', 'noop'), capability('ka', 'noop')],
      }),
    ).toThrow(/duplicate capability ka/);
  });

  it('lets a strategy invoke another capability under the same principal', async () => {
    const inner = strategy('inner', async function* (ctx) {
      yield { type: 'kernel.result', data: [textPart(`indre for ${ctx.principal.subject}`)] };
    });
    const outer = strategy(
      'outer',
      async function* (ctx) {
        const sub = await ctx.invoke('helper', {});
        yield { type: 'kernel.result', data: await sub.result };
      },
      { requires: { kernel: 1, ports: [], features: ['subinvoke'] } },
    );
    const kernel = kernelWith({
      strategies: [inner, outer],
      capabilities: [capability('ka', 'outer'), capability('helper', 'inner')],
    });

    const run = await kernel.invoke(kari, 'ka', {});

    expect(await run.result).toEqual([textPart('indre for kari')]);
  });
});

describe('kernel: capabilities published while running', () => {
  const echo = strategy('echo', async function* () {
    yield { type: 'kernel.result', data: [textPart('hei')] };
  });

  it('serves a capability added after boot and stops serving it once removed', async () => {
    const registry = new CapabilityRegistry({ strategies: [echo], ports: {} });
    const kernel = createKernel({
      strategies: [echo],
      capabilities: registry,
      ports: {},
      policy: allowAll,
    });

    await expect(kernel.invoke(kari, 'late', {})).rejects.toBeInstanceOf(KernelError);
    registry.replace(() => false, [capability('late', 'echo')]);
    expect(await (await kernel.invoke(kari, 'late', {})).result).toEqual([textPart('hei')]);
    expect((await kernel.describe(kari)).map((d) => d.id)).toEqual(['late']);

    registry.replace((c) => c.descriptor.id === 'late', []);
    await expect(kernel.invoke(kari, 'late', {})).rejects.toBeInstanceOf(KernelError);
  });

  it('refuses a capability whose strategy or port is missing, or whose id is taken, and keeps the old set', () => {
    const registry = new CapabilityRegistry({ strategies: [echo], ports: {} });
    registry.replace(() => false, [capability('one', 'echo')]);

    expect(() => registry.replace(() => false, [capability('two', 'nope')])).toThrow(
      /no strategy nope/,
    );
    expect(() => registry.replace(() => false, [capability('one', 'echo')])).toThrow(
      /duplicate capability one/,
    );
    const needsModel = strategy('needs', async function* () {}, {
      requires: { kernel: 1, ports: ['model'], features: [] },
    });
    const strict = new CapabilityRegistry({ strategies: [needsModel], ports: {} });
    expect(() => strict.replace(() => false, [capability('m', 'needs')])).toThrow(
      /no provider for port model/,
    );
    expect(registry.all().map((c) => c.descriptor.id)).toEqual(['one']);
  });
});

describe('kernel: what a strategy can see', () => {
  it('exposes the capability descriptor and the service provenance to the strategy', async () => {
    let seen: { capability?: string; disclosure?: string; strategy?: string; hash?: string } = {};
    const echo = strategy('seer', async function* (ctx) {
      seen = {
        capability: ctx.capability.id,
        disclosure: ctx.capability.oversight.aiDisclosure,
        strategy: ctx.service.strategy.id,
        hash: ctx.service.configHash,
      };
      yield { type: 'kernel.result', data: [textPart('ok')] };
    });
    const kernel = kernelWith({ strategies: [echo], capabilities: [capability('ka', 'seer')] });

    const run = await kernel.invoke(kari, 'ka', {});
    await run.result;

    expect(seen.capability).toBe('ka');
    expect(seen.strategy).toBe('seer');
    expect(seen.hash).toBe((await kernel.task(kari, run.task)).service.configHash);
  });

  it('stores the task before its input is logged', async () => {
    const tasks = new InMemoryTaskStore();
    const inner = new InMemoryEventLog();
    const storedWhenInputLogged: boolean[] = [];
    const log: EventLog = {
      append: async (event) => {
        if (event.type === 'kernel.task.input')
          storedWhenInputLogged.push((await tasks.get(event.task)) !== undefined);
        return inner.append(event);
      },
      read: (task, fromSeq, isLive) => inner.read(task, fromSeq, isLive),
      wake: (task) => inner.wake(task),
    };
    const done = strategy('done', async function* () {
      yield { type: 'kernel.result', data: [textPart('ok')] };
    });
    const kernel = kernelWith({
      strategies: [done],
      capabilities: [capability('ka', 'done')],
      tasks,
      log,
    });

    await (
      await kernel.invoke(kari, 'ka', {})
    ).result;

    expect(storedWhenInputLogged).toEqual([true]);
  });

  it('tells a resumed strategy who responded, so approvers are not self-reported', async () => {
    let responder: string | undefined;
    const approval = strategy(
      'approval',
      async function* (ctx) {
        await ctx.state.checkpoint({});
        yield {
          type: 'kernel.interrupt',
          data: {
            id: 'i1',
            reason: 'r',
            prompt: [],
            assignee: {
              kind: 'employee',
              id: JSON.stringify(['ansattporten', 'leder']),
              tenant: '999888777',
            },
          },
        };
      },
      {
        requires: { kernel: 1, ports: [], features: ['interrupts', 'checkpoint'] },
        resume: async function* (ctx) {
          responder = ctx.responder?.subject;
          yield { type: 'kernel.result', data: [textPart('ok')] };
        },
      },
    );
    const kernel = kernelWith({
      strategies: [approval],
      capabilities: [capability('ka', 'approval')],
    });

    const first = await kernel.invoke(kari, 'ka', {});
    await expect(first.result).rejects.toMatchObject({ code: 'interrupted' });
    await (
      await kernel.resume(leader, first.task, 'i1', { data: { approver: 'someone-else' } })
    ).result;

    expect(responder).toBe('leder');
  });
});
