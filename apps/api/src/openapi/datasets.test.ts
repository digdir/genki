import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteConfig, z } from '@hono/zod-openapi';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir } from '../testkit.js';
import { datasetDocRoutes } from './datasets.js';

type Operation = {
  parameters?: { name: string; in: string }[];
  requestBody?: unknown;
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema?: unknown }> }
  >;
};
type Document = { paths: Record<string, Record<string, Operation>> };

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};
const reason = 'Dokumentasjonen skal stemme';
const area =
  /^\/(tenants\/\{tenant\}\/(datasets|knowledge|catalog)|operator\/(datasets|knowledge|catalog|model-endpoints|models\/\{id\}(\/price)?$)|models$)/;

const routeOf = (method: string, path: string) => {
  const found = datasetDocRoutes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`no documented route ${method} ${path}`);
  return found;
};

const schemaOf = (route: RouteConfig, status: number, type: string) => {
  const response = route.responses[status] as
    { content?: Record<string, { schema: z.ZodType }> } | undefined;
  return response?.content?.[type]?.schema;
};

const conforms = async (response: Response, method: string, path: string) => {
  const route = routeOf(method, path);
  expect(Object.keys(route.responses)).toContain(String(response.status));
  if (response.status === 204) return undefined;
  const type = response.headers.get('content-type')?.split(';')[0] ?? '';
  const schema = schemaOf(route, response.status, type);
  if (!schema) throw new Error(`no ${type} schema for ${response.status} on ${method} ${path}`);
  const body = (await response.json()) as unknown;
  const parsed = schema.safeParse(body);
  expect(parsed.error?.issues ?? [], JSON.stringify(body)).toEqual([]);
  return body as Record<string, unknown>;
};

beforeEach(() => {
  vi.stubGlobal('fetch', async () => {
    throw new Error('offline');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const boot = async () => {
  const booted = await bootPlatform({
    people,
    knowledge: {
      endpoints: {
        search: {
          engine: 'typesense',
          baseURL: 'https://search.example.no',
          auth: { kind: 'api-key', secret: 'secret://env/search-key' },
        },
      },
      datasets: [
        {
          id: 'digdir/kudos',
          endpoint: 'search',
          residency: 'norway',
          options: {
            collections: { docs: 'kudos_docs', chunks: 'kudos_chunks' },
            profiles: {
              content: {
                collection: 'chunks',
                queryBy: ['content_markdown'],
                textField: 'content_markdown',
              },
            },
          },
        },
      ],
    },
  });
  const send = (path: string, as: string, init: Parameters<typeof booted.send>[2] = {}) =>
    booted.send(path, as, { reason, ...init });
  return { ...booted, send };
};

const tenantEndpoint = {
  engine: 'http-search',
  baseURL: 'https://sok.testetaten.example.no',
  auth: { kind: 'bearer', secret: `secret://tenant/${digdir}/search-token` },
};

const withDataset = async () => {
  const booted = await boot();
  const endpoint = await booted.send(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, 'kari', {
    method: 'PUT',
    body: tenantEndpoint,
  });
  expect(endpoint.status).toBe(200);
  const created = await booted.send(`/tenants/${digdir}/datasets`, 'kari', {
    body: { id: 'sider', name: 'Sider', residency: 'norway', endpoint: 'sok', facets: ['tema'] },
  });
  expect(created.status).toBe(201);
  return { ...booted, created };
};

describe('dataset, knowledge and catalogue API reference', () => {
  it('documents every dataset, knowledge and catalogue operation with request and response schemas', async () => {
    const { app } = await boot();
    const doc = (await (await app.request('/openapi.json')).json()) as Document;

    for (const route of datasetDocRoutes) {
      const operation = doc.paths[route.path]?.[route.method];
      expect(operation, `${route.method} ${route.path}`).toBeDefined();
      if (!operation) continue;
      expect(Object.keys(operation.responses)).not.toContain('default');
      const success = Object.entries(operation.responses).filter(([s]) => s.startsWith('2'));
      expect(success.length, `${route.method} ${route.path}`).toBeGreaterThan(0);
      for (const [status, response] of success)
        if (status !== '204')
          expect(response.content, `${route.method} ${route.path}`).toBeDefined();
      const pathParams = [...route.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => name);
      const declared = (operation.parameters ?? [])
        .filter((p) => p.in === 'path')
        .map((p) => p.name);
      expect(declared.sort()).toEqual(pathParams.sort());
      if (route.request?.body) expect(operation.requestBody).toBeDefined();
      if (route.request?.headers)
        expect((operation.parameters ?? []).some((p) => p.in === 'header')).toBe(true);
    }

    const placeholders = Object.entries(doc.paths).flatMap(([path, item]) =>
      area.test(path)
        ? Object.entries(item)
            .filter(([, op]) => op.responses.default?.description === 'See the route')
            .map(([method]) => `${method} ${path}`)
        : [],
    );
    expect(placeholders).toEqual([]);
  });

  it('documents the catalogue as it answers', async () => {
    const { send } = await boot();
    const put = await send('/operator/catalog/model-endpoint/norsk', 'drift', {
      method: 'PUT',
      body: {
        protocol: 'openai-chat',
        baseURL: 'https://modeller.example.no/v1',
        auth: { kind: 'api-key', secret: 'secret://env/other-key' },
      },
    });
    expect(put.status).toBe(200);
    await conforms(put, 'put', '/operator/catalog/{kind}/{id}');
    await conforms(
      await send('/operator/catalog/entries', 'drift'),
      'get',
      '/operator/catalog/entries',
    );
    await conforms(
      await send('/operator/catalog/model-endpoint/norsk', 'drift'),
      'get',
      '/operator/catalog/{kind}/{id}',
    );
    await conforms(
      await send('/operator/catalog/model-endpoint/norsk/versions', 'drift'),
      'get',
      '/operator/catalog/{kind}/{id}/versions',
    );
    await conforms(
      await send('/operator/catalog/model-endpoint/norsk', 'kari', { method: 'PUT', body: {} }),
      'put',
      '/operator/catalog/{kind}/{id}',
    );
    await conforms(
      await send('/operator/catalog/model-endpoint/norsk', 'drift', { method: 'DELETE' }),
      'delete',
      '/operator/catalog/{kind}/{id}',
    );
    await conforms(await send('/operator/catalog', 'drift'), 'get', '/operator/catalog');
    await conforms(
      await send(`/tenants/${digdir}/catalog?kind=dataset`, 'kari'),
      'get',
      '/tenants/{tenant}/catalog',
    );
  });

  it('documents datasets and their pipelines as they answer', async () => {
    const { send, created } = await withDataset();
    await conforms(created, 'post', '/tenants/{tenant}/datasets');
    await conforms(
      await send(`/tenants/${digdir}/datasets`, 'kari'),
      'get',
      '/tenants/{tenant}/datasets',
    );
    await conforms(
      await send(`/tenants/${digdir}/datasets/sider`, 'kari'),
      'get',
      '/tenants/{tenant}/datasets/{id}',
    );
    await conforms(
      await send(`/tenants/${digdir}/datasets/sider`, 'kari', {
        method: 'PUT',
        body: { description: 'Nettsidene våre' },
      }),
      'put',
      '/tenants/{tenant}/datasets/{id}',
    );
    await conforms(
      await send(`/tenants/${digdir}/datasets`, 'kari', { body: { name: 'Uten residens' } }),
      'post',
      '/tenants/{tenant}/datasets',
    );
    await conforms(await send('/operator/datasets', 'drift'), 'get', '/operator/datasets');
    await conforms(
      await send(`/operator/datasets/${encodeURIComponent('digdir/kudos')}`, 'drift'),
      'get',
      '/operator/datasets/{id}',
    );

    const pipelines = `/tenants/${digdir}/datasets/sider/pipelines`;
    const saved = await send(pipelines, 'kari', {
      body: { id: 'filer', name: 'Filer', source: { kind: 'upload' }, schedule: 'weekly' },
    });
    expect(saved.status).toBe(201);
    await conforms(saved, 'post', '/tenants/{tenant}/datasets/{dataset}/pipelines');
    await conforms(
      await send(pipelines, 'kari'),
      'get',
      '/tenants/{tenant}/datasets/{dataset}/pipelines',
    );
    await conforms(
      await send(`${pipelines}/filer`, 'kari'),
      'get',
      '/tenants/{tenant}/datasets/{dataset}/pipelines/{id}',
    );
    await conforms(
      await send(`${pipelines}/filer/versions`, 'kari'),
      'get',
      '/tenants/{tenant}/datasets/{dataset}/pipelines/{id}/versions',
    );
    await conforms(
      await send(`${pipelines}/filer/executions`, 'kari'),
      'get',
      '/tenants/{tenant}/datasets/{dataset}/pipelines/{id}/executions',
    );
    await conforms(
      await send(`${pipelines}/filer`, 'kari', { method: 'DELETE' }),
      'delete',
      '/tenants/{tenant}/datasets/{dataset}/pipelines/{id}',
    );
  });

  it('documents knowledge endpoints and engines as they answer', async () => {
    const { send } = await withDataset();
    await conforms(
      await send('/operator/knowledge/engines', 'drift'),
      'get',
      '/operator/knowledge/engines',
    );
    await conforms(
      await send(`/tenants/${digdir}/knowledge/engines`, 'kari'),
      'get',
      '/tenants/{tenant}/knowledge/engines',
    );
    await conforms(
      await send('/operator/knowledge/endpoints', 'drift'),
      'get',
      '/operator/knowledge/endpoints',
    );
    await conforms(
      await send(`/tenants/${digdir}/knowledge/endpoints`, 'kari'),
      'get',
      '/tenants/{tenant}/knowledge/endpoints',
    );
    await conforms(
      await send('/operator/knowledge/secrets', 'drift'),
      'get',
      '/operator/knowledge/secrets',
    );
    await conforms(
      await send('/operator/knowledge/endpoints/test', 'drift', { body: tenantEndpoint }),
      'post',
      '/operator/knowledge/endpoints/test',
    );
    await conforms(
      await send('/operator/knowledge/endpoints/search', 'drift', { method: 'DELETE' }),
      'delete',
      '/operator/knowledge/endpoints/{id}',
    );
  });

  it('documents engine switches, uploads and enrichment as they answer', async () => {
    const { send, app } = await withDataset();
    const dataset = `/tenants/${digdir}/datasets/sider`;
    await conforms(
      await send(`${dataset}/engine`, 'kari'),
      'get',
      '/tenants/{tenant}/datasets/{id}/engine',
    );
    await conforms(
      await send(`${dataset}/engine-switches`, 'kari'),
      'get',
      '/tenants/{tenant}/datasets/{id}/engine-switches',
    );
    await conforms(
      await send(`${dataset}/engine-switches`, 'kari', { body: { to: 'sok', method: 'move' } }),
      'post',
      '/tenants/{tenant}/datasets/{id}/engine-switches',
    );

    const form = new FormData();
    form.append('files', new File(['Digdir har ansvar for felles løsninger.'], 'notat.txt'));
    form.append('files', new File(['x'], 'bilde.png'));
    const uploaded = await app.request(`${dataset}/uploads`, {
      method: 'POST',
      headers: { authorization: 'Bearer kari', 'change-reason': reason },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    await conforms(uploaded, 'post', '/tenants/{tenant}/datasets/{id}/uploads');
    await conforms(
      await send(`${dataset}/uploads`, 'kari'),
      'get',
      '/tenants/{tenant}/datasets/{id}/uploads',
    );
    await conforms(
      await send(`${dataset}/uploads/notat.txt`, 'kari', { method: 'DELETE' }),
      'delete',
      '/tenants/{tenant}/datasets/{id}/uploads/{name}',
    );

    const enrichment = `${dataset}/enrichment/hypothetical-questions`;
    await conforms(
      await send(`${enrichment}/apply`, 'kari', {
        body: {
          dryRun: true,
          proposals: [{ chunkId: 'c1', questions: ['Hva gjør Digdir?'] }],
        },
      }),
      'post',
      '/tenants/{tenant}/datasets/{id}/enrichment/hypothetical-questions/apply',
    );
    await conforms(
      await send(`${enrichment}/revert`, 'kari', { body: {} }),
      'post',
      '/tenants/{tenant}/datasets/{id}/enrichment/hypothetical-questions/revert',
    );
  });

  it('documents platform models and model endpoints as they answer', async () => {
    const { send } = await boot();
    await send('/operator/secrets/sigma2-key', 'drift', {
      method: 'PUT',
      body: { value: 'hemmelig' },
    });
    const added = await send('/operator/model-endpoints', 'drift', {
      body: {
        id: 'sigma2',
        protocol: 'openai-chat',
        baseURL: 'https://llm.sigma2.test/v1',
        auth: { kind: 'bearer', secret: 'secret://platform/sigma2-key' },
      },
    });
    expect(added.status).toBe(201);
    await conforms(added, 'post', '/operator/model-endpoints');
    await conforms(
      await send('/operator/models/sigma2/norallm-7b', 'drift', {
        method: 'PUT',
        body: {
          endpoint: 'sigma2',
          deployment: 'NorAllm-7B',
          residency: 'norway',
          capabilities: ['stream'],
          enabled: true,
        },
      }),
      'put',
      '/operator/models/{id}',
    );
    await conforms(
      await send('/operator/models/sigma2/norallm-7b/price', 'drift', {
        method: 'PUT',
        body: { inputPerThousand: 0.01, outputPerThousand: 0.03 },
      }),
      'put',
      '/operator/models/{id}/price',
    );
    await conforms(await send('/models', 'kari'), 'get', '/models');
    await conforms(await send('/models?residency=mars', 'kari'), 'get', '/models');
    await conforms(
      await send('/operator/model-endpoints/sigma2', 'drift', { method: 'DELETE' }),
      'delete',
      '/operator/model-endpoints/{id}',
    );
  });
});
