import { describe, expect, it } from 'vitest';
import type { RouteConfig } from '@hono/zod-openapi';
import type { z } from 'zod';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir } from '../testkit.js';
import { workRoutes } from './work.js';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir },
};

const area = new RegExp(
  [
    '^/tenants/\\{tenant\\}/(projects|tasks|test-sets|eval-runs|testcase-candidates|gates|guardrail-rules|diagnostics|feedback|usage|audit|overview)\\b',
    '^/(tasks|eval-tasks|eval-runs|testcase-candidates|a2a|up)\\b',
    '^/operator/(tasks|gates|guardrail-rules|quality|usage|audit|operations|running-tasks|tracing|hooks)\\b',
    '^/api/',
  ].join('|'),
);

interface Operation {
  parameters?: { name: string; in: string }[];
  requestBody?: unknown;
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

type Content = Record<string, { schema: z.ZodType }>;

const routeOf = (method: string, path: string) => {
  const route = workRoutes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`no documented route ${method} ${path}`);
  return route;
};

const conforms = async (status: number, response: Response, method: string, path: string) => {
  expect(response.status, `${method} ${path}`).toBe(status);
  const route = routeOf(method, path);
  const documented = route.responses[response.status] as { content?: Content } | undefined;
  const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  const schema = documented?.content?.[type]?.schema;
  expect(schema, `${method} ${path} answered ${response.status} ${type}`).toBeDefined();
  const value = type.startsWith('text/') ? await response.text() : await response.json();
  const parsed = (schema as z.ZodType).safeParse(value);
  expect(parsed.success ? [] : parsed.error.issues, `${method} ${path}`).toEqual([]);
  return value as Record<string, unknown>;
};

const declaredHeaders = (route: RouteConfig) => {
  const headers = route.request?.headers as { shape?: Record<string, unknown> } | undefined;
  return Object.keys(headers?.shape ?? {});
};

describe('work, quality and operations API reference', () => {
  it('documents every operation of the area with request and response schemas, none left to the placeholder', async () => {
    const { app } = await bootPlatform({ people });
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, Operation>>;
    };

    for (const route of workRoutes) {
      const operation = spec.paths[route.path]?.[route.method];
      const name = `${route.method} ${route.path}`;
      expect(operation, name).toBeDefined();
      expect(Object.keys(operation?.responses ?? {}), name).not.toContain('default');
      const success = Object.keys(operation?.responses ?? {}).filter((s) => s.startsWith('2'));
      if (!('405' in (operation?.responses ?? {}))) expect(success.length, name).toBeGreaterThan(0);
      for (const response of Object.values(operation?.responses ?? {}))
        for (const media of Object.values(response.content ?? {}))
          expect(media.schema, name).toBeDefined();
      if (route.request?.body) expect(operation?.requestBody, name).toBeDefined();
      const parameters = (operation?.parameters ?? []).map((p) => `${p.in}:${p.name}`);
      for (const param of route.path.match(/\{[^}]+\}/g) ?? [])
        expect(parameters, name).toContain(`path:${param.slice(1, -1)}`);
      for (const header of declaredHeaders(route))
        expect(parameters, name).toContain(`header:${header}`);
    }

    const placeholders = Object.entries(spec.paths).flatMap(([path, item]) =>
      area.test(path)
        ? Object.entries(item)
            .filter(([, op]) => 'default' in op.responses)
            .map(([method]) => `${method} ${path}`)
        : [],
    );
    expect(placeholders).toEqual([]);
  });

  it('asks for a change reason on every tenant write that is audited', () => {
    const writes = workRoutes.filter(
      (r) =>
        r.method !== 'get' &&
        r.path.startsWith('/tenants/') &&
        r.description?.includes('Audited.') &&
        !r.path.endsWith('/check'),
    );
    expect(writes.length).toBeGreaterThan(20);
    for (const route of writes)
      expect(declaredHeaders(route), `${route.method} ${route.path}`).toContain('change-reason');
  });

  it('gives project responses that match their schemas', async () => {
    const { send } = await bootPlatform({ people, services: ['svar'] });
    const base = `/tenants/${digdir}/projects`;
    const reason = 'Nytt prosjekt for test';

    await conforms(
      200,
      await send(`${base}/sources`, 'kari'),
      'get',
      '/tenants/{tenant}/projects/sources',
    );
    const created = await conforms(
      201,
      await send(base, 'kari', { body: { id: 'arsrapporter', name: 'Årsrapporter' }, reason }),
      'post',
      '/tenants/{tenant}/projects',
    );
    expect(created.id).toBe('arsrapporter');
    const one = `${base}/arsrapporter`;
    await conforms(200, await send(base, 'kari'), 'get', '/tenants/{tenant}/projects');
    await conforms(200, await send(one, 'kari'), 'get', '/tenants/{tenant}/projects/{project}');
    await conforms(
      200,
      await send(one, 'kari', {
        method: 'PUT',
        body: { name: 'Årsrapporter 2026', version: 1 },
        reason,
      }),
      'put',
      '/tenants/{tenant}/projects/{project}',
    );
    await conforms(
      201,
      await send(`${one}/points`, 'kari', { body: { text: 'Se etter frister' }, reason }),
      'post',
      '/tenants/{tenant}/projects/{project}/points',
    );
    for (const tail of ['points', 'history', 'log', 'subscriptions', 'runs'])
      await conforms(
        200,
        await send(`${one}/${tail}`, 'kari'),
        'get',
        `/tenants/{tenant}/projects/{project}/${tail}`,
      );
    await conforms(
      400,
      await send(`${one}/documents`, 'kari'),
      'get',
      '/tenants/{tenant}/projects/{project}/documents',
    );
    await conforms(
      400,
      await send(`${one}/runs/estimate`, 'kari', { body: { service: 'svar' }, reason }),
      'post',
      '/tenants/{tenant}/projects/{project}/runs/estimate',
    );
    await conforms(
      200,
      await send(one, 'kari', { method: 'DELETE', reason }),
      'delete',
      '/tenants/{tenant}/projects/{project}',
    );
    await conforms(404, await send(one, 'kari'), 'get', '/tenants/{tenant}/projects/{project}');
  });

  it('gives task, usage, overview and operator responses that match their schemas', async () => {
    const { send } = await bootPlatform({ people, services: ['svar'] });
    const t = `/tenants/${digdir}`;

    for (const path of ['tasks', 'tasks/mine', 'usage', 'overview'])
      await conforms(200, await send(`${t}/${path}`, 'kari'), 'get', `/tenants/{tenant}/${path}`);
    await conforms(
      404,
      await send(`${t}/tasks/ukjent`, 'kari'),
      'get',
      '/tenants/{tenant}/tasks/{task}',
    );
    await conforms(
      404,
      await send(`${t}/tasks/ukjent/review`, 'kari'),
      'get',
      '/tenants/{tenant}/tasks/{task}/review',
    );
    await conforms(
      404,
      await send(`${t}/tasks/ukjent/export`, 'kari', {
        method: 'POST',
        reason: 'Innsyn i kjøring',
      }),
      'post',
      '/tenants/{tenant}/tasks/{task}/export',
    );
    await conforms(404, await send(`${t}/tasks`, 'drift'), 'get', '/tenants/{tenant}/tasks');

    for (const path of [
      'tasks',
      'running-tasks',
      'quality',
      'quality/label-queue',
      'audit',
      'operations',
      'tracing',
      'hooks',
      'gates',
      'guardrail-rules',
    ])
      await conforms(200, await send(`/operator/${path}`, 'drift'), 'get', `/operator/${path}`);
    await conforms(
      200,
      await send(`/operator/usage?tenants=${digdir}`, 'drift'),
      'get',
      '/operator/usage',
    );
    await conforms(403, await send('/operator/quality', 'kari'), 'get', '/operator/quality');
    await conforms(
      200,
      await send('/operator/audit/exports', 'drift', {
        body: { count: 3 },
        reason: 'Eksport til arkivet',
      }),
      'post',
      '/operator/audit/exports',
    );
    await conforms(
      404,
      await send('/operator/tasks/ukjent/cancel', 'drift', {
        method: 'POST',
        reason: 'Henger og må stoppes',
      }),
      'post',
      '/operator/tasks/{task}/cancel',
    );
  });

  it('gives test set, candidate, feedback and eval responses that match their schemas', async () => {
    const { send } = await bootPlatform({ people, services: ['svar'] });
    const t = `/tenants/${digdir}`;
    const reason = 'Testsett for svar-tjenesten';

    await conforms(
      201,
      await send(`${t}/test-sets`, 'kari', {
        body: { id: 'svar-sporsmal', name: 'Spørsmål', service: 'svar' },
        reason,
      }),
      'post',
      '/tenants/{tenant}/test-sets',
    );
    await conforms(
      201,
      await send(`${t}/test-sets/svar-sporsmal/cases`, 'kari', {
        body: { input: 'Når er fristen?', expected: 'Svaret nevner fristen' },
        reason,
      }),
      'post',
      '/tenants/{tenant}/test-sets/{setId}/cases',
    );
    await conforms(
      200,
      await send(`${t}/test-sets/svar-sporsmal/cases/frist`, 'kari', {
        method: 'PUT',
        body: { split: 'validation', input: 'Hva er fristen?' },
        reason,
      }),
      'put',
      '/tenants/{tenant}/test-sets/{id}/cases/{case}',
    );
    await conforms(
      200,
      await send(`${t}/test-sets/svar-sporsmal`, 'kari'),
      'get',
      '/tenants/{tenant}/test-sets/{id}',
    );
    await conforms(
      200,
      await send(`${t}/test-sets/svar-sporsmal/cases`, 'kari'),
      'get',
      '/tenants/{tenant}/test-sets/{setId}/cases',
    );
    await conforms(200, await send(`${t}/test-sets`, 'kari'), 'get', '/tenants/{tenant}/test-sets');
    await conforms(
      200,
      await send(`${t}/test-sets/svar-sporsmal/cases/frist`, 'kari', { method: 'DELETE', reason }),
      'delete',
      '/tenants/{tenant}/test-sets/{id}/cases/{case}',
    );
    await conforms(
      404,
      await send(`${t}/test-sets/finnes-ikke`, 'kari'),
      'get',
      '/tenants/{tenant}/test-sets/{id}',
    );

    const proposed = await conforms(
      201,
      await send(`${t}/testcase-candidates`, 'kari', {
        body: { question: 'Hva koster det?', answer: 'Det er gratis', testSet: 'svar-sporsmal' },
        reason,
      }),
      'post',
      '/tenants/{tenant}/testcase-candidates',
    );
    await conforms(
      200,
      await send(`${t}/testcase-candidates`, 'kari'),
      'get',
      '/tenants/{tenant}/testcase-candidates',
    );
    await conforms(
      200,
      await send(`${t}/testcase-candidates/${String(proposed.id)}/review`, 'kari', {
        body: { decision: 'accept' },
        reason,
      }),
      'post',
      '/tenants/{tenant}/testcase-candidates/{id}/review',
    );
    const second = await conforms(
      201,
      await send(`${t}/testcase-candidates`, 'kari', {
        body: { question: 'Hvem svarer?' },
        reason,
      }),
      'post',
      '/tenants/{tenant}/testcase-candidates',
    );
    await conforms(
      200,
      await send(`/testcase-candidates/${String(second.id)}/review`, 'kari', {
        body: { decision: 'reject' },
        reason,
      }),
      'post',
      '/testcase-candidates/{id}/review',
    );

    await conforms(200, await send(`${t}/feedback`, 'kari'), 'get', '/tenants/{tenant}/feedback');
    await conforms(200, await send(`${t}/eval-runs`, 'kari'), 'get', '/tenants/{tenant}/eval-runs');
    await conforms(
      404,
      await send(`${t}/eval-runs/ukjent`, 'kari'),
      'get',
      '/tenants/{tenant}/eval-runs/{runId}',
    );
    await conforms(404, await send('/eval-tasks/ukjent', 'kari'), 'get', '/eval-tasks/{task}');
    await conforms(404, await send('/eval-runs/ukjent', 'kari'), 'get', '/eval-runs/{id}');
    await conforms(
      404,
      await send('/tasks/ukjent/feedback', 'kari', { body: { rating: 'up' } }),
      'post',
      '/tasks/{task}/feedback',
    );
  });

  it('gives gate, guardrail rule and hook responses that match their schemas', async () => {
    const { send } = await bootPlatform({ people });
    const t = `/tenants/${digdir}`;
    const reason = 'Strengere krav til svar';

    await conforms(
      200,
      await send(`${t}/gates/hjelpsom`, 'kari', {
        method: 'PUT',
        body: { metric: 'judge.overall', kind: 'threshold', threshold: 0.8 },
        reason,
      }),
      'put',
      '/tenants/{tenant}/gates/{id}',
    );
    await conforms(200, await send(`${t}/gates`, 'kari'), 'get', '/tenants/{tenant}/gates');
    await conforms(
      200,
      await send(`${t}/gates/hjelpsom/versions`, 'kari'),
      'get',
      '/tenants/{tenant}/gates/{id}/versions',
    );
    await conforms(
      200,
      await send(`${t}/gates/hjelpsom`, 'kari', { method: 'DELETE', reason }),
      'delete',
      '/tenants/{tenant}/gates/{id}',
    );
    await conforms(
      200,
      await send(`${t}/guardrail-rules/navn`, 'kari', {
        method: 'PUT',
        body: { kind: 'denylist', terms: ['hemmelig'] },
        reason,
      }),
      'put',
      '/tenants/{tenant}/guardrail-rules/{id}',
    );
    await conforms(
      200,
      await send(`${t}/guardrail-rules`, 'kari'),
      'get',
      '/tenants/{tenant}/guardrail-rules',
    );
    await conforms(
      200,
      await send('/operator/guardrail-rules/streng', 'drift', {
        method: 'PUT',
        body: { kind: 'regex', pattern: '\\d{11}', mandatory: true },
        reason,
      }),
      'put',
      '/operator/guardrail-rules/{id}',
    );
    await conforms(
      200,
      await send('/operator/guardrail-rules/streng/versions', 'drift'),
      'get',
      '/operator/guardrail-rules/{id}/versions',
    );

    const hook = '/operator/hooks/stopp';
    await conforms(
      200,
      await send(hook, 'drift', {
        method: 'PUT',
        body: {
          name: 'Stopp',
          point: 'before_model',
          mode: 'enforce',
          handler: { kind: 'builtin', id: 'block-terms', config: { terms: ['Hei'] } },
        },
        reason,
      }),
      'put',
      '/operator/hooks/{id}',
    );
    await conforms(200, await send('/operator/hooks', 'drift'), 'get', '/operator/hooks');
    await conforms(
      200,
      await send(`${hook}/test`, 'drift', { method: 'POST' }),
      'post',
      '/operator/hooks/{id}/test',
    );
    await conforms(
      200,
      await send(hook, 'drift', { method: 'DELETE', reason }),
      'delete',
      '/operator/hooks/{id}',
    );
  });

  it('gives diagnostics and quality matrix responses that match their schemas', async () => {
    const { send, admin } = await bootPlatform({ people, services: ['svar'] });
    const t = `/tenants/${digdir}`;
    const opened = await admin.openSupportSession(
      people.drift as Principal,
      digdir,
      'Feilsøker svar-tjenesten',
      15,
    );
    const session = (opened as { value: { id: string } }).value.id;
    const headers = { 'support-session': session };

    await conforms(
      200,
      await send(`${t}/diagnostics/services/svar/resolution`, 'drift', { headers }),
      'get',
      '/tenants/{tenant}/diagnostics/services/{service}/resolution',
    );
    await conforms(
      404,
      await send(`${t}/diagnostics/tasks/ukjent/attribution`, 'drift', { headers }),
      'get',
      '/tenants/{tenant}/diagnostics/tasks/{task}/attribution',
    );
    await conforms(
      400,
      await send(`${t}/diagnostics/retrieve`, 'drift', { headers, body: { queries: [] } }),
      'post',
      '/tenants/{tenant}/diagnostics/retrieve',
    );
    await conforms(
      404,
      await send(`${t}/diagnostics/plan`, 'kari', { body: { service: 'svar', query: 'frist' } }),
      'post',
      '/tenants/{tenant}/diagnostics/plan',
    );

    await conforms(
      400,
      await send('/operator/quality/matrix/estimate', 'drift', {
        body: { model: 'fake/gpt', current: 'fake/gpt' },
      }),
      'post',
      '/operator/quality/matrix/estimate',
    );
    await conforms(
      404,
      await send('/operator/quality/matrix/runs/ukjent', 'drift'),
      'get',
      '/operator/quality/matrix/runs/{id}',
    );
    await conforms(
      200,
      await send('/operator/quality/labels', 'drift', {
        body: { item: 'run:case:0', judge: 'judge.rubric', judgeLabel: 'good', humanLabel: 'bad' },
        reason: 'Dommeren tok feil her',
      }),
      'post',
      '/operator/quality/labels',
    );
  });

  it('gives protocol and liveness responses that match their schemas', async () => {
    const { app, send } = await bootPlatform({ people, services: ['svar'] });

    await conforms(200, await app.request('/up'), 'get', '/up');
    await conforms(200, await app.request('/a2a'), 'get', '/a2a');
    await conforms(200, await send('/a2a', 'kari'), 'get', '/a2a');
    await conforms(404, await send('/a2a/ukjent', 'kari'), 'get', '/a2a/{agent}');
    await conforms(
      404,
      await send('/a2a/ukjent', 'kari', {
        body: { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } },
      }),
      'post',
      '/a2a/{agent}',
    );
    await conforms(405, await send('/api/mcp', 'kari'), 'get', '/api/mcp');
    await conforms(
      200,
      await send('/api/mcp', 'kari', {
        body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      }),
      'post',
      '/api/mcp',
    );
    await conforms(
      200,
      await send('/api/tools/openapi.json', 'kari'),
      'get',
      '/api/tools/openapi.json',
    );
    await conforms(
      404,
      await send('/api/tools/call/ukjent', 'kari', { body: { query: 'Hei' } }),
      'post',
      '/api/tools/call/{tool}',
    );
  });
});
