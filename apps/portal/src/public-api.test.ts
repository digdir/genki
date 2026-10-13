import { describe, expect, it } from 'vitest';
import { createApiClient } from './api';
import { curlFor } from './components/ApiCall';
import { API_BASE as referenceBase } from './data/api-reference';
import { API_BASE as integrationsBase } from './data/integrations';
import { publicApiBase } from './public-api';
import { API_BASE as sharedBase } from './screens/shared/code';

describe('public API base', () => {
  it('is the configured base everywhere code can be copied, never a placeholder host', () => {
    expect(publicApiBase).toBe('http://localhost:8080');
    expect([referenceBase, integrationsBase, sharedBase]).toEqual([
      publicApiBase,
      publicApiBase,
      publicApiBase,
    ]);
    const curl = curlFor({
      action: 'Hent',
      method: 'GET',
      path: '/tenants/999888777/datasets',
      right: 'Bruke tjenester',
    });
    expect(curl).toContain('"http://localhost:8080/tenants/999888777/datasets"');
    expect(curl).not.toContain('example.no');
  });
});

describe('definition paths', () => {
  it('reads services, step flows and skills from their own definitions path', async () => {
    const seen: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      seen.push(String(input));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };
    const api = createApiClient({ baseUrl: '', fetch, token: () => 'kari' });

    for (const kind of ['Service', 'StepFlow', 'Skill'] as const)
      await api.getDefinition('999888777', kind, 'klarsprak');

    expect(seen).toEqual([
      '/tenants/999888777/definitions/services/klarsprak',
      '/tenants/999888777/definitions/step-flows/klarsprak',
      '/tenants/999888777/definitions/skills/klarsprak',
    ]);
  });
});
