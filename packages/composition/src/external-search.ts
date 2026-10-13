import { authHeaders, type Credential } from '@genai/kernel';
import {
  filterKinds,
  KnowledgeError,
  type Hit,
  type KnowledgeAdapter,
  type KnowledgeCapability,
  type KnowledgeConnection,
  type SearchResult,
} from '@genai/port-knowledge';
import {
  McpClient,
  TenantSecrets,
  type CallToolResult,
  type EgressGuard,
} from '@genai/providers-mcp-client';
import { z } from 'zod';

const hit = z.object({
  id: z.union([z.string().min(1), z.number()]).transform(String),
  text: z.string(),
  score: z.number().default(0),
  title: z.string().optional(),
  url: z.string().optional(),
  document: z.string().optional(),
  position: z.number().int().optional(),
  fields: z.record(z.string(), z.unknown()).default({}),
});

const searchReply = z.object({
  hits: z.array(hit),
  found: z.number().int().optional(),
});

const toResult = (raw: unknown): SearchResult => {
  const parsed = searchReply.safeParse(raw);
  if (!parsed.success) throw new Error('the search endpoint answered in an unknown shape');
  return {
    hits: parsed.data.hits.map((h): Hit => ({
      id: h.id,
      score: h.score,
      text: h.text,
      fields: h.fields,
      ...(h.title !== undefined ? { title: h.title } : {}),
      ...(h.url !== undefined ? { url: h.url } : {}),
      ...(h.document !== undefined ? { document: h.document } : {}),
      ...(h.position !== undefined ? { position: h.position } : {}),
    })),
    ...(parsed.data.found !== undefined ? { found: parsed.data.found } : {}),
  };
};

const datasetOptions = z.strictObject({
  index: z.string().min(1).optional(),
  maxFacetValues: z.number().int().positive().max(1000).optional(),
});
type DatasetOptions = z.infer<typeof datasetOptions>;

export const externalSearchCapabilities: KnowledgeCapability[] = [
  'search.text',
  ...filterKinds.map((k) => `filter.${k}` as const),
];

const refuse = (what: string) => async (): Promise<never> => {
  throw new KnowledgeError('unsupported', `an external search endpoint does not offer ${what}`);
};

const unsupported = {
  fetch: refuse('fetch'),
  range: refuse('range'),
  facets: refuse('facets'),
};

export type HttpSend = (
  url: string,
  init: { headers: Record<string, string>; body: string },
  signal: AbortSignal,
) => Promise<{ status: number; body: string }>;

export const guardedSend =
  (guard: EgressGuard): HttpSend =>
  async (url, init, signal) => {
    const target = new URL(url);
    const port = target.port ? Number(target.port) : 443;
    const response = await guard.request(
      [{ host: target.hostname, port }],
      url,
      { method: 'POST', headers: init.headers, body: init.body },
      signal,
    );
    return { status: response.status, body: response.body };
  };

export const httpSearchAdapter = (
  send: HttpSend,
): KnowledgeAdapter<{ searchPath: string }, DatasetOptions> => ({
  engine: 'http-search',
  endpointOptions: z.strictObject({ searchPath: z.string().startsWith('/').default('/search') }),
  datasetOptions,
  capabilities: () => [...externalSearchCapabilities],
  connect: (endpoint): KnowledgeConnection<DatasetOptions> => {
    const url = `${endpoint.baseURL.replace(/\/$/, '')}${endpoint.options.searchPath}`;
    const one = async (
      dataset: { options: DatasetOptions },
      request: { query: string; limit?: number; filters?: unknown; profile?: string },
      signal: AbortSignal,
    ) => {
      const response = await send(
        url,
        {
          headers: {
            'content-type': 'application/json',
            ...(await authHeaders(endpoint.credential, 'authorization')),
          },
          body: JSON.stringify({
            query: request.query,
            limit: request.limit,
            ...(request.filters ? { filters: request.filters } : {}),
            ...(dataset.options.index ? { index: dataset.options.index } : {}),
          }),
        },
        signal,
      );
      if (response.status >= 400)
        throw new Error(`the search endpoint answered ${response.status}`);
      return toResult(JSON.parse(response.body));
    };
    return {
      profiles: () => ['default'],
      search: (dataset, requests, signal) =>
        Promise.all(requests.map((r) => one(dataset, r, signal))),
      ...unsupported,
    };
  },
});

class CredentialSecrets extends TenantSecrets {
  constructor(private readonly value: () => Promise<string>) {
    super({ resolve: async () => '' });
  }

  override async resolveFor(): Promise<string> {
    return this.value();
  }
}

const mcpAuth = (credential: Credential) =>
  credential.kind === 'bearer'
    ? {
        auth: { kind: 'bearer' as const, secret: 'secret://tenant/000000000/knowledge' },
        value: credential.token,
      }
    : credential.header && credential.header.toLowerCase() !== 'authorization'
      ? {
          auth: {
            kind: 'header' as const,
            header: credential.header,
            secret: 'secret://tenant/000000000/knowledge',
          },
          value: credential.key,
        }
      : {
          auth: { kind: 'bearer' as const, secret: 'secret://tenant/000000000/knowledge' },
          value: credential.key,
        };

export type McpCall = (
  endpoint: { baseURL: string; credential: Credential },
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<CallToolResult>;

export const mcpClientCall =
  (guard: EgressGuard): McpCall =>
  async (endpoint, tool, args, signal) => {
    const target = new URL(endpoint.baseURL);
    const { auth, value } = mcpAuth(endpoint.credential);
    const client = new McpClient(
      {
        id: 'knowledge',
        tenant: '000000000',
        name: 'knowledge',
        endpoint: endpoint.baseURL,
        version: '1',
        allow: [{ host: target.hostname, port: target.port ? Number(target.port) : 443 }],
        auth,
      },
      guard,
      new CredentialSecrets(value),
    );
    return client.callTool(tool, args, signal);
  };

const toolPayload = (result: CallToolResult): unknown => {
  if (result.isError)
    throw new Error(result.content?.find((c) => c.text)?.text ?? 'the search tool failed');
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text' && c.text)?.text;
  if (!text) throw new Error('the search tool returned nothing');
  return JSON.parse(text);
};

export const mcpSearchAdapter = (
  call: McpCall,
): KnowledgeAdapter<{ tool: string }, DatasetOptions> => ({
  engine: 'mcp',
  endpointOptions: z.strictObject({ tool: z.string().min(1).default('search') }),
  datasetOptions,
  capabilities: () => [...externalSearchCapabilities],
  connect: (endpoint): KnowledgeConnection<DatasetOptions> => ({
    profiles: () => ['default'],
    search: (dataset, requests, signal) =>
      Promise.all(
        requests.map(async (request) =>
          toResult(
            toolPayload(
              await call(
                endpoint,
                endpoint.options.tool,
                {
                  query: request.query,
                  limit: request.limit ?? 10,
                  ...(request.filters ? { filters: request.filters } : {}),
                  ...(dataset.options.index ? { index: dataset.options.index } : {}),
                },
                signal,
              ),
            ),
          ),
        ),
      ),
    ...unsupported,
  }),
});
