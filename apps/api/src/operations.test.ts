import { describe, expect, it } from 'vitest';
import type { Execution } from './ingestion.js';
import { elapsed, operationsOverview, type OperationsDeps } from './operations.js';

const now = new Date('2026-10-08T10:00:00Z');

const execution = (patch: Partial<Execution>): Execution => ({
  id: 'x',
  dataset: 'nettsider',
  pipeline: 'p1',
  pipelineVersion: 1,
  backend: 'index',
  status: 'succeeded',
  startedBy: 'operator:test:drift',
  startedAt: '2026-10-08T09:00:00Z',
  endedAt: '2026-10-08T09:10:00Z',
  ...patch,
});

const running = (patch: Partial<Execution>): Execution => {
  const started = execution({ ...patch, status: 'running' });
  delete started.endedAt;
  return started;
};

const deps = (patch: Partial<OperationsDeps> = {}): OperationsDeps => ({
  now: () => now,
  models: () => [
    { id: 'gpt-4o', endpoint: 'foundry-openai', enabled: true },
    { id: 'gpt-4', endpoint: 'foundry-openai', enabled: false },
    { id: 'claude', endpoint: 'foundry-claude', enabled: false },
  ],
  ingestion: () => ({ available: true }),
  pipelines: async () => [],
  tasks: async () => [],
  tenantNames: async () => new Map([['991825827', 'Digitaliseringsdirektoratet']]),
  ...patch,
});

describe('operations overview', () => {
  it('reports the parts of the platform from real state and leaves out numbers it does not have', async () => {
    const overview = await operationsOverview(deps());

    expect(overview.incidents).toEqual([]);
    expect(overview.components).toEqual([
      { name: 'API', status: 'normal' },
      {
        name: 'Modeller: foundry-claude',
        status: 'down',
        note: '0 av 1 modeller i bruk.',
      },
      {
        name: 'Modeller: foundry-openai',
        status: 'normal',
        note: '1 av 2 modeller i bruk.',
      },
      { name: 'Kjøringer', status: 'normal' },
      { name: 'Innlesing', status: 'normal' },
    ]);
    expect(overview.queue).toEqual([]);
    expect(overview.triggers).toEqual([]);
  });

  it('pings the database when it can and says it is down when the ping fails', async () => {
    const up = await operationsOverview(deps({ database: async () => undefined }));
    const down = await operationsOverview(
      deps({
        database: async () => {
          throw new Error('connection refused');
        },
      }),
    );

    expect(up.components.find((c) => c.name === 'Database')?.status).toBe('normal');
    expect(down.components.find((c) => c.name === 'Database')).toEqual({
      name: 'Database',
      status: 'down',
      note: 'Svarer ikke.',
    });
  });

  it('computes the error rate of the last hour from finished runs', async () => {
    const overview = await operationsOverview(
      deps({
        tasks: async () => [
          { task: 't1', tenant: '991825827', status: 'completed', at: '2026-10-08T09:30:00Z' },
          { task: 't2', tenant: '991825827', status: 'failed', at: '2026-10-08T09:40:00Z' },
          { task: 't3', tenant: '991825827', status: 'failed', at: '2026-10-08T07:00:00Z' },
          { task: 't4', tenant: '991825827', status: 'running', at: '2026-10-08T09:55:00Z' },
        ],
      }),
    );

    expect(overview.components.find((c) => c.name === 'Kjøringer')).toEqual({
      name: 'Kjøringer',
      status: 'down',
      errorRate: '50 %',
    });
    expect(overview.queueStats).toContainEqual({ label: 'Kjøringer som pågår', value: '1' });
  });

  it('marks ingestion as down with the reason when no backend can write', async () => {
    const overview = await operationsOverview(
      deps({ ingestion: () => ({ available: false, reason: 'no write key' }) }),
    );

    expect(overview.components.find((c) => c.name === 'Innlesing')).toEqual({
      name: 'Innlesing',
      status: 'down',
      note: 'no write key',
    });
  });

  it('queues running and recently failed ingestions, and lists scheduled pipelines whose last run failed', async () => {
    const overview = await operationsOverview(
      deps({
        pipelines: async () => [
          {
            tenant: '991825827',
            dataset: 'nettsider',
            pipeline: 'Nettsider',
            scheduled: true,
            executions: [
              execution({
                id: 'e3',
                status: 'failed',
                startedAt: '2026-10-08T03:00:00Z',
                endedAt: '2026-10-08T03:05:00Z',
                error: 'sitemap svarte 503',
              }),
              execution({
                id: 'e2',
                startedAt: '2026-10-07T03:00:00Z',
                endedAt: '2026-10-07T03:10:00Z',
              }),
            ],
          },
          {
            tenant: '889640782',
            dataset: 'rapporter',
            pipeline: 'Rapporter',
            scheduled: false,
            executions: [running({ id: 'e4', startedAt: '2026-10-08T09:48:00Z' })],
          },
        ],
      }),
    );

    expect(overview.queue).toEqual([
      {
        type: 'Innlesing',
        what: 'Rapporter · rapporter · 889640782',
        status: 'running',
        age: '12 min',
        at: '2026-10-08T09:48:00Z',
      },
      {
        type: 'Innlesing',
        what: 'Nettsider · nettsider · Digitaliseringsdirektoratet',
        status: 'failed',
        age: '6 t 55 min',
        at: '2026-10-08T03:05:00Z',
      },
    ]);
    expect(overview.queueStats).toEqual([
      { label: 'Innlesinger som kjører', value: '1' },
      { label: 'Innlesinger som feilet siste døgn', value: '1' },
      { label: 'Kjøringer som pågår', value: '0' },
      { label: 'Lengst kjørende innlesing', value: '12 min' },
    ]);
    expect(overview.triggers).toEqual([
      {
        tenant: 'Digitaliseringsdirektoratet',
        what: 'Planlagt innlesing: Nettsider · nettsider',
        error: 'sitemap svarte 503',
        failedAt: '2026-10-08T03:05:00Z',
        lastSuccess: '2026-10-07T03:10:00Z',
      },
    ]);
  });

  it('writes elapsed time in minutes and hours', () => {
    expect(elapsed(59_000)).toBe('0 min');
    expect(elapsed(3 * 60 * 60_000)).toBe('3 t');
    expect(elapsed(72 * 60_000)).toBe('1 t 12 min');
  });
});
