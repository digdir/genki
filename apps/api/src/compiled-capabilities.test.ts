import { describe, expect, it } from 'vitest';
import type { CompiledCapability } from '@genai/definitions';
import { compiledCapabilityCache } from './compiled-capabilities.js';

const compiledAt = (version: number) =>
  ({ service: { tenant: '991825827', id: 'svar', version } }) as CompiledCapability;

const counting = () => {
  const state = { version: 1, compiles: 0 };
  const cache = compiledCapabilityCache(async () => {
    state.compiles++;
    return [compiledAt(state.version)];
  });
  return { state, cache };
};

describe('the compiled capability cache', () => {
  it('compiles once for any number of concurrent and later requests', async () => {
    const { state, cache } = counting();

    await Promise.all([cache.get(), cache.get(), cache.get()]);
    await cache.get();

    expect(state.compiles).toBe(1);
  });

  it('compiles the published services again after invalidate', async () => {
    const { state, cache } = counting();
    await cache.get();

    state.version = 2;
    cache.invalidate();

    expect((await cache.get()).map((c) => c.service.version)).toEqual([2]);
    expect(state.compiles).toBe(2);
  });

  it('never keeps a compile that started before invalidate', async () => {
    let release: () => void = () => undefined;
    let version = 1;
    const cache = compiledCapabilityCache(async () => {
      const seen = version;
      if (seen === 1) await new Promise<void>((resolve) => (release = resolve));
      return [compiledAt(seen)];
    });
    const stale = cache.get();
    version = 2;
    cache.invalidate();
    release();

    expect((await stale).map((c) => c.service.version)).toEqual([1]);
    expect((await cache.get()).map((c) => c.service.version)).toEqual([2]);
  });

  it('does not keep a failed compile', async () => {
    let fail = true;
    const cache = compiledCapabilityCache(async () => {
      if (fail) throw new Error('database unavailable');
      return [compiledAt(1)];
    });

    await expect(cache.get()).rejects.toThrow('database unavailable');
    fail = false;

    expect(await cache.get()).toHaveLength(1);
  });

  it('hands every caller its own list', async () => {
    const { cache } = counting();

    (await cache.get()).splice(0);

    expect(await cache.get()).toHaveLength(1);
  });
});
