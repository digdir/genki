import { describe, expect, it, vi } from 'vitest';
import { buildTimeOf, createApp, databaseBusyType } from './app.js';

describe('api', () => {
  const app = createApp('test');

  it('answers 503 with a problem when the database pool has no free connection', async () => {
    const starved = createApp('test');
    starved.get('/starved', () => {
      throw new Error('timeout exceeded when trying to connect');
    });

    const res = await starved.request('/starved');

    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toMatchObject({ type: databaseBusyType, status: 503 });
  });

  it('still answers 500 for any other unhandled error', async () => {
    const failing = createApp('test');
    failing.get('/failing', () => {
      throw new Error('something else');
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await failing.request('/failing');
    quiet.mockRestore();

    expect(res.status).toBe(500);
  });

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

  it('health is degraded while a catalog entry is skipped, and still answers 200 so replicas stay ready', async () => {
    let skipped: string[] = ['dataset digdir/kudos'];
    const watched = createApp('abc', { catalogSkipped: () => skipped });

    const health = await watched.request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'degraded',
      catalog: { skipped: [{ kind: 'dataset', id: 'digdir/kudos' }] },
    });
    skipped = [];
    expect(await (await watched.request('/health')).json()).toMatchObject({
      status: 'ok',
      catalog: { skipped: [] },
    });
  });

  it('health names a skipped entry by kind and id, and never its reasons', async () => {
    const watched = createApp('abc', {
      catalogSkipped: () => [
        {
          kind: 'dataset',
          id: 'digdir/kudos',
          problems: [{ path: 'datasets', message: 'unknown endpoint kunnskapsserveren' }],
        },
      ],
    });

    const body = await (await watched.request('/health')).json();
    expect(body.catalog).toEqual({ skipped: [{ kind: 'dataset', id: 'digdir/kudos' }] });
  });

  it("health leaves an organisation's own skipped entry unnamed", async () => {
    const watched = createApp('abc', {
      catalogSkipped: () => ['dataset 312521172/hemmelig', 'knowledge-endpoint kunnskapsserveren'],
    });

    expect((await (await watched.request('/health')).json()).catalog).toEqual({
      skipped: [{ kind: 'dataset' }, { kind: 'knowledge-endpoint', id: 'kunnskapsserveren' }],
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
