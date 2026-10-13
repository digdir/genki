import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { manifest, type ContractTarget, type PluginRegistration } from '@genai/plugins';
import {
  toolSourceContract,
  toolSourceContractVersion,
  type ToolSourceContractSubject,
} from '@genai/port-tools/contract';
import { ToolRegistry } from '@genai/port-tools';
import { EgressGuard } from './egress.js';
import { InMemoryConnections } from './registry.js';
import { McpToolSource } from './source.js';

const tenant = '991825827';

const fakeMcpServer = async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { id?: unknown; method?: string };
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'kontrakt' });
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
          tools: [
            {
              name: 'Finn sak',
              description: 'Finner en sak i arkivet',
              inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
            },
          ],
        });
      if (body.method === 'tools/call') {
        calls += 1;
        return reply({ content: [{ type: 'text', text: 'Fant 1 sak.' }] });
      }
      res.writeHead(400);
      res.end();
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

export const mcpToolsContractTarget = async (): Promise<
  ContractTarget<ToolSourceContractSubject>
> => {
  const fake = await fakeMcpServer();
  const registry = new InMemoryConnections();
  await registry.save({
    connection: {
      id: 'kontrakt',
      tenant,
      name: 'Kontrakt',
      endpoint: `http://127.0.0.1:${fake.port}/mcp`,
      version: '1',
      allow: [{ host: '127.0.0.1', port: fake.port }],
    },
    tools: [],
    pending: [],
  });
  const source = new McpToolSource({
    registry,
    secrets: { resolve: async () => '' },
    guard: new EgressGuard({
      testOverride: { allowLoopback: true, allowHttp: true },
      timeoutMs: 5000,
    }),
  });
  await source.sync(tenant, 'kontrakt');
  return {
    subject: {
      provider: new ToolRegistry().addSource(source),
      tenant,
      tool: { name: 'kontrakt.finn-sak', version: '1', input: { q: 'tilskudd' } },
      calls: fake.calls,
    },
    close: fake.close,
  };
};

export const mcpPlugins: PluginRegistration[] = [
  {
    manifest: manifest({
      kind: 'tool-source',
      id: 'tool-source.mcp',
      version: '1',
      contract: toolSourceContractVersion,
      title: 'MCP-verktøy',
      description: 'Remote tools over the Model Context Protocol, pinned per connection version.',
      capabilities: ['tools/list', 'tools/call'],
      secrets: ['bearer'],
    }),
    suite: toolSourceContract,
    target: mcpToolsContractTarget,
  } as PluginRegistration,
];
