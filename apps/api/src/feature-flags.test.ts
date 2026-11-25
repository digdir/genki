import { describe, expect, it, vi } from 'vitest';
import { defaultPlatformTenant } from '@genai/composition';
import type { Principal } from '@genai/contracts';
import type { Env, Hono, Schema } from 'hono';
import { platformModules } from './composition.js';
import { requireFlag } from './feature-flags.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import { bootPlatform, digdir, other, readJson } from './testkit.js';

vi.mock('@genai/contracts/flags', async (importOriginal) => {
  const original = await importOriginal<typeof import('@genai/contracts/flags')>();
  const flags = {
    ...original.flags,
    platformTrial: {
      description: 'A platform-level switch only operators turn on',
      owner: 'the platform team',
      removeBy: '2027-01-31',
      selfService: false,
    },
  };
  return {
    ...original,
    flags,
    flagKeys: Object.keys(flags),
    isFlagKey: (value: unknown) => typeof value === 'string' && Object.hasOwn(flags, value),
  };
});

const resource = 'urn:altinn:resource:digdir-genai-platform';
const person = (subject: string, actions: string[], tenant = digdir): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  tenant,
  authorizedFor: [{ org: tenant, resource, actions }],
});

const people: Record<string, Principal> = {
  kari: person('kari', ['use-services', 'manage-services']),
  ingrid: person('ingrid', ['use-services']),
  operator: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir },
  vakt: { kind: 'operator', issuer: 'test', subject: 'vakt' },
};

const studioRoute: PlatformModuleFactory = () => ({
  id: 'studio-route',
  mount: <E extends Env, S extends Schema, B extends string>(
    app: Hono<E, S, B>,
    mounted: MountDeps,
  ) => {
    app.get('/tenants/:tenant/block-studio', requireFlag(mounted, 'blockStudio'), (c) =>
      c.json({ open: true }),
    );
    app.get('/operator/block-studio', requireFlag(mounted, 'blockStudio'), (c) =>
      c.json({ open: true }),
    );
  },
});

const boot = async () => {
  const booted = await bootPlatform({ people, modules: [...platformModules, studioRoute] });
  const put = (path: string, as: string, body: unknown, reason?: string) =>
    booted.send(path, as, { method: 'PUT', body, ...(reason ? { reason } : {}) });
  const mine = async (as: string, tenant = digdir) =>
    (
      await readJson<{ data: { key: string; on: boolean; source: string }[] }>(
        await booted.send(`/tenants/${tenant}/me/flags`, as),
      )
    ).data.find((f) => f.key === 'blockStudio');
  return { ...booted, put, mine };
};

const orgReason = 'Laben prøver ny utforming først';

describe('feature flags', () => {
  it('answers 404 like an unknown route while the flag is off for the caller', async () => {
    const { send } = await boot();

    const guarded = await send(`/tenants/${digdir}/block-studio`, 'kari');
    const unknown = await send(`/tenants/${digdir}/no-such-route`, 'kari');

    expect(guarded.status).toBe(404);
    expect(await guarded.json()).toEqual(await unknown.json());
  });

  it('lets the guarded route through once a tenant admin turns the flag on for the tenant', async () => {
    const { send, put } = await boot();

    const switched = await put(
      `/tenants/${digdir}/flags/blockStudio`,
      'kari',
      { on: true },
      orgReason,
    );

    expect(switched.status).toBe(200);
    expect((await send(`/tenants/${digdir}/block-studio`, 'ingrid')).status).toBe(200);
  });

  it('lets a person turn off for themselves a flag the tenant turned on, since the person wins', async () => {
    const { put, mine } = await boot();
    await put(`/tenants/${digdir}/flags/blockStudio`, 'kari', { on: true }, orgReason);

    await put(`/tenants/${digdir}/me/flags/blockStudio`, 'ingrid', { on: false });

    expect(await mine('ingrid')).toMatchObject({ on: false, source: 'person' });
    expect(await mine('kari')).toMatchObject({ on: true, source: 'tenant' });
  });

  it('changes only the caller’s own row when a person switches a flag for themselves', async () => {
    const { put, mine } = await boot();

    const switched = await put(`/tenants/${digdir}/me/flags/blockStudio`, 'ingrid', { on: true });

    expect(switched.status).toBe(200);
    expect(await mine('ingrid')).toMatchObject({ on: true, source: 'person' });
    expect(await mine('kari')).toMatchObject({ on: false, source: 'default' });
  });

  it('refuses a tenant switch to a member without manage-services', async () => {
    const { put, mine } = await boot();

    const refused = await put(
      `/tenants/${digdir}/flags/blockStudio`,
      'ingrid',
      { on: true },
      orgReason,
    );

    expect(refused.status).toBe(403);
    expect(await mine('kari')).toMatchObject({ on: false });
  });

  it('refuses a tenant switch for another tenant as if the tenant did not exist', async () => {
    const { put } = await boot();

    const refused = await put(
      `/tenants/${other}/flags/blockStudio`,
      'kari',
      { on: true },
      orgReason,
    );

    expect(refused.status).toBe(404);
  });

  it('refuses people and tenant admins a flag that is not self-service', async () => {
    const { put } = await boot();

    const self = await put(`/tenants/${digdir}/me/flags/platformTrial`, 'kari', { on: true });
    const tenant = await put(
      `/tenants/${digdir}/flags/platformTrial`,
      'kari',
      { on: true },
      orgReason,
    );

    expect(self.status).toBe(403);
    expect(await readJson<{ type: string }>(self)).toMatchObject({
      type: 'urn:genai:problem:flag-operator-only',
    });
    expect(tenant.status).toBe(403);
  });

  it('answers 404 for a flag key that is not registered', async () => {
    const { put } = await boot();

    expect(
      (await put(`/tenants/${digdir}/me/flags/blokkStudio`, 'kari', { on: true })).status,
    ).toBe(404);
  });

  it('requires a reason for a tenant switch and stores a default one for a personal switch', async () => {
    const { put, admin } = await boot();

    const noReason = await put(`/tenants/${digdir}/flags/blockStudio`, 'kari', { on: true });
    await put(`/tenants/${digdir}/me/flags/blockStudio`, 'ingrid', { on: true });

    expect(noReason.status).toBe(400);
    expect((await admin.audit(digdir)).at(-1)).toMatchObject({
      action: 'platform.flag.person',
      reason: 'Endret for meg selv under Nye funksjoner',
    });
  });

  it('writes every change to the audit log with who, the level and the reason', async () => {
    const { put, admin } = await boot();

    await put(`/tenants/${digdir}/flags/blockStudio`, 'kari', { on: true }, orgReason);
    await put(
      `/tenants/${digdir}/me/flags/blockStudio`,
      'ingrid',
      { on: false },
      'Jeg vil vente litt',
    );

    expect(await admin.audit(digdir)).toEqual([
      expect.objectContaining({
        action: 'platform.flag.tenant',
        actor: 'employee:test:kari',
        target: 'flag:blockStudio',
        reason: orgReason,
        outcome: 'applied',
      }),
      expect.objectContaining({
        action: 'platform.flag.person',
        actor: 'employee:test:ingrid',
        target: 'flag:blockStudio:person:test:ingrid',
        reason: 'Jeg vil vente litt',
        outcome: 'applied',
      }),
    ]);
  });

  it('lets an operator switch any flag for a tenant or one person, audited in that tenant', async () => {
    const { put, send, admin, mine } = await boot();
    const reason = 'Driften slår på for piloten';

    const forTenant = await put(
      '/operator/flags/platformTrial',
      'operator',
      { tenant: other, on: true },
      reason,
    );
    const forPerson = await put(
      '/operator/flags/blockStudio',
      'operator',
      { tenant: digdir, person: { issuer: 'test', subject: 'ingrid' }, on: true },
      reason,
    );
    const listed = await readJson<{ data: { key: string; rows: unknown[] }[] }>(
      await send('/operator/flags', 'operator'),
    );

    expect(forTenant.status).toBe(200);
    expect(forPerson.status).toBe(200);
    expect(await mine('ingrid')).toMatchObject({ on: true, source: 'person' });
    expect(listed.data.find((f) => f.key === 'platformTrial')?.rows).toEqual([
      expect.objectContaining({ tenant: other, on: true, by: 'operator:test:drift', reason }),
    ]);
    expect(await admin.audit(other)).toEqual([
      expect.objectContaining({ action: 'platform.flag.tenant', actor: 'operator:test:drift' }),
    ]);
  });

  it('refuses the operator flag routes to anyone who is not an operator', async () => {
    const { send, put } = await boot();

    expect((await send('/operator/flags', 'kari')).status).toBe(403);
    expect(
      (await put('/operator/flags/blockStudio', 'kari', { tenant: digdir, on: true }, orgReason))
        .status,
    ).toBe(403);
  });

  it('gives the signed-in person the flags of their own organisation on /me/flags', async () => {
    const { send, put } = await boot();
    await put(`/tenants/${digdir}/flags/blockStudio`, 'kari', { on: true }, orgReason);

    const found = await readJson<{ data: { key: string; on: boolean }[] }>(
      await send('/me/flags', 'ingrid'),
    );

    expect(found.data.find((f) => f.key === 'blockStudio')).toMatchObject({ on: true });
  });

  it('gives an operator without an organisation the flags of the platform tenant on /me/flags', async () => {
    const { send, put } = await boot();
    await put(
      '/operator/flags/platformTrial',
      'operator',
      { tenant: defaultPlatformTenant, on: true },
      'Driften prøver selv først',
    );

    const found = await readJson<{ data: { key: string; on: boolean }[] }>(
      await send('/me/flags', 'vakt'),
    );

    expect(found.data.find((f) => f.key === 'platformTrial')).toMatchObject({ on: true });
  });

  it('guards a route without a tenant by the platform tenant for an operator without one', async () => {
    const { send, put } = await boot();
    expect((await send('/operator/block-studio', 'vakt')).status).toBe(404);

    await put(
      '/operator/flags/blockStudio',
      'operator',
      { tenant: defaultPlatformTenant, on: true },
      'Driften prøver selv først',
    );

    expect((await send('/operator/block-studio', 'vakt')).status).toBe(200);
  });

  it('keeps both of two changes to the same flag sent at once', async () => {
    const { put, admin } = await boot();

    const answers = await Promise.all([
      put(`/tenants/${digdir}/me/flags/blockStudio`, 'ingrid', { on: true }),
      put(`/tenants/${digdir}/me/flags/blockStudio`, 'ingrid', { on: false }),
    ]);

    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect(await admin.audit(digdir)).toHaveLength(2);
  });
});
