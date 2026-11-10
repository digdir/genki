import { withoutTrailingSlashes } from '@genai/kernel';
import type { Part } from '@genai/contracts';
import type { PortContext, SecretResolver } from '@genai/kernel';
import { errorResult, ToolError, type ToolPort, type ToolResult } from '@genai/port-tools';
import {
  authHeaders,
  EgressError,
  EgressGuard,
  PinnedToolSource,
  TenantSecrets,
  toolSlug,
  type Connection,
  type ConnectionRegistry,
  type ConnectionState,
  type EgressResponse,
  type PinnedTool,
} from '@genai/providers-mcp-client';
import {
  inputSchemaOf,
  operationsOf,
  parseDocument,
  type HttpMethod,
  type Operation,
  type OperationParameter,
} from './document.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export type OperationStatus = 'enabled' | 'not_selected' | 'write_disabled';

export const operationStatus = (connection: Connection, op: Operation): OperationStatus => {
  if (connection.operations && !connection.operations.includes(op.id)) return 'not_selected';
  if (!op.readOnly && connection.writes !== true) return 'write_disabled';
  return 'enabled';
};

export const loadDocument = async (
  connection: Connection,
  guard: EgressGuard,
  secrets: TenantSecrets,
  signal?: AbortSignal,
) => {
  if (connection.document) return parseDocument(connection.document);
  if (!connection.documentUrl) throw new ToolError('bad_input', 'the connection has no document');
  const response = await guard.request(
    connection.allow,
    connection.documentUrl,
    {
      method: 'GET',
      headers: {
        accept: 'application/json, application/yaml, text/yaml',
        ...(await authHeaders(connection, connection.documentUrl, guard, secrets, signal)),
      },
      maxResponseBytes: 2 * 1024 * 1024,
      ...(connection.timeoutMs ? { timeoutMs: connection.timeoutMs } : {}),
    },
    signal,
  );
  if (response.status !== 200)
    throw new ToolError('failed', `the document address answered HTTP ${response.status}`);
  return parseDocument(response.body);
};

export const pinnedFromOperations = (
  connection: Connection,
  operations: Operation[],
): PinnedTool[] =>
  operations
    .filter((op) => operationStatus(connection, op) === 'enabled')
    .map((op) => ({
      remoteName: op.id,
      name: `${connection.id}.${toolSlug(op.id)}`,
      description: op.summary || `${op.method.toUpperCase()} ${op.path}`,
      input: inputSchemaOf(op),
      call: {
        method: op.method,
        path: op.path,
        parameters: op.parameters.map((p) => ({ name: p.name, in: p.in })),
        body: Boolean(op.body),
      },
    }));

interface CallPlan {
  method: HttpMethod;
  path: string;
  parameters: Pick<OperationParameter, 'name' | 'in'>[];
  body: boolean;
}

const planOf = (tool: PinnedTool): CallPlan => tool.call as unknown as CallPlan;

const scalar = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

const matchesTemplate = (template: string, url: string) => {
  const expected = new URL(template).pathname.split('/');
  const actual = new URL(url).pathname.split('/');
  return (
    expected.length === actual.length &&
    expected.every((segment, i) => segment.includes('%7B') || segment === actual[i])
  );
};

export const requestFor = (
  endpoint: string,
  plan: CallPlan,
  input: Record<string, unknown>,
): { url: string; headers: Record<string, string>; body?: string } | { error: string } => {
  let path = plan.path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {};
  for (const p of plan.parameters) {
    const value = input[p.name];
    if (value === undefined || value === null) {
      if (p.in === 'path') return { error: `\`${p.name}\` is required` };
      continue;
    }
    if (p.in === 'path') {
      const raw = scalar(value);
      if (raw === '' || raw === '.' || raw === '..')
        return { error: `\`${p.name}\` is not a valid path segment` };
      path = path.replaceAll(`{${p.name}}`, encodeURIComponent(raw));
    } else if (p.in === 'query') {
      if (Array.isArray(value)) for (const v of value) query.append(p.name, scalar(v));
      else query.append(p.name, scalar(value));
    } else headers[p.name.toLowerCase()] = scalar(value);
  }
  const base = withoutTrailingSlashes(endpoint);
  const search = query.toString();
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}${search ? `?${search}` : ''}`;
  if (!matchesTemplate(`${base}${plan.path.startsWith('/') ? plan.path : `/${plan.path}`}`, url))
    return { error: 'the request path does not match the operation' };
  return {
    url,
    headers,
    ...(plan.body && input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  };
};

const maxText = 20_000;

export const toToolResult = (connectionId: string, response: EgressResponse): ToolResult => {
  const meta = { untrusted: true, source: `openapi:${connectionId}` };
  const type = String(response.headers['content-type'] ?? '');
  const parts: Part[] = [];
  let json: unknown;
  if (/json/.test(type)) {
    try {
      json = JSON.parse(response.body);
    } catch {
      json = undefined;
    }
  }
  if (json !== undefined)
    parts.push({ mime: 'application/json', body: { kind: 'json', json }, meta });
  else if (response.body)
    parts.push({
      mime: 'text/plain',
      body: { kind: 'text', text: response.body.slice(0, maxText) },
      meta,
    });
  const failed = response.status >= 400;
  if (failed)
    parts.unshift({
      mime: 'text/plain',
      body: { kind: 'text', text: `The API answered HTTP ${response.status}.` },
      meta,
    });
  return { parts, ...(failed ? { isError: true } : {}) };
};

export interface OpenApiToolSourceOptions {
  registry: ConnectionRegistry;
  secrets: SecretResolver;
  guard?: EgressGuard;
}

export class OpenApiToolSource extends PinnedToolSource {
  readonly protocol = 'openapi' as const;
  readonly #guard: EgressGuard;
  readonly #secrets: TenantSecrets;

  constructor(options: OpenApiToolSourceOptions) {
    super(options.registry);
    this.#guard = options.guard ?? new EgressGuard();
    this.#secrets = new TenantSecrets(options.secrets);
  }

  protected async listTools(state: ConnectionState, signal?: AbortSignal) {
    const doc = await loadDocument(state.connection, this.#guard, this.#secrets, signal);
    return pinnedFromOperations(state.connection, operationsOf(doc));
  }

  protected port(
    state: ConnectionState,
    tool: PinnedTool,
    ctx: PortContext,
    version: string,
  ): ToolPort {
    const connection = state.connection;
    const plan = planOf(tool);
    return {
      definition: () => ({
        name: tool.name,
        version,
        description: tool.description,
        input: tool.input,
        origin: 'openapi',
      }),
      call: async (input) => {
        if (!isRecord(input))
          return errorResult(`Invalid input for ${tool.name}: expected an object`);
        if (plan.method !== 'get' && connection.writes !== true)
          return errorResult(`${tool.name} changes data, and write operations are turned off`);
        const request = requestFor(connection.endpoint, plan, input);
        if ('error' in request)
          return errorResult(`Invalid input for ${tool.name}: ${request.error}`);
        if (ctx.signal.aborted) throw new ToolError('cancelled', 'the tool call was cancelled');
        await ctx.meter({ requests: 1 });
        try {
          const response = await this.#guard.request(
            connection.allow,
            request.url,
            {
              method: plan.method.toUpperCase() as 'GET',
              headers: {
                accept: 'application/json',
                ...request.headers,
                ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
                ...(await authHeaders(
                  connection,
                  request.url,
                  this.#guard,
                  this.#secrets,
                  ctx.signal,
                )),
              },
              ...(request.body === undefined ? {} : { body: request.body }),
              ...(connection.timeoutMs ? { timeoutMs: connection.timeoutMs } : {}),
              ...(connection.maxResponseBytes
                ? { maxResponseBytes: connection.maxResponseBytes }
                : {}),
            },
            ctx.signal,
          );
          return toToolResult(connection.id, response);
        } catch (error) {
          if (ctx.signal.aborted || (error instanceof EgressError && error.code === 'cancelled'))
            throw new ToolError('cancelled', 'the tool call was cancelled');
          throw new ToolError('failed', error instanceof Error ? error.message : String(error));
        }
      },
    };
  }
}
