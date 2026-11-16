import { platformSettings } from '@genai/definitions';
import { describe, expect, it } from 'vitest';
import { digdir, other, setup } from './testkit.js';

type Json = Record<string, unknown>;
const body = async <T = Json>(res: Response) => (await res.json()) as T;
const operatorOnly = 'urn:genai:problem:operator-only-setting';
const typeOf = async (res: Response) => (await body<{ type?: string }>(res)).type;

const limits = [
  'assistant.dailyTokens',
  'usage.monthlyTokens',
  'batch.approvalLimitNok',
  'usage.tenantCallsPerMinute',
];

const bundleOf = (settings: { values?: Json; pins?: Record<string, number> }) => ({
  format: 'genai-tenant-export/v1',
  tenant: digdir,
  exportedAt: '2026-10-06T10:00:00.000Z',
  definitions: [],
  settings: { values: settings.values ?? {}, pins: settings.pins ?? {} },
});

const withPlatformSettings = () => setup({ settings: platformSettings });

const openSession = async (send: ReturnType<typeof setup>['send'], who = 'operator') =>
  (
    await body<{ id: string }>(
      await send('/support-sessions', who, {
        body: { tenant: other, reason: 'ny avtale om forbruk', minutes: 30 },
      }),
    )
  ).id;

describe('limits Digdir sets for an organisation', () => {
  it('marks exactly the usage limits as set only by operators at the tenant layer', () => {
    expect(
      platformSettings
        .filter((s) => s.operatorOnly)
        .map((s) => s.key)
        .sort(),
    ).toEqual([...limits].sort());
  });

  it.each(limits)(
    'refuses a tenant manager who sets, previews, removes or pins %s',
    async (key) => {
      const { send, settings } = withPlatformSettings();
      const session = await openSession(send);
      await send(`/tenants/${other}/settings/${key}`, 'operator', {
        method: 'PUT',
        body: { value: 1000 },
        reason: 'avtalt grense med Digdir',
        session,
      });

      const set = await send(`/tenants/${other}/settings/${key}`, 'ola', {
        method: 'PUT',
        body: { value: 999_999 },
        reason: 'vi trenger mer kapasitet',
      });
      const preview = await send(`/tenants/${other}/settings/${key}?dryRun=true`, 'ola', {
        method: 'PUT',
        body: { value: 999_999 },
        reason: 'vi trenger mer kapasitet',
      });
      const unset = await send(`/tenants/${other}/settings/${key}`, 'ola', {
        method: 'DELETE',
        reason: 'tilbake til standard',
      });
      const pin = await send(`/tenants/${other}/pins/${key}`, 'ola', {
        method: 'PUT',
        body: { version: 1 },
        reason: 'hold fast ved standarden',
      });

      expect([set.status, preview.status, unset.status, pin.status]).toEqual([403, 403, 403, 403]);
      expect(await Promise.all([set, preview, unset, pin].map(typeOf))).toEqual([
        operatorOnly,
        operatorOnly,
        operatorOnly,
        operatorOnly,
      ]);
      expect(settings.tenant(other)).toEqual({ values: { [key]: 1000 }, pins: {} });
    },
  );

  it.each(limits)('refuses a tenant manager who imports %s', async (key) => {
    const { send, settings } = withPlatformSettings();
    const bundle = bundleOf({ values: { [key]: 999_999 } });

    const dry = await send(`/tenants/${other}/import?dryRun=true`, 'ola', {
      body: bundle,
      reason: 'flytter oppsettet vårt',
    });
    const real = await send(`/tenants/${other}/import`, 'ola', {
      body: bundle,
      reason: 'flytter oppsettet vårt',
    });
    const pinned = await send(`/tenants/${other}/import`, 'ola', {
      body: bundleOf({ pins: { [key]: 1 } }),
      reason: 'flytter oppsettet vårt',
    });

    expect([dry.status, real.status, pinned.status]).toEqual([403, 403, 403]);
    expect((await body<{ type: string; errors: { path: string }[] }>(dry)).errors).toEqual([
      expect.objectContaining({ path: `settings.values.${key}` }),
    ]);
    expect(await Promise.all([real, pinned].map(typeOf))).toEqual([operatorOnly, operatorOnly]);
    expect(settings.tenant(other)).toEqual({ values: {}, pins: {} });
  });

  it('lets a tenant import a bundle that keeps a limit at the value Digdir set', async () => {
    const { send } = withPlatformSettings();
    const session = await openSession(send);
    await send(`/tenants/${other}/settings/usage.monthlyTokens`, 'operator', {
      method: 'PUT',
      body: { value: 1000 },
      reason: 'avtalt grense med Digdir',
      session,
    });
    const bundle = await body(await send(`/tenants/${other}/export`, 'ola'));

    const res = await send(`/tenants/${other}/import`, 'ola', {
      body: bundle,
      reason: 'gjenoppretter oppsettet',
    });

    expect(res.status).toBe(200);
  });

  it("lets an operator in a support session set and remove a limit, recorded as Digdir's change", async () => {
    const { send } = withPlatformSettings();
    const session = await openSession(send);

    const set = await send(`/tenants/${other}/settings/usage.monthlyTokens`, 'operator', {
      method: 'PUT',
      body: { value: 120_000_000 },
      reason: 'avtalt grense med Digdir',
      session,
    });
    const effective = await body<Record<string, Json>>(
      await send(`/tenants/${other}/settings/effective`, 'ola'),
    );
    const unset = await send(`/tenants/${other}/settings/usage.monthlyTokens`, 'operator', {
      method: 'DELETE',
      reason: 'avtalen er over',
      session,
    });

    expect([set.status, unset.status]).toEqual([200, 200]);
    expect(effective['usage.monthlyTokens']).toMatchObject({
      value: 120_000_000,
      source: 'tenant',
    });
    const audit = (
      await body<{ data: { action: string; actor: string; onBehalfOf?: string }[] }>(
        await send(`/tenants/${other}/audit`, 'ola'),
      )
    ).data;
    expect(audit.map((a) => [a.action, a.actor, a.onBehalfOf])).toEqual([
      ['platform.support.open', 'operator:test:drift', other],
      ['platform.setting.set', 'operator:test:drift', other],
      ['platform.setting.set', 'operator:test:drift', other],
    ]);
  });

  it('refuses an API key with the admin scope that sets a limit, though it may change other settings', async () => {
    const { send } = withPlatformSettings();

    const limit = await send(`/tenants/${other}/settings/usage.monthlyTokens`, 'other-admin-key', {
      method: 'PUT',
      body: { value: 999_999_999 },
      reason: 'vi trenger mer kapasitet',
    });
    const plain = await send(`/tenants/${other}/settings/assistant.enabled`, 'other-admin-key', {
      method: 'PUT',
      body: { value: false },
      reason: 'skrur av assistenten',
    });

    expect([limit.status, plain.status]).toEqual([403, 200]);
    expect(await typeOf(limit)).toBe(operatorOnly);
  });

  it('treats an operator without a support session as an employee who cannot change a limit', async () => {
    const { send } = withPlatformSettings();

    const limit = await send(
      `/tenants/${other}/settings/usage.monthlyTokens`,
      'operator-employed-at-other',
      { method: 'PUT', body: { value: 999_999_999 }, reason: 'vi trenger mer kapasitet' },
    );
    const plain = await send(
      `/tenants/${other}/settings/assistant.enabled`,
      'operator-employed-at-other',
      { method: 'PUT', body: { value: false }, reason: 'skrur av assistenten' },
    );

    expect([limit.status, plain.status]).toEqual([403, 200]);
    expect(await typeOf(limit)).toBe(operatorOnly);
  });

  it('refuses a limit change once the support session has expired', async () => {
    const { send, advance } = withPlatformSettings();
    const session = await openSession(send, 'operator-employed-at-other');
    const change = () =>
      send(`/tenants/${other}/settings/usage.monthlyTokens`, 'operator-employed-at-other', {
        method: 'PUT',
        body: { value: 120_000_000 },
        reason: 'avtalt grense med Digdir',
        session,
      });

    expect((await change()).status).toBe(200);
    advance(31);
    const expired = await change();

    expect(expired.status).toBe(403);
    expect(await typeOf(expired)).toBe(operatorOnly);
  });

  it('lets an operator in a support session import a limit', async () => {
    const { send, settings } = withPlatformSettings();
    const session = await openSession(send);

    const res = await send(`/tenants/${other}/import`, 'operator', {
      body: bundleOf({ values: { 'usage.monthlyTokens': 120_000_000 } }),
      reason: 'flytter avtalt grense',
      session,
    });

    expect(res.status).toBe(200);
    expect(settings.tenant(other).values).toEqual({ 'usage.monthlyTokens': 120_000_000 });
  });

  it('lets a tenant manager change a setting that is not a limit', async () => {
    const { send } = withPlatformSettings();

    const res = await send(`/tenants/${other}/settings/assistant.enabled`, 'ola', {
      method: 'PUT',
      body: { value: false },
      reason: 'skrur av assistenten',
    });

    expect(res.status).toBe(200);
  });

  it('tells clients which settings only Digdir sets for an organisation', async () => {
    const { send } = withPlatformSettings();

    const { data } = await body<{ data: { key: string; operatorOnly?: boolean }[] }>(
      await send('/settings', 'ola'),
    );

    expect(
      data
        .filter((s) => s.operatorOnly)
        .map((s) => s.key)
        .sort(),
    ).toEqual([...limits].sort());
  });
});
