import { authHeaders } from './auth.js';
import type { EgressGuard } from './egress.js';
import type { Connection } from './registry.js';
import type { TenantSecrets } from './secrets.js';

export const latestProtocolVersion = '2026-07-28';
export const clientProtocolVersion = '2025-06-18';
export const clientHandshakeVersions = [clientProtocolVersion];

const headerValue = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?base64?${Buffer.from(value).toString('base64')}?=`;

export interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface CallToolResult {
  content?: {
    type: string;
    text?: string;
    uri?: string;
    name?: string;
    title?: string;
    resource?: { uri?: string; text?: string };
  }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export class McpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

const parseSse = (body: string, id: number): unknown => {
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      const message = JSON.parse(data) as { id?: unknown };
      if (message.id === id) return message;
    } catch {
      continue;
    }
  }
  throw new McpProtocolError('the stream ended without a response');
};

export class McpClient {
  #session: string | undefined;
  #initialized = false;
  #version = clientProtocolVersion;
  #nextId = 1;

  constructor(
    private readonly connection: Connection,
    private readonly guard: EgressGuard,
    private readonly secrets: TenantSecrets,
  ) {}

  get protocolVersion() {
    return this.#version;
  }

  async #headers(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    const params = payload.params as { name?: unknown } | undefined;
    const modern = this.#version === latestProtocolVersion;
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.#version,
      ...(modern && typeof payload.method === 'string' ? { 'mcp-method': payload.method } : {}),
      ...(modern && payload.method === 'tools/call' && typeof params?.name === 'string'
        ? { 'mcp-name': headerValue(params.name) }
        : {}),
      ...(this.#session ? { 'mcp-session-id': this.#session } : {}),
      ...(await authHeaders(
        this.connection,
        this.connection.endpoint,
        this.guard,
        this.secrets,
        signal,
      )),
    };
  }

  async #post(payload: Record<string, unknown>, signal?: AbortSignal) {
    const response = await this.guard.request(
      this.connection.allow,
      this.connection.endpoint,
      {
        method: 'POST',
        headers: await this.#headers(payload, signal),
        body: JSON.stringify(payload),
        ...(this.connection.timeoutMs ? { timeoutMs: this.connection.timeoutMs } : {}),
        ...(this.connection.maxResponseBytes
          ? { maxResponseBytes: this.connection.maxResponseBytes }
          : {}),
      },
      signal,
    );
    const session = response.headers['mcp-session-id'];
    if (typeof session === 'string' && session) this.#session = session;
    return response;
  }

  async #rpc(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.#nextId++;
    const response = await this.#post({ jsonrpc: '2.0', id, method, params }, signal);
    if (response.status === 404 && this.#session && method !== 'initialize') {
      this.#session = undefined;
      this.#initialized = false;
      await this.#ensureInitialized(signal);
      return this.#rpc(method, params, signal);
    }
    if (method === 'server/discover' && (response.status < 200 || response.status >= 300))
      return undefined;
    if (response.status < 200 || response.status >= 300)
      throw new McpProtocolError(`the tool server answered HTTP ${response.status}`);
    const type = String(response.headers['content-type'] ?? '');
    let message: { result?: unknown; error?: { message?: string } };
    try {
      message = (
        type.includes('text/event-stream') ? parseSse(response.body, id) : JSON.parse(response.body)
      ) as typeof message;
    } catch (error) {
      if (error instanceof McpProtocolError) throw error;
      throw new McpProtocolError('the tool server sent an unreadable response');
    }
    if (message.error)
      throw new McpProtocolError(message.error.message ?? 'the tool server returned an error');
    return message.result;
  }

  async #discover(signal?: AbortSignal) {
    this.#version = latestProtocolVersion;
    try {
      const found = (await this.#rpc('server/discover', {}, signal)) as
        { supportedVersions?: unknown } | undefined;
      return Array.isArray(found?.supportedVersions)
        ? found.supportedVersions.includes(latestProtocolVersion)
        : false;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }

  async #ensureInitialized(signal?: AbortSignal) {
    if (this.#initialized) return;
    if (await this.#discover(signal)) {
      this.#initialized = true;
      return;
    }
    this.#version = clientProtocolVersion;
    const answered = (await this.#rpc(
      'initialize',
      {
        protocolVersion: clientProtocolVersion,
        capabilities: {},
        clientInfo: { name: 'genki', version: '1' },
      },
      signal,
    )) as { protocolVersion?: unknown } | undefined;
    const agreed = answered?.protocolVersion ?? clientProtocolVersion;
    if (typeof agreed !== 'string' || !clientHandshakeVersions.includes(agreed))
      throw new McpProtocolError(
        `the tool server speaks MCP ${String(agreed)}, which is not supported`,
      );
    this.#version = agreed;
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
    this.#initialized = true;
  }

  async listTools(signal?: AbortSignal): Promise<RemoteTool[]> {
    await this.#ensureInitialized(signal);
    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = (await this.#rpc('tools/list', cursor ? { cursor } : {}, signal)) as {
        tools?: RemoteTool[];
        nextCursor?: string;
      };
      tools.push(...(result?.tools ?? []));
      cursor = result?.nextCursor;
      if (!cursor) return tools;
    }
    throw new McpProtocolError('the tool list has too many pages');
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    await this.#ensureInitialized(signal);
    return ((await this.#rpc('tools/call', { name, arguments: args }, signal)) ??
      {}) as CallToolResult;
  }
}
