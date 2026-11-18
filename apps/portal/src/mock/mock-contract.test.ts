import { describe, expect, it } from 'vitest';
import { mockFetch } from '../mock';

const reason = { 'change-reason': 'Prøver kontrakten i mocken' };
const call = async (path: string, init?: RequestInit) => {
  const response = await mockFetch()(`/api${path}`, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe('the mock follows the API contract', () => {
  it('gives every overview service its status, warnings and runs this week', async () => {
    const { body } = await call('/tenants/999888777/overview');
    const services = body.services as Record<string, unknown>[];
    expect(services.length).toBeGreaterThan(0);
    for (const service of services) {
      expect(service).toMatchObject({ status: expect.any(String), warnings: [] });
      expect(typeof service.runsThisWeek).toBe('number');
    }
  });

  it('names the organisations on /me', async () => {
    const { body } = await call('/me');
    expect(body.organisations).toContainEqual(
      expect.objectContaining({ orgNumber: '999888777', name: 'Testetaten' }),
    );
  });

  it('gives a failed run its failure reason', async () => {
    const { body } = await call('/tenants/999888777/tasks?status=failed');
    const rows = body.data as { failure?: { reason: string } }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.failure?.reason).toBeTruthy();
  });

  it('refuses an empty dataset description, like the API', async () => {
    const { status } = await call('/tenants/999888777/datasets/nettsider', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...reason },
      body: JSON.stringify({ description: '' }),
    });
    expect(status).toBe(400);
  });

  it('activates an approved tool change, so the tool is in use and no longer waiting', async () => {
    const fetch = mockFetch();
    const approved = await fetch('/api/tenants/999888777/tool-connections/arkiv/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...reason },
      body: JSON.stringify({ tool: 'arkiv.sok' }),
    });
    expect(approved.status).toBe(200);
    const view = (await (await fetch('/api/tenants/999888777/integrations')).json()) as {
      connections: {
        id: string;
        tools: { name: string; description: string }[];
        pending: unknown[];
      }[];
    };
    const arkiv = view.connections.find((c) => c.id === 'arkiv');
    expect(arkiv?.pending).toEqual([]);
    expect(arkiv?.tools).toContainEqual({
      name: 'arkiv.sok',
      description: 'Søk i saksarkivet, nå med datofilter',
    });
  });

  it('names the person who paused a service', async () => {
    const fetch = mockFetch();
    await fetch('/api/tenants/999888777/services/rapportassistenten/lifecycle', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...reason },
      body: JSON.stringify({ state: 'paused' }),
    });
    const lifecycle = (await (
      await fetch('/api/tenants/999888777/services/rapportassistenten/lifecycle')
    ).json()) as { by?: string; byName?: string };
    expect(lifecycle).toMatchObject({ by: 'employee:ansattporten:kari', byName: 'Kari Nordmann' });
  });

  it('names the environment on /health and lists past incidents on the status', async () => {
    expect((await call('/health')).body).toMatchObject({ environment: 'genki-test' });
    const { body } = await call('/tenants/999888777/status');
    expect((body.pastIncidents as unknown[]).length).toBeGreaterThan(0);
    expect((body.pastIncidents as Record<string, unknown>[])[0]).toMatchObject({
      date: expect.any(String),
      title: expect.any(String),
      text: expect.any(String),
    });
  });
});
