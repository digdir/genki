import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets, type PortContext } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { EgressGuard, InMemoryConnections, McpToolSource } from '@genai/providers-mcp-client';
import { createAdmin } from './admin.js';
import { resolveCatalog } from './catalogs.js';
import { createPlatform } from './composition.js';
import { kernelTaskReader, toTimeline } from './timeline.js';

const tenant = '991825827';
const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) =>
  parseYaml(readFileSync(join(config, file), 'utf8')) as Record<string, unknown>;

const fakes: FakeServer[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((s) => s.close()));
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
  return (server.address() as AddressInfo).port;
};

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => resolve(raw));
  });

const completion = (content: string) => ({
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-test',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant,
  authorizedFor: [{ org: tenant }],
} as Principal;

const boot = async () => {
  const model = await fakeHttp((body) =>
    !body.messages
      ? {
          status: 200,
          json: { data: [{ id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' }] },
        }
      : { status: 200, json: completion('Saken gjelder en tilskuddssøknad.') },
  );
  const idle = await fakeHttp(() => ({ status: 200, json: {} }));
  fakes.push(model, idle);
  const env = {
    FOUNDRY_OPENAI_BASE_URL: `${model.url}/v1`,
    TYPESENSE_URL: idle.url,
    COLBERT_API_URL: idle.url,
  };
  const platform = await createPlatform({
    catalogs: {
      models: resolveCatalog(yaml('models.yaml'), 'models', env).catalog,
      knowledge: resolveCatalog(yaml('knowledge.yaml'), 'datasets', env).catalog,
      rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', env).catalog,
    },
    secrets: envSecrets({ FOUNDRY_OPENAI_KEY: 'm', TYPESENSE_KEY: 't', COLBERT_API_KEY: 'c' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer kari' ? { principal: kari } : undefined,
    egress: { testOverride: { allowLoopback: true, allowHttp: true }, timeoutMs: 2000 },
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const as = (extra: Record<string, string> = {}) => ({
    authorization: 'Bearer kari',
    'content-type': 'application/json',
    ...extra,
  });
  const secret = (name: string, value: string, port: number) =>
    app.request(`/tenants/${tenant}/secrets/${name}`, {
      method: 'PUT',
      headers: as({ 'change-reason': 'test av endringen' }),
      body: JSON.stringify({ value, allowedHosts: [`http://127.0.0.1:${port}`] }),
    });
  const reader = kernelTaskReader(platform.kernel, kari);
  const steps = async (id: string) => {
    const task = await reader.task(id);
    if (!task) throw new Error(`no task ${id}`);
    return toTimeline(task, await reader.events(id), new Date()).steps;
  };
  return { platform, app, as, secret, steps, model };
};

const remoteService = (url: string, residency = 'eu') => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'ekstern', name: 'Ekstern' },
  spec: {
    purpose: 'Svar med en ekstern agent',
    audience: ['employees'],
    riskClass: 'limited',
    variants: [{ id: 'default' }],
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer', withSources: true },
    strategy: {
      id: 'remote-agent',
      version: 1,
      config: {
        endpoint: {
          url,
          residency: 'eu',
          auth: { kind: 'bearer', secret: `secret://tenant/${tenant}/agent-token` },
        },
      },
    },
    model: { primary: 'foundry-openai/gpt-4o-2m-tps', residency },
    exposure: { chat: true, openai: true, mcp: true, rest: true },
    guardrails: { 'pii-before-model': { categories: ['national-id'], action: 'refuse' } },
  },
});

const turnReply = JSON.stringify({
  answer: 'Fristen er 1. mars.',
  sources: [{ id: 's1', title: 'Fristene', url: 'https://example.no/frister' }],
  steps: [{ title: 'Slo opp fristen', summary: 'fant 1 treff', durationMs: 50 }],
  usage: { inputTokens: 30, outputTokens: 8 },
});

describe('bringing your own logic', () => {
  it('runs a service whose whole turn is answered by an external agent, with the platform guarantees around it', async () => {
    const { platform, app, as, secret, steps, model } = await boot();
    const received: { auth?: string; body: Record<string, unknown> }[] = [];
    const port = await listen(async (req, res) => {
      received.push({
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        body: JSON.parse(await readBody(req)) as Record<string, unknown>,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(turnReply);
    });
    expect((await secret('agent-token', 'ekstern-token', port)).status).toBe(200);
    const published = await platform.definitions.publish(
      remoteService(`http://127.0.0.1:${port}/turn`),
      'test',
      'test',
    );
    expect(published.ok ? [] : published.errors).toEqual([]);
    const modelCalls = model.seen.length;

    const chat = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: as(),
      body: JSON.stringify({
        model: 'ekstern__default',
        messages: [{ role: 'user', content: 'Når er fristen?' }],
      }),
    });
    const body = (await chat.json()) as { choices: { message: { content: string } }[] };

    expect(body.choices[0]?.message.content).toContain('Fristen er 1. mars.');
    expect(received[0]?.auth).toBe('Bearer ekstern-token');
    expect(received[0]?.body).toMatchObject({
      contract: 'remote-agent/v1',
      query: 'Når er fristen?',
      context: { tenant, service: { id: `${tenant}/ekstern/default` } },
    });
    expect(model.seen.length).toBe(modelCalls);

    const run = await platform.kernel.invoke(kari, `${tenant}/ekstern/default`, {
      data: { query: 'Når er fristen?' },
    });
    await run.result;
    const shown = await steps(run.task);
    expect(shown.map((s) => s.title)).toEqual(
      expect.arrayContaining(['Slo opp fristen', 'Egen motor «127.0.0.1»']),
    );
    const task = await platform.kernel.task(kari, run.task);
    expect(task.usage).toMatchObject({ inputTokens: 30, outputTokens: 8 });
  });

  it('publishes and runs an external agent service that names no model', async () => {
    const { platform, app, as, secret } = await boot();
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(turnReply);
    });
    await secret('agent-token', 'ekstern-token', port);
    const service = remoteService(`http://127.0.0.1:${port}/turn`);
    const published = await platform.definitions.publish(
      { ...service, spec: { ...service.spec, model: { residency: 'eu' } } },
      'test',
      'test',
    );
    expect(published.ok ? [] : published.errors).toEqual([]);

    const chat = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: as(),
      body: JSON.stringify({
        model: 'ekstern__default',
        messages: [{ role: 'user', content: 'Når er fristen?' }],
      }),
    });

    expect(JSON.stringify(await chat.json())).toContain('Fristen er 1. mars.');
  });

  it('lets the platform MCP client call the platform own MCP server after agreeing on a protocol version', async () => {
    const { platform, app, secret } = await boot();
    const agent = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(turnReply);
    });
    await secret('agent-token', 'ekstern-token', agent);
    await platform.definitions.publish(
      remoteService(`http://127.0.0.1:${agent}/turn`),
      'test',
      'test',
    );
    const versions: (string | null)[] = [];
    const port = await listen(
      getRequestListener((request) => {
        versions.push(request.headers.get('mcp-protocol-version'));
        return app.fetch(request);
      }),
    );
    const registry = new InMemoryConnections();
    await registry.save({
      connection: {
        id: 'selv',
        tenant,
        name: 'Plattformen selv',
        endpoint: `http://127.0.0.1:${port}/api/mcp`,
        version: '1',
        allow: [{ host: '127.0.0.1', port }],
        auth: { kind: 'bearer', secret: `secret://tenant/${tenant}/self` },
      },
      tools: [],
      pending: [],
    });
    const source = new McpToolSource({
      registry,
      secrets: {
        resolve: async () => 'kari',
        hostsFor: async () => [`http://127.0.0.1:${port}`],
      },
      guard: new EgressGuard({
        testOverride: { allowLoopback: true, allowHttp: true },
        timeoutMs: 5000,
      }),
    });
    const ctx: PortContext = {
      tenant,
      principal: kari,
      task: 't1',
      signal: new AbortController().signal,
      meter: async () => undefined,
    };

    const synced = await source.sync(tenant, 'selv');
    const listed = (await registry.get(tenant, 'selv'))?.tools ?? [];
    const tool = listed.find((t) => t.remoteName === 'ekstern__default');
    const result = await source.resolve(tool?.name ?? '', '1', ctx)?.call({
      query: 'Når er fristen?',
    });

    expect(synced.active).toBeGreaterThan(0);
    expect(tool).toBeDefined();
    expect(JSON.stringify(result?.parts)).toContain('Fristen er 1. mars.');
    expect(new Set(versions)).toEqual(new Set(['2026-07-28']));
  });

  it('applies the platform guardrails before the question leaves for the external agent', async () => {
    const { platform, app, as, secret } = await boot();
    let calls = 0;
    const port = await listen((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(turnReply);
    });
    await secret('agent-token', 'ekstern-token', port);
    await platform.definitions.publish(
      remoteService(`http://127.0.0.1:${port}/turn`),
      'test',
      'test',
    );

    const chat = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: as(),
      body: JSON.stringify({
        model: 'ekstern__default',
        messages: [{ role: 'user', content: 'Hva er status for 15838510075?' }],
      }),
    });

    expect(JSON.stringify(await chat.json())).not.toContain('Fristen');
    expect(calls).toBe(0);
  });

  it('refuses to publish a remote agent whose residency is wider than the service requires, and an inline secret', async () => {
    const { platform } = await boot();
    const url = 'http://127.0.0.1:9/turn';
    const endpointOf = (service: ReturnType<typeof remoteService>) =>
      service.spec.strategy.config.endpoint as Record<string, unknown>;
    const wide = remoteService(url);
    endpointOf(wide).residency = 'global';
    const inline = remoteService(url);
    endpointOf(inline).auth = { kind: 'bearer', secret: 'hemmelig-token' };

    const widePublish = await platform.definitions.publish(wide, 'test', 'test');
    const inlinePublish = await platform.definitions.publish(inline, 'test', 'test');

    expect(widePublish.ok ? [] : widePublish.errors.map((e) => e.path)).toContain(
      'spec.strategy.config.endpoint.residency',
    );
    expect(inlinePublish.ok ? [] : inlinePublish.errors.map((e) => e.path)).toContain(
      'spec.strategy.config.endpoint.auth.secret',
    );
  });

  it('lets a step flow call a registered tool source, shows the call in the timeline and hands the result to the model', async () => {
    const { platform, app, as, secret, steps, model } = await boot();
    const called: unknown[] = [];
    const port = await listen(async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      };
      if (body.method === 'initialize')
        return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
      if (body.method === 'notifications/initialized') {
        res.writeHead(202);
        return res.end();
      }
      if (body.method === 'tools/list')
        return reply({
          tools: [{ name: 'sok', description: 'Søk i saker', inputSchema: { type: 'object' } }],
        });
      if (body.method === 'tools/call') {
        called.push((body.params as { arguments: unknown }).arguments);
        return reply({ content: [{ type: 'text', text: 'Sak 2025/17: tilskuddssøknad.' }] });
      }
      res.writeHead(400);
      res.end();
    });
    await secret('case-api', 'tool-token', port);
    await platform.connections.save({
      connection: {
        id: 'saker',
        tenant,
        name: 'Saksarkiv',
        endpoint: `http://127.0.0.1:${port}/mcp`,
        version: '1',
        allow: [{ host: '127.0.0.1', port }],
        auth: { kind: 'bearer', secret: `secret://tenant/${tenant}/case-api` },
      },
      tools: [],
      pending: [],
    } as Parameters<typeof platform.connections.save>[0]);
    const sync = await app.request(`/tenants/${tenant}/tool-connections/saker/sync`, {
      method: 'POST',
      headers: as({ 'change-reason': 'test av endringen' }),
    });
    expect(sync.status).toBe(200);
    const examples = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'packages',
      'definitions',
      'examples',
    );
    const flow = parseYaml(readFileSync(join(examples, 'saksoppslag-flyt.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;
    const service = parseYaml(readFileSync(join(examples, 'saksoppslag.yaml'), 'utf8')) as {
      spec: Record<string, unknown>;
    };
    service.spec.model = { primary: 'foundry-openai/gpt-4o-2m-tps', residency: 'global' };
    expect((await platform.definitions.publish(flow, 'test', 'test')).ok).toBe(true);
    const published = await platform.definitions.publish(service, 'test', 'test');
    expect(published.ok ? [] : published.errors).toEqual([]);

    const run = await platform.kernel.invoke(kari, `${tenant}/saksoppslag/default`, {
      data: { query: 'Hva gjelder sak 17?' },
    });
    await run.result;

    expect(called).toEqual([{ q: 'Hva gjelder sak 17?', limit: 5 }]);
    expect(JSON.stringify(model.seen.at(-1)?.body)).toContain('Sak 2025/17: tilskuddssøknad.');
    expect((await steps(run.task)).map((s) => s.title)).toContain('Verktøy «saker.sok»');
  });
});
