import { describe, expect, it } from 'vitest';
import { serviceArchivedType } from './archived-services.js';
import { digdir, klarsprak, setup } from './testkit.js';

const archivedKlarsprak = async (tenant: string, service: string) => ({
  state: tenant === digdir && service === 'klarsprak' ? 'archived' : 'active',
});

describe('archived services', () => {
  it('refuses to publish a new version of an archived service', async () => {
    const { publish } = setup({ lifecycle: archivedKlarsprak });

    const refused = await publish('kari', klarsprak());

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ type: serviceArchivedType, status: 409 });
  });

  it('refuses every change under an archived service with a typed conflict', async () => {
    const { send } = setup({ lifecycle: archivedKlarsprak });

    for (const [method, path] of [
      ['PUT', `/tenants/${digdir}/services/klarsprak/draft`],
      ['POST', `/tenants/${digdir}/services/klarsprak/eval-runs`],
      ['POST', `/tenants/${digdir}/services/klarsprak/environments`],
      ['POST', `/tenants/${digdir}/services/klarsprak/api-keys`],
      ['DELETE', `/tenants/${digdir}/services/klarsprak/draft`],
    ] as const) {
      const res = await send(path, 'kari', { method, body: {}, reason: 'endrer tjenesten nå' });
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(((await res.json()) as { type: string }).type).toBe(serviceArchivedType);
    }
  });

  it('keeps reads and restoring open on an archived service', async () => {
    const { send } = setup({ lifecycle: archivedKlarsprak });

    const restore = await send(`/tenants/${digdir}/services/klarsprak/lifecycle`, 'kari', {
      method: 'PUT',
      body: { state: 'active' },
      reason: 'tar tjenesten i bruk igjen',
    });
    const read = await send(`/tenants/${digdir}/services/klarsprak/draft`, 'kari');

    expect(restore.status).not.toBe(409);
    expect(read.status).not.toBe(409);
  });

  it('tells nobody outside the organisation that a service is archived', async () => {
    const { send } = setup({ lifecycle: archivedKlarsprak });

    const res = await send(`/tenants/${digdir}/services/klarsprak/draft`, 'ola', {
      method: 'PUT',
      body: {},
      reason: 'endrer tjenesten nå',
    });
    const anonymous = await send(`/tenants/${digdir}/services/klarsprak/draft`, undefined, {
      method: 'PUT',
      body: {},
    });

    expect(res.status).not.toBe(409);
    expect(anonymous.status).not.toBe(409);
  });
});
