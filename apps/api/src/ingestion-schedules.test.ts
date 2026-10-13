import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import {
  InMemoryExecutionStore,
  InMemoryIngestionBackend,
  IngestionService,
  type Pipeline,
} from './ingestion.js';

const tenant = '991825827';
const dataset = `${tenant}/sider`;
const target = { dataset, endpoint: `${tenant}/sok`, collections: {} };

const boot = (clock: { now: Date }, store = new InMemoryConfigEntryStore()) => {
  const backend = new InMemoryIngestionBackend(() => [{ key: 'a', text: 'Digdir har ansvar.' }]);
  const executions = new InMemoryExecutionStore();
  const service = new IngestionService({
    store,
    executions,
    backend,
    now: () => clock.now,
  });
  return { service, backend, executions, store };
};

const save = async (service: IngestionService, schedule: string) => {
  const saved = await service.save({
    scope: tenant,
    dataset,
    id: 'nettsider',
    spec: {
      name: 'Nettsidene',
      source: { kind: 'website', sitemap: 'https://www.digdir.no/sitemap.xml' },
      chunking: { minimumLength: 1 },
      schedule,
    },
    by: 'kari',
    reason: 'Test',
  });
  if (!saved.ok) throw new Error(JSON.stringify(saved.errors));
  return saved.value;
};

describe('scheduled ingestion', () => {
  it('runs a daily pipeline once a night and tells when it runs next', async () => {
    const clock = { now: new Date('2026-10-07T10:00:00Z') };
    const { service, backend } = boot(clock);
    const pipeline = await save(service, 'daily');

    expect(await service.nextRunAt(tenant, pipeline)).toBe('2026-10-08T01:00:00.000Z');
    expect(await service.runDue(() => target, 'platform')).toEqual([]);

    clock.now = new Date('2026-10-08T01:00:30Z');
    const fired = await service.runDue(() => target, 'platform');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ startedBy: 'platform:ingestion-schedule' });
    expect(backend.jobs[0]).toMatchObject({ tenant, target });
    expect(await service.runDue(() => target, 'platform')).toEqual([]);
    expect(await service.nextRunAt(tenant, pipeline)).toBe('2026-10-09T01:00:00.000Z');
  });

  it('runs a weekly pipeline on Monday night', async () => {
    const clock = { now: new Date('2026-10-07T10:00:00Z') };
    const { service } = boot(clock);
    const pipeline = await save(service, 'weekly');

    expect(await service.nextRunAt(tenant, pipeline)).toBe('2026-10-12T01:00:00.000Z');
  });

  it('has no next run without a schedule, or when the pipeline is turned off', async () => {
    const clock = { now: new Date('2026-10-07T10:00:00Z') };
    const { service } = boot(clock);
    const unscheduled = await save(service, 'none');
    expect(await service.nextRunAt(tenant, unscheduled)).toBeNull();
    const off: Pipeline = {
      ...unscheduled,
      spec: { ...unscheduled.spec, schedule: 'daily', enabled: false },
    };
    expect(await service.nextRunAt(tenant, off)).toBeNull();
  });

  it('lets only one instance run a given slot', async () => {
    const clock = { now: new Date('2026-10-07T10:00:00Z') };
    const store = new InMemoryConfigEntryStore();
    const first = boot(clock, store);
    const second = boot(clock, store);
    await save(first.service, 'daily');

    clock.now = new Date('2026-10-08T02:00:00Z');
    const runs = await Promise.all([
      first.service.runDue(() => target, 'platform'),
      second.service.runDue(() => target, 'platform'),
    ]);

    expect(runs.flat()).toHaveLength(1);
    expect(first.backend.jobs.length + second.backend.jobs.length).toBe(1);
  });

  it('records a refused scheduled run so the dataset shows why it did not run', async () => {
    const clock = { now: new Date('2026-10-07T10:00:00Z') };
    const { service, executions } = boot(clock);
    await save(service, 'daily');

    clock.now = new Date('2026-10-08T02:00:00Z');
    await service.runDue(() => undefined, 'platform');

    expect(await executions.list(dataset, 'nettsider')).toEqual([
      expect.objectContaining({ status: 'failed', error: 'the dataset is gone' }),
    ]);
  });
});
