import { describe, expect, it } from 'vitest';
import { refusedAsArchived, serviceArchivedType } from './archived-services.js';
import { appendVersion } from './config-store.js';
import { serviceLifecycleKind } from './service-lifecycle.js';
import { bootPlatform, digdir, files, klarsprak, setup, testService } from './testkit.js';

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

  describe('import', () => {
    type Json = Record<string, unknown>;
    const twoServices = async () => {
      const archived = new Set<string>();
      const env = setup({
        lifecycle: async (tenant, service) => ({
          state: archived.has(`${tenant}/${service}`) ? 'archived' : 'active',
        }),
      });
      await env.publish('kari', klarsprak());
      await env.publish(
        'kari',
        klarsprak({ id: 'klartekst', variants: [{ id: 'default', publicName: 'klartekst' }] }),
      );
      const exported = (await (await env.send(`/tenants/${digdir}/export`, 'kari')).json()) as {
        definitions: { definition: Json; files: Json }[];
      };
      const changed = {
        ...exported,
        definitions: exported.definitions.map((d) => ({
          ...d,
          definition: {
            ...d.definition,
            spec: { ...(d.definition.spec as Json), purpose: 'Et nytt formål for tjenesten' },
          },
        })),
      };
      archived.add(`${digdir}/klarsprak`);
      return { ...env, changed };
    };

    it('import with overwrite refuses an archived service and imports nothing', async () => {
      const { send, store, changed } = await twoServices();

      const refused = await send(`/tenants/${digdir}/import?onConflict=overwrite`, 'kari', {
        body: changed,
        reason: 'henter inn en eksport',
      });

      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        type: serviceArchivedType,
        errors: [expect.objectContaining({ path: 'Service:klarsprak.lifecycle' })],
      });
      expect((await store.get('Service', digdir, 'klarsprak'))?.version).toBe(1);
      expect((await store.get('Service', digdir, 'klartekst'))?.version).toBe(1);
    });

    it('a dry run of the import names the archived service', async () => {
      const { send, changed } = await twoServices();

      const dry = await send(`/tenants/${digdir}/import?onConflict=overwrite&dryRun=true`, 'kari', {
        body: changed,
        reason: 'henter inn en eksport',
      });

      expect(dry.status).toBe(409);
      expect(((await dry.json()) as { type: string }).type).toBe(serviceArchivedType);
    });

    it('an import that skips conflicts leaves the archived service alone', async () => {
      const { send, store, changed } = await twoServices();

      const skipped = await send(`/tenants/${digdir}/import?onConflict=skip`, 'kari', {
        body: changed,
        reason: 'henter inn en eksport',
      });

      expect(skipped.status).toBe(200);
      expect((await store.get('Service', digdir, 'klarsprak'))?.version).toBe(1);
    });
  });

  it('every publish through the platform store refuses an archived service, whichever route calls it', async () => {
    const { platform, configEntries } = await bootPlatform({ services: ['arkivert'] });
    await appendVersion(configEntries, {
      kind: serviceLifecycleKind,
      scope: digdir,
      id: 'arkivert',
      spec: { state: 'archived' },
      deleted: false,
      by: 'employee:test:kari',
      reason: 'Erstattet av en annen tjeneste',
    });

    const result = await platform.definitions.publish(
      testService('arkivert'),
      'employee:test:kari',
      'ny versjon',
      files,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && refusedAsArchived(result.errors)).toBe(true);
  });
});
