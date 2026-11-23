import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@genai/contracts';
import { inMemoryDiscoveredModels } from '@genai/port-model';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { InMemoryConfigEntryStore } from './config-store.js';
import { bootPlatform, readJson } from './testkit.js';

const people: Record<string, Principal> = {
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

const servers: FakeServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const gateway = async () => {
  const server = await fakeHttp((_body, _attempt, path) =>
    path === '/v1/models'
      ? {
          status: 200,
          json: {
            object: 'list',
            data: [{ id: 'aivar:borealis' }, { id: 'sigma2:normistral' }, { id: 'other:x' }],
          },
        }
      : { status: 404, json: {} },
  );
  servers.push(server);
  return server;
};

const addedThroughApi = async (baseURL: string) => {
  const store = new InMemoryConfigEntryStore();
  await store.append({
    kind: 'model-endpoint',
    scope: 'platform',
    id: 'ai-gateway',
    version: 1,
    spec: {
      baseURL,
      families: { openai: '' },
      gateway: true,
      auth: {
        kind: 'federated-app',
        clientId: '334f8fa1-437e-4b84-bceb-f320fb60f3ed',
        tenant: '11111111-2222-3333-4444-555555555555',
        scope: 'api://gateway/.default',
      },
      discovery: [{ source: 'openai-models', include: ['aivar:*', 'sigma2:*'] }],
    },
    deleted: false,
    by: 'drift',
    at: '2026-11-20T08:00:00.000Z',
    reason: 'AI-gatewayen',
  });
  return store;
};

const modelIds = async (send: Awaited<ReturnType<typeof bootPlatform>>['send']) =>
  (await readJson<{ data: { id: string }[] }>(await send('/operator/models', 'drift'))).data
    .map((m) => m.id)
    .filter((id) => id.startsWith('ai-gateway/'))
    .sort();

describe('model discovery at startup', () => {
  it('models on a connection added through the operator API are discovered at startup', async () => {
    const server = await gateway();
    const { send, platform } = await bootPlatform({
      people,
      models: { endpoints: {}, models: [] },
      configEntries: await addedThroughApi(`${server.url}/v1`),
      federatedTokens: () => async () => 'federated-token',
    });

    expect(await modelIds(send)).toEqual([
      'ai-gateway/aivar-borealis',
      'ai-gateway/sigma2-normistral',
    ]);
    expect(platform.modelDiscovery.state()).toMatchObject({ state: 'ok' });
  });

  it('a connection whose discovery fails at startup is named in the state and the log, and retried', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const server = await gateway();
    const warnings: string[] = [];
    let signIns = 0;
    const { send, platform } = await bootPlatform({
      people,
      models: { endpoints: {}, models: [] },
      configEntries: await addedThroughApi(`${server.url}/v1`),
      federatedTokens: () => async () => {
        signIns += 1;
        if (signIns === 1) throw new Error('federated sign-in is not ready');
        return 'federated-token';
      },
      onWarning: (message) => warnings.push(message),
    });

    const failed = platform.modelDiscovery.state();
    const before = await modelIds(send);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(failed).toMatchObject({
      state: 'retrying',
      lastError: expect.stringContaining('ai-gateway: federated sign-in is not ready'),
    });
    expect(warnings).toContainEqual(
      expect.stringContaining('model discovery failed for ai-gateway'),
    );
    expect(before).toEqual([]);
    await vi.waitFor(() =>
      expect(platform.modelDiscovery.state()).toMatchObject({ state: 'ok', attempts: 2 }),
    );
    expect(await modelIds(send)).toEqual([
      'ai-gateway/aivar-borealis',
      'ai-gateway/sigma2-normistral',
    ]);
  });

  it('/health reports the discovered count per connection', async () => {
    const server = await gateway();
    const { send } = await bootPlatform({
      people,
      models: { endpoints: {}, models: [] },
      configEntries: await addedThroughApi(`${server.url}/v1`),
      federatedTokens: () => async () => 'federated-token',
    });

    const health = await readJson<{ modelDiscovery: { connections: unknown[] } }>(
      await send('/health', 'drift'),
    );

    expect(health.modelDiscovery.connections).toEqual([
      {
        connection: 'ai-gateway',
        source: 'openai-models',
        discovered: 2,
        listed: 3,
        listedAt: expect.any(String),
      },
    ]);
  });

  it('/health names the kind of a failed listing and never the URL or the error text', async () => {
    const server = await fakeHttp(() => ({ status: 401, json: { error: 'bad key k-123' } }));
    servers.push(server);
    const { send } = await bootPlatform({
      people,
      models: { endpoints: {}, models: [] },
      configEntries: await addedThroughApi(`${server.url}/v1`),
      federatedTokens: () => async () => 'federated-token',
    });

    const response = await send('/health', 'drift');
    const text = await response.text();

    expect(JSON.parse(text).modelDiscovery.connections).toEqual([
      {
        connection: 'ai-gateway',
        source: 'openai-models',
        discovered: 0,
        listed: 0,
        lastError: { kind: 'unauthorized', at: expect.any(String) },
      },
    ]);
    expect(text).not.toContain(server.url);
    expect(text).not.toContain('k-123');
  });

  const sharedReplicas = async () => {
    const server = await gateway();
    const discoveredModels = inMemoryDiscoveredModels();
    const boot = async () =>
      bootPlatform({
        people,
        models: { endpoints: {}, models: [] },
        configEntries: await addedThroughApi(`${server.url}/v1`),
        federatedTokens: () => async () => 'federated-token',
        discoveredModels,
      });
    const listings = () => server.seen.filter((r) => r.path === '/v1/models').length;
    return { boot, listings };
  };

  it('a replica booting within the interval serves the stored set without listing again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T10:00:00Z'));
    const { boot, listings } = await sharedReplicas();
    await boot();
    vi.setSystemTime(new Date('2026-11-21T10:29:00Z'));

    const second = await boot();

    expect(listings()).toBe(1);
    expect(await modelIds(second.send)).toEqual([
      'ai-gateway/aivar-borealis',
      'ai-gateway/sigma2-normistral',
    ]);
  });

  it('the scheduled re-list lists on one replica once the interval has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T10:00:00Z'));
    const { boot, listings } = await sharedReplicas();
    const replicas = [await boot(), await boot(), await boot()];
    vi.setSystemTime(new Date('2026-11-21T10:20:00Z'));
    await Promise.all(replicas.map((r) => r.platform.modelDiscovery.relistIfDue()));
    expect(listings()).toBe(1);

    vi.setSystemTime(new Date('2026-11-21T10:30:00Z'));
    await Promise.all(replicas.map((r) => r.platform.modelDiscovery.relistIfDue()));

    expect(listings()).toBe(2);
  });
});
