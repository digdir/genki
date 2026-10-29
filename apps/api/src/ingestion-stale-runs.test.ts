import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import {
  InMemoryExecutionStore,
  IngestionService,
  staleRunMessage,
  type Execution,
  type IngestionBackend,
} from './ingestion.js';

const tenant = '991825827';
const dataset = `${tenant}/sider`;
const target = { dataset, endpoint: `${tenant}/sok`, collections: {} };

const runsUntilCancelled: IngestionBackend = {
  name: 'test',
  available: true,
  run: (_job, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason as Error));
    }),
};

const instance = (executions: InMemoryExecutionStore) =>
  new IngestionService({
    store: new InMemoryConfigEntryStore(),
    executions,
    backend: runsUntilCancelled,
  });

const startRun = async (service: IngestionService) => {
  const saved = await service.save({
    scope: tenant,
    dataset,
    id: 'nettsider',
    spec: {
      name: 'Nettsidene',
      source: { kind: 'website', sitemap: 'https://www.digdir.no/sitemap.xml' },
      chunking: { minimumLength: 1 },
      schedule: 'none',
    },
    by: 'kari',
    reason: 'Test',
  });
  if (!saved.ok) throw new Error(JSON.stringify(saved.errors));
  const started = await service.execute({ pipeline: saved.value, target, by: 'kari' });
  if (!started.ok) throw new Error(JSON.stringify(started.errors));
  return started;
};

const platformOn = async (executions: InMemoryExecutionStore) => {
  const platform = await createPlatform({
    ingestionExecutions: executions,
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({}),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    configurables: {},
    authenticate: async () => undefined,
  });
  platform.mount(
    new Hono(),
    createAdmin({
      store: platform.definitions,
      plugins: platform.plugins,
      settings: new SettingsRegistry([]),
      extensions: platform.extensions,
    }),
  );
};

const running = (id: string, startedAt: string): Execution => ({
  id,
  dataset,
  pipeline: 'nettsider',
  pipelineVersion: 1,
  backend: 'test',
  status: 'running',
  startedBy: 'kari',
  startedAt,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stale ingestion runs', () => {
  it('a long run with a fresh heartbeat is kept, however long ago it started', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T01:00:00Z') });
    const executions = new InMemoryExecutionStore();
    const { value: run } = await startRun(instance(executions));

    await vi.advanceTimersByTimeAsync(7 * 3_600_000);
    const changed = await instance(executions).failStaleRuns();

    expect(changed).toBe(0);
    expect((await executions.get(run.id))?.status).toBe('running');
  });

  it('stops the heartbeat when the run ends', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T01:00:00Z') });
    const executions = new InMemoryExecutionStore();
    const beat = vi.spyOn(executions, 'beat');
    const service = instance(executions);
    const { value: run, done } = await startRun(service);
    await vi.advanceTimersByTimeAsync(30_000);

    service.cancel({ dataset, execution: run.id, by: 'kari' });
    await done;
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(beat).toHaveBeenCalledTimes(1);
  });

  it('checks for stale ingestion runs every minute, not only when the platform starts', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T08:00:00Z') });
    const executions = new InMemoryExecutionStore();
    await platformOn(executions);
    await vi.advanceTimersByTimeAsync(30_000);
    const stopped = running('stoppet', '2026-10-29T07:00:00.000Z');
    await executions.save(stopped);
    await executions.beat(stopped, '2026-10-29T08:00:30.000Z');

    await vi.advanceTimersByTimeAsync(150_000);

    expect(await executions.get(stopped.id)).toMatchObject({
      status: 'failed',
      endedAt: '2026-10-29T08:03:00.000Z',
      error: staleRunMessage,
    });
  });
});
