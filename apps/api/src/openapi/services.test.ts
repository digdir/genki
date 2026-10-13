import { describe, expect, it } from 'vitest';
import type { z } from '@hono/zod-openapi';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir, testService } from '../testkit.js';
import { serviceRoutes } from './services.js';

type Operation = {
  parameters?: { name: string; in: string }[];
  requestBody?: unknown;
  responses?: Record<string, { content?: Record<string, unknown>; headers?: unknown }>;
};

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir },
};

const area = [
  /^\/tenants\/\{tenant\}\/(services|definitions|proposals|playground|step-flows|skills|skill-tools|pins|export|import)(\/|$)/,
  /^\/(definitions|services|shared-services)(\/|$)/,
  /^\/operator\/(proposals|skills\/shares|recipes\/shares|shared-services|definitions\/drift|definitions\/quarantine)/,
];

const withoutBody = new Set([
  'post /tenants/{tenant}/skills/{id}/fix',
  'post /tenants/{tenant}/skills/{id}/fix/{fixId}/apply',
  'delete /tenants/{tenant}/skills/{id}/testcases/{index}',
  'delete /tenants/{tenant}/skills/{id}/share',
  'put /operator/recipes/shares/{flow}',
  'delete /operator/recipes/shares/{flow}',
]);

const unaudited = new Set([
  'post /definitions/validate',
  'post /tenants/{tenant}/definitions/complete',
  'post /tenants/{tenant}/definitions/input-fields',
  'post /tenants/{tenant}/definitions/test-run',
  'post /tenants/{tenant}/playground/runs',
  'post /tenants/{tenant}/playground/runs/stream',
  'post /tenants/{tenant}/services/{id}/assistant/turns',
  'post /tenants/{tenant}/skills/{id}/assistant/turns',
  'post /tenants/{tenant}/step-flows/{id}/assistant/turns',
  'post /tenants/{tenant}/services/{id}/eval-runs',
  'post /tenants/{tenant}/services/{id}/improvements',
  'post /tenants/{tenant}/skills/{id}/test-runs',
  'post /tenants/{tenant}/skills/{id}/fix',
]);

const boot = () => bootPlatform({ people, services: ['klarsprak'] });

const documented = async () => {
  const { send } = await boot();
  const doc = (await (await send('/openapi.json', 'kari')).json()) as {
    paths: Record<string, Record<string, Operation>>;
  };
  return Object.entries(doc.paths)
    .filter(([path]) => area.some((pattern) => pattern.test(path)))
    .flatMap(([path, item]) =>
      Object.entries(item).map(([method, op]) => ({ key: `${method} ${path}`, path, method, op })),
    );
};

const schemaFor = (method: string, path: string, status: number, type: string) => {
  const route = serviceRoutes.find((r) => r.method === method && r.path === path);
  const responses = route?.responses as
    Record<number, { content?: Record<string, { schema: z.ZodType }> }> | undefined;
  const schema = responses?.[status]?.content?.[type]?.schema;
  if (!schema) throw new Error(`no ${status} ${type} schema for ${method} ${path}`);
  return schema;
};

describe('services and definitions in the API reference', () => {
  it('every service and definition operation has its path parameters and response schemas', async () => {
    const ops = await documented();
    expect(ops.length).toBeGreaterThanOrEqual(75);
    const gaps = ops.flatMap(({ key, path, op }) => {
      const declared = new Set((op.parameters ?? []).map((p) => `${p.in}:${p.name}`));
      const missing = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)]
        .map(([, name]) => `path:${name}`)
        .filter((p) => !declared.has(p));
      const responses = op.responses ?? {};
      const success = Object.entries(responses).filter(([status]) => /^2/.test(status));
      return [
        ...missing.map((p) => `${key}: undeclared ${p}`),
        ...('default' in responses ? [`${key}: placeholder response`] : []),
        ...(success.length === 0 || success.some(([, r]) => !r.content)
          ? [`${key}: no success schema`]
          : []),
        ...(Object.keys(responses).some((s) => /^[45]/.test(s)) ? [] : [`${key}: no error`]),
      ];
    });
    expect(gaps).toEqual([]);
  });

  it('every write in the area documents its body, and audited writes the change-reason header', async () => {
    const writes = (await documented()).filter(({ method }) => method !== 'get');
    const noBody = writes
      .filter(({ key, op }) => !op.requestBody && !withoutBody.has(key))
      .map(({ key }) => key);
    const noReason = writes
      .filter(
        ({ key, op }) =>
          !unaudited.has(key) &&
          !(op.parameters ?? []).some((p) => p.in === 'header' && p.name === 'change-reason'),
      )
      .map(({ key }) => key);
    expect({ noBody, noReason }).toEqual({ noBody: [], noReason: [] });
  });

  it('real responses from each route group match their documented schema exactly', async () => {
    const { send } = await boot();
    const t = `/tenants/${digdir}`;
    const reason = 'dokumentasjonstest';
    const definition = testService('klarsprak');
    const calls: {
      method: 'get' | 'post' | 'put' | 'delete';
      path: string;
      url: string;
      as?: string;
      body?: unknown;
      status: number;
      type?: string;
    }[] = [
      { method: 'get', path: '/tenants/{tenant}/services', url: `${t}/services`, status: 200 },
      {
        method: 'put',
        path: '/tenants/{tenant}/services/{id}/draft',
        url: `${t}/services/klarsprak/draft`,
        body: { definition, files: {}, baseVersion: 1 },
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/services/{id}/draft',
        url: `${t}/services/klarsprak/draft`,
        status: 200,
      },
      {
        method: 'post',
        path: '/tenants/{tenant}/services/{id}/draft/rebase',
        url: `${t}/services/klarsprak/draft/rebase`,
        body: {},
        status: 200,
      },
      {
        method: 'delete',
        path: '/tenants/{tenant}/services/{id}/draft',
        url: `${t}/services/klarsprak/draft`,
        status: 200,
      },
      {
        method: 'put',
        path: '/tenants/{tenant}/services/{id}/lifecycle',
        url: `${t}/services/klarsprak/lifecycle`,
        body: { state: 'paused' },
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/services/{id}/lifecycle',
        url: `${t}/services/klarsprak/lifecycle`,
        status: 200,
      },
      {
        method: 'post',
        path: '/tenants/{tenant}/services/{id}/risk-confirmations',
        url: `${t}/services/klarsprak/risk-confirmations`,
        body: { riskClass: 'limited' },
        status: 201,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/services/{id}/risk-confirmations',
        url: `${t}/services/klarsprak/risk-confirmations`,
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/services/{id}/test-sets',
        url: `${t}/services/klarsprak/test-sets`,
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/services/{id}/eval-runs',
        url: `${t}/services/klarsprak/eval-runs`,
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/services/{id}/improvements',
        url: `${t}/services/klarsprak/improvements`,
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/services/{id}/batch-runs',
        url: `${t}/services/klarsprak/batch-runs`,
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/services/{id}/batch-runs/sources',
        url: `${t}/services/klarsprak/batch-runs/sources`,
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/services/{id}/batch-runs/{runId}',
        url: `${t}/services/klarsprak/batch-runs/finnes-ikke`,
        status: 404,
        type: 'application/problem+json',
      },
      {
        method: 'post',
        path: '/tenants/{tenant}/services/{id}/assistant/turns',
        url: `${t}/services/klarsprak/assistant/turns`,
        body: { message: 'Gjør svaret kortere', draft: { definition } },
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/definitions/template',
        url: `${t}/definitions/template`,
        status: 200,
      },
      {
        method: 'post',
        path: '/tenants/{tenant}/definitions/input-fields',
        url: `${t}/definitions/input-fields`,
        body: { definition },
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/step-flows/blocks',
        url: `${t}/step-flows/blocks`,
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/step-flows/recipes',
        url: `${t}/step-flows/recipes`,
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/playground/options',
        url: `${t}/playground/options`,
        status: 200,
      },
      {
        method: 'post',
        path: '/tenants/{tenant}/playground/runs',
        url: `${t}/playground/runs`,
        body: { setup: { output: 'text' } },
        status: 400,
        type: 'application/problem+json',
      },
      { method: 'get', path: '/tenants/{tenant}/proposals', url: `${t}/proposals`, status: 200 },
      {
        method: 'post',
        path: '/tenants/{tenant}/skills',
        url: `${t}/skills`,
        body: { id: 'klart-sprak', name: 'Klart språk' },
        status: 201,
      },
      { method: 'get', path: '/tenants/{tenant}/skills', url: `${t}/skills`, status: 200 },
      {
        method: 'put',
        path: '/tenants/{tenant}/skills/{id}',
        url: `${t}/skills/klart-sprak`,
        body: {
          definition: {
            metadata: { name: 'Klart språk' },
            spec: {
              description: 'Skriver klart',
              instructions: 'Skriv kort.',
              examples: [],
              tools: [],
              attachments: [],
              testset: { cases: [] },
            },
          },
        },
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/skills/{id}',
        url: `${t}/skills/klart-sprak`,
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/skills/{id}/versions',
        url: `${t}/skills/klart-sprak/versions`,
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/skills/{id}/usage',
        url: `${t}/skills/klart-sprak/usage`,
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/skills/{id}/test-runs',
        url: `${t}/skills/klart-sprak/test-runs`,
        status: 200,
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/skills/{id}/requirements',
        url: `${t}/skills/klart-sprak/requirements`,
        status: 200,
      },
      {
        method: 'post',
        path: '/tenants/{tenant}/skills/{id}/publish',
        url: `${t}/skills/klart-sprak/publish`,
        body: {},
        status: 422,
        type: 'application/problem+json',
      },
      {
        method: 'get',
        path: '/tenants/{tenant}/skill-tools',
        url: `${t}/skill-tools`,
        status: 200,
      },
      { method: 'get', path: '/shared-services', url: '/shared-services', status: 200 },
      {
        method: 'get',
        path: '/operator/proposals',
        url: '/operator/proposals',
        as: 'drift',
        status: 200,
      },
      {
        method: 'get',
        path: '/operator/skills/shares',
        url: '/operator/skills/shares',
        as: 'drift',
        status: 200,
      },
      {
        method: 'get',
        path: '/operator/shared-services',
        url: '/operator/shared-services',
        as: 'drift',
        status: 200,
      },
      {
        method: 'put',
        path: '/operator/shared-services/{tenant}/{id}',
        url: `/operator/shared-services/${digdir}/klarsprak`,
        as: 'drift',
        body: { availableTo: '*' },
        status: 200,
      },
      {
        method: 'get',
        path: '/operator/definitions/quarantine',
        url: '/operator/definitions/quarantine',
        as: 'drift',
        status: 200,
      },
      {
        method: 'get',
        path: '/operator/proposals',
        url: '/operator/proposals',
        status: 403,
        type: 'application/problem+json',
      },
    ];
    const seen: string[] = [];
    for (const call of calls) {
      const response = await send(call.url, call.as ?? 'kari', {
        method: call.method.toUpperCase(),
        ...(call.body === undefined ? {} : { body: call.body }),
        reason,
      });
      const where = `${call.method} ${call.url}`;
      const value = (await response.json()) as unknown;
      expect({ where, status: response.status }, JSON.stringify(value)).toEqual({
        where,
        status: call.status,
      });
      const schema = schemaFor(
        call.method,
        call.path,
        call.status,
        call.type ?? 'application/json',
      );
      const parsed = schema.safeParse(value);
      expect({ where, issues: parsed.error?.issues ?? [] }).toEqual({ where, issues: [] });
      if (!call.type) expect(parsed.data, where).toEqual(value);
      seen.push(call.path);
    }
    expect(new Set(seen).size).toBeGreaterThanOrEqual(30);
  });
});
