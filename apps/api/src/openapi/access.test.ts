import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import {
  createMockAltinnPdp,
  createMockAnsattporten,
  createSigningKey,
  type IdentityTestDataInput,
} from '@genai/identity';
import { splitOperators } from '../operators.js';
import { bootPlatform, digdir } from '../testkit.js';
import { accessRoutes, documentMockRoutes, mockRoutes } from './access.js';

type Operation = {
  parameters?: { name: string; in: string }[];
  requestBody?: { content: Record<string, { schema?: unknown }> };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema?: unknown }> }
  >;
};
type Doc = { paths: Record<string, Record<string, Operation>> };

const area =
  /^\/(tenants\/\{tenant\}\/(api-keys|api-key-policies|clients|maskinporten-clients|me|access|connectors|tool-connections|building-blocks|secrets|private-networks|integrations|plugins|services\/\{service\}\/api-keys)(\/|$)|operator\/(building-blocks|secrets|plugins|onboarding|tenants|organizations|support-sessions)(\/|$)|onboarding\/|support-sessions$|mock\/)/;

const leader = [
  'read',
  'write',
  'use-services',
  'manage-services',
  'manage-datasets',
  'register-building-blocks',
  'view-usage',
];
const testdep = '405003309';
const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  ingrid: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ingrid',
    tenant: testdep,
    authorizedFor: [{ org: testdep, actions: leader }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};
const reason = 'Dokumenterer API-et med et ekte svar';

const schemaOf = (routes: RouteConfig[], method: string, path: string, status: number) => {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`${method} ${path} is not documented`);
  const response = route.responses[status] as { content?: unknown } | undefined;
  const content = response?.content as
    | Record<string, { schema: { safeParse(v: unknown): { success: boolean; error?: unknown } } }>
    | undefined;
  const schema = content?.['application/json']?.schema;
  if (!schema) throw new Error(`${method} ${path} has no ${status} schema`);
  return schema;
};

const conforms = async (
  response: Response,
  method: string,
  path: string,
  status: number,
  routes = accessRoutes,
) => {
  expect(response.status, `${method} ${path}`).toBe(status);
  const parsed = schemaOf(routes, method, path, status).safeParse(await response.json());
  expect(parsed.error, `${method} ${path}`).toBeUndefined();
};

const documentOf = async (app: { request(path: string): Response | Promise<Response> }) =>
  (await (await app.request('/openapi.json')).json()) as Doc;

const expectDocumented = (doc: Doc, route: RouteConfig) => {
  const name = `${route.method.toUpperCase()} ${route.path}`;
  const operation = doc.paths[route.path]?.[route.method];
  expect(operation, name).toBeDefined();
  if (!operation) return;
  expect(operation.responses.default, name).toBeUndefined();
  const success = Object.entries(operation.responses).filter(([s]) => s.startsWith('2'));
  expect(success.length, name).toBeGreaterThan(0);
  for (const [status, response] of success)
    if (status !== '204')
      expect(Object.values(response.content ?? {})[0]?.schema, `${name} ${status}`).toBeDefined();
  for (const [status, response] of Object.entries(operation.responses))
    if (/^[45]/.test(status))
      expect(Object.values(response.content ?? {})[0]?.schema, `${name} ${status}`).toBeDefined();
  const pathParams = [...route.path.matchAll(/\{(\w+)\}/g)].map(([, p]) => p);
  for (const param of pathParams)
    expect(
      operation.parameters?.some((p) => p.in === 'path' && p.name === param),
      `${name} ${param}`,
    ).toBe(true);
  if (route.request?.body)
    expect(Object.values(operation.requestBody?.content ?? {})[0]?.schema, name).toBeDefined();
  if (route.request?.query)
    expect(
      operation.parameters?.some((p) => p.in === 'query'),
      name,
    ).toBe(true);
  const headers = route.request?.headers as { shape?: Record<string, unknown> } | undefined;
  for (const header of Object.keys(headers?.shape ?? {}))
    expect(
      operation.parameters?.some((p) => p.in === 'header' && p.name === header),
      `${name} ${header}`,
    ).toBe(true);
};

describe('access and extensions API reference', () => {
  it('documents every access and extension route with request and response schemas', async () => {
    const { app } = await bootPlatform({ people });
    const doc = await documentOf(app);
    const mine = Object.entries(doc.paths).flatMap(([path, item]) =>
      area.test(path) ? Object.entries(item).map(([method, op]) => ({ path, method, op })) : [],
    );
    expect(mine.length).toBeGreaterThan(70);
    expect(mine.filter((m) => m.op.responses.default).map((m) => `${m.method} ${m.path}`)).toEqual(
      [],
    );
    for (const route of accessRoutes) expectDocumented(doc, route);
  });

  it('documents the development login mocks and marks them as development only', async () => {
    const app = new OpenAPIHono();
    documentMockRoutes(app);
    const doc = (app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'test', version: '1' },
    }) ?? {}) as unknown as Doc;
    for (const route of mockRoutes) {
      expectDocumented(doc, route);
      expect(route.summary).toMatch(/^Development only/);
    }
  });

  it('answers API key, client and access routes as documented', async () => {
    const { send } = await bootPlatform({ people, services: ['klarsprak'] });
    const t = `/tenants/${digdir}`;

    const created = await send(`${t}/api-keys`, 'kari', { body: { name: 'Fagsystem' }, reason });
    const key = ((await created.clone().json()) as { apiKey: { id: string } }).apiKey.id;
    await conforms(created, 'post', '/tenants/{tenant}/api-keys', 201);
    await conforms(await send(`${t}/access`, 'kari'), 'get', '/tenants/{tenant}/access', 200);

    const policy = await send(`${t}/api-key-policies`, 'kari', {
      body: { name: 'Bare søk', scopes: ['query'] },
      reason,
    });
    const policyId = ((await policy.clone().json()) as { id: string }).id;
    await conforms(policy, 'post', '/tenants/{tenant}/api-key-policies', 201);
    await conforms(
      await send(`${t}/api-keys/${key}/policy`, 'kari', {
        method: 'PUT',
        body: { policyId },
        reason,
      }),
      'put',
      '/tenants/{tenant}/api-keys/{id}/policy',
      200,
    );
    await conforms(
      await send(`${t}/api-key-policies`, 'kari'),
      'get',
      '/tenants/{tenant}/api-key-policies',
      200,
    );
    await conforms(
      await send(`${t}/api-keys/${key}/rotate`, 'kari', { body: {}, reason }),
      'post',
      '/tenants/{tenant}/api-keys/{id}/rotate',
      201,
    );

    await conforms(
      await send(`${t}/clients/fagsystem`, 'kari', {
        method: 'PUT',
        body: { spec: { service: 'klarsprak', kind: 'server', channels: ['openai'] } },
        reason,
      }),
      'put',
      '/tenants/{tenant}/clients/{id}',
      200,
    );
    await conforms(await send(`${t}/clients`, 'kari'), 'get', '/tenants/{tenant}/clients', 200);
    await conforms(
      await send(`${t}/clients/fagsystem/webhook/test`, 'kari', { body: {}, reason }),
      'post',
      '/tenants/{tenant}/clients/{id}/webhook/test',
      200,
    );
    await conforms(
      await send(`${t}/services/klarsprak/api-keys`, 'kari', {
        body: { name: 'Klarspråk', client: 'fagsystem' },
        reason,
      }),
      'post',
      '/tenants/{tenant}/services/{service}/api-keys',
      201,
    );
    await conforms(
      await send(`${t}/maskinporten-clients`, 'kari', {
        body: { clientId: 'fagsystem-mp', name: 'Fagsystem', services: ['klarsprak'] },
        reason,
      }),
      'post',
      '/tenants/{tenant}/maskinporten-clients',
      201,
    );
    await conforms(await send(`${t}/me`, 'kari'), 'get', '/tenants/{tenant}/me', 200);
    await conforms(
      await send(`${t}/me/preferences`, 'kari', {
        method: 'PUT',
        body: { language: 'en' },
        reason,
      }),
      'put',
      '/tenants/{tenant}/me/preferences',
      200,
    );
  });

  it('answers integration, connector and building block routes as documented', async () => {
    const { send } = await bootPlatform({ people, services: ['klarsprak'] });
    const t = `/tenants/${digdir}`;

    await conforms(
      await send(`${t}/integrations`, 'kari'),
      'get',
      '/tenants/{tenant}/integrations',
      200,
    );
    await conforms(
      await send(`${t}/tool-connections`, 'kari'),
      'get',
      '/tenants/{tenant}/tool-connections',
      200,
    );
    await conforms(
      await send(`${t}/secrets/lovdata`, 'kari', {
        method: 'PUT',
        body: { value: 'ikke-en-ekte-verdi' },
        reason,
      }),
      'put',
      '/tenants/{tenant}/secrets/{name}',
      200,
    );
    await conforms(
      await send(`${t}/connectors`, 'kari'),
      'get',
      '/tenants/{tenant}/connectors',
      200,
    );
    await conforms(
      await send(`/operator/tenants/${digdir}/private-networks`, 'drift', {
        method: 'PUT',
        body: { entries: ['10.20.0.0/16'] },
        reason,
      }),
      'put',
      '/operator/tenants/{tenant}/private-networks',
      200,
    );
    await conforms(
      await send(`${t}/private-networks`, 'kari'),
      'get',
      '/tenants/{tenant}/private-networks',
      200,
    );

    const list = await send(`${t}/building-blocks`, 'kari');
    const blocks = ((await list.clone().json()) as { data: { kind: string; id: string }[] }).data;
    expect(blocks.length).toBeGreaterThan(0);
    await conforms(list, 'get', '/tenants/{tenant}/building-blocks', 200);
    const [first] = blocks;
    await conforms(
      await send(
        `${t}/building-blocks/${first?.kind}/${encodeURIComponent(first?.id ?? '')}`,
        'kari',
      ),
      'get',
      '/tenants/{tenant}/building-blocks/{kind}/{id}',
      200,
    );
    await conforms(
      await send(
        `${t}/building-blocks/${first?.kind}/${encodeURIComponent(first?.id ?? '')}/versions`,
        'kari',
      ),
      'get',
      '/tenants/{tenant}/building-blocks/{kind}/{id}/versions',
      200,
    );
    await conforms(
      await send(`${t}/building-blocks/manifest-preview`, 'kari', {
        body: { type: 'mcp', name: 'Lovdata', endpoint: 'https://lovdata.example.no/mcp' },
      }),
      'post',
      '/tenants/{tenant}/building-blocks/manifest-preview',
      200,
    );
    await conforms(
      await send('/operator/building-blocks', 'drift'),
      'get',
      '/operator/building-blocks',
      200,
    );
    await conforms(
      await send('/operator/building-blocks/approval-requests', 'drift'),
      'get',
      '/operator/building-blocks/approval-requests',
      200,
    );
  });

  it('answers plug-in, onboarding, tenant and support session routes as documented', async () => {
    const { send, admin } = await bootPlatform({ people, services: ['klarsprak'] });

    await conforms(await send('/operator/plugins', 'drift'), 'get', '/operator/plugins', 200);
    await conforms(
      await send('/operator/plugins/blob.memory', 'drift'),
      'get',
      '/operator/plugins/{id}',
      200,
    );
    await conforms(
      await send('/operator/plugins/manifest-check', 'drift', {
        body: {
          kind: 'model',
          id: 'model.example',
          version: '1',
          contract: 'model@1',
          title: 'Eks',
        },
      }),
      'post',
      '/operator/plugins/manifest-check',
      200,
    );
    await conforms(
      await send(`/tenants/${digdir}/plugins`, 'kari'),
      'get',
      '/tenants/{tenant}/plugins',
      200,
    );

    await conforms(
      await send('/onboarding/requests', 'ingrid', {
        body: {
          org: testdep,
          orgName: 'Testdepartementet',
          contactName: 'Ingrid Berg',
          contactEmail: 'ingrid@testdep.example.no',
          purpose: 'Spørsmål og svar for veiledere',
          acceptedTerms: true,
        },
      }),
      'post',
      '/onboarding/requests',
      201,
    );
    await conforms(
      await send('/onboarding/requests/mine', 'ingrid'),
      'get',
      '/onboarding/requests/mine',
      200,
    );
    await conforms(
      await send(`/onboarding/organisations/${testdep}`, 'ingrid'),
      'get',
      '/onboarding/organisations/{org}',
      200,
    );
    const requests = await send('/operator/onboarding/requests', 'drift');
    const request = ((await requests.clone().json()) as { data: { id: string }[] }).data[0];
    await conforms(requests, 'get', '/operator/onboarding/requests', 200);
    await conforms(
      await send(`/operator/onboarding/requests/${request?.id}/decision`, 'drift', {
        body: { approve: true },
        reason,
      }),
      'post',
      '/operator/onboarding/requests/{id}/decision',
      200,
    );

    await conforms(
      await send('/operator/tenants', 'drift', {
        body: { orgNumber: '889640782', name: 'Arbeids- og velferdsetaten' },
        reason,
      }),
      'post',
      '/operator/tenants',
      200,
    );
    await conforms(
      await send('/operator/organizations/889640782', 'drift'),
      'get',
      '/operator/organizations/{orgNumber}',
      200,
    );
    await conforms(
      await send(`/operator/tenants/${digdir}/definitions`, 'drift'),
      'get',
      '/operator/tenants/{tenant}/definitions',
      200,
    );
    await conforms(
      await send(`/operator/tenants/${digdir}/definitions/services/klarsprak`, 'drift'),
      'get',
      '/operator/tenants/{tenant}/definitions/{kind}/{id}',
      200,
    );
    await conforms(
      await send(`/operator/tenants/${digdir}/definitions/services/klarsprak/versions/1`, 'drift'),
      'get',
      '/operator/tenants/{tenant}/definitions/{kind}/{id}/versions/{version}',
      200,
    );

    const opened = await admin.openSupportSession(
      people.drift as Principal,
      digdir,
      'Feilsøker en tjeneste for kunden',
      30,
    );
    if (!opened.ok) throw new Error('no support session');
    await conforms(
      await send('/operator/support-sessions', 'drift'),
      'get',
      '/operator/support-sessions',
      200,
    );
    await conforms(
      await send(`/operator/support-sessions/${opened.value.id}/extend`, 'drift', {
        body: { minutes: 10 },
        reason,
      }),
      'post',
      '/operator/support-sessions/{id}/extend',
      200,
    );
    await conforms(
      await send(`/operator/support-sessions/${opened.value.id}/end`, 'drift', {
        body: {},
        reason,
      }),
      'post',
      '/operator/support-sessions/{id}/end',
      200,
    );
  });

  it('answers the development login mocks as documented', async () => {
    const raw = parseYaml(
      readFileSync(
        join(import.meta.dirname, '..', '..', 'config', 'local', 'identity.yaml'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    delete raw.devLogin;
    const testData = splitOperators(raw).testData as IdentityTestDataInput;
    const issuer = 'http://localhost/mock/ansattporten';
    const mock = createMockAnsattporten({ issuer, key: await createSigningKey(), testData });
    const app = new OpenAPIHono();
    app.route('/mock/ansattporten', mock.app);
    app.route('/mock/altinn', createMockAltinnPdp(testData).app);
    const pid = testData.persons?.[0]?.pid ?? '';
    const tokens = await mock.testTokens(pid, 'local-portal');

    await conforms(
      await app.request('/mock/ansattporten/.well-known/openid-configuration'),
      'get',
      '/mock/ansattporten/.well-known/openid-configuration',
      200,
      mockRoutes,
    );
    await conforms(
      await app.request('/mock/ansattporten/jwks.json'),
      'get',
      '/mock/ansattporten/jwks.json',
      200,
      mockRoutes,
    );
    await conforms(
      await app.request('/mock/ansattporten/userinfo', {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
      'get',
      '/mock/ansattporten/userinfo',
      200,
      mockRoutes,
    );
    await conforms(
      await app.request('/mock/altinn/authorization/api/v1/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ Request: {} }),
      }),
      'post',
      '/mock/altinn/authorization/api/v1/decision',
      200,
      mockRoutes,
    );
  });
});
