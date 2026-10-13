import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import type { KnowledgeAdapter } from '@genai/port-knowledge';
import { typesense } from '@genai/providers-typesense';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import {
  createKnowledgeEndpointsModule,
  summarizeCapabilities,
  type EndpointTestResult,
  type KnowledgeEndpointView,
  type StoredSecretView,
} from './knowledge-endpoints.js';

const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(request.url?.startsWith('/health') ? 401 : 404, {
      'content-type': 'application/json',
    });
    response.end(
      JSON.stringify({ message: 'Forbidden - a valid `x-typesense-api-key` header must be sent.' }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const secretValue = 'ts-verdi-som-aldri-vises';

const boot = async () => {
  const secrets = envSecrets({ TS_KEY: secretValue });
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: {
        endpoints: {
          ka: {
            engine: 'typesense',
            baseURL: url,
            auth: { kind: 'api-key', secret: 'secret://env/ts-key' },
            sharing: { tenants: ['991825827'] },
          },
        },
        datasets: [
          {
            id: 'ka',
            endpoint: 'ka',
            residency: 'norway',
            options: {
              collections: { docs: 'docs', chunks: 'chunks' },
              profiles: { content: { collection: 'chunks', queryBy: ['text'], textField: 'text' } },
            },
          },
        ],
      },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets,
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
    modules: [
      createKnowledgeEndpointsModule({
        knowledgeAdapters: [typesense as KnowledgeAdapter],
        secrets,
        secretNames: ['azure-search-key'],
      }),
    ],
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  return (path: string, as: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${as}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
};

describe('search endpoints for operators', () => {
  it('lists catalog endpoints with engine, place and dataset count', async () => {
    const call = await boot();
    const response = await call('/operator/knowledge/endpoints', 'drift');
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: KnowledgeEndpointView[] };
    expect(data.find((e) => e.id === 'ka')).toMatchObject({
      engine: 'typesense',
      title: 'Typesense',
      builtin: false,
      runsAt: '127.0.0.1',
      datasetCount: 1,
      status: 'ok',
      writeKeyRequired: true,
    });
    expect((await call('/operator/knowledge/endpoints', 'kari')).status).toBe(403);
  });

  it('the endpoint test reports a failing probe clearly', async () => {
    const call = await boot();
    const refused = await call('/operator/knowledge/endpoints/test', 'drift', {
      engine: 'typesense',
      baseURL: url,
      auth: { kind: 'api-key', secret: 'secret://env/ts-key' },
      name: 'Nytt endepunkt',
    });
    expect(refused.status).toBe(200);
    expect((await refused.json()) as EndpointTestResult).toMatchObject({
      ok: false,
      engine: 'typesense',
      code: 'unauthorized',
      message: 'the search engine refused the key',
    });

    const incomplete = (await (
      await call('/operator/knowledge/endpoints/test', 'drift', { engine: 'typesense' })
    ).json()) as EndpointTestResult;
    expect(incomplete).toMatchObject({ ok: false, code: 'bad_request' });
    expect(incomplete.message).toContain('baseURL');
  });

  it('lists platform secret names and refs, never their values', async () => {
    const call = await boot();
    const response = await call('/operator/knowledge/secrets', 'drift');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(secretValue);
    expect((JSON.parse(text) as { data: StoredSecretView[] }).data).toEqual([
      { ref: 'secret://env/azure-search-key', name: 'azure-search-key' },
      { ref: 'secret://env/ts-key', name: 'ts-key' },
    ]);
    expect((await call('/operator/knowledge/secrets', 'kari')).status).toBe(403);
  });

  it('a tenant sees the endpoints it can reach with the same view', async () => {
    const call = await boot();
    const response = await call('/tenants/991825827/knowledge/endpoints', 'kari');
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: KnowledgeEndpointView[] };
    expect(data.find((e) => e.id === 'ka')).toMatchObject({
      engine: 'typesense',
      writeKeyRequired: true,
      capabilities: { supported: expect.arrayContaining(['text_search']) as unknown },
    });
    expect(JSON.stringify(data)).not.toContain('secret://');
  });

  it('maps port capabilities to the capabilities the screens name', () => {
    expect(summarizeCapabilities(['search.text', 'fetch', 'filter.select'])).toEqual({
      supported: ['text_search', 'filters', 'full_document'],
      missing: ['vector_search', 'hybrid', 'facets', 'ordered_passages'],
    });
  });
});
