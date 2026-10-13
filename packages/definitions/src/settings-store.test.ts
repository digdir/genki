import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  InMemorySettingsStore,
  SettingsConflictError,
  SettingsRegistry,
  type SettingDefinition,
  type SettingsStore,
} from './index.js';

const digdir = '991825827';

const topK: SettingDefinition<number> = {
  key: 'search.topK',
  description: 'How many results a search returns',
  category: 'Søk',
  axis: 'service',
  sensitivity: 'normal',
  schema: z.number().int().min(1).max(200),
  default: 100,
  settableAt: ['platform', 'tenant', 'service', 'call'],
};
const temperature: SettingDefinition<number> = {
  ...topK,
  key: 'model.temperature',
  schema: z.number().min(0).max(2),
  default: 0.2,
};

describe('a settings registry backed by a store', () => {
  it('restores defaults, tenant values, pins and locks in a new registry', async () => {
    const store = new InMemorySettingsStore();
    const first = new SettingsRegistry([topK, temperature]);
    await first.attach(store);
    first.setDefault('search.topK', 50, 'operator:ola', 'færre treff');
    first.setTenant(digdir, 'search.topK', 20);
    first.pin(digdir, 'search.topK', 1);
    first.lock('model.temperature', 'fast verdi');
    await first.flush();

    const second = new SettingsRegistry([topK, temperature]);
    await second.attach(store);

    expect(second.defaultOf('search.topK')).toMatchObject({ version: 2, value: 50 });
    expect(second.changelog('search.topK')).toHaveLength(1);
    expect(second.tenant(digdir)).toEqual({
      values: { 'search.topK': 20 },
      pins: { 'search.topK': 1 },
    });
    expect(second.setTenant(digdir, 'model.temperature', 1).ok).toBe(false);
  });

  it('reports a failed write on flush', async () => {
    const failing: SettingsStore = {
      load: async () => ({ defaults: [], tenants: {}, tenantVersions: {}, locks: {} }),
      appendDefault: async () => undefined,
      saveTenant: async () => {
        throw new Error('database unavailable');
      },
      saveLock: async () => undefined,
    };
    const registry = new SettingsRegistry([topK]);
    await registry.attach(failing);
    registry.setTenant(digdir, 'search.topK', 20);

    await expect(registry.flush()).rejects.toThrow('database unavailable');
    await expect(registry.flush()).resolves.toBeUndefined();
  });

  it('reload replaces tenant values and locks with the stored snapshot, dropping ones removed elsewhere', async () => {
    const store = new InMemorySettingsStore();
    const here = new SettingsRegistry([topK, temperature]);
    const elsewhere = new SettingsRegistry([topK, temperature]);
    await here.attach(store);
    await elsewhere.attach(store);
    here.setTenant(digdir, 'search.topK', 20);
    here.setTenant('987654321', 'search.topK', 30);
    here.lock('model.temperature', 'fast verdi');
    await here.flush();
    await elsewhere.reload();

    elsewhere.setTenant(digdir, 'search.topK', null);
    elsewhere.unlock('model.temperature');
    elsewhere.setDefault('search.topK', 40, 'operator:ola', 'færre treff');
    await elsewhere.flush();
    await here.reload();

    expect(here.tenant(digdir)).toEqual({ values: {}, pins: {} });
    expect(here.tenant('987654321').values).toEqual({ 'search.topK': 30 });
    expect(here.setTenant(digdir, 'model.temperature', 1).ok).toBe(true);
    expect(here.defaultOf('search.topK')).toMatchObject({ version: 2, value: 40 });
  });

  it('reload waits for queued local writes before reading', async () => {
    const inner = new InMemorySettingsStore();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const store: SettingsStore = {
      load: async () => {
        calls.push('load');
        return inner.load();
      },
      appendDefault: (v) => inner.appendDefault(v),
      saveTenant: async (tenant, settings, expected) => {
        await gate;
        calls.push('save');
        return inner.saveTenant(tenant, settings, expected);
      },
      saveLock: (key, lock) => inner.saveLock(key, lock),
    };
    const registry = new SettingsRegistry([topK]);
    await registry.attach(store);
    calls.length = 0;

    registry.setTenant(digdir, 'search.topK', 20);
    const reloaded = registry.reload();
    release();
    await reloaded;

    expect(calls).toEqual(['save', 'load']);
    expect(registry.tenant(digdir).values).toEqual({ 'search.topK': 20 });
  });

  it('a stale tenant settings save fails on flush and the registry reloads the stored values', async () => {
    const store = new InMemorySettingsStore();
    const here = new SettingsRegistry([topK]);
    const elsewhere = new SettingsRegistry([topK]);
    await here.attach(store);
    await elsewhere.attach(store);
    elsewhere.setTenant(digdir, 'search.topK', 30);
    await elsewhere.flush();

    here.setTenant(digdir, 'search.topK', 20);

    await expect(here.flush()).rejects.toBeInstanceOf(SettingsConflictError);
    expect(here.tenant(digdir).values).toEqual({ 'search.topK': 30 });
    here.setTenant(digdir, 'search.topK', 25);
    await expect(here.flush()).resolves.toBeUndefined();
    expect((await store.load()).tenants[digdir]?.values).toEqual({ 'search.topK': 25 });
  });
});
