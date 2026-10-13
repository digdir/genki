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
import { OpenApiToolSource } from './source.js';

const tenant = '991825827';

const document = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Kontrakt', version: '1' },
  paths: {
    '/saker': {
      get: {
        operationId: 'finnSaker',
        summary: 'Søker i saker.',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
      },
    },
  },
});

const fakeApi = async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ treff: 1 }));
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

export const openApiToolsContractTarget = async (): Promise<
  ContractTarget<ToolSourceContractSubject>
> => {
  const fake = await fakeApi();
  const registry = new InMemoryConnections();
  await registry.save({
    connection: {
      id: 'kontrakt',
      tenant,
      name: 'Kontrakt',
      protocol: 'openapi',
      endpoint: `http://127.0.0.1:${fake.port}/api`,
      version: '1',
      allow: [{ host: '127.0.0.1', port: fake.port }],
      document,
    },
    tools: [],
    pending: [],
  });
  const source = new OpenApiToolSource({
    registry,
    secrets: { resolve: async () => '' },
    guard: new EgressGuard({
      testOverride: { allowLoopback: true, allowHttp: true },
      timeoutMs: 5000,
    }),
  });
  await source.sync(tenant, 'kontrakt');
  const name = (await registry.get(tenant, 'kontrakt'))?.tools[0]?.name ?? 'kontrakt.finnsaker';
  return {
    subject: {
      provider: new ToolRegistry().addSource(source),
      tenant,
      tool: { name, version: '1', input: { q: 'tilskudd' } },
      calls: fake.calls,
    },
    close: fake.close,
  };
};

export const openApiPlugins: PluginRegistration[] = [
  {
    manifest: manifest({
      kind: 'tool-source',
      id: 'tool-source.openapi',
      version: '1',
      contract: toolSourceContractVersion,
      title: 'REST-verktøy fra OpenAPI',
      description:
        'One tool per operation in an OpenAPI document; write operations are off unless allowed.',
      capabilities: ['read-operations', 'write-operations-on-request'],
      secrets: ['bearer', 'header', 'oauth-client'],
    }),
    suite: toolSourceContract,
    target: openApiToolsContractTarget,
  } as PluginRegistration,
];
