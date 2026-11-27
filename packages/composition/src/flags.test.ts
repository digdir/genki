import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryConfigEntryStore } from './config-store.js';
import { createFlags, envFlagsIn } from './flags.js';

const tenant = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };
const ingrid: Principal = { kind: 'employee', issuer: 'test', subject: 'ingrid', tenant };
const by = 'operator:test:drift';
const reason = 'Prøver funksjonen i laben';

describe('feature flag state', () => {
  it('is off by default', async () => {
    const flags = createFlags({ store: new InMemoryConfigEntryStore() });

    expect(await flags.on({ principal: kari, tenant }, 'blockStudio')).toBe(false);
  });

  it('lets a person override beat the tenant override', async () => {
    const flags = createFlags({ store: new InMemoryConfigEntryStore() });
    await flags.set({ tenant, key: 'blockStudio', on: true, by, reason });
    await flags.set({ tenant, key: 'blockStudio', person: kari, on: false, by, reason });

    expect(await flags.on({ principal: kari, tenant }, 'blockStudio')).toBe(false);
    expect(await flags.on({ principal: ingrid, tenant }, 'blockStudio')).toBe(true);
  });

  it('falls back to the tenant once a person clears their own choice', async () => {
    const flags = createFlags({ store: new InMemoryConfigEntryStore() });
    await flags.set({ tenant, key: 'blockStudio', on: true, by, reason });
    await flags.set({ tenant, key: 'blockStudio', person: kari, on: false, by, reason });
    await flags.set({ tenant, key: 'blockStudio', person: kari, on: null, by, reason });

    const [state] = await flags.states(tenant, kari);
    expect(state).toMatchObject({ on: true, source: 'tenant', person: null, tenant: true });
  });

  it('keeps one tenant’s choice out of another tenant', async () => {
    const flags = createFlags({ store: new InMemoryConfigEntryStore() });
    await flags.set({ tenant, key: 'blockStudio', on: true, by, reason });

    expect(await flags.on({ principal: kari, tenant: '999888777' }, 'blockStudio')).toBe(false);
  });

  it('turns a flag on from GENAI_FLAGS below any stored choice', async () => {
    const flags = createFlags({ store: new InMemoryConfigEntryStore(), envOn: ['blockStudio'] });
    await flags.set({ tenant, key: 'blockStudio', person: kari, on: false, by, reason });

    expect((await flags.states(tenant, ingrid))[0]).toMatchObject({ on: true, source: 'env' });
    expect(await flags.on({ principal: kari, tenant }, 'blockStudio')).toBe(false);
  });

  it('lets a tenant choice beat GENAI_FLAGS', async () => {
    const flags = createFlags({ store: new InMemoryConfigEntryStore(), envOn: ['blockStudio'] });
    await flags.set({ tenant, key: 'blockStudio', on: false, by, reason });

    expect((await flags.states(tenant, kari))[0]).toMatchObject({ on: false, source: 'tenant' });
  });

  it('stops applying an override once it expires, and keeps the row', async () => {
    let clock = new Date('2026-11-26T10:00:00Z');
    const flags = createFlags({ store: new InMemoryConfigEntryStore(), now: () => clock });
    await flags.set({
      tenant,
      key: 'blockStudio',
      on: true,
      by,
      reason,
      expiresAt: '2026-11-30T23:00:00Z',
    });

    expect(await flags.on({ principal: kari, tenant }, 'blockStudio')).toBe(true);
    clock = new Date('2026-12-01T00:00:00Z');
    expect(await flags.on({ principal: kari, tenant }, 'blockStudio')).toBe(false);
    expect(await flags.rows(tenant)).toMatchObject([{ expiresAt: '2026-11-30T23:00:00Z' }]);
  });

  it('lists only overrides that expire within the window and have not expired', async () => {
    const flags = createFlags({
      store: new InMemoryConfigEntryStore(),
      now: () => new Date('2026-11-26T10:00:00Z'),
    });
    const set = (person: Principal, expiresAt: string) =>
      flags.set({ tenant, key: 'blockStudio', person, on: true, by, reason, expiresAt });
    await set(kari, '2026-11-28T10:00:00Z');
    await set(ingrid, '2026-12-28T10:00:00Z');
    await set({ ...kari, subject: 'per' }, '2026-11-20T10:00:00Z');

    const soon = await flags.expiringWithin(7 * 86_400_000);

    expect(soon.map((r) => r.person?.subject)).toEqual(['kari']);
  });

  it('ignores GENAI_FLAGS outside dev mode, also on the test tier', () => {
    expect(envFlagsIn({ GENAI_FLAGS: 'blockStudio', GENAI_ENV: 'test' })).toEqual([]);
    expect(envFlagsIn({ GENAI_FLAGS: ' blockStudio ,', GENAI_DEV_MODE: 'true' })).toEqual([
      'blockStudio',
    ]);
  });
});
