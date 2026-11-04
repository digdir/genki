import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCResponse,
  type JSONRPCResultResponse,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { describe, expect, it } from 'vitest';
import type { GenkiClient } from './client.js';
import { createAdminServer } from './protocol.js';
import { adminTools, toolsFor, type Tool } from './tools.js';

const genki: GenkiClient = {
  tenant: '991825827',
  request: async <T>() => ({ data: [] }) as T,
};
const spend = { budgetNok: 5, spentNok: 0 };
const clientInfo = { name: 'test-agent', version: '1' };

interface Listed extends JSONRPCResultResponse {
  result: {
    tools: {
      name: string;
      inputSchema: Record<string, unknown>;
      annotations: Record<string, unknown>;
    }[];
  };
}

const open = async ({
  tools = adminTools,
  client = async () => genki,
}: { tools?: Tool[]; client?: () => Promise<GenkiClient> } = {}) => {
  const [agent, server] = InMemoryTransport.createLinkedPair();
  serveStdio(() => createAdminServer(tools, client, spend), { transport: server });
  const waiting = new Map<string | number, (response: JSONRPCResponse) => void>();
  agent.onmessage = (message) => {
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message))
      if (message.id !== undefined) waiting.get(message.id)?.(message);
  };
  await agent.start();
  let nextId = 0;
  let meta: Record<string, unknown> | undefined;
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    const answered = new Promise<JSONRPCResponse>((resolve) => waiting.set(id, resolve));
    void agent.send({
      jsonrpc: '2.0',
      id,
      method,
      params: meta ? { ...params, _meta: meta } : params,
    });
    return answered;
  };
  return {
    request,
    listTools: async () => ((await request('tools/list')) as Listed).result.tools,
    legacy: async (protocolVersion = '2025-11-25') => {
      const response = await request('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo,
      });
      await agent.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return response;
    },
    modern: () => {
      meta = {
        [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
        [CLIENT_INFO_META_KEY]: clientInfo,
        [CLIENT_CAPABILITIES_META_KEY]: {},
      };
      return request('server/discover');
    },
  };
};

describe('the MCP protocol', () => {
  it('gives an older client the version it asks for', async () => {
    const session = await open();

    expect(await session.legacy('2025-06-18')).toMatchObject({
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'genki-admin', title: 'genki admin' },
        instructions: expect.stringContaining('untrusted-data'),
      },
    });
  });

  it('offers a current client the newest version and tells it the rules', async () => {
    const session = await open();

    expect(await session.modern()).toMatchObject({
      result: {
        supportedVersions: ['2026-07-28'],
        instructions: expect.stringContaining('untrusted-data'),
      },
    });
    expect(
      await session.request('tools/call', { name: 'list_services', arguments: {} }),
    ).toMatchObject({ result: { content: [{ text: 'No services.' }] } });
  });

  it('lists every tool with a strict JSON schema and says which read, write or cost money', async () => {
    const session = await open();
    await session.legacy();

    const byName = new Map((await session.listTools()).map((t) => [t.name, t]));

    expect([...byName.keys()]).toEqual(adminTools.map((t) => t.name));
    expect(byName.get('publish_definition')).toMatchObject({
      inputSchema: { additionalProperties: false, required: ['yaml', 'reason'] },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    });
    expect(byName.get('get_run')?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('run_playground')?.annotations).toMatchObject({
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it('answers a tool call with text only, so nothing from genki bypasses the untrusted-data tags, and bad arguments as a tool error', async () => {
    const session = await open();
    await session.legacy();

    const listed = await session.request('tools/call', { name: 'list_services', arguments: {} });
    const bad = await session.request('tools/call', {
      name: 'get_service',
      arguments: { idd: 'x' },
    });

    expect(listed).toMatchObject({
      result: {
        content: [{ type: 'text', text: 'No services.' }],
        isError: false,
      },
    });
    expect((listed as { result: Record<string, unknown> }).result).not.toHaveProperty(
      'structuredContent',
    );
    expect(bad).toMatchObject({ result: { isError: true } });
  });

  it('refuses an unknown tool as a protocol error', async () => {
    const session = await open();
    await session.legacy();

    expect(
      await session.request('tools/call', { name: 'delete_everything', arguments: {} }),
    ).toMatchObject({ error: { code: -32602 } });
  });

  it('turns a failed login into a tool error the agent can read', async () => {
    const session = await open({
      client: async () => {
        throw new Error('login timed out');
      },
    });
    await session.legacy();

    expect(
      await session.request('tools/call', { name: 'list_services', arguments: {} }),
    ).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining('login timed out') }] },
    });
  });

  it('leaves publishing out in read-only mode', async () => {
    const session = await open({ tools: toolsFor({ readOnly: true, playground: true }) });
    await session.legacy();

    const names = (await session.listTools()).map((t) => t.name);

    expect(names).toContain('list_services');
    expect(names).not.toContain('publish_definition');
  });
});
