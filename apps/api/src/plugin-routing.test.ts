import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import type { Evaluator, Score } from '@genai/eval';
import { envSecrets, type PortContext } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { openAiChatFixture } from '@genai/providers-openai/contract';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';

const other = '999888777';
const third = '974760673';

const people: Record<string, Principal> = {
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: other,
    authorizedFor: [{ org: other }],
  } as Principal,
  per: {
    kind: 'employee',
    issuer: 'test',
    subject: 'per',
    tenant: third,
    authorizedFor: [{ org: third }],
  } as Principal,
};

const fakes: FakeServer[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((resolve) => {
          s.closeAllConnections();
          s.close(resolve);
        }),
    ),
  );
});

const listen = async (handler: RequestListener) => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const jsonServer = (reply: (body: Record<string, unknown>, path: string) => unknown) =>
  listen((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const out = reply(body, req.url ?? '');
      if (out === undefined) {
        res.writeHead(202);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

const mcpServer = (onCall: (args: unknown) => string) =>
  jsonServer((body) => {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'initialize')
      return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    if (body.method === 'tools/list')
      return reply({
        tools: [
          {
            name: 'Finn sak',
            description: 'Finner en sak',
            inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
          },
        ],
      });
    if (body.method === 'tools/call')
      return reply({
        content: [
          { type: 'text', text: onCall((body.params as { arguments?: unknown }).arguments) },
        ],
      });
    return undefined;
  });

const modelServer = async (text: string, status = 200) => {
  const fake = await fakeHttp((body) =>
    status === 200
      ? openAiChatFixture.reply({ kind: 'text', text }, body, '')
      : { status, json: { error: { message: 'nede' } } },
  );
  fakes.push(fake);
  return fake;
};

const boot = async (
  egress: Parameters<typeof createPlatform>[0]['egress'] = {
    testOverride: { allowLoopback: true, allowHttp: true },
    timeoutMs: 3000,
  },
) => {
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ PLUGIN_KEY: 'k' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const person = people[request.headers.get('authorization')?.slice(7) ?? ''];
      return person ? { principal: person } : undefined;
    },
    egress,
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const send = (path: string, init: { method?: string; body?: unknown; reason?: string } = {}) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: 'Bearer drift',
        'content-type': 'application/json',
        ...(init.reason ? { 'change-reason': init.reason } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const as = (who: string, path: string, body: unknown, reason = 'Løfter en byggekloss') =>
    app.request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${who}`,
        'content-type': 'application/json',
        'change-reason': reason,
      },
      body: JSON.stringify(body),
    });
  const register = (body: unknown) =>
    send('/operator/plugins', { body, reason: 'Ny byggekloss fra en leverandør' });
  const adopt = async (who: string, tenant: string, kind: string, id: string) => {
    const adopted = await as(
      who,
      `/tenants/${tenant}/building-blocks/${kind}/${encodeURIComponent(id)}/adopt`,
      {},
      'Tar i bruk byggeklossen fra Digdir',
    );
    expect(adopted.status, await adopted.clone().text()).toBe(200);
  };
  return { platform, send, register, as, adopt };
};

const modelPlugin = (url: string, patch: Record<string, unknown> = {}) => ({
  manifest: {
    kind: 'model',
    id: 'model.leverandor',
    version: '1',
    contract: 'model@1',
    title: 'Leverandørmodell',
    capabilities: ['stream'],
    dataLocation: 'norway',
    hosts: ['127.0.0.1'],
    secrets: ['secret://env/plugin-key'],
    ...patch,
  },
  endpoint: {
    baseURL: `${url}/v1`,
    protocol: 'openai-chat',
    deployment: 'leverandor',
    auth: { kind: 'api-key', secret: 'secret://env/plugin-key' },
  },
});

const ctx: PortContext = {
  tenant: other,
  principal: people.kari as Principal,
  task: 't1',
  signal: new AbortController().signal,
  meter: async () => undefined,
};

const answerService = (model: string, patch: Record<string, unknown> = {}) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: other, id: 'svar', name: 'Svar' },
  spec: {
    purpose: 'Svarer kort',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'prompts/svar.md' } },
    model: { primary: model, residency: 'norway' },
    exposure: { rest: true },
    ...patch,
  },
});

const flowCalling = (tenant: string, id: string, source: string) => ({
  apiVersion: 'genai/v1',
  kind: 'StepFlow',
  metadata: { tenant, id, name: id },
  spec: {
    purpose: 'Slå opp en sak',
    input: { query: 'tekst' },
    steps: [
      {
        id: 'sok',
        name: 'Slå opp',
        block: 'tool@1',
        params: { source, tool: 'finn-sak', arguments: { q: '{{input.query}}' } },
      },
      {
        id: 'svar',
        name: 'Svar',
        block: 'model@1',
        input: { prompt: 'Svar fra arkivet: {{sok.text}}' },
      },
    ],
  },
});

const textOf = (parts: { mime: string; body: { kind: string; text?: string } }[]) =>
  parts.find((p) => p.body.kind === 'text')?.body.text;

describe('operator-registered plug-ins at registration', () => {
  it('runs the contract suite when an operator registers a plug-in and records the run', async () => {
    const { send, register } = await boot();
    const model = await modelServer('Hei fra leverandøren');
    const saved = await register(modelPlugin(model.url));
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({ contractTests: { passed: true } });
    const detail = (await (await send('/operator/plugins/model.leverandor')).json()) as {
      runs: { trigger: string; passed: boolean }[];
    };
    expect(detail.runs).toEqual([
      expect.objectContaining({ trigger: 'registration', passed: true }),
    ]);
  });

  it('refuses a plug-in whose contract suite fails at registration and stores nothing', async () => {
    const { send, register } = await boot();
    const model = await modelServer('', 500);
    const refused = await register(modelPlugin(model.url));
    expect(refused.status).toBe(422);
    const body = (await refused.json()) as { errors: { path: string }[] };
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors.every((e) => e.path.startsWith('contract.'))).toBe(true);
    const { data } = (await (await send('/operator/plugins?kind=model')).json()) as {
      data: { id: string }[];
    };
    expect(data.map((p) => p.id)).not.toContain('model.leverandor');
  });

  it('refuses an endpoint on a host or with a secret the manifest does not declare', async () => {
    const { register } = await boot();
    const wrongHost = await register(
      modelPlugin('http://127.0.0.1:9', { hosts: ['api.example.no'] }),
    );
    expect(wrongHost.status).toBe(400);
    expect(JSON.stringify(await wrongHost.json())).toContain('endpoint.baseURL');
    const wrongSecret = await register(modelPlugin('http://127.0.0.1:9', { secrets: [] }));
    expect(wrongSecret.status).toBe(400);
    expect(JSON.stringify(await wrongSecret.json())).toContain('endpoint.auth.secret');
  });
});

describe('operator-registered plug-ins in the routers', () => {
  it('serves a published service from an operator-registered model endpoint, and stops when removed', async () => {
    const { platform, send, register, adopt } = await boot();
    const model = await modelServer('Hei fra leverandøren');
    expect((await register(modelPlugin(model.url))).status).toBe(201);
    expect(platform.models.models().has('model.leverandor')).toBe(true);
    await adopt('kari', other, 'model', 'model.leverandor');

    const published = await platform.definitions.publish(
      answerService('model.leverandor'),
      'test',
      'test',
      { 'prompts/svar.md': 'Svar kort.' },
    );
    expect(published.ok ? [] : published.errors).toEqual([]);
    const before = model.seen.length;
    const run = await platform.kernel.invoke(people.kari as Principal, `${other}/svar/default`, {
      data: { query: 'Hei' },
      parts: [{ mime: 'text/plain', body: { kind: 'text', text: 'Hei' } }],
    });
    expect(textOf((await run.result) as never)).toBe('Hei fra leverandøren');
    expect(model.seen.length).toBeGreaterThan(before);
    expect(
      model.seen.at(-1)?.headers['api-key'] ?? model.seen.at(-1)?.headers.authorization,
    ).toBeTruthy();

    const removed = await send('/operator/plugins/model.leverandor', {
      method: 'DELETE',
      reason: 'Avtalen med leverandøren er sagt opp',
    });
    expect(removed.status).toBe(200);
    expect(platform.models.models().has('model.leverandor')).toBe(false);
  });

  it('keeps a catalog entry that comes from a plug-in out of reach of the catalog API', async () => {
    const { platform, register } = await boot();
    const model = await modelServer('Hei');
    await register(modelPlugin(model.url));
    const result = await platform.catalog.publish({
      kind: 'model',
      scope: 'platform',
      id: 'model.leverandor',
      spec: { endpoint: 'model.leverandor', deployment: 'x', residency: 'global' },
      by: 'drift',
      reason: 'Prøver å overstyre',
    });
    expect(result).toMatchObject({ ok: false, conflict: true });
  });

  it('searches an operator-registered search endpoint as a dataset', async () => {
    const { platform, register } = await boot();
    const searched: unknown[] = [];
    const url = await jsonServer((body) => {
      searched.push(body);
      return {
        hits: [{ id: 'd1', text: 'Tildelingsbrevet for 2025', score: 0.8, title: 'Brev' }].slice(
          0,
          Number(body.limit ?? 10),
        ),
      };
    });
    const saved = await register({
      manifest: {
        kind: 'knowledge',
        id: 'knowledge.arkiv',
        version: '1',
        contract: 'knowledge@1',
        title: 'Arkivsøk',
        dataLocation: 'norway',
        hosts: ['127.0.0.1'],
        secrets: ['secret://env/plugin-key'],
      },
      endpoint: {
        baseURL: url,
        protocol: 'http-search',
        auth: { kind: 'bearer', secret: 'secret://env/plugin-key' },
        query: 'tildelingsbrev',
      },
    });
    expect(saved.status).toBe(201);
    const port = platform.knowledge.open({ kind: 'dataset', id: 'knowledge.arkiv' }, ctx);
    const { hits } = await port.search({ query: 'tildelingsbrev', limit: 3 });
    expect(hits.map((h) => h.id)).toEqual(['d1']);
    expect(searched.at(-1)).toMatchObject({ query: 'tildelingsbrev', limit: 3 });
  });

  it('lets a service in another tenant call a tool from an operator-registered tool source', async () => {
    const { platform, register, adopt } = await boot();
    const calls: unknown[] = [];
    const url = await mcpServer((args) => {
      calls.push(args);
      return 'Sak 17 gjelder en tilskuddssøknad.';
    });
    const model = await modelServer('Saken gjelder en tilskuddssøknad.');
    expect(
      (await register(modelPlugin(model.url, { capabilities: ['stream', 'tools', 'json-schema'] })))
        .status,
    ).toBe(201);
    const saved = await register({
      manifest: {
        kind: 'tool-source',
        id: 'tool-source.saker',
        version: '1',
        contract: 'tool-source@1',
        title: 'Saksarkiv',
        hosts: ['127.0.0.1'],
      },
      endpoint: {
        baseURL: `${url}/mcp`,
        protocol: 'mcp',
        example: { tool: 'finn-sak', input: { q: 'tilskudd' } },
      },
    });
    expect(saved.status).toBe(201);

    const flow = {
      apiVersion: 'genai/v1',
      kind: 'StepFlow',
      metadata: { tenant: other, id: 'oppslag', name: 'Oppslag' },
      spec: {
        purpose: 'Slå opp en sak',
        input: { query: 'tekst' },
        steps: [
          {
            id: 'sok',
            name: 'Slå opp',
            block: 'tool@1',
            params: {
              source: 'tool-source-saker',
              tool: 'finn-sak',
              arguments: { q: '{{input.query}}' },
            },
          },
          {
            id: 'svar',
            name: 'Svar',
            block: 'model@1',
            input: { prompt: 'Svar fra arkivet: {{sok.text}}' },
          },
        ],
      },
    };
    expect((await platform.definitions.publish(flow, 'test', 'test')).ok).toBe(true);
    const service = {
      ...answerService('model.leverandor'),
      metadata: { tenant: other, id: 'oppslag', name: 'Oppslag' },
    };
    service.spec = {
      ...service.spec,
      strategy: { id: 'step-flow', version: 1, config: { flow: 'oppslag@1' } },
      tools: ['tool-source-saker.finn-sak@1'],
    } as never;
    await adopt('kari', other, 'model', 'model.leverandor');
    await adopt('kari', other, 'tool', 'tool-source-saker');
    const published = await platform.definitions.publish(service, 'test', 'test');
    expect(published.ok ? [] : published.errors).toEqual([]);
    const before = calls.length;
    const run = await platform.kernel.invoke(people.kari as Principal, `${other}/oppslag/default`, {
      data: { query: 'sak 17' },
    });
    await run.result;
    expect(calls.slice(before)).toEqual([{ q: 'sak 17' }]);
    expect(JSON.stringify(model.seen.at(-1)?.body)).toContain('Sak 17 gjelder en tilskuddssøknad.');
  });
});

describe('plug-in kinds that call out', () => {
  it('registers an agent endpoint that answers in the remote-agent/v1 shape', async () => {
    const { send, register } = await boot();
    const asked: unknown[] = [];
    const url = await jsonServer((body) => {
      asked.push(body);
      return { answer: 'Jeg hjelper med saker.' };
    });
    const saved = await register({
      manifest: {
        kind: 'agent',
        id: 'agent.saksbehandler',
        version: '1',
        contract: 'agent@1',
        title: 'Saksbehandler',
        hosts: ['127.0.0.1'],
      },
      endpoint: { baseURL: `${url}/agent`, protocol: 'http' },
    });
    expect(saved.status).toBe(201);
    expect(asked[0]).toMatchObject({ contract: 'remote-agent/v1' });
    const { data } = (await (await send('/operator/plugins?kind=agent')).json()) as {
      data: { id: string }[];
    };
    expect(data.map((p) => p.id)).toEqual(['agent.saksbehandler']);
  });

  it('refuses an agent that does not answer in the remote-agent/v1 shape', async () => {
    const { register } = await boot();
    const url = await jsonServer(() => ({ answer: 42 }));
    const refused = await register({
      manifest: {
        kind: 'agent',
        id: 'agent.feil',
        version: '1',
        contract: 'agent@1',
        title: 'Feil',
        hosts: ['127.0.0.1'],
      },
      endpoint: { baseURL: url, protocol: 'http' },
    });
    expect(refused.status).toBe(422);
  });

  it('adds an operator-registered evaluator to the evaluators eval runs use, and drops it when removed', async () => {
    const { platform, send, register } = await boot();
    const judged: unknown[] = [];
    const url = await jsonServer((body) => {
      judged.push(body);
      return { scores: [{ metric: 'korrekthet', value: 0.9, reason: 'Stemmer' }] };
    });
    const saved = await register({
      manifest: {
        kind: 'evaluator',
        id: 'evaluator.dommer',
        version: '1',
        contract: 'evaluator@2',
        title: 'Ekstern dommer',
        capabilities: ['korrekthet'],
        hosts: ['127.0.0.1'],
      },
      endpoint: { baseURL: url, protocol: 'http-judge' },
    });
    expect(saved.status).toBe(201);
    expect(judged[0]).toMatchObject({ contract: 'evaluator@2', answer: expect.any(String) });
    const evaluator = platform.evaluators.get('evaluator.dommer');
    expect(evaluator).toBeDefined();
    await send('/operator/plugins/evaluator.dommer', {
      method: 'DELETE',
      reason: 'Dommeren er byttet ut',
    });
    expect(platform.evaluators.has('evaluator.dommer')).toBe(false);
  });
  it('collects what an evaluator plug-in answered pending, by its ticket', async () => {
    const { platform, register } = await boot();
    const asked: Record<string, unknown>[] = [];
    let ready = false;
    const url = await jsonServer((body) => {
      asked.push(body);
      if (!body.collect)
        return { scores: [{ metric: 'korrekthet', state: 'pending' }], ticket: 'sak-1' };
      const tickets = (body.collect as { tickets: string[] }).tickets;
      const results = tickets.map((ticket) => ({
        ticket,
        scores: [
          ready
            ? { metric: 'korrekthet', value: 0.7, reason: 'Stemmer' }
            : { metric: 'korrekthet', state: 'pending' },
        ],
      }));
      ready = true;
      return { results };
    });
    const saved = await register({
      manifest: {
        kind: 'evaluator',
        id: 'evaluator.senere',
        version: '1',
        contract: 'evaluator@2',
        title: 'Dommer som svarer senere',
        capabilities: ['korrekthet'],
        hosts: ['127.0.0.1'],
      },
      endpoint: { baseURL: url, protocol: 'http-judge' },
    });
    expect(saved.status).toBe(201);
    const judge = platform.evaluators.get('evaluator.senere') as Evaluator;

    const [answer] = await judge.evaluate(
      {
        id: 'sak',
        split: 'validation',
        input: 'Hvem utsteder tildelingsbrevet?',
        expected: { sources: [] },
        grounding: 'sources-and-answer',
        tags: [],
        needsReview: false,
      },
      { answer: 'Departementet.', retrieved: [], citations: [] },
      { servedModels: [], modelFamily: () => undefined },
    );
    const item = { case: 'sak', repeat: 0, task: 't-sak', score: answer as Score };
    ready = false;
    const notYet = await judge.collect?.([item]);
    const collected = await judge.collect?.([item]);

    expect(answer).toMatchObject({ state: 'pending', value: null, details: { ticket: 'sak-1' } });
    expect(asked.at(-1)).toEqual({ contract: 'evaluator@2', collect: { tickets: ['sak-1'] } });
    expect(notYet).toEqual([]);
    expect(collected).toEqual([
      {
        case: 'sak',
        repeat: 0,
        score: {
          evaluator: 'evaluator.senere',
          version: '1',
          metric: 'korrekthet',
          value: 0.7,
          applicable: true,
          state: 'scored',
          reason: 'Stemmer',
        },
      },
    ]);
  });

  it('refuses an evaluator plug-in that claims evaluator@1', async () => {
    const { platform, register } = await boot();
    const url = await jsonServer(() => ({ scores: [{ metric: 'korrekthet', value: 0.9 }] }));

    const refused = await register({
      manifest: {
        kind: 'evaluator',
        id: 'evaluator.gammel',
        version: '1',
        contract: 'evaluator@1',
        title: 'Gammel dommer',
        capabilities: ['korrekthet'],
        hosts: ['127.0.0.1'],
      },
      endpoint: { baseURL: url, protocol: 'http-judge' },
    });

    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain(
      'evaluator plug-ins meet evaluator@2; register evaluator.gammel again under evaluator@2',
    );
    expect(platform.evaluators.has('evaluator.gammel')).toBe(false);
  });
});

describe('promotion to the shared catalog', () => {
  it('lets Digdir promote a tenant tool connection so services in other tenants can call it', async () => {
    const { platform, send, register, as, adopt } = await boot();
    const calls: unknown[] = [];
    const url = await mcpServer((args) => {
      calls.push(args);
      return 'Sak 9 er avsluttet.';
    });
    await platform.connections.save({
      connection: {
        id: 'arkiv',
        tenant: other,
        name: 'Arkiv',
        protocol: 'mcp',
        endpoint: `${url}/mcp`,
        version: '1',
        allow: [{ host: '127.0.0.1', port: Number(new URL(url).port) }],
      },
      tools: [],
      pending: [],
    });
    expect((await as('kari', `/tenants/${other}/tool-connections/arkiv/sync`, {})).status).toBe(
      200,
    );
    const model = await modelServer('Saken er avsluttet.');
    await register(modelPlugin(model.url, { capabilities: ['stream', 'tools', 'json-schema'] }));

    expect(
      (await as('kari', '/operator/plugins/promotions', { tenant: other, connection: 'arkiv' }))
        .status,
    ).toBe(403);
    const promoted = await as('drift', '/operator/plugins/promotions', {
      tenant: other,
      connection: 'arkiv',
    });
    expect(promoted.status).toBe(201);
    expect(await promoted.json()).toMatchObject({
      id: `tool-source.${other}.arkiv`,
      publisher: other,
      shared: { tenant: other, connection: 'arkiv' },
    });
    const listed = (await (await send('/operator/plugins?kind=tool-source')).json()) as {
      data: { id: string }[];
    };
    expect(listed.data.map((p) => p.id)).toContain(`tool-source.${other}.arkiv`);

    expect(
      (await platform.definitions.publish(flowCalling(third, 'oppslag', 'arkiv'), 'test', 'test'))
        .ok,
    ).toBe(true);
    const service = {
      ...answerService('model.leverandor'),
      metadata: { tenant: third, id: 'oppslag', name: 'Oppslag' },
    };
    service.spec = {
      ...service.spec,
      strategy: { id: 'step-flow', version: 1, config: { flow: 'oppslag@1' } },
      tools: ['arkiv.finn-sak@1'],
    } as never;
    await adopt('per', third, 'model', 'model.leverandor');
    await adopt('per', third, 'tool', 'arkiv');
    const published = await platform.definitions.publish(service, 'test', 'test');
    expect(published.ok ? [] : published.errors).toEqual([]);
    const run = await platform.kernel.invoke(people.per as Principal, `${third}/oppslag/default`, {
      data: { query: 'sak 9' },
    });
    await run.result;
    expect(calls).toEqual([{ q: 'sak 9' }]);
  });

  it('refuses to promote a connection that does not exist', async () => {
    const { as } = await boot();
    const missing = await as('drift', '/operator/plugins/promotions', {
      tenant: other,
      connection: 'finnes-ikke',
    });
    expect(missing.status).toBe(404);
  });
});

describe('per-tenant adoption of operator plug-ins', () => {
  it('refuses to publish a service that uses an operator plug-in the tenant has not adopted', async () => {
    const { platform, register, adopt } = await boot();
    const model = await modelServer('Hei');
    await register(modelPlugin(model.url));
    const refused = await platform.definitions.publish(
      answerService('model.leverandor'),
      't',
      't',
      {
        'prompts/svar.md': 'Svar kort.',
      },
    );
    expect(refused.ok ? [] : refused.errors.map((e) => e.message)).toEqual([
      `model.leverandor is offered by Digdir but ${other} has not adopted it`,
    ]);
    await adopt('kari', other, 'model', 'model.leverandor');
    const published = await platform.definitions.publish(
      answerService('model.leverandor'),
      't',
      't',
      { 'prompts/svar.md': 'Svar kort.' },
    );
    expect(published.ok ? [] : published.errors).toEqual([]);
  });
});

describe('egress on plug-in calls', () => {
  it('sends every call to a plug-in model through the egress guard, while the contract run does not', async () => {
    const { platform, register, adopt } = await boot({ timeoutMs: 3000 });
    const model = await modelServer('Hei fra leverandøren');
    expect((await register(modelPlugin(model.url))).status).toBe(201);
    await adopt('kari', other, 'model', 'model.leverandor');
    const port = platform.models.open({ kind: 'model', id: 'model.leverandor' }, ctx);
    const before = model.seen.length;
    await expect(port.chat({ messages: [{ role: 'user', content: 'Hei' }] })).rejects.toThrow();
    expect(model.seen.length).toBe(before);
  });
});

describe('operator-registered rerankers', () => {
  it('reranks through an operator-registered reranker endpoint', async () => {
    const { platform, register } = await boot();
    const seen: Record<string, unknown>[] = [];
    const url = await jsonServer((body) => {
      seen.push(body);
      const words = new Set(
        String(body.user_input ?? '')
          .toLowerCase()
          .split(/\s+/),
      );
      const documents = (body.documents as string[] | undefined) ?? [];
      return documents
        .map((d, index) => ({
          index,
          score: d
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => words.has(w)).length,
        }))
        .sort((a, b) => b.score - a.score)
        .map((r, i) => ({ ...r, rank: i + 1 }));
    });
    const saved = await register({
      manifest: {
        kind: 'rerank',
        id: 'rerank.leverandor',
        version: '1',
        contract: 'rerank@1',
        title: 'Leverandørens omrangering',
        dataLocation: 'norway',
        hosts: ['127.0.0.1'],
        secrets: ['secret://env/plugin-key'],
      },
      endpoint: {
        baseURL: `${url}/rerank`,
        protocol: 'colbert',
        auth: { kind: 'api-key', secret: 'secret://env/plugin-key' },
      },
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const port = platform.rerank.open({ kind: 'reranker', id: 'rerank.leverandor' }, ctx);
    const before = seen.length;
    const result = await port.rerank({
      query: 'frist for klage',
      documents: ['Barnehageplass', 'Frist for klage på vedtak', 'Klage'],
    });
    expect(seen.length).toBe(before + 1);
    expect(result.ranking[0]?.index).toBe(1);
  });
});

describe('agent plug-ins in services', () => {
  const agentPlugin = (url: string, dataLocation = 'norway') => ({
    manifest: {
      kind: 'agent',
      id: 'agent.saksbehandler',
      version: '1',
      contract: 'agent@1',
      title: 'Saksbehandler',
      dataLocation,
      hosts: ['127.0.0.1'],
    },
    endpoint: { baseURL: `${url}/agent`, protocol: 'http' },
  });
  const agentService = (residency = 'norway') => ({
    apiVersion: 'genai/v1',
    kind: 'Service',
    metadata: { tenant: other, id: 'agent', name: 'Agent' },
    spec: {
      purpose: 'Svarer med en registrert agent',
      riskClass: 'minimal',
      input: { accepts: ['text/plain'] },
      output: { kind: 'answer' },
      strategy: { id: 'remote-agent', version: 1, config: { agent: 'agent.saksbehandler' } },
      model: { primary: 'model.leverandor', residency },
      exposure: { rest: true },
    },
  });

  it('runs a remote-agent service that names a registered agent plug-in by id', async () => {
    const { platform, register, adopt } = await boot();
    const asked: Record<string, unknown>[] = [];
    const url = await jsonServer((body) => {
      asked.push(body);
      return { answer: 'Saken er under behandling.' };
    });
    const model = await modelServer('Hei');
    await register(modelPlugin(model.url));
    expect((await register(agentPlugin(url))).status).toBe(201);
    await adopt('kari', other, 'model', 'model.leverandor');
    const unadopted = await platform.definitions.publish(agentService(), 't', 't');
    expect(unadopted.ok ? [] : unadopted.errors.map((e) => e.path)).toEqual([
      'spec.strategy.config.agent',
    ]);
    await adopt('kari', other, 'shared_service', 'agent.saksbehandler');
    const published = await platform.definitions.publish(agentService(), 't', 't');
    expect(published.ok ? [] : published.errors).toEqual([]);
    const run = await platform.kernel.invoke(people.kari as Principal, `${other}/agent/default`, {
      data: { query: 'Hvor er saken?' },
    });
    expect(textOf((await run.result) as never)).toBe('Saken er under behandling.');
    expect(asked.at(-1)).toMatchObject({ query: 'Hvor er saken?', context: { tenant: other } });
  });

  it('refuses a registered agent whose data location is outside what the service allows', async () => {
    const { platform, register, adopt } = await boot();
    const url = await jsonServer(() => ({ answer: 'Hei' }));
    const model = await modelServer('Hei');
    await register(modelPlugin(model.url));
    await register(agentPlugin(url, 'global'));
    await adopt('kari', other, 'model', 'model.leverandor');
    await adopt('kari', other, 'shared_service', 'agent.saksbehandler');
    const refused = await platform.definitions.publish(agentService('norway'), 't', 't');
    expect(refused.ok ? [] : refused.errors.map((e) => e.message)).toEqual([
      'Den eksterne agenten behandler data utenfor EU/EØS. Tjenesten krever at data behandles i Norge.',
    ]);
  });

  it('refuses a service that names an agent nobody registered', async () => {
    const { platform, register, adopt } = await boot();
    const model = await modelServer('Hei');
    await register(modelPlugin(model.url));
    await adopt('kari', other, 'model', 'model.leverandor');
    const refused = await platform.definitions.publish(agentService(), 't', 't');
    expect(refused.ok ? [] : refused.errors.map((e) => e.path)).toContain(
      'spec.strategy.config.agent',
    );
  });
});
