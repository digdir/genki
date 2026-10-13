import type { JSONSchema, Part } from '@genai/contracts';
import type { PortContext, SecretResolver } from '@genai/kernel';
import {
  errorResult,
  ToolError,
  type Source,
  type ToolPort,
  type ToolResult,
} from '@genai/port-tools';
import { McpClient, type CallToolResult, type RemoteTool } from './client.js';
import { EgressError, EgressGuard } from './egress.js';
import { PinnedToolSource } from './pinned.js';
import type { ConnectionRegistry, ConnectionState, PinnedTool } from './registry.js';
import { TenantSecrets } from './secrets.js';

export const toolSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 64) || 'tool';

const pinnedFrom = (connectionId: string, remote: RemoteTool): PinnedTool => ({
  remoteName: remote.name,
  name: `${connectionId}.${toolSlug(remote.name)}`,
  description: remote.description ?? '',
  input: (remote.inputSchema ?? { type: 'object' }) as JSONSchema,
});

const untrusted = (connection: string) => ({ untrusted: true, source: `mcp:${connection}` });

export const toToolResult = (connectionId: string, result: CallToolResult): ToolResult => {
  const meta = untrusted(connectionId);
  const parts: Part[] = [];
  const sources: Source[] = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text' && typeof item.text === 'string')
      parts.push({ mime: 'text/plain', body: { kind: 'text', text: item.text }, meta });
    else if (item.type === 'resource_link' && item.uri)
      sources.push({
        id: item.uri,
        ...(item.title || item.name ? { title: item.title ?? item.name } : {}),
        ...(/^https:\/\//.test(item.uri) ? { url: item.uri } : {}),
      });
    else if (item.type === 'resource' && item.resource?.uri) {
      sources.push({
        id: item.resource.uri,
        ...(item.resource.text ? { text: item.resource.text } : {}),
        ...(/^https:\/\//.test(item.resource.uri) ? { url: item.resource.uri } : {}),
      });
    }
  }
  if (result.structuredContent !== undefined)
    parts.push({
      mime: 'application/json',
      body: { kind: 'json', json: result.structuredContent },
      meta,
    });
  return {
    parts,
    ...(sources.length ? { sources } : {}),
    ...(result.isError ? { isError: true } : {}),
  };
};

export interface McpToolSourceOptions {
  registry: ConnectionRegistry;
  secrets: SecretResolver;
  guard?: EgressGuard;
}

export class McpToolSource extends PinnedToolSource {
  readonly protocol = 'mcp' as const;
  readonly #guard: EgressGuard;
  readonly #secrets: TenantSecrets;
  readonly #clients = new Map<string, McpClient>();

  constructor(options: McpToolSourceOptions) {
    super(options.registry);
    this.#guard = options.guard ?? new EgressGuard();
    this.#secrets = new TenantSecrets(options.secrets);
  }

  #client(state: ConnectionState) {
    const key = this.key(state.connection.tenant, state.connection.id);
    let client = this.#clients.get(key);
    if (!client) {
      client = new McpClient(state.connection, this.#guard, this.#secrets);
      this.#clients.set(key, client);
    }
    return client;
  }

  protected async listTools(state: ConnectionState, signal?: AbortSignal) {
    return (await this.#client(state).listTools(signal)).map((t) =>
      pinnedFrom(state.connection.id, t),
    );
  }

  protected port(
    state: ConnectionState,
    tool: PinnedTool,
    ctx: PortContext,
    version: string,
  ): ToolPort {
    const client = this.#client(state);
    const connectionId = state.connection.id;
    return {
      definition: () => ({
        name: tool.name,
        version,
        description: tool.description,
        input: tool.input,
        origin: 'mcp',
      }),
      call: async (input) => {
        if (typeof input !== 'object' || input === null || Array.isArray(input))
          return errorResult(`Invalid input for ${tool.name}: expected an object`);
        if (ctx.signal.aborted) throw new ToolError('cancelled', 'the tool call was cancelled');
        await ctx.meter({ requests: 1 });
        try {
          return toToolResult(
            connectionId,
            await client.callTool(tool.remoteName, input as Record<string, unknown>, ctx.signal),
          );
        } catch (error) {
          if (ctx.signal.aborted || (error instanceof EgressError && error.code === 'cancelled'))
            throw new ToolError('cancelled', 'the tool call was cancelled');
          throw new ToolError('failed', error instanceof Error ? error.message : String(error));
        }
      },
    };
  }
}
