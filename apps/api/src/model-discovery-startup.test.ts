import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@genai/contracts';
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
});
