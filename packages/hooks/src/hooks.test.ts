import type { Emitted, InvocationContext, Strategy } from '@genai/kernel';
import { describeContract } from '@genai/plugins/testing';
import type { ModelPort } from '@genai/port-model';
import type { KnowledgePort } from '@genai/port-knowledge';
import type { ToolPort } from '@genai/port-tools';
import { describe, expect, it } from 'vitest';
import {
  builtinHookPlugins,
  hookContract,
  hookEventType,
  hookInvoker,
  hookSpec,
  runHooks,
  sortHooks,
  withHooks,
  type HookConfig,
  type HookInvoker,
  type HookSpecInput,
} from './index.js';

const hook = (id: string, spec: Partial<HookSpecInput> = {}, scope = '991825827'): HookConfig => ({
  id,
  scope,
  ...hookSpec.parse({
    name: id,
    point: 'before_model',
    handler: { kind: 'builtin', id: 'tag', config: { labels: { fra: id } } },
    ...spec,
  }),
});

const call = { point: 'before_model' as const, tenant: '991825827', payload: { text: 'hei' } };

describe('hook specs', () => {
  it('only let enforcing hooks fail closed, and never refuse task completion', () => {
    const closed = hookSpec.safeParse({
      name: 'x',
      point: 'before_model',
      failure: 'closed',
      handler: { kind: 'builtin', id: 'tag', config: {} },
    });
    expect(closed.success).toBe(false);
    const completed = hookSpec.safeParse({
      name: 'x',
      point: 'task_completed',
      mode: 'enforce',
      handler: { kind: 'builtin', id: 'tag', config: {} },
    });
    expect(completed.success).toBe(false);
    expect(
      hookSpec.safeParse({
        name: 'x',
        point: 'before_tool',
        handler: { kind: 'webhook', url: 'http://ute.example.no/krok', secret: 'krok' },
      }).success,
    ).toBe(false);
  });
});

describe('running hooks', () => {
  it('runs platform hooks first, then by order, and stops at the first refusal', async () => {
    const seen: string[] = [];
    const invoke: HookInvoker = async (h) => {
      seen.push(h.id);
      return h.id === 'stopper' ? { decision: 'refuse', reason: 'nei' } : { decision: 'allow' };
    };
    const hooks = sortHooks([
      hook('sist', { order: 50 }),
      hook('stopper', { order: 10, mode: 'enforce' }),
      hook('plattform', { order: 900 }, 'platform'),
    ]);
    const outcome = await runHooks(hooks, call, invoke);
    expect(seen).toEqual(['plattform', 'stopper']);
    expect(outcome.refused).toEqual({ hook: 'stopper', name: 'stopper', reason: 'nei' });
    expect(outcome.records.map((r) => r.outcome)).toEqual(['allowed', 'refused']);
  });

  it('ignores a refusal from a hook that only observes, and drops its annotations', async () => {
    const outcome = await runHooks([hook('observerer')], call, async () => ({
      decision: 'refuse',
      reason: 'liker ikke',
      annotations: { a: 1 },
    }));
    expect(outcome.refused).toBeUndefined();
    expect(outcome.records[0]).toMatchObject({ outcome: 'ignored', reason: 'liker ikke' });
    expect(outcome.records[0]?.annotations).toBeUndefined();
  });

  it('fails open or closed on a timeout, as the hook says', async () => {
    const slow: HookInvoker = () => new Promise(() => undefined);
    const open = await runHooks([hook('treg', { timeoutMs: 50 })], call, slow);
    expect(open.refused).toBeUndefined();
    expect(open.records[0]).toMatchObject({ outcome: 'failed', reason: 'no answer within 50 ms' });
    const closed = await runHooks(
      [hook('treg', { timeoutMs: 50, mode: 'enforce', failure: 'closed' })],
      call,
      slow,
    );
    expect(closed.refused?.reason).toBe('kroken svarte ikke: no answer within 50 ms');
  });

  it('skips disabled hooks, other points and other services', async () => {
    const seen: string[] = [];
    const invoke: HookInvoker = async (h) => {
      seen.push(h.id);
      return {};
    };
    await runHooks(
      [
        hook('av', { enabled: false }),
        hook('verktoy', { point: 'before_tool' }),
        hook('annen', { services: ['991825827/annen'] }),
        hook('denne', { services: ['991825827/denne'] }),
      ],
      { ...call, service: '991825827/denne/default' },
      invoke,
    );
    expect(seen).toEqual(['denne']);
  });
});

const fakeModel = (text = 'Svar'): ModelPort => ({
  info: () => ({ id: 'test/modell', residency: 'norway', capabilities: ['stream'] }),
  chat: async () => ({
    content: text,
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, requests: 1 },
    servedModel: 'm',
  }),
  chatStream: async function* () {
    yield { kind: 'delta', text };
    yield {
      kind: 'done',
      result: {
        content: text,
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, requests: 1 },
        servedModel: 'm',
      },
    };
  },
});

let toolCalls = 0;
const fakeTool: ToolPort = {
  definition: () => ({
    name: 'finn',
    version: '1',
    description: 'Finn',
    input: { type: 'object' },
    origin: 'builtin',
  }),
  call: async () => {
    toolCalls += 1;
    return { parts: [{ mime: 'text/plain', body: { kind: 'text', text: 'fant' } }] };
  },
};

const ctx = (): InvocationContext =>
  ({
    tenant: '991825827',
    task: 't1',
    capability: { id: '991825827/svar' },
    signal: new AbortController().signal,
    use: async (port: string) => (port === 'model' ? fakeModel() : fakeTool),
  }) as unknown as InvocationContext;

const inner = (body: (ctx: InvocationContext) => AsyncIterable<Emitted>): Strategy => ({
  id: 'test',
  version: '1',
  requires: { kernel: 1, ports: ['model', 'tools'], features: [] },
  run: (c) => body(c),
});

const collect = async (events: AsyncIterable<Emitted>) => {
  const out: Emitted[] = [];
  for await (const e of events) out.push(e);
  return out;
};

describe('withHooks', () => {
  const invoke = hookInvoker();

  it('refuses a model call before it is made and records why', async () => {
    let answered = false;
    const events: Emitted[] = [];
    const strategy = withHooks(
      inner(async function* (c) {
        const model = await c.use<ModelPort>('model', { kind: 'model', id: 'm' });
        yield { type: 'x.test.started', data: null };
        await model.chat({ messages: [{ role: 'user', content: 'det er hemmelig' }] });
        answered = true;
      }),
      {
        invoke,
        hooks: async () => [
          hook('ord', {
            mode: 'enforce',
            handler: { kind: 'builtin', id: 'block-terms', config: { terms: ['hemmelig'] } },
          }),
        ],
      },
    );
    await expect(
      (async () => {
        for await (const e of strategy.run(ctx(), { parts: [] } as never, {})) events.push(e);
      })(),
    ).rejects.toMatchObject({
      code: 'refused',
      message: 'Stoppet av kroken «ord»: teksten inneholder «hemmelig»',
    });
    expect(answered).toBe(false);
    expect(events.find((e) => e.type === hookEventType)).toMatchObject({
      audience: 'audit',
      data: { hook: 'ord', point: 'before_model', outcome: 'refused' },
    });
  });

  it('turns a refused tool call into an error result without calling the tool', async () => {
    toolCalls = 0;
    const strategy = withHooks(
      inner(async function* (c) {
        const tool = await c.use<ToolPort>('tools', { kind: 'tool', id: 'finn@1' });
        const result = await tool.call({ q: 'fødselsnummer 123' });
        yield { type: 'x.test.tool', data: result };
      }),
      {
        invoke,
        hooks: async () => [
          hook('pii', {
            point: 'before_tool',
            mode: 'enforce',
            handler: { kind: 'builtin', id: 'block-terms', config: { terms: ['fødselsnummer'] } },
          }),
        ],
      },
    );
    const events = await collect(strategy.run(ctx(), { parts: [] } as never, {}));
    expect(toolCalls).toBe(0);
    expect(events.find((e) => e.type === 'x.test.tool')?.data).toMatchObject({ isError: true });
  });

  it('holds streamed deltas until an enforcing after_model hook has answered', async () => {
    const order: string[] = [];
    const strategy = withHooks(
      inner(async function* (c) {
        const model = await c.use<ModelPort>('model', { kind: 'model', id: 'm' });
        for await (const chunk of model.chatStream({ messages: [] })) order.push(chunk.kind);
        yield { type: 'x.test.done', data: null };
      }),
      {
        invoke: async (h) => {
          order.push(`hook:${h.id}`);
          return { decision: 'allow' };
        },
        hooks: async () => [hook('etter', { point: 'after_model', mode: 'enforce' })],
      },
    );
    await collect(strategy.run(ctx(), { parts: [] } as never, {}));
    expect(order).toEqual(['hook:etter', 'delta', 'done']);
  });

  it('annotates the audit trail and reports task completion, but not after a pause', async () => {
    const annotate = hook('merk', {
      mode: 'annotate',
      handler: { kind: 'builtin', id: 'tag', config: { labels: { avdeling: 'okonomi' } } },
    });
    const done = hook('ferdig', { point: 'task_completed' });
    const run = (paused: boolean) =>
      collect(
        withHooks(
          inner(async function* (c) {
            const model = await c.use<ModelPort>('model', { kind: 'model', id: 'm' });
            await model.chat({ messages: [] });
            yield paused
              ? { type: 'kernel.interrupt', data: { id: 'i', reason: 'r', prompt: 'p' } }
              : { type: 'kernel.result', data: [] };
          }),
          { invoke, hooks: async () => [annotate, done] },
        ).run(ctx(), { parts: [] } as never, {}),
      );
    const finished = (await run(false)).filter((e) => e.type === hookEventType);
    expect(finished.map((e) => (e.data as { hook: string; outcome: string }).outcome)).toEqual([
      'annotated',
      'allowed',
    ]);
    expect(finished[0]?.data).toMatchObject({ annotations: { avdeling: 'okonomi' } });
    const paused = (await run(true)).filter((e) => e.type === hookEventType);
    expect(paused.map((e) => (e.data as { hook: string }).hook)).toEqual(['merk']);
  });

  it('leaves the strategy untouched when no hooks apply', async () => {
    const strategy = withHooks(
      inner(async function* () {
        yield { type: 'kernel.result', data: [] };
      }),
      { invoke, hooks: async () => [] },
    );
    expect(await collect(strategy.run(ctx(), { parts: [] } as never, {}))).toEqual([
      { type: 'kernel.result', data: [] },
    ]);
  });
});

for (const plugin of builtinHookPlugins())
  if (plugin.target) describeContract(plugin.manifest.id, hookContract, plugin.target as never);

describe('search hooks', () => {
  const invoke = hookInvoker();
  let searched = 0;
  const fakeKnowledge: KnowledgePort = {
    info: () => ({ id: 'kudos', residency: 'norway', filters: {}, profiles: ['default'] }),
    search: async () => {
      searched += 1;
      return { hits: [{ id: 'h1', score: 1, text: 'Tildelingsbrev med persondata', fields: {} }] };
    },
    searchMany: async (requests) => {
      searched += requests.length;
      return requests.map(() => ({ hits: [] }));
    },
    fetch: async () => [],
    range: async () => [],
    facets: async () => ({}),
  };
  const withKnowledge = (): InvocationContext =>
    ({ ...ctx(), use: async () => fakeKnowledge }) as unknown as InvocationContext;
  const searching = (query: string) =>
    inner(async function* (c) {
      const port = await c.use<KnowledgePort>('knowledge', { kind: 'dataset', id: 'kudos' });
      yield { type: 'x.test.hits', data: await port.search({ query }) };
    });

  it('refuses a search before it reaches the engine when a before_search hook says no', async () => {
    searched = 0;
    const strategy = withHooks(searching('finn fødselsnummer'), {
      invoke,
      hooks: async () => [
        hook('sok', {
          point: 'before_search',
          mode: 'enforce',
          handler: { kind: 'builtin', id: 'block-terms', config: { terms: ['fødselsnummer'] } },
        }),
      ],
    });
    await expect(
      collect(strategy.run(withKnowledge(), { parts: [] } as never, {})),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(searched).toBe(0);
  });

  it('refuses the hits after search when an after_search hook says no, and records both points', async () => {
    searched = 0;
    const seen: string[] = [];
    const strategy = withHooks(searching('tildelingsbrev'), {
      invoke: async (h, c, signal) => {
        seen.push(c.point);
        return invoke(h, c, signal);
      },
      hooks: async () => [
        hook('logg', { point: 'before_search' }),
        hook('treff', {
          point: 'after_search',
          mode: 'enforce',
          handler: { kind: 'builtin', id: 'block-terms', config: { terms: ['persondata'] } },
        }),
      ],
    });
    await expect(
      collect(strategy.run(withKnowledge(), { parts: [] } as never, {})),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('treff') });
    expect(searched).toBe(1);
    expect(seen).toEqual(['before_search', 'after_search']);
  });

  it('does not let an on_feedback hook refuse, since feedback is already given', () => {
    expect(
      hookSpec.safeParse({
        name: 'x',
        point: 'on_feedback',
        mode: 'enforce',
        handler: { kind: 'builtin', id: 'tag', config: {} },
      }).success,
    ).toBe(false);
  });
});
