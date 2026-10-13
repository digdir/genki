import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { manifest, type ContractTarget, type PluginRegistration } from '@genai/plugins';
import { ToolRegistry } from '@genai/port-tools';
import {
  toolSourceContract,
  toolSourceContractVersion,
  type ToolSourceContractSubject,
} from '@genai/port-tools/contract';
import { EgressGuard, InMemoryConnections } from '@genai/providers-mcp-client';
import { A2aToolSource } from './source.js';

const tenant = '991825827';

const fakeAgent = async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const port = (server.address() as AddressInfo).port;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET')
        return res.end(
          JSON.stringify({
            name: 'Kontraktagent',
            description: 'Svarer i kontrakttesten.',
            version: '1',
            supportedInterfaces: [
              {
                url: `http://127.0.0.1:${port}/rpc`,
                protocolBinding: 'JSONRPC',
                protocolVersion: '1.0',
              },
            ],
            capabilities: { streaming: false },
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['text/plain'],
            skills: [{ id: 'svar', name: 'Svar', description: 'Svarer kort.', tags: [] }],
          }),
        );
      const body = JSON.parse(raw) as { id: number; method: string };
      if (body.method !== 'SendMessage')
        return res.end(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nei' } }),
        );
      calls += 1;
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            task: {
              id: 't1',
              contextId: 'c1',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [{ artifactId: 'a1', parts: [{ text: 'Svar fra agenten.' }] }],
            },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    calls: () => calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

export const a2aToolsContractTarget = async (): Promise<
  ContractTarget<ToolSourceContractSubject>
> => {
  const fake = await fakeAgent();
  const registry = new InMemoryConnections();
  await registry.save({
    connection: {
      id: 'kontrakt',
      tenant,
      name: 'Kontraktagent',
      protocol: 'a2a',
      endpoint: `http://127.0.0.1:${fake.port}/.well-known/agent-card.json`,
      version: '1',
      allow: [{ host: '127.0.0.1', port: fake.port }],
    },
    tools: [],
    pending: [],
  });
  const source = new A2aToolSource({
    registry,
    secrets: { resolve: async () => '' },
    guard: new EgressGuard({
      testOverride: { allowLoopback: true, allowHttp: true },
      timeoutMs: 5000,
    }),
    pollMs: 5,
  });
  await source.sync(tenant, 'kontrakt');
  const name = (await registry.get(tenant, 'kontrakt'))?.tools[0]?.name ?? 'kontrakt.svar';
  return {
    subject: {
      provider: new ToolRegistry().addSource(source),
      tenant,
      tool: { name, version: '1', input: { message: 'Hei' } },
      calls: fake.calls,
    },
    close: fake.close,
  };
};

export const a2aPlugins: PluginRegistration[] = [
  {
    manifest: manifest({
      kind: 'tool-source',
      id: 'tool-source.a2a',
      version: '1',
      contract: toolSourceContractVersion,
      title: 'A2A-agenter',
      description:
        'Remote agents over the Agent2Agent protocol, one tool per skill on the agent card.',
      capabilities: ['agent-card', 'SendMessage', 'GetTask'],
      secrets: ['bearer'],
    }),
    suite: toolSourceContract,
    target: a2aToolsContractTarget,
  } as PluginRegistration,
];
