import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Event, Principal } from '@genai/contracts';
import { createKernel, type Capability, type SecretResolver } from '@genai/kernel';
import { EgressGuard } from '@genai/providers-mcp-client';
import { createRemoteAgent, createRemoteTransport, remoteAgentConfig } from './index.js';

const tenant = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };

interface Seen {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

const servers: Server[] = [];
const agentHosts = new Set<string>();
afterEach(async () => {
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

const fakeAgent = async (
  handler: (seen: Seen, port: number) => { status?: number; body?: unknown; hang?: boolean },
) => {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const entry: Seen = {
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      seen.push(entry);
      const reply = handler(entry, (server.address() as AddressInfo).port);
      if (reply.hang) return;
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  agentHosts.add(url);
  return { seen, url };
};

const secrets: SecretResolver = {
  resolve: async (ref) => {
    if (ref === `secret://tenant/${tenant}/agent-key`) return 'agent-token';
    throw new Error(`no secret ${ref}`);
  },
  hostsFor: async () => [...agentHosts],
};

const open = { testOverride: { allowLoopback: true, allowHttp: true } };

const boot = (
  endpoint: Record<string, unknown>,
  options: {
    send?: Record<string, unknown>;
    egress?: ConstructorParameters<typeof EgressGuard>[0];
    budget?: { requests?: number; inputTokens?: number };
    output?: Record<string, unknown>;
  } = {},
) => {
  const transport = createRemoteTransport({
    guard: new EgressGuard(options.egress ?? open),
    secrets,
    pollMs: 10,
  });
  const strategy = remoteAgentConfig.parse({
    endpoint: { residency: 'norway', ...endpoint },
    ...(options.send ? { send: options.send } : {}),
  });
  const capability: Capability = {
    descriptor: {
      id: `${tenant}/ekstern/default`,
      version: '3',
      tenant,
      title: 'Ekstern',
      description: 'Ekstern agent',
      input: {},
      interaction: ['unary'],
      accepts: ['text/plain'],
      produces: ['text/plain'],
      emits: [],
      oversight: { interrupts: false, riskClass: 'limited', aiDisclosure: 'KI' },
    },
    strategy: { id: 'remote-agent', version: '1' },
    config: { strategy, output: options.output ?? { kind: 'answer' } },
    grants: [],
    ...(options.budget ? { budget: options.budget } : {}),
  };
  const kernel = createKernel({
    strategies: [createRemoteAgent({ transport })],
    capabilities: [capability],
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
  });
  const ask = async (data: Record<string, unknown>) => {
    const run = await kernel.invoke(kari, capability.descriptor.id, { data });
    const result = await run.result.catch((error: unknown) => error);
    const events: Event[] = [];
    for await (const e of run.events) events.push(e);
    return { run, result, events, task: await kernel.task(kari, run.task) };
  };
  return { kernel, ask, capability };
};

const notices = (events: Event[]) =>
  events.filter((e) => e.type === 'kernel.notice').map((e) => e.data as Record<string, unknown>);

describe('the remote agent strategy', () => {
  it('sends the conversation and the allowed context, and maps the reply into answer, sources, steps and usage', async () => {
    const agent = await fakeAgent(() => ({
      body: {
        answer: 'Frist er 1. mars.',
        sources: [{ id: 's1', title: 'Fristene', url: 'https://example.no/frister' }],
        steps: [
          { title: 'Slo opp fristen', summary: 'fant 2 treff', durationMs: 120 },
          { title: 'Sjekket unntak', status: 'failed' },
        ],
        usage: { inputTokens: 40, outputTokens: 10, costMicroNok: 500 },
      },
    }));
    const { ask } = boot(
      {
        url: `${agent.url}/turn`,
        auth: { kind: 'bearer', secret: `secret://tenant/${tenant}/agent-key` },
      },
      { send: { metadata: ['year'] } },
    );

    const { result, events, task } = await ask({
      query: 'Når er fristen?',
      year: 2025,
      secretField: 'skal ikke sendes',
      history: [
        { role: 'user', text: 'Hei' },
        { role: 'assistant', text: 'Hei, hva lurer du på?' },
      ],
    });

    expect(JSON.stringify(result)).toContain('Frist er 1. mars.');
    expect(JSON.stringify(result)).toContain('Fristene');
    const sent = agent.seen[0];
    expect(sent?.headers.authorization).toBe('Bearer agent-token');
    expect(sent?.headers['x-genai-contract']).toBe('remote-agent/v1');
    expect(sent?.body).toMatchObject({
      contract: 'remote-agent/v1',
      conversation: { task: task.id },
      query: 'Når er fristen?',
      messages: [
        { role: 'user', text: 'Hei' },
        { role: 'assistant', text: 'Hei, hva lurer du på?' },
        { role: 'user', text: 'Når er fristen?' },
      ],
      context: {
        tenant,
        caller: { tenant },
        service: { id: `${tenant}/ekstern/default`, version: '3' },
      },
      metadata: { year: 2025 },
    });
    expect(JSON.stringify(sent?.body)).not.toContain('skal ikke sendes');
    expect((sent?.body.context as Record<string, unknown>).principal).toBeUndefined();
    const steps = notices(events).filter((n) => n.kind === 'external-step');
    expect(steps.map((n) => [n.title ?? n.host, n.ok])).toEqual([
      ['Slo opp fristen', true],
      ['Sjekket unntak', false],
      ['127.0.0.1', true],
    ]);
    expect(task.usage).toMatchObject({
      inputTokens: 40,
      outputTokens: 10,
      costMicroNok: 500,
      requests: 1,
    });
  });

  it('names the caller only when the service asks for it', async () => {
    const agent = await fakeAgent(() => ({ body: { answer: 'ok' } }));
    const { ask } = boot({ url: agent.url }, { send: { identity: 'subject', history: false } });

    await ask({ query: 'hei', history: [{ role: 'user', text: 'tidligere' }] });

    expect(agent.seen[0]?.body.context).toMatchObject({
      principal: { kind: 'employee', subject: 'kari', tenant },
    });
    expect(agent.seen[0]?.body.messages).toEqual([{ role: 'user', text: 'hei' }]);
  });

  it('refuses a secret that belongs to another tenant before any request leaves', async () => {
    const agent = await fakeAgent(() => ({ body: { answer: 'ok' } }));
    const { ask } = boot({
      url: agent.url,
      auth: { kind: 'bearer', secret: 'secret://tenant/123456785/agent-key' },
    });

    const { task } = await ask({ query: 'hei' });

    expect(task.status).toBe('failed');
    expect(agent.seen).toEqual([]);
  });

  it('fails the task when the agent answers outside the contract', async () => {
    const agent = await fakeAgent(() => ({ body: { steps: [{ title: '' }] } }));
    const { ask } = boot({ url: agent.url });

    const { result, task } = await ask({ query: 'hei' });

    expect(task.status).toBe('failed');
    expect(String(result)).toContain('broke the remote-agent/v1 reply');
  });

  it('fails the task when the agent answers with an HTTP error', async () => {
    const agent = await fakeAgent(() => ({ status: 502, body: { error: 'nede' } }));
    const { ask } = boot({ url: agent.url });

    const { result } = await ask({ query: 'hei' });

    expect(String(result)).toContain('answered HTTP 502');
  });

  it('gives up when the agent takes longer than the endpoint timeout', async () => {
    const agent = await fakeAgent(() => ({ hang: true }));
    const { ask } = boot({ url: agent.url, timeoutMs: 1000 });

    const { result, task } = await ask({ query: 'hei' });

    expect(task.status).toBe('failed');
    expect(String(result)).toContain('no answer within 1000 ms');
  });

  it('stops waiting for the agent when the task is cancelled', async () => {
    const agent = await fakeAgent(() => ({ hang: true }));
    const { kernel, capability } = boot({ url: agent.url });

    const run = await kernel.invoke(kari, capability.descriptor.id, { data: { query: 'hei' } });
    while (agent.seen.length === 0) await new Promise((r) => setTimeout(r, 10));
    await kernel.cancel(kari, run.task);

    await expect(run.result).rejects.toThrow();
    expect((await kernel.task(kari, run.task)).status).toBe('cancelled');
  });

  it('refuses plain HTTP and private addresses with the default egress rules', async () => {
    const agent = await fakeAgent(() => ({ body: { answer: 'ok' } }));
    const { ask } = boot({ url: agent.url }, { egress: {} });

    const { result } = await ask({ query: 'hei' });

    expect(String(result)).toContain('could not be reached');
    expect(agent.seen).toEqual([]);
  });

  it('stops a service whose agent reports more usage than the cost cap allows', async () => {
    const agent = await fakeAgent(() => ({
      body: { answer: 'dyrt', usage: { inputTokens: 900 } },
    }));
    const { ask } = boot({ url: agent.url }, { budget: { inputTokens: 100 } });

    const { task } = await ask({ query: 'hei' });

    expect(task.status).toBe('failed');
  });

  it('returns structured data for a service whose output is fields', async () => {
    const agent = await fakeAgent(() => ({ body: { data: { kategori: 'klage' } } }));
    const { ask } = boot({ url: agent.url }, { output: { kind: 'fields' } });

    const { result } = await ask({ query: 'hei' });

    expect(JSON.stringify(result)).toContain('"kategori":"klage"');
  });

  it('talks to an A2A agent and reads its answer and sources', async () => {
    const received: Record<string, unknown>[] = [];
    const agent = await fakeAgent((seen, port) => {
      if (!seen.body.method)
        return {
          body: {
            name: 'Ekstern',
            description: 'Ekstern agent',
            supportedInterfaces: [
              {
                url: `http://127.0.0.1:${port}/rpc`,
                protocolBinding: 'JSONRPC',
                protocolVersion: '1.0',
              },
            ],
            skills: [],
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['text/plain'],
          },
        };
      received.push(seen.body);
      return {
        body: {
          jsonrpc: '2.0',
          id: seen.body.id,
          result: {
            task: {
              id: 't1',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [
                {
                  parts: [
                    { text: 'A2A-svar' },
                    {
                      data: { sources: [{ chunkId: 'k1', title: 'Kilde' }] },
                      mediaType: 'application/vnd.genai.sources+json',
                    },
                  ],
                },
              ],
            },
          },
        },
      };
    });
    const { ask } = boot({ url: agent.url, protocol: 'a2a' });

    const { result } = await ask({ query: 'hva skjer' });

    expect(JSON.stringify(result)).toContain('A2A-svar');
    expect(JSON.stringify(result)).toContain('Kilde');
    expect(JSON.stringify(received[0])).toContain('hva skjer');
  });

  it('rejects an endpoint that is not an https URL with a tenant secret reference', () => {
    expect(
      remoteAgentConfig.safeParse({
        endpoint: { url: 'ftp://x', residency: 'eu' },
      }).success,
    ).toBe(false);
    expect(
      remoteAgentConfig.safeParse({
        endpoint: {
          url: 'https://agent.example.no',
          residency: 'eu',
          auth: { kind: 'bearer', secret: 'hemmelig-token' },
        },
      }).success,
    ).toBe(false);
    expect(
      remoteAgentConfig.safeParse({
        endpoint: { url: 'https://agent.example.no', residency: 'eu' },
      }).success,
    ).toBe(true);
  });

  it('names either an endpoint or a registered agent, never both or neither', () => {
    const endpoint = { url: 'https://agent.example.no', residency: 'eu' };
    expect(remoteAgentConfig.safeParse({ agent: 'agent.saksbehandler' }).success).toBe(true);
    expect(remoteAgentConfig.safeParse({ endpoint, agent: 'agent.saksbehandler' }).success).toBe(
      false,
    );
    expect(remoteAgentConfig.safeParse({}).success).toBe(false);
  });
});
