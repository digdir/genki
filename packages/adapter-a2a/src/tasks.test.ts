import { describe, expect, it } from 'vitest';
import { textPart, type CapabilityDescriptor, type Principal } from '@genai/contracts';
import { createKernel, type Capability, type Kernel, type Strategy } from '@genai/kernel';
import { createA2aApp, errorCodes, type AgentEntry } from './index.js';

const tenant = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };

const descriptor = (id: string): CapabilityDescriptor => ({
  id,
  version: '1',
  tenant,
  title: id,
  description: id,
  input: {},
  interaction: ['unary', 'stream'],
  accepts: ['text/plain'],
  produces: ['text/plain'],
  emits: [],
  oversight: { interrupts: true, riskClass: 'limited', aiDisclosure: 'KI' },
});

const strategies: Strategy[] = [
  {
    id: 'answer',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* (_ctx, input) {
      const { query } = input.data as { query: string };
      yield { type: 'kernel.part.delta', data: { text: 'Svar' } };
      yield { type: 'kernel.result', data: [textPart(`Svar på: ${query}`)] };
    },
  },
  {
    id: 'slow',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* (ctx) {
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'kernel.result', data: [textPart('for sent')] };
    },
  },
];

const capability = (id: string, strategy: string): Capability => ({
  descriptor: descriptor(`${tenant}/${id}/default`),
  strategy: { id: strategy, version: '1' },
  config: {},
  grants: [],
});

const entries: AgentEntry[] = [
  { id: 'rapport__default', capability: `${tenant}/rapport/default`, title: 'Rapport' },
  { id: 'annen__default', capability: `${tenant}/annen/default`, title: 'Annen' },
  { id: 'slow__default', capability: `${tenant}/slow/default`, title: 'Treg' },
];

const setup = (options: { listing?: boolean } = {}) => {
  const inner = createKernel({
    strategies,
    capabilities: [
      capability('rapport', 'answer'),
      capability('annen', 'answer'),
      capability('slow', 'slow'),
    ],
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
  });
  const ids: string[] = [];
  const kernel: Kernel = {
    ...inner,
    invoke: async (...args) => {
      const run = await inner.invoke(...args);
      ids.push(run.task);
      return run;
    },
  };
  let n = 0;
  const app = createA2aApp({
    kernel,
    resolver: {
      list: async () => entries,
      resolve: async (_p, name) => {
        const entry = entries.find((e) => e.id === name);
        return entry
          ? { ok: true, entry }
          : { ok: false, code: 'agent_not_found', message: `Agent not found: ${name}` };
      },
    },
    auth: {
      authenticate: async (r) => {
        const key = r.headers.get('x-api-key');
        if (key === 'good') return kari;
        return key === 'other' ? { ...kari, subject: 'ola' } : undefined;
      },
    },
    contextId: () => `ctx-${++n}`,
    ...(options.listing === false ? {} : { taskIds: async () => [...ids] }),
  });
  return { app, kernel };
};

type App = ReturnType<typeof setup>['app'];

const rpc = (
  app: App,
  agent: string,
  method: string,
  params: Record<string, unknown>,
  options: { key?: string; version?: string | null } = {},
) =>
  app.request(`http://plattform.test/a2a/${agent}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': options.key ?? 'good',
      ...(options.version === null ? {} : { 'a2a-version': options.version ?? '1.0' }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

const send = async (app: App, agent: string, text: string, extra: Record<string, unknown> = {}) => {
  const body = (await (
    await rpc(app, agent, 'SendMessage', {
      message: { messageId: `m-${text}`, role: 'ROLE_USER', parts: [{ text }], ...extra },
    })
  ).json()) as { result: { task: { id: string; contextId: string } } };
  return body.result.task;
};

interface ListResult {
  tasks: {
    id: string;
    contextId: string;
    status: { state: string; timestamp: string };
    artifacts?: unknown[];
  }[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

const list = async (app: App, agent: string, params: Record<string, unknown>, key = 'good') =>
  (await (await rpc(app, agent, 'ListTasks', params, { key })).json()) as {
    result: ListResult;
    error?: { code: number; message: string };
  };

describe('A2A ListTasks', () => {
  it('lists only the caller’s tasks on this agent, newest first, without artifacts by default', async () => {
    const { app } = setup();
    const first = await send(app, 'rapport__default', 'en');
    const second = await send(app, 'rapport__default', 'to');
    await send(app, 'annen__default', 'annet');
    await (
      await rpc(
        app,
        'rapport__default',
        'SendMessage',
        { message: { messageId: 'x', role: 'ROLE_USER', parts: [{ text: 'ola' }] } },
        { key: 'other' },
      )
    ).json();

    const { result } = await list(app, 'rapport__default', {});

    expect(result.totalSize).toBe(2);
    expect(result.pageSize).toBe(50);
    expect(result.nextPageToken).toBe('');
    expect(result.tasks.map((t) => t.id).sort()).toEqual([first.id, second.id].sort());
    expect(result.tasks[0]?.status.state).toBe('TASK_STATE_COMPLETED');
    expect(result.tasks[0]).not.toHaveProperty('artifacts');
    const times = result.tasks.map((t) => Date.parse(t.status.timestamp));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('includes artifacts when asked and filters by context, state and status timestamp', async () => {
    const { app } = setup();
    const first = await send(app, 'rapport__default', 'en');
    await send(app, 'rapport__default', 'to');

    const withArtifacts = await list(app, 'rapport__default', {
      contextId: first.contextId,
      includeArtifacts: true,
    });
    expect(withArtifacts.result.tasks.map((t) => t.id)).toEqual([first.id]);
    expect(withArtifacts.result.tasks[0]?.artifacts).toHaveLength(1);

    const working = await list(app, 'rapport__default', { status: 'TASK_STATE_WORKING' });
    expect(working.result.totalSize).toBe(0);

    const future = await list(app, 'rapport__default', {
      statusTimestampAfter: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(future.result.tasks).toEqual([]);
  });

  it('pages with an opaque cursor until the last page has an empty token', async () => {
    const { app } = setup();
    for (const text of ['a', 'b', 'c', 'd', 'e']) await send(app, 'rapport__default', text);

    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const { result } = await list(app, 'rapport__default', {
        pageSize: 2,
        ...(token ? { pageToken: token } : {}),
      });
      expect(result.totalSize).toBe(5);
      seen.push(...result.tasks.map((t) => t.id));
      token = result.nextPageToken || undefined;
      pages += 1;
    } while (token);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects invalid paging and filters as invalid params', async () => {
    const { app } = setup();

    for (const params of [
      { pageSize: 0 },
      { pageSize: 101 },
      { pageToken: 'ikke-gyldig' },
      { status: 'done' },
      { statusTimestampAfter: 'i går' },
    ])
      expect((await list(app, 'rapport__default', params)).error?.code).toBe(
        errorCodes.invalidParams,
      );
  });

  it('reports ListTasks as unsupported when the host gives no task index', async () => {
    const { app } = setup({ listing: false });

    expect((await list(app, 'rapport__default', {})).error?.code).toBe(errorCodes.unsupported);
  });
});

const legacyMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  message: {
    kind: 'message',
    messageId: `m-${text}`,
    role: 'user',
    parts: [{ kind: 'text', text }],
    ...extra,
  },
});

const events = async (response: Response) =>
  (await response.text())
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => (JSON.parse(b.slice(6)) as { result: Record<string, unknown> }).result);

describe('A2A 0.3 clients', () => {
  it('answers message/send with a bare 0.3 task when the version header is 0.3', async () => {
    const { app } = setup();

    const response = await rpc(app, 'rapport__default', 'message/send', legacyMessage('hei'), {
      version: '0.3',
    });

    expect(response.headers.get('a2a-version')).toBe('0.3');
    const { result } = (await response.json()) as { result: Record<string, unknown> };
    expect(result).toMatchObject({
      kind: 'task',
      contextId: 'ctx-1',
      status: { state: 'completed' },
      artifacts: [{ parts: [{ kind: 'text', text: 'Svar på: hei' }] }],
      history: [{ kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'hei' }] }],
    });
    expect(result).not.toHaveProperty('task');
  });

  it('treats a 0.3 method name without a version header as a 0.3 request', async () => {
    const { app } = setup();

    const sent = (await (
      await rpc(app, 'rapport__default', 'message/send', legacyMessage('hei'), { version: null })
    ).json()) as { result: { id: string } };
    const got = await rpc(
      app,
      'rapport__default',
      'tasks/get',
      { id: sent.result.id },
      {
        version: null,
      },
    );

    expect(got.headers.get('a2a-version')).toBe('0.3');
    expect(((await got.json()) as { result: unknown }).result).toMatchObject({
      kind: 'task',
      id: sent.result.id,
      status: { state: 'completed' },
    });
  });

  it('streams 0.3 events with kinds and a final status update', async () => {
    const { app } = setup();

    const response = await rpc(app, 'rapport__default', 'message/stream', legacyMessage('hei'), {
      version: '0.3',
    });

    const results = await events(response);
    expect(results[0]).toMatchObject({ kind: 'task', status: { state: 'working' } });
    expect(results.some((r) => r.kind === 'artifact-update')).toBe(true);
    expect(results.at(-1)).toMatchObject({
      kind: 'status-update',
      status: { state: 'completed' },
      final: true,
    });
  });

  it('maps blocking: false, tasks/cancel and tasks/resubscribe onto the same handlers', async () => {
    const { app } = setup();

    const started = (await (
      await rpc(
        app,
        'slow__default',
        'message/send',
        { ...legacyMessage('vent'), configuration: { blocking: false } },
        { version: '0.3' },
      )
    ).json()) as { result: { id: string; status: { state: string } } };
    expect(started.result.status.state).toBe('working');

    const resubscribed = await rpc(
      app,
      'slow__default',
      'tasks/resubscribe',
      {
        id: started.result.id,
      },
      { version: '0.3' },
    );
    const cancelled = (await (
      await rpc(app, 'slow__default', 'tasks/cancel', { id: started.result.id }, { version: '0.3' })
    ).json()) as { result: { kind: string; status: { state: string } } };
    expect(cancelled.result).toMatchObject({ kind: 'task', status: { state: 'canceled' } });
    const streamed = await events(resubscribed);
    expect(streamed[0]).toMatchObject({ kind: 'task', id: started.result.id });
    expect(streamed.at(-1)).toMatchObject({ kind: 'status-update', final: true });
  });

  it('rejects 0.3 file parts as unsupported content and 1.0 method names under 0.3', async () => {
    const { app } = setup();

    const file = (await (
      await rpc(
        app,
        'rapport__default',
        'message/send',
        legacyMessage('x', {
          parts: [
            {
              kind: 'file',
              file: { uri: 'https://example.test/a.pdf', mimeType: 'application/pdf' },
            },
          ],
        }),
        { version: '0.3' },
      )
    ).json()) as { error: { code: number } };
    expect(file.error.code).toBe(errorCodes.contentType);

    const renamed = (await (
      await rpc(app, 'rapport__default', 'SendMessage', legacyMessage('x'), { version: '0.3' })
    ).json()) as { error: { code: number } };
    expect(renamed.error.code).toBe(errorCodes.methodNotFound);
  });

  it('keeps 1.0 as the default: 1.0 names without a header get 1.0 shapes, 0.3 names under 1.0 are unknown', async () => {
    const { app } = setup();

    const plain = await rpc(
      app,
      'rapport__default',
      'SendMessage',
      { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'hei' }] } },
      { version: null },
    );
    expect(plain.headers.get('a2a-version')).toBe('1.0');
    expect(
      ((await plain.json()) as { result: { task: { status: { state: string } } } }).result.task
        .status.state,
    ).toBe('TASK_STATE_COMPLETED');

    const legacyUnder1 = (await (
      await rpc(app, 'rapport__default', 'message/send', legacyMessage('hei'))
    ).json()) as { error: { code: number } };
    expect(legacyUnder1.error.code).toBe(errorCodes.methodNotFound);
  });
});
