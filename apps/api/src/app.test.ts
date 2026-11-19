import { describe, expect, it } from 'vitest';
import { buildTimeOf, createApp } from './app.js';

describe('api', () => {
  const app = createApp('test');

  it('answers health with its version', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: 'test', lockdown: false });
  });

  it('answers health with the build time when the build has one', async () => {
    const built = createApp('abc', { builtAt: '2026-11-17T08:00:00.000Z' });
    expect(await (await built.request('/health')).json()).toEqual({
      status: 'ok',
      version: 'abc',
      lockdown: false,
      builtAt: '2026-11-17T08:00:00.000Z',
    });
  });

  it('names the environment it runs in on health', async () => {
    const test = createApp('abc', { environment: 'genki-test' });

    expect(await (await test.request('/health')).json()).toMatchObject({
      environment: 'genki-test',
    });
  });

  it('health says degraded while model discovery has not succeeded, and ok once it has', async () => {
    let discovery = {
      state: 'retrying' as 'ok' | 'retrying',
      attempts: 2,
      lastError: 'foundry: 408',
      since: '2026-11-18T09:00:00.000Z',
    };
    const watched = createApp('abc', { modelDiscovery: () => discovery });

    const retrying = await watched.request('/health');
    expect(retrying.status).toBe(200);
    expect(await retrying.json()).toMatchObject({
      status: 'degraded',
      modelDiscovery: { state: 'retrying', attempts: 2, lastError: 'foundry: 408' },
    });
    discovery = { state: 'ok', attempts: 3 } as typeof discovery;
    expect(await (await watched.request('/health')).json()).toMatchObject({
      status: 'ok',
      modelDiscovery: { state: 'ok', attempts: 3 },
    });
  });

  it('health stays degraded and says failed once model discovery has given up', async () => {
    const gaveUp = createApp('abc', {
      modelDiscovery: () => ({ state: 'failed', attempts: 12, lastError: 'foundry: 408' }),
    });

    const health = await gaveUp.request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'degraded',
      modelDiscovery: { state: 'failed', attempts: 12 },
    });
  });

  it('reads the build time from the commit time in seconds and ignores anything else', () => {
    expect(buildTimeOf('1763366400')).toBe('2025-11-17T08:00:00.000Z');
    expect(buildTimeOf('')).toBeUndefined();
    expect(buildTimeOf(undefined)).toBeUndefined();
    expect(buildTimeOf('yesterday')).toBeUndefined();
  });

  it('publishes an OpenAPI document that lists health', async () => {
    const res = await app.request('/openapi.json');
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/health');
  });
});
