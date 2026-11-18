import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortContext } from '@genai/kernel';
import { ToolRegistry, toolRef } from '@genai/port-tools';
import {
  EgressGuard,
  InMemoryConnections,
  validateConnection,
  type Connection,
} from '@genai/providers-mcp-client';
import { inputSchemaOf, OpenApiToolSource, operationsOf, parseDocument } from './index.js';

const TENANT = '991825827';

const spec = {
  openapi: '3.1.0',
  info: { title: 'Saksarkiv', version: '1' },
  paths: {
    '/saker/{saksnummer}': {
      parameters: [{ name: 'saksnummer', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'hentSak',
        summary: 'Henter en sak.',
        parameters: [
          { name: 'utvidet', in: 'query', schema: { type: 'boolean' } },
          { name: 'Authorization', in: 'header', schema: { type: 'string' } },
        ],
      },
      delete: { operationId: 'slettSak', summary: 'Sletter en sak.' },
    },
    '/saker': {
      get: {
        summary: 'Søker i saker.',
        parameters: [{ $ref: '#/components/parameters/Tekst' }],
      },
      post: {
        operationId: 'opprettSak',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/NySak' } } },
        },
      },
    },
  },
  components: {
    parameters: {
      Tekst: {
        name: 'q',
        in: 'query',
        required: true,
        description: 'Søketekst',
        schema: { type: 'string' },
      },
    },
    schemas: {
      NySak: {
        type: 'object',
        properties: {
          tittel: { type: 'string' },
          forelder: { $ref: '#/components/schemas/NySak' },
        },
        required: ['tittel'],
      },
    },
  },
};

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const fakeApi = async () => {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      seen.push({
        ...(req.method ? { method: req.method } : {}),
        ...(req.url ? { url: req.url } : {}),
        headers: req.headers,
        body: raw,
      });
      if (req.url === '/openapi.yaml') {
        res.writeHead(200, { 'content-type': 'application/yaml' });
        return res.end(
          'openapi: 3.0.3\ninfo: {title: X, version: "1"}\npaths:\n  /ping:\n    get:\n      operationId: ping\n',
        );
      }
      if (req.url === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }));
      }
      if (req.url?.startsWith('/api/saker/404')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'ukjent sak' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
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

const boundTo = (value: string, port: number) => ({
  resolve: async () => value,
  hostsFor: async () => [`http://127.0.0.1:${port}`],
});

const connection = (port: number, extra: Partial<Connection> = {}): Connection => ({
  id: 'arkiv',
  tenant: TENANT,
  name: 'Saksarkiv',
  protocol: 'openapi',
  endpoint: `http://127.0.0.1:${port}/api`,
  version: '1',
  allow: [{ host: '127.0.0.1', port }],
  document: JSON.stringify(spec),
  auth: { kind: 'header', header: 'x-api-key', secret: `secret://tenant/${TENANT}/arkiv` },
  ...extra,
});

const setup = async (extra: Partial<Connection> = {}) => {
  const api = await fakeApi();
  closers.push(api.close);
  const registry = new InMemoryConnections();
  await registry.save({ connection: connection(api.port, extra), tools: [], pending: [] });
  const source = new OpenApiToolSource({
    registry,
    secrets: boundTo('nokkel', api.port),
    guard: new EgressGuard({ testOverride: { allowLoopback: true, allowHttp: true } }),
  });
  return { api, registry, source, tools: new ToolRegistry().addSource(source) };
};

describe('OpenAPI import', () => {
  it('reads every operation with merged parameters, resolved references and a generated id', () => {
    const ops = operationsOf(parseDocument(JSON.stringify(spec)));

    expect(ops.map((o) => [o.id, o.method, o.readOnly])).toEqual([
      ['hentSak', 'get', true],
      ['slettSak', 'delete', false],
      ['get_saker', 'get', true],
      ['opprettSak', 'post', false],
    ]);
    expect(ops[0]?.parameters.map((p) => `${p.in}:${p.name}`)).toEqual([
      'path:saksnummer',
      'query:utvidet',
    ]);
  });

  it('builds a JSON schema per operation from parameters and body, and survives recursive schemas', () => {
    const [get, , search, create] = operationsOf(parseDocument(JSON.stringify(spec)));
    if (!get || !search || !create) throw new Error('missing operations');

    expect(inputSchemaOf(get)).toEqual({
      type: 'object',
      properties: { saksnummer: { type: 'string' }, utvidet: { type: 'boolean' } },
      required: ['saksnummer'],
    });
    expect(inputSchemaOf(search)).toMatchObject({
      properties: { q: { type: 'string', description: 'Søketekst' } },
      required: ['q'],
    });
    expect(inputSchemaOf(create)).toMatchObject({
      properties: {
        body: { type: 'object', required: ['tittel'], properties: { forelder: {} } },
      },
      required: ['body'],
    });
  });

  it('reads YAML and refuses documents that are not OpenAPI 3', () => {
    expect(
      operationsOf(parseDocument('openapi: 3.0.0\ninfo: {title: a, version: "1"}\npaths: {}\n')),
    ).toEqual([]);
    expect(() => parseDocument('{"swagger": "2.0", "paths": {}}')).toThrow(/OpenAPI 3/);
    expect(() =>
      parseDocument(
        '{"openapi": "3.1.0", "paths": {"/a": {"get": {"parameters": [{"$ref": "https://x.test/p"}]}}}}',
      ),
    ).not.toThrow();
  });
});

describe('OpenAPI tools', () => {
  it('exposes read operations only until writes are turned on', async () => {
    const { source, registry } = await setup();

    expect(await source.sync(TENANT, 'arkiv')).toEqual({ active: 2, pending: [] });
    expect((await registry.get(TENANT, 'arkiv'))?.tools.map((t) => t.name)).toEqual([
      'arkiv.hentsak',
      'arkiv.get_saker',
    ]);
  });

  it('exposes only the operations the tenant picked, and write operations once enabled', async () => {
    const { source, registry } = await setup({
      operations: ['hentSak', 'opprettSak'],
      writes: true,
    });

    await source.sync(TENANT, 'arkiv');

    expect((await registry.get(TENANT, 'arkiv'))?.tools.map((t) => t.name)).toEqual([
      'arkiv.hentsak',
      'arkiv.opprettsak',
    ]);
  });

  it('calls the API through the egress guard with the vault credential and path and query values', async () => {
    const { source, tools, api } = await setup();
    await source.sync(TENANT, 'arkiv');

    const result = await tools
      .open(toolRef('arkiv.hentsak', '1', TENANT), ctx())
      .call({ saksnummer: '2024/12', utvidet: true });

    const call = api.seen.at(-1);
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe('/api/saker/2024%2F12?utvidet=true');
    expect(call?.headers['x-api-key']).toBe('nokkel');
    expect(result.parts[0]).toMatchObject({
      body: { kind: 'json', json: { ok: true } },
      meta: { untrusted: true, source: 'openapi:arkiv' },
    });
  });

  it('sends the JSON body on an enabled write operation', async () => {
    const { source, tools, api } = await setup({ writes: true });
    await source.sync(TENANT, 'arkiv');

    await tools
      .open(toolRef('arkiv.opprettsak', '1', TENANT), ctx())
      .call({ body: { tittel: 'Ny' } });

    expect(api.seen.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/saker',
      body: '{"tittel":"Ny"}',
    });
    expect(api.seen.at(-1)?.headers['content-type']).toBe('application/json');
  });

  it('refuses a write call when writes were turned off after pinning', async () => {
    const { source, tools, registry, api } = await setup({ writes: true });
    await source.sync(TENANT, 'arkiv');
    const state = await registry.get(TENANT, 'arkiv');
    if (!state) throw new Error('no state');
    await registry.save({ ...state, connection: { ...state.connection, writes: false } });
    await source.load(TENANT);
    const before = api.seen.length;

    const result = await tools
      .open(toolRef('arkiv.opprettsak', '1', TENANT), ctx())
      .call({ body: {} });

    expect(result.isError).toBe(true);
    expect(api.seen.length).toBe(before);
  });

  it('reports an HTTP error as a tool error', async () => {
    const { source, tools } = await setup();
    await source.sync(TENANT, 'arkiv');

    const result = await tools
      .open(toolRef('arkiv.hentsak', '1', TENANT), ctx())
      .call({ saksnummer: '404' });

    expect(result.isError).toBe(true);
    expect(result.parts[0]?.body).toEqual({ kind: 'text', text: 'The API answered HTTP 404.' });
  });

  it('fetches the document from its address and authenticates with OAuth client credentials', async () => {
    const api = await fakeApi();
    closers.push(api.close);
    const registry = new InMemoryConnections();
    await registry.save({
      connection: connection(api.port, {
        document: undefined,
        documentUrl: `http://127.0.0.1:${api.port}/openapi.yaml`,
        auth: {
          kind: 'oauth-client-credentials',
          tokenUrl: `http://127.0.0.1:${api.port}/token`,
          clientId: 'plattform',
          secret: `secret://tenant/${TENANT}/arkiv`,
        },
      }),
      tools: [],
      pending: [],
    });
    const source = new OpenApiToolSource({
      registry,
      secrets: boundTo('klienthemmelighet', api.port),
      guard: new EgressGuard({ testOverride: { allowLoopback: true, allowHttp: true } }),
    });
    await source.sync(TENANT, 'arkiv');

    await new ToolRegistry()
      .addSource(source)
      .open(toolRef('arkiv.ping', '1', TENANT), ctx())
      .call({});

    const token = api.seen.find((s) => s.url === '/token');
    expect(token?.body).toContain('grant_type=client_credentials');
    expect(token?.body).toContain('client_secret=klienthemmelighet');
    expect(api.seen.at(-1)).toMatchObject({ url: '/api/ping' });
    expect(api.seen.at(-1)?.headers.authorization).toBe('Bearer tok-1');
  });

  it('refuses private hosts at call time and at registration', async () => {
    const api = await fakeApi();
    closers.push(api.close);
    const registry = new InMemoryConnections();
    await registry.save({ connection: connection(api.port), tools: [], pending: [] });
    const source = new OpenApiToolSource({
      registry,
      secrets: boundTo('x', api.port),
      guard: new EgressGuard({ testOverride: { allowHttp: true } }),
    });
    await source.sync(TENANT, 'arkiv');

    await expect(
      new ToolRegistry()
        .addSource(source)
        .open(toolRef('arkiv.hentsak', '1', TENANT), ctx())
        .call({ saksnummer: '1' }),
    ).rejects.toThrow(/private address/);
    expect(() =>
      validateConnection({
        ...connection(443),
        endpoint: 'https://10.0.0.5/api',
        allow: [{ host: '10.0.0.5' }],
      }),
    ).toThrow(/private address/);
  });

  it('needs a document, and keeps document settings off other protocols', () => {
    const base = {
      ...connection(443),
      endpoint: 'https://api.example.no/v1',
      allow: [{ host: 'api.example.no' }],
    };
    expect(() => validateConnection({ ...base, document: undefined })).toThrow(/needs a document/);
    expect(() => validateConnection({ ...base, protocol: 'mcp' })).toThrow(/only for OpenAPI/);
    expect(() =>
      validateConnection({ ...base, documentUrl: 'https://andre.example.no/openapi.json' }),
    ).toThrow(/allowlist/);
  });
});
