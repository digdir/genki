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
  it('sends the held support session on tenant routes only', async () => {
    const { api, calls } = recorder();
    api.holdSupport('991825827', 'sess-1');

    await api.configList('/tenants/991825827/catalog');
    await api.configList('/operator/catalog/entries');

    expect(calls[0]?.headers.get('support-session')).toBe('sess-1');
    expect(calls[1]?.headers.get('support-session')).toBeNull();
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
