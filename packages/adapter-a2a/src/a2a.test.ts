import { describe, expect, it } from 'vitest';
import { textPart, type CapabilityDescriptor, type Principal } from '@genai/contracts';
import { createKernel, type Capability, type Strategy } from '@genai/kernel';
import {
  agentCard,
  createA2aApp,
  errorCodes,
  publicAgentCard,
  type A2aAppOptions,
  type AgentEntry,
  type AgentResolver,
} from './index.js';

const tenant = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };

const descriptor = (id: string): CapabilityDescriptor => ({
  id,
  version: '3',
  tenant,
  title: 'Rapportassistenten',
  description: 'Svarer på spørsmål om evalueringer.',
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
      yield { type: 'kernel.part.delta', data: { text: 'Svar ' } };
      yield { type: 'kernel.part.delta', data: { text: `på: ${query}` } };
      yield {
        type: 'kernel.result',
        data: [
          textPart(`Svar på: ${query}`),
          {
            mime: 'application/vnd.genai.sources+json',
            body: { kind: 'json', json: { sources: [{ chunkId: 'c1', title: 'Rapport' }] } },
          },
        ],
      };
    },
  },
  {
    id: 'slow',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* (ctx) {
      yield { type: 'kernel.part.delta', data: { text: 'Starter' } };
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'kernel.result', data: [textPart('for sent')] };
    },
  },
  {
    id: 'broken',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* () {
      yield { type: 'kernel.part.delta', data: { text: '' } };
      throw new Error('postgres://secret');
    },
  },
  {
    id: 'ask',
    version: '1',
    requires: { kernel: 1, ports: [], features: ['interrupts', 'checkpoint'] },
    run: async function* (ctx) {
      await ctx.state.checkpoint({ draft: 'Utkast' });
      yield {
        type: 'kernel.interrupt',
        data: { id: 'i1', reason: 'mangler år', prompt: [textPart('Hvilket år gjelder det?')] },
      };
    },
    resume: async function* (_ctx, _checkpoint, response) {
      yield {
        type: 'kernel.result',
        data: [textPart(`Året er ${(response.data as { year?: number }).year}`)],
      };
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
  {
    id: 'rapport__default',
    capability: `${tenant}/rapport/default`,
    title: 'Rapportassistenten',
    description: 'Svarer på spørsmål om evalueringer.',
    version: 3,
  },
  { id: 'rapport-alias', capability: `${tenant}/rapport/default`, title: 'Alias' },
  { id: 'slow__default', capability: `${tenant}/slow/default`, title: 'Treg' },
  { id: 'broken__default', capability: `${tenant}/broken/default`, title: 'Ødelagt' },
  {
    id: 'skjema__default',
    capability: `${tenant}/skjema/default`,
    title: 'Skjema',
    inputFields: [{ id: 'year', label: 'År', kind: 'year', required: true }],
    inputSchema: {
      type: 'object',
      properties: { year: { type: 'integer' } },
      required: ['year'],
    },
  },
  { id: 'ask__default', capability: `${tenant}/ask/default`, title: 'Spør' },
  { id: 'hidden__default', capability: `${tenant}/hidden/default`, title: 'Skjult' },
];

const resolver: AgentResolver = {
  list: async () => entries,
  resolve: async (_principal, name) => {
    const entry = entries.find((e) => e.id === name);
    return entry
      ? { ok: true, entry }
      : { ok: false, code: 'agent_not_found', message: `Agent not found: ${name}` };
  },
};

const setup = (extra: Partial<A2aAppOptions> = {}) => {
  const kernel = createKernel({
    strategies,
    capabilities: [
      capability('rapport', 'answer'),
      capability('slow', 'slow'),
      capability('broken', 'broken'),
      capability('skjema', 'answer'),
      capability('ask', 'ask'),
      capability('hidden', 'answer'),
    ],
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
  });
  let n = 0;
  const app = createA2aApp({
    kernel,
    resolver,
    auth: {
      authenticate: async (r) => {
        const key = r.headers.get('x-api-key');
        if (key === 'good') return kari;
        return key === 'other' ? { ...kari, subject: 'ola' } : undefined;
      },
    },
    exposed: (entry) => entry.id !== 'hidden__default',
    contextId: () => `ctx-${++n}`,
    modelsOf: async () => ['gpt-test'],
    provider: { organization: 'Digdir', url: 'https://digdir.no' },
    ...extra,
  });
  return { kernel, app };
};

const headers = (key = 'good') => ({
  'content-type': 'application/json',
  'x-api-key': key,
  'a2a-version': '1.0',
});

const rpc = (
  app: ReturnType<typeof setup>['app'],
  agent: string,
  method: string,
  params: Record<string, unknown>,
  key = 'good',
) =>
  app.request(`http://plattform.test/a2a/${agent}`, {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
  });

const userMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text }], ...extra },
});

interface StreamEvent {
  result: Record<string, Record<string, unknown>>;
}

const events = async (response: Response) =>
  (await response.text())
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as StreamEvent);

describe('A2A agent card', () => {
  it('describes an exposed service as an A2A 1.0 agent with a JSON-RPC interface, skills and auth', async () => {
    const { app } = setup();

    const response = await app.request(
      'http://plattform.test/a2a/rapport__default/.well-known/agent-card.json',
      { headers: headers() },
    );

    expect(response.status).toBe(200);
    const card = (await response.json()) as Record<string, unknown>;
    expect(card).toMatchObject({
      name: 'Rapportassistenten',
      description: 'Svarer på spørsmål om evalueringer.',
      version: '3',
      supportedInterfaces: [
        {
          url: 'http://plattform.test/a2a/rapport__default',
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        },
      ],
      provider: { organization: 'Digdir', url: 'https://digdir.no' },
      capabilities: { streaming: true, pushNotifications: false },
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      defaultInputModes: ['text/plain'],
      skills: [{ id: 'rapport__default', name: 'Rapportassistenten', tags: ['genai'] }],
    });
    for (const key of [
      'name',
      'description',
      'supportedInterfaces',
      'version',
      'capabilities',
      'defaultInputModes',
      'defaultOutputModes',
      'skills',
    ])
      expect(card).toHaveProperty(key);
  });

  it('carries the input fields as a JSON schema extension', async () => {
    const { app } = setup();

    const card = (await (
      await app.request('http://plattform.test/a2a/skjema__default', { headers: headers() })
    ).json()) as {
      capabilities: { extensions: { uri: string; params: { schema: unknown } }[] };
      defaultInputModes: string[];
    };

    expect(card.defaultInputModes).toContain('application/json');
    expect(card.capabilities.extensions[0]).toMatchObject({
      uri: 'urn:genai:a2a:input-schema:v1',
      params: { schema: { required: ['year'] } },
    });
  });

  it('lists one agent per exposed service and hides services without the a2a channel', async () => {
    const { app } = setup();

    const listing = (await (
      await app.request('http://plattform.test/a2a', { headers: headers() })
    ).json()) as { agents: { skills: { id: string }[] }[] };

    const ids = listing.agents.map((a) => a.skills[0]?.id);
    expect(ids).toContain('rapport__default');
    expect(ids).not.toContain('rapport-alias');
    expect(ids).not.toContain('hidden__default');
    const hidden = await app.request('http://plattform.test/a2a/hidden__default', {
      headers: headers(),
    });
    expect(hidden.status).toBe(404);
  });

  it('requires an API key', async () => {
    const { app } = setup();

    const response = await app.request('http://plattform.test/a2a');

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });
});

describe('public A2A discovery', () => {
  const opted = entries.filter((e) => e.id === 'skjema__default');
  const discovery = (perAddress = 100) => {
    const seen = new Map<string, number>();
    return {
      list: async () =>
        opted.map((entry) => ({ entry, provider: { organization: 'Skatteetaten' } })),
      resolve: async (name: string) => {
        const entry = opted.find((e) => e.id === name);
        return entry ? { entry, provider: { organization: 'Skatteetaten' } } : undefined;
      },
      limit: async (c: { req: { header(name: string): string | undefined } }) => {
        const address = c.req.header('x-forwarded-for') ?? 'unknown';
        const count = (seen.get(address) ?? 0) + 1;
        seen.set(address, count);
        return count > perAddress
          ? { ok: false as const, retryAfterSeconds: 60 }
          : { ok: true as const };
      },
    };
  };
  const anonymous = (app: ReturnType<typeof setup>['app'], path: string, ip = '10.0.0.1') =>
    app.request(`http://plattform.test${path}`, { headers: { 'x-forwarded-for': ip } });

  it('keeps cards behind login for services that did not opt in', async () => {
    const { app } = setup({ publicDiscovery: discovery() });

    expect((await anonymous(app, '/a2a/rapport__default/.well-known/agent-card.json')).status).toBe(
      401,
    );
    expect((await anonymous(app, '/a2a/rapport__default')).status).toBe(401);
    const listing = (await (await anonymous(app, '/a2a')).json()) as {
      agents: { name: string }[];
    };
    expect(listing.agents.map((a) => a.name)).toEqual(['Skjema']);
  });

  it('shows an opted-in service as a reduced card that strict A2A 1.0 clients accept, without input schema or fields', async () => {
    const { app } = setup({ publicDiscovery: discovery() });

    const response = await anonymous(app, '/a2a/skjema__default/.well-known/agent-card.json');

    expect(response.status).toBe(200);
    const card = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(card).sort()).toEqual(
      [
        'capabilities',
        'defaultInputModes',
        'defaultOutputModes',
        'description',
        'name',
        'provider',
        'securityRequirements',
        'securitySchemes',
        'skills',
        'supportedInterfaces',
        'version',
      ].sort(),
    );
    expect(card.provider).toEqual({
      organization: 'Skatteetaten',
      url: expect.stringMatching(/^https?:\/\//),
    });
    expect(card.capabilities).toEqual({ streaming: true });
    expect(card.defaultInputModes).toEqual(['text/plain']);
    expect(card.skills).toEqual([
      { id: 'skjema__default', name: card.name, description: card.description, tags: ['genai'] },
    ]);
    for (const iface of card.supportedInterfaces as Record<string, unknown>[])
      expect(iface).toMatchObject({
        url: expect.any(String),
        protocolBinding: 'JSONRPC',
        protocolVersion: expect.any(String),
      });
    const text = JSON.stringify(card);
    for (const leak of ['year', 'required', 'schema', 'inputFields', 'examples', 'extensions'])
      expect(text).not.toContain(leak);
  });

  it('gives an authenticated caller the full card', async () => {
    const { app } = setup({ publicDiscovery: discovery() });

    const card = (await (
      await app.request('http://plattform.test/a2a/skjema__default/.well-known/agent-card.json', {
        headers: headers(),
      })
    ).json()) as Record<string, unknown>;

    expect(card).toHaveProperty('skills');
    expect(JSON.stringify(card)).toContain('year');
  });

  it('rate limits public discovery per address', async () => {
    const { app } = setup({ publicDiscovery: discovery(2) });
    const path = '/a2a/skjema__default/.well-known/agent-card.json';

    expect((await anonymous(app, path)).status).toBe(200);
    expect((await anonymous(app, '/a2a')).status).toBe(200);
    const limited = await anonymous(app, path);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await anonymous(app, path, '10.0.0.2')).status).toBe(200);
  });

  it('still requires a token to call an opted-in agent', async () => {
    const { app } = setup({ publicDiscovery: discovery() });

    const response = await app.request('http://plattform.test/a2a/skjema__default', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }),
    });

    expect(response.status).toBe(401);
  });
});

describe('A2A SendMessage and GetTask', () => {
  it('runs the service through the kernel and returns a completed task with the answer artifact', async () => {
    const { app } = setup();

    const response = await rpc(app, 'rapport__default', 'SendMessage', userMessage('ventetid'));

    expect(response.status).toBe(200);
    expect(response.headers.get('genai-generated-by')).toBe('ai');
    expect(response.headers.get('genai-model')).toBe('gpt-test');
    expect(response.headers.get('genai-service-version')).toBe('3');
    const body = (await response.json()) as {
      id: number;
      result: { task: Record<string, unknown> & { artifacts: { parts: unknown[] }[] } };
    };
    expect(body.id).toBe(7);
    expect(body.result.task).toMatchObject({
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED' },
      metadata: { aiGenerated: true, model: 'gpt-test', serviceVersion: 3 },
      history: [{ messageId: 'm1', role: 'ROLE_USER' }],
    });
    expect(body.result.task.artifacts[0]?.parts).toEqual([
      { text: 'Svar på: ventetid', mediaType: 'text/plain' },
      {
        data: { sources: [{ chunkId: 'c1', title: 'Rapport' }] },
        mediaType: 'application/vnd.genai.sources+json',
      },
    ]);
    expect(response.headers.get('genai-task')).toBe(body.result.task.id);

    const got = (await (
      await rpc(app, 'rapport__default', 'GetTask', { id: body.result.task.id })
    ).json()) as { result: Record<string, unknown> };
    expect(got.result).toMatchObject({
      id: body.result.task.id,
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ name: 'answer' }],
    });
  });

  it('keeps the context id the caller sends so a conversation continues', async () => {
    const { app } = setup();

    const body = (await (
      await rpc(
        app,
        'rapport__default',
        'SendMessage',
        userMessage('hei', { contextId: 'samtale-1' }),
      )
    ).json()) as { result: { task: { contextId: string } } };

    expect(body.result.task.contextId).toBe('samtale-1');
  });

  it('checks input fields from a data part and refuses a message without them', async () => {
    const { app } = setup();

    const refused = (await (
      await rpc(app, 'skjema__default', 'SendMessage', userMessage('Oppsummer'))
    ).json()) as { error: { code: number; data: { code: string } } };
    expect(refused.error).toMatchObject({
      code: errorCodes.invalidParams,
      data: { code: 'invalid_input' },
    });

    const accepted = (await (
      await rpc(app, 'skjema__default', 'SendMessage', {
        message: {
          messageId: 'm2',
          role: 'ROLE_USER',
          parts: [{ text: 'Oppsummer' }, { data: { year: 2024 } }],
        },
      })
    ).json()) as { result: { task: { status: { state: string } } } };
    expect(accepted.result.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('returns a failed task without leaking the internal error', async () => {
    const { app } = setup();

    const body = (await (
      await rpc(app, 'broken__default', 'SendMessage', userMessage('hei'))
    ).json()) as { result: { task: { status: { state: string; message: unknown } } } };

    expect(body.result.task.status.state).toBe('TASK_STATE_FAILED');
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });

  it('answers immediately with a working task when the caller asks for it', async () => {
    const { app, kernel } = setup();

    const body = (await (
      await rpc(app, 'slow__default', 'SendMessage', {
        ...userMessage('hei'),
        configuration: { returnImmediately: true },
      })
    ).json()) as { result: { task: { id: string; status: { state: string } } } };

    expect(body.result.task.status.state).toBe('TASK_STATE_WORKING');
    await kernel.cancel(kari, body.result.task.id);
  });

  it('asks for more input on an interrupt and continues the same task with the reply', async () => {
    const { app } = setup();

    const first = (await (
      await rpc(app, 'ask__default', 'SendMessage', userMessage('hei'))
    ).json()) as {
      result: { task: { id: string; contextId: string; status: Record<string, unknown> } };
    };
    expect(first.result.task.status).toMatchObject({
      state: 'TASK_STATE_INPUT_REQUIRED',
      message: {
        role: 'ROLE_AGENT',
        parts: [{ text: 'Hvilket år gjelder det?' }],
        metadata: { interruptId: 'i1' },
      },
    });

    const second = (await (
      await rpc(app, 'ask__default', 'SendMessage', {
        message: {
          messageId: 'm3',
          role: 'ROLE_USER',
          taskId: first.result.task.id,
          contextId: first.result.task.contextId,
          parts: [{ data: { year: 2024 } }],
        },
      })
    ).json()) as { result: { task: { id: string; artifacts: { parts: { text?: string }[] }[] } } };
    expect(second.result.task.id).toBe(first.result.task.id);
    expect(second.result.task.artifacts[0]?.parts[0]?.text).toBe('Året er 2024');

    const again = (await (
      await rpc(app, 'ask__default', 'SendMessage', {
        message: {
          messageId: 'm4',
          role: 'ROLE_USER',
          taskId: first.result.task.id,
          parts: [{ text: 'x' }],
        },
      })
    ).json()) as { error: { code: number } };
    expect(again.error.code).toBe(errorCodes.unsupported);
  });

  it('does not show another caller the task', async () => {
    const { app } = setup();
    const body = (await (
      await rpc(app, 'rapport__default', 'SendMessage', userMessage('hei'))
    ).json()) as {
      result: { task: { id: string } };
    };

    const other = (await (
      await rpc(app, 'rapport__default', 'GetTask', { id: body.result.task.id }, 'other')
    ).json()) as { error: { code: number } };
    const wrongAgent = (await (
      await rpc(app, 'slow__default', 'GetTask', { id: body.result.task.id })
    ).json()) as { error: { code: number } };

    expect(other.error.code).toBe(errorCodes.taskNotFound);
    expect(wrongAgent.error.code).toBe(errorCodes.taskNotFound);
  });

  it('refuses file parts, unknown versions, unknown methods and push notifications with the A2A codes', async () => {
    const { app } = setup();

    const file = (await (
      await rpc(app, 'rapport__default', 'SendMessage', {
        message: { messageId: 'm', role: 'ROLE_USER', parts: [{ url: 'https://x.test/a.pdf' }] },
      })
    ).json()) as { error: { code: number } };
    const version = (await (
      await app.request('http://plattform.test/a2a/rapport__default', {
        method: 'POST',
        headers: { ...headers(), 'a2a-version': '0.5' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }),
      })
    ).json()) as { error: { code: number } };
    const unknown = (await (await rpc(app, 'rapport__default', 'message/send', {})).json()) as {
      error: { code: number };
    };
    const push = (await (
      await rpc(app, 'rapport__default', 'CreateTaskPushNotificationConfig', {})
    ).json()) as { error: { code: number } };
    const list = (await (await rpc(app, 'rapport__default', 'ListTasks', {})).json()) as {
      error: { code: number };
    };

    expect(file.error.code).toBe(errorCodes.contentType);
    expect(version.error.code).toBe(errorCodes.versionNotSupported);
    expect(unknown.error.code).toBe(errorCodes.methodNotFound);
    expect(push.error.code).toBe(errorCodes.pushNotSupported);
    expect(list.error.code).toBe(errorCodes.unsupported);
  });

  it('refuses a call to an agent that is not exposed', async () => {
    const { app } = setup();

    const response = await rpc(app, 'hidden__default', 'SendMessage', userMessage('hei'));

    expect(response.status).toBe(404);
  });
});

describe('A2A CancelTask', () => {
  it('cancels a working task and refuses to cancel one that has ended', async () => {
    const { app } = setup();
    const started = (await (
      await rpc(app, 'slow__default', 'SendMessage', {
        ...userMessage('hei'),
        configuration: { returnImmediately: true },
      })
    ).json()) as { result: { task: { id: string } } };

    const cancelled = (await (
      await rpc(app, 'slow__default', 'CancelTask', { id: started.result.task.id })
    ).json()) as { result: { status: { state: string } } };
    const again = (await (
      await rpc(app, 'slow__default', 'CancelTask', { id: started.result.task.id })
    ).json()) as { error: { code: number } };

    expect(cancelled.result.status.state).toBe('TASK_STATE_CANCELED');
    expect(again.error.code).toBe(errorCodes.taskNotCancelable);
  });
});

describe('A2A streaming', () => {
  it('opens with the task, streams the answer as artifact chunks and ends with the final status', async () => {
    const { app } = setup();

    const response = await rpc(
      app,
      'rapport__default',
      'SendStreamingMessage',
      userMessage('ventetid'),
    );

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const stream = await events(response);
    expect(stream[0]?.result.task).toMatchObject({ status: { state: 'TASK_STATE_WORKING' } });
    const chunks = stream.filter((e) => e.result.artifactUpdate);
    expect(chunks.slice(0, 2).map((e) => e.result.artifactUpdate)).toMatchObject([
      { append: false, lastChunk: false, artifact: { parts: [{ text: 'Svar ' }] } },
      { append: true, lastChunk: false, artifact: { parts: [{ text: 'på: ventetid' }] } },
    ]);
    expect(chunks.at(-1)?.result.artifactUpdate).toMatchObject({
      append: false,
      lastChunk: true,
      artifact: {
        parts: [{ text: 'Svar på: ventetid' }, { mediaType: 'application/vnd.genai.sources+json' }],
      },
    });
    expect(stream.at(-1)?.result.statusUpdate).toMatchObject({
      status: { state: 'TASK_STATE_COMPLETED' },
      metadata: { aiGenerated: true },
    });
  });

  it('lets a second caller subscribe to a working task and see it end when cancelled', async () => {
    const { app } = setup();
    const started = (await (
      await rpc(app, 'slow__default', 'SendMessage', {
        ...userMessage('hei'),
        configuration: { returnImmediately: true },
      })
    ).json()) as { result: { task: { id: string } } };
    const id = started.result.task.id;

    const subscribed = rpc(app, 'slow__default', 'SubscribeToTask', { id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rpc(app, 'slow__default', 'CancelTask', { id });
    const stream = await events(await subscribed);

    expect(stream[0]?.result.task).toMatchObject({ id });
    expect(stream.at(-1)?.result.statusUpdate).toMatchObject({
      taskId: id,
      status: { state: 'TASK_STATE_CANCELED' },
    });
    const ended = (await (await rpc(app, 'slow__default', 'SubscribeToTask', { id })).json()) as {
      error: { code: number };
    };
    expect(ended.error.code).toBe(errorCodes.unsupported);
  });
});

describe('agent card names', () => {
  const variant: AgentEntry = {
    id: 'kunnskapsassistenten__arsrapporter-forst',
    capability: `${tenant}/kunnskapsassistenten/arsrapporter-forst`,
    title: 'Årsrapporter først',
    serviceTitle: 'Kunnskapsassistenten',
    variantTitle: 'Årsrapporter først',
    mode: 'arsrapporter-forst',
  };
  const provider = { organization: 'Digdir', url: 'https://www.digdir.no' };

  it('names a card "Service · Variant" so a variant is never shown as a service of its own', () => {
    const card = agentCard(variant, { url: 'https://plattform.test/a2a/x' });

    expect(card.name).toBe('Kunnskapsassistenten · Årsrapporter først');
    expect(card.skills[0]?.name).toBe('Kunnskapsassistenten · Årsrapporter først');
  });

  it('names the public card "Service · Variant" too', () => {
    const card = publicAgentCard(variant, { url: 'https://plattform.test/a2a/x', provider });

    expect(card.name).toBe('Kunnskapsassistenten · Årsrapporter først');
  });

  it('names the card of the default variant after the service alone', () => {
    const card = agentCard(
      {
        ...variant,
        id: 'kunnskapsassistenten__default',
        mode: 'default',
        variantTitle: 'Standard',
      },
      { url: 'https://plattform.test/a2a/x' },
    );

    expect(card.name).toBe('Kunnskapsassistenten');
  });

  it('falls back to the title when the entry does not name its service and variant', () => {
    const plain: AgentEntry = {
      id: variant.id,
      capability: variant.capability,
      title: 'Årsrapporter først',
    };

    expect(agentCard(plain, { url: 'https://plattform.test/a2a/x' }).name).toBe(
      'Årsrapporter først',
    );
  });
});
