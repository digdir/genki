import { describe, expect, it } from 'vitest';
import { createApiClient } from './api';

const recorder = () => {
  const calls: { path: string; headers: Headers }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), headers: new Headers(init?.headers) });
    const body = { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return { calls, api: createApiClient({ baseUrl: '/api', fetch, token: () => 't' }) };
};

describe('console api', () => {
  it('asks once for a reason when several content calls to one organisation are refused together', async () => {
    const reasons = new Set<string>();
    const posted: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const path = String(input);
      if (path.endsWith('/content-reason')) {
        posted.push(path);
        reasons.add('991825827');
        return Response.json({ tenant: '991825827' }, { status: 201 });
      }
      if (!reasons.has('991825827'))
        return Response.json(
          { type: 'urn:genai:problem:content-reason-required', tenant: '991825827', status: 403 },
          { status: 403 },
        );
      return Response.json({ id: path });
    };
    const api = createApiClient({ baseUrl: '/api', fetch, token: () => 't' });
    let asked = 0;
    api.onContentReason(async (tenant) => {
      asked += 1;
      await api.giveContentReason(tenant, 'Feilsøker sak DIG-4420');
    });

    const [first, second] = await Promise.all([
      api.timeline('991825827', 'a'),
      api.timeline('991825827', 'b'),
    ]);

    expect(asked).toBe(1);
    expect(posted).toEqual(['/api/operator/tenants/991825827/content-reason']);
    expect([first, second]).toEqual([
      { id: '/api/tenants/991825827/tasks/a/timeline' },
      { id: '/api/tenants/991825827/tasks/b/timeline' },
    ]);
  });

  it('does not fetch usage for a plain tenant list', async () => {
    const { api, calls } = recorder();

    await api.listTenants();

    expect(calls.map((c) => c.path)).toEqual(['/api/operator/tenants']);
  });

  it('reuses fetched usage for the same tenants within a short time', async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const path = String(input);
      calls.push(path);
      const body = path.includes('/operator/usage')
        ? {
            data: [
              {
                orgNumber: '991825827',
                usage: { inputTokens: 1, outputTokens: 1, costMicroNok: 0 },
              },
            ],
          }
        : {
            data: [
              {
                orgNumber: '991825827',
                name: 'Digdir',
                status: 'active',
                services: 1,
                quotaUsedPercent: 0,
              },
            ],
          };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const api = createApiClient({ baseUrl: '/api', fetch, token: () => 't' });

    await api.listTenants(undefined, { usage: true });
    await api.listTenants(undefined, { usage: true });

    expect(calls.filter((c) => c.includes('/operator/usage'))).toHaveLength(1);
  });
});
