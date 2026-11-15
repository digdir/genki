import { describe, expect, it } from 'vitest';
import { textPart, type CapabilityDescriptor, type Principal } from '@genai/contracts';
import {
  createKernel,
  InMemoryEventLog,
  InMemoryTaskStore,
  type Capability,
  type Emitted,
  type Strategy,
} from '@genai/kernel';
import {
  createOpenAiAdapter,
  type AskConversations,
  type AskTurn,
  type CapabilityResolver,
} from './index.js';

const TENANT = '991825827';
const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: TENANT },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: TENANT },
  'kari-elsewhere': { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '889640782' },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: TENANT },
};
const kari = people.kari as Principal;

const delta = (text: string): Emitted => ({ type: 'kernel.part.delta', data: { text } });

const capability = (id: string): Capability => {
  const descriptor: CapabilityDescriptor = {
    id,
    version: '1',
    tenant: TENANT,
    availableTo: '*',
    title: id,
    description: id,
    input: { type: 'object', properties: { query: { type: 'string' } } },
    interaction: ['unary', 'stream'],
    accepts: [],
    produces: [],
    emits: [],
    oversight: { interrupts: true, riskClass: 'limited', aiDisclosure: 'KI' },
  };
  return { descriptor, strategy: { id, version: '1' }, config: {}, grants: [] };
};

const resolver: CapabilityResolver = {
  list: async () => [],
  resolve: async (_principal, name) => ({
    ok: true,
    entry: {
      id: name,
      capability: name.split('__')[0] ?? name,
      agentId: 'ka',
      ...(name.endsWith('__live') ? { live: true } : {}),
    },
  }),
};

interface Thread {
  owner: string;
  turns: AskTurn[];
}

/** One platform instance; instances made with the same `shared` stores see each other's runs. */
const setup = (
  shared = { tasks: new InMemoryTaskStore(), log: new InMemoryEventLog() },
  options: { cancelPollMs?: number; cancelWaitMs?: number; threads?: Map<string, Thread> } = {},
) => {
  const gates: (() => void)[] = [];
  const started: string[] = [];
  const waitForGate = () => new Promise<void>((resolve) => gates.push(resolve));
  const held: Strategy = {
    id: 'held',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* (ctx) {
      started.push(ctx.task);
      yield delta('Første utkast.');
      yield { type: 'kernel.notice', data: { stage: 'answer-discarded' } };
      yield delta('Svaret ');
      yield delta('begynner');
      await waitForGate();
      yield delta(' og slutter.');
      yield { type: 'kernel.result', data: [textPart('Svaret begynner og slutter.')] };
    },
  };
  const quick: Strategy = {
    id: 'quick',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* () {
      yield { type: 'kernel.result', data: [textPart('Ferdig.')] };
    },
  };
  const approval: Strategy = {
    id: 'approval',
    version: '1',
    requires: { kernel: 1, ports: [], features: ['interrupts'] },
    run: async function* () {
      yield delta('Utkast');
      await waitForGate();
      yield {
        type: 'kernel.interrupt',
        data: { id: 'i1', reason: 'godkjenning', prompt: [textPart('Godkjenn?')] },
      };
    },
  };
  const kernel = createKernel({
    strategies: [held, quick, approval],
    capabilities: [capability('held'), capability('quick'), capability('approval')],
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
    ...shared,
    limits: { deltaFlushMs: 0, cancelPollMs: options.cancelPollMs ?? 10 },
  });

  const threads = options.threads ?? new Map<string, Thread>();
  const ownerOf = (request: Request) =>
    `${request.headers.get('authorization')}#${request.headers.get('x-user-id') ?? ''}`;
  const conversations: AskConversations = {
    open: async (request, { conversationId }) => {
      if (conversationId === undefined) {
        const id = `c${threads.size + 1}`;
        threads.set(id, { owner: ownerOf(request), turns: [] });
        return { ok: true, id, history: [] };
      }
      const thread = threads.get(conversationId);
      if (thread?.owner !== ownerOf(request))
        return { ok: false, code: 'conversation_not_found', message: 'Conversation not found' };
      return { ok: true, id: conversationId, history: [] };
    },
    append: async (_request, id, turn) => {
      threads.get(id)?.turns.push(turn);
    },
    discard: async (_request, id) => {
      threads.delete(id);
    },
    owns: async (request, id) => threads.get(id)?.owner === ownerOf(request),
  };

  const app = createOpenAiAdapter({
    kernel,
    resolver,
    auth: {
      authenticate: async (request) =>
        people[request.headers.get('authorization')?.slice('Bearer '.length) ?? ''],
    },
    conversations,
    cancelWaitMs: options.cancelWaitMs ?? 500,
  });
  const headers = (who: string, user?: string) => ({
    authorization: `Bearer ${who}`,
    'content-type': 'application/json',
    ...(user ? { 'x-user-id': user } : {}),
  });
  const ask = (body: Record<string, unknown>, who = 'kari', user?: string) =>
    app.request('/v1/chat/completions', {
      method: 'POST',
      headers: headers(who, user),
      body: JSON.stringify({
        model: 'held__default',
        messages: [{ role: 'user', content: 'Hva?' }],
        genai_conversation: true,
        stream: true,
        genai_stream: 'live',
        ...body,
      }),
    });
  const cancel = (task: string, who = 'kari', user?: string) =>
    app.request(`/v1/tasks/${task}/cancel`, { method: 'POST', headers: headers(who, user) });
  const release = () => {
    for (const open of gates.splice(0)) open();
  };
  return {
    kernel,
    app,
    ask,
    cancel,
    release,
    threads,
    started,
    shared,
    waiting: () => gates.length,
  };
};

const readUntil = async (response: Response, text: string) => {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  return { reader, decoder };
};

const rest = async ({ reader, decoder }: Awaited<ReturnType<typeof readUntil>>) => {
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
};

const taskOf = (response: Response) => response.headers.get('genai-task') ?? '';

describe('POST /v1/tasks/{task}/cancel', () => {
  it('stops a streamed run its caller started, and the stream keeps what it showed', async () => {
    const { ask, cancel, release, kernel } = setup();
    const asked = await ask({});
    const stream = await readUntil(asked, 'begynner');

    const cancelled = await cancel(taskOf(asked));
    release();
    const after = await rest(stream);

    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({
      id: taskOf(asked),
      object: 'task',
      status: 'cancelled',
    });
    expect((await kernel.task(kari, taskOf(asked))).status).toBe('cancelled');
    expect(after).not.toContain('"retract":true');
    expect(after).not.toContain('Error:');
    expect(after).toContain('"failure_code":"cancelled"');
  });

  it('stores the turn of a stopped run as stopped, with the text it had made after the drafts it took back', async () => {
    const { ask, cancel, release, threads } = setup();
    const asked = await ask({});
    const stream = await readUntil(asked, 'begynner');

    await cancel(taskOf(asked));
    release();
    await rest(stream);

    expect(threads.get('c1')?.turns).toEqual([
      expect.objectContaining({ role: 'user', text: 'Hva?' }),
      { role: 'assistant', task: taskOf(asked), text: 'Svaret begynner', stopped: true },
    ]);
  });

  it('keeps a run going when its client disconnects, and stores the whole answer', async () => {
    const { ask, release, threads, kernel } = setup();
    const asked = await ask({});
    const { reader } = await readUntil(asked, 'begynner');

    await reader.cancel();
    release();

    await expect
      .poll(async () => (await kernel.task(kari, taskOf(asked))).status)
      .toBe('completed');
    await expect
      .poll(() => threads.get('c1')?.turns.at(-1))
      .toMatchObject({ role: 'assistant', text: 'Svaret begynner og slutter.' });
    expect(threads.get('c1')?.turns.at(-1)).not.toHaveProperty('stopped');
  });

  it('answers a second cancel of the same run as the first', async () => {
    const { ask, cancel, release } = setup();
    const asked = await ask({});
    await readUntil(asked, 'begynner');

    const first = await cancel(taskOf(asked));
    const again = await cancel(taskOf(asked));
    release();

    expect([first.status, again.status]).toEqual([200, 200]);
    expect(await again.json()).toMatchObject({ status: 'cancelled' });
  });

  it('refuses to cancel a run that has finished', async () => {
    const { ask, cancel, threads } = setup();
    const asked = await ask({ model: 'quick__default', stream: false });

    const refused = await cancel(asked.headers.get('genai-task') ?? '');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'run_finished' } });
    expect(threads.get('c1')?.turns.at(-1)).toMatchObject({ text: 'Ferdig.' });
  });

  it('answers 404 to another person, the same person in another organisation, and another end user of the key', async () => {
    const { ask, cancel, release, kernel } = setup();
    const asked = await ask({}, 'kari', 'ende-1');
    await readUntil(asked, 'begynner');

    const refused = [
      await cancel(taskOf(asked), 'ola', 'ende-1'),
      await cancel(taskOf(asked), 'kari-elsewhere', 'ende-1'),
      await cancel(taskOf(asked), 'kari', 'ende-2'),
      await cancel('no-such-task', 'kari', 'ende-1'),
    ];
    const statusAfter = (await kernel.task(kari, taskOf(asked))).status;
    release();

    expect(refused.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(await refused[0]?.json()).toMatchObject({ error: { code: 'task_not_found' } });
    expect(statusAfter).toBe('running');
  });

  it('answers 404 to an operator, who stops runs through the operator route', async () => {
    const { ask, cancel, release, kernel } = setup();
    const asked = await ask({ genai_conversation: false });
    await readUntil(asked, 'begynner');

    const refused = await cancel(taskOf(asked), 'drift');
    const statusAfter = (await kernel.task(kari, taskOf(asked))).status;
    release();

    expect(refused.status).toBe(404);
    expect(statusAfter).toBe('running');
  });

  it('refuses a run that was not started through /v1, such as a batch item or an MCP call', async () => {
    const { kernel, cancel, release } = setup();
    const batchItem = await kernel.invoke(kari, 'held', { data: {} });
    const mcpCall = await kernel.invoke(kari, 'held', { data: {} }, { entryPoint: 'mcp' });

    const refused = [await cancel(batchItem.task), await cancel(mcpCall.task)];
    const statuses = [
      (await kernel.task(kari, batchItem.task)).status,
      (await kernel.task(kari, mcpCall.task)).status,
    ];
    release();

    expect(refused.map((r) => r.status)).toEqual([409, 409]);
    expect(await refused[1]?.json()).toMatchObject({ error: { code: 'run_not_cancellable' } });
    expect(statuses).toEqual(['running', 'running']);
  });

  it('stops a live session its caller opened', async () => {
    const { app, cancel, release, kernel } = setup();
    const opened = await app.request('/v1/sessions?model=held__live', {
      headers: { authorization: 'Bearer kari', upgrade: 'websocket' },
    });
    const { task } = (await opened.json()) as { task: string };

    const cancelled = await cancel(task);
    release();

    expect(cancelled.status).toBe(200);
    expect((await kernel.task(kari, task)).status).toBe('cancelled');
  });

  it('stops a run another instance runs, which stores the turn as stopped', async () => {
    const runner = setup(undefined, { cancelPollMs: 10 });
    const elsewhere = setup(runner.shared, { threads: runner.threads, cancelWaitMs: 2000 });
    const asked = await runner.ask({});
    const stream = await readUntil(asked, 'begynner');

    const cancelled = await elsewhere.cancel(taskOf(asked));
    await rest(stream);
    runner.release();

    expect(cancelled.status).toBe(200);
    expect(runner.threads.get('c1')?.turns.at(-1)).toMatchObject({
      text: 'Svaret begynner',
      stopped: true,
    });
  });

  it('answers 202 while the instance that runs the run has not stopped it yet', async () => {
    const runner = setup(undefined, { cancelPollMs: 60_000 });
    const elsewhere = setup(runner.shared, { threads: runner.threads, cancelWaitMs: 100 });
    const asked = await runner.ask({});
    await readUntil(asked, 'begynner');

    const accepted = await elsewhere.cancel(taskOf(asked));
    runner.release();

    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ id: taskOf(asked), object: 'task', status: 'running' });
  });

  it('stops a run that pauses for approval before the instance running it sees the stop', async () => {
    const runner = setup(undefined, { cancelPollMs: 60_000 });
    const elsewhere = setup(runner.shared, { threads: runner.threads, cancelWaitMs: 2000 });
    const asked = await runner.ask({ model: 'approval__default', genai_conversation: false });
    await readUntil(asked, 'Utkast');

    const cancelling = elsewhere.cancel(taskOf(asked));
    await expect.poll(() => runner.shared.tasks.cancelRequested([taskOf(asked)])).toHaveLength(1);
    runner.release();
    const cancelled = await cancelling;

    expect(cancelled.status).toBe(200);
    expect((await runner.kernel.task(kari, taskOf(asked))).status).toBe('cancelled');
  });

  it('stores a stopped turn, keeps the conversation and names both when a run asked without streaming is cancelled', async () => {
    const { ask, cancel, release, threads, started, waiting } = setup();
    const pending = ask({ stream: false });
    await expect.poll(waiting).toBe(1);
    const running = started[0] ?? '';

    const cancelled = await cancel(running);
    const answered = await pending;
    release();

    expect(cancelled.status).toBe(200);
    expect(answered.status).toBe(500);
    expect(answered.headers.get('genai-task')).toBe(running);
    expect(answered.headers.get('genai-conversation')).toBe('c1');
    expect(await answered.json()).toMatchObject({
      conversation_id: 'c1',
      error: { failure_code: 'cancelled' },
    });
    expect(threads.get('c1')?.turns.at(-1)).toEqual({
      role: 'assistant',
      task: running,
      text: 'Svaret begynner',
      stopped: true,
    });
  });
});
