import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortContext } from '@genai/kernel';
import { ToolRegistry, toolRef } from '@genai/port-tools';
import { EgressGuard, InMemoryConnections, type Connection } from '@genai/providers-mcp-client';
import { A2aToolSource } from './index.js';

const TENANT = '991825827';

interface Received {
  method?: string;
  headers: IncomingMessage['headers'];
  params?: Record<string, unknown>;
}

const fakeAgent = async (
  options: { skills?: unknown[]; description?: string; slow?: boolean } = {},
) => {
  const received: Received[] = [];
  let polls = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const port = (server.address() as AddressInfo).port;
      if (req.method === 'GET') {
        received.push({ headers: req.headers });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            name: 'Skatteveilederen',
            description: options.description ?? 'Svarer på spørsmål om skatt.',
            version: '2',
            supportedInterfaces: [
              {
                url: `http://127.0.0.1:${port}/rpc`,
                protocolBinding: 'JSONRPC',
                protocolVersion: '1.0',
              },
            ],
            capabilities: {
              streaming: false,
              extensions: [
                {
                  uri: 'urn:genai:a2a:input-schema:v1',
                  params: { schema: { type: 'object', properties: { year: { type: 'integer' } } } },
                },
              ],
            },
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['text/plain'],
            skills: options.skills ?? [
              { id: 'fradrag', name: 'Fradrag', description: 'Forklarer fradrag.', tags: [] },
            ],
          }),
        );
      }
      const body = JSON.parse(raw) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      received.push({ method: body.method, headers: req.headers, params: body.params });
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      };
      if (body.method === 'SendMessage') {
        const message = body.params.message as { contextId?: string; parts: { text?: string }[] };
        if (options.slow)
          return reply({
            task: { id: 't-slow', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } },
          });
        return reply({
          task: {
            id: 't1',
            contextId: message.contextId ?? 'c1',
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [
              {
                artifactId: 'a1',
                parts: [
                  { text: `Svar: ${message.parts[0]?.text}` },
                  {
                    data: {
                      sources: [
                        { chunkId: 'k1', title: 'Skatte-ABC', url: 'https://skatt.test/abc' },
                      ],
                    },
                    mediaType: 'application/vnd.genai.sources+json',
                  },
                ],
              },
            ],
          },
        });
      }
      if (body.method === 'GetTask') {
        polls += 1;
        return reply({
          id: 't-slow',
          contextId: 'c1',
          status: { state: polls < 2 ? 'TASK_STATE_WORKING' : 'TASK_STATE_COMPLETED' },
          artifacts: polls < 2 ? [] : [{ artifactId: 'a', parts: [{ text: 'Ferdig' }] }],
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nei' } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

const ctx = (): PortContext => ({
  tenant: TENANT,
  principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: TENANT },
  task: 'task-1',
  signal: new AbortController().signal,
  meter: async () => undefined,
});

const connection = (port: number, extra: Partial<Connection> = {}): Connection => ({
  id: 'skatt',
  tenant: TENANT,
  name: 'Skatteveilederen',
  protocol: 'a2a',
  endpoint: `http://127.0.0.1:${port}/.well-known/agent-card.json`,
  version: '1',
  allow: [{ host: '127.0.0.1', port }],
  auth: { kind: 'bearer', secret: `secret://tenant/${TENANT}/skatt` },
  ...extra,
});

const setup = async (
  agent: Awaited<ReturnType<typeof fakeAgent>>,
  extra: Partial<Connection> = {},
) => {
  closers.push(agent.close);
  const registry = new InMemoryConnections();
  await registry.save({ connection: connection(agent.port, extra), tools: [], pending: [] });
  const source = new A2aToolSource({
    registry,
    secrets: { resolve: async () => 'hemmelig' },
    guard: new EgressGuard({ testOverride: { allowLoopback: true, allowHttp: true } }),
    pollMs: 5,
  });
  return { registry, source, tools: new ToolRegistry().addSource(source) };
};

describe('A2A agents as tools', () => {
  it('pins one tool per skill from the agent card, with the input schema the card offers', async () => {
    const agent = await fakeAgent();
    const { source, tools } = await setup(agent);

    expect(await source.sync(TENANT, 'skatt')).toEqual({ active: 1, pending: [] });
    const port = tools.open(toolRef('skatt.fradrag', '1', TENANT), ctx());

    expect(port.definition()).toMatchObject({
      name: 'skatt.fradrag',
      origin: 'a2a',
      description: 'Skatteveilederen: Forklarer fradrag.',
      input: {
        required: ['message'],
        properties: {
          message: { type: 'string' },
          data: { properties: { year: { type: 'integer' } } },
        },
      },
    });
  });

  it('sends a message with the vault credential and returns the answer, sources and handles as untrusted data', async () => {
    const agent = await fakeAgent();
    const { source, tools } = await setup(agent);
    await source.sync(TENANT, 'skatt');

    const result = await tools
      .open(toolRef('skatt.fradrag', '1', TENANT), ctx())
      .call({ message: 'Hva er minstefradrag?', data: { year: 2025 }, context_id: 'samtale' });

    const sent = agent.received.find((r) => r.method === 'SendMessage');
    expect(sent?.headers.authorization).toBe('Bearer hemmelig');
    expect(sent?.headers['a2a-version']).toBe('1.0');
    expect(sent?.params?.message).toMatchObject({
      role: 'ROLE_USER',
      contextId: 'samtale',
      parts: [{ text: 'Hva er minstefradrag?' }, { data: { year: 2025 } }],
      metadata: { skillId: 'fradrag' },
    });
    expect(result.isError).toBeUndefined();
    expect(result.parts[0]).toMatchObject({
      body: { kind: 'text', text: 'Svar: Hva er minstefradrag?' },
      meta: { untrusted: true, source: 'a2a:skatt' },
    });
    expect(result.parts.at(-1)?.body).toEqual({
      kind: 'json',
      json: { state: 'completed', task_id: 't1', context_id: 'samtale' },
    });
    expect(result.sources).toEqual([
      { id: 'k1', title: 'Skatte-ABC', url: 'https://skatt.test/abc' },
    ]);
  });

  it('polls a task the agent left working until it completes', async () => {
    const agent = await fakeAgent({ slow: true });
    const { source, tools } = await setup(agent);
    await source.sync(TENANT, 'skatt');

    const result = await tools
      .open(toolRef('skatt.fradrag', '1', TENANT), ctx())
      .call({ message: 'hei' });

    expect(result.parts[0]?.body).toEqual({ kind: 'text', text: 'Ferdig' });
    expect(agent.received.filter((r) => r.method === 'GetTask').length).toBe(2);
  });

  it('holds a changed card back for approval like MCP tools', async () => {
    const agent = await fakeAgent();
    const { registry, source } = await setup(agent);
    await source.sync(TENANT, 'skatt');
    const state = await registry.get(TENANT, 'skatt');
    if (!state) throw new Error('no state');
    await registry.save({
      ...state,
      tools: state.tools.map((t) => ({ ...t, description: 'gammel' })),
    });

    const result = await source.sync(TENANT, 'skatt');

    expect(result).toEqual({ active: 1, pending: ['skatt.fradrag'] });
    await source.approve(TENANT, 'skatt', 'skatt.fradrag');
    expect((await registry.get(TENANT, 'skatt'))?.tools[0]?.description).toBe(
      'Skatteveilederen: Forklarer fradrag.',
    );
  });

  it('refuses an interface address that is not on the allowlist', async () => {
    const agent = await fakeAgent();
    const { source } = await setup(agent, { allow: [{ host: '127.0.0.1', port: agent.port + 1 }] });

    await expect(source.sync(TENANT, 'skatt')).rejects.toThrow(/allowlist/);
  });

  it('refuses private hosts without the test override', async () => {
    const agent = await fakeAgent();
    closers.push(agent.close);
    const registry = new InMemoryConnections();
    await registry.save({ connection: connection(agent.port), tools: [], pending: [] });
    const source = new A2aToolSource({
      registry,
      secrets: { resolve: async () => 'x' },
      guard: new EgressGuard({ testOverride: { allowHttp: true } }),
    });

    await expect(source.sync(TENANT, 'skatt')).rejects.toThrow(/private address/);
  });

  it('ignores connections of other protocols', async () => {
    const agent = await fakeAgent();
    const { source } = await setup(agent, { protocol: 'mcp' });

    await expect(source.sync(TENANT, 'skatt')).rejects.toThrow(/no tool connection/);
  });
});
