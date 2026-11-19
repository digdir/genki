import { describe, expect, it } from 'vitest';
import type { ApiContext } from '../api';
import { platformStatusApi } from './platform-status';

const withStatus = (body: unknown) =>
  platformStatusApi({
    get: async <T>() => body as T,
    request: async () => {
      throw new Error('not used');
    },
    tenantPath: (tenant: string) => `/tenants/${tenant}`,
  } as ApiContext);

describe('platformStatusApi.tenant', () => {
  it('passes the past incidents through from the API', async () => {
    const pastIncidents = [
      { date: '2026-09-22T07:40:00Z', title: 'Treg innlesing', text: 'Rettet.' },
    ];
    const status = await withStatus({ incidents: [], pastIncidents }).tenant('999888777');
    expect(status).toMatchObject({ pastIncidents });
  });

  it('leaves past incidents out when the API has none', async () => {
    const status = await withStatus({}).tenant('999888777');
    expect('pastIncidents' in status).toBe(false);
    expect(status.incidents).toEqual([]);
  });
});
