import {
  InMemoryJobQueue,
  knowledgeBuildQueue,
  knowledgeCheckQueue,
  knowledgeFillQueue,
  queueWork,
  type Job,
  type JobData,
  type QueueDefinition,
} from '@genai/jobs';
import type { DatasetConfig } from '@genai/port-knowledge';
import { describe, expect, it, vi } from 'vitest';
import {
  buildWork,
  checkWork,
  finishRun,
  heavyWindow,
  recallMargin,
  recallQueries,
  runVacuum,
  type HeavyDeps,
  type HeavyServer,
} from './heavy-work.js';

// November: Oslo is UTC+1, so the default window 01:00-06:00 is 00:00-05:00 UTC.
const day = new Date('2026-11-03T13:00:00Z');
const night = new Date('2026-11-04T01:30:00Z');
const nextStart = '2026-11-04T00:00:00.000Z';

const dataset: DatasetConfig = {
  id: '991825827/docs',
  filters: {},
  options: {},
  generation: 'g-docs-1',
  embedding: { model: 'fake/embed', dimensions: 8 },
};

const server = (overrides: Partial<HeavyServer> = {}): HeavyServer => ({
  state: vi.fn(async () => 'attached' as const),
  chunks: vi.fn(async () => 10),
  vacuum: vi.fn(async () => undefined),
  build: vi.fn(async () => undefined),
  reindex: vi.fn(async () => undefined),
  prewarm: vi.fn(async () => 1),
  toFreeze: vi.fn(async () => []),
  progress: vi.fn(async () => ({ phase: 'building index', blocks: '10/40' })),
  cancel: vi.fn(async () => undefined),
  recall: vi.fn(async () => ({ recall: 0.995, queries: 200 })),
  baseline: vi.fn(async (_g: string, measured: number) => measured),
  datasetOf: vi.fn(async () => dataset.id),
  ...overrides,
});

interface Sent {
  queue: string;
  data: JobData;
  startAfter?: Date;
}

const deps = (overrides: Partial<HeavyDeps> = {}, at = day) => {
  const sent: Sent[] = [];
  const worked: string[] = [];
  const stopped: string[] = [];
  const retimed: { queues: string[]; startAfter: Date }[] = [];
  const scheduled: { queue: string; cron: string; tz: string }[] = [];
  const d: HeavyDeps = {
    server: server(),
    queue: {
      send: async (queue: QueueDefinition, data: JobData, options = {}) => {
        sent.push({
          queue: queue.name,
          data,
          ...(options.startAfter ? { startAfter: options.startAfter } : {}),
        });
        return 'job';
      },
      work: async (queue: QueueDefinition) => {
        worked.push(queue.name);
        return async () => {
          stopped.push(queue.name);
        };
      },
      retime: async (queues: QueueDefinition[], startAfter: Date) => {
        retimed.push({ queues: queues.map((q) => q.name), startAfter });
        return 0;
      },
      schedule: async (queue: QueueDefinition, cron: string, _data, options) => {
        scheduled.push({ queue: queue.name, cron, tz: options.tz });
      },
    } as HeavyDeps['queue'],
    window: () => '01:00-06:00',
    threshold: () => 100,
    datasets: () => [dataset],
    now: () => at,
    log: () => undefined,
    ...overrides,
  };
  return { deps: d, sent, worked, stopped, retimed, scheduled };
};

const job = <T extends JobData>(queue: QueueDefinition<T>, data: T): Job<T> => ({
  id: crypto.randomUUID(),
  queue: queue.name,
  data,
  retryCount: 0,
  signal: new AbortController().signal,
});

const noop = (queue: QueueDefinition) => queueWork(queue, async () => undefined);

describe('heavy work waits for the night window', () => {
  it('a heavy job does not start outside the night window', async () => {
    const t = deps({ server: server({ chunks: vi.fn(async () => 500) }) });
    expect(await runVacuum(t.deps, { id: 'run-1', dataset: dataset.id }, 'g-docs-1')).toBe('sent');
    expect(t.sent).toEqual([
      {
        queue: 'knowledge.build',
        data: { tenant: '991825827', generation: 'g-docs-1', kind: 'vacuum', run: 'run-1' },
        startAfter: new Date(nextStart),
      },
    ]);
    const window = heavyWindow(t.deps, {
      build: noop(knowledgeBuildQueue),
      fill: noop(knowledgeFillQueue),
    });
    await window.tick();
    expect(t.worked).toEqual([]);
  });

  it('work above the heavy threshold waits for the window and work below it does not', async () => {
    const below = deps({ server: server({ chunks: vi.fn(async () => 100) }) });
    expect(await runVacuum(below.deps, { id: 'run-1', dataset: dataset.id }, 'g-docs-1')).toBe(
      'done',
    );
    expect(below.deps.server.vacuum).toHaveBeenCalledWith(
      'g-docs-1',
      expect.objectContaining({ analyze: true }),
    );
    expect(below.sent).toEqual([]);
    const above = deps({ server: server({ chunks: vi.fn(async () => 101) }) });
    expect(await runVacuum(above.deps, { id: 'run-1', dataset: dataset.id }, 'g-docs-1')).toBe(
      'sent',
    );
    expect(above.deps.server.vacuum).not.toHaveBeenCalled();
  });

  it('VACUUM outside the window is throttled', async () => {
    const byDay = deps();
    await runVacuum(byDay.deps, { id: 'run-1', dataset: dataset.id }, 'g-docs-1');
    expect(byDay.deps.server.vacuum).toHaveBeenCalledWith(
      'g-docs-1',
      expect.objectContaining({ throttled: true }),
    );
    const byNight = deps({}, night);
    await runVacuum(byNight.deps, { id: 'run-1', dataset: dataset.id }, 'g-docs-1');
    expect(byNight.deps.server.vacuum).toHaveBeenCalledWith(
      'g-docs-1',
      expect.objectContaining({ throttled: false }),
    );
  });

  it('with the night window set to always, heavy jobs start at once', async () => {
    const t = deps({ window: () => 'always', server: server({ chunks: vi.fn(async () => 500) }) });
    await runVacuum(t.deps, { id: 'run-1', dataset: dataset.id }, 'g-docs-1');
    expect(t.sent[0]?.startAfter).toEqual(day);
    const window = heavyWindow(t.deps, {
      build: noop(knowledgeBuildQueue),
      fill: noop(knowledgeFillQueue),
    });
    await window.tick();
    expect(t.worked).toEqual(['knowledge.build', 'knowledge.fill']);
  });

  it('a change of the night window moves waiting heavy jobs to its next start', async () => {
    let setting = '01:00-06:00';
    const t = deps({ window: () => setting });
    const window = heavyWindow(t.deps, {
      build: noop(knowledgeBuildQueue),
      fill: noop(knowledgeFillQueue),
    });
    await window.tick();
    await window.tick();
    setting = 'always';
    await window.tick();
    expect(t.retimed).toEqual([
      { queues: ['knowledge.build', 'knowledge.fill'], startAfter: new Date(nextStart) },
      { queues: ['knowledge.build', 'knowledge.fill'], startAfter: day },
    ]);
  });

  it("the worker stops taking heavy jobs at the window's end", async () => {
    let at = night;
    const t = deps({ now: () => at });
    const window = heavyWindow(t.deps, {
      build: noop(knowledgeBuildQueue),
      fill: noop(knowledgeFillQueue),
    });
    await window.tick();
    expect(t.worked).toEqual(['knowledge.build', 'knowledge.fill']);
    at = new Date('2026-11-04T05:00:00Z');
    await window.tick();
    expect(t.stopped).toEqual(['knowledge.build', 'knowledge.fill']);
    await window.tick();
    expect(t.worked).toHaveLength(2);
  });

  it('schedules the nightly checks at the window start in Europe/Oslo', async () => {
    const t = deps({ window: () => '22:30-04:00' });
    await heavyWindow(t.deps, {
      build: noop(knowledgeBuildQueue),
      fill: noop(knowledgeFillQueue),
    }).tick();
    expect(t.scheduled).toEqual([
      { queue: knowledgeCheckQueue.name, cron: '30 22 * * *', tz: 'Europe/Oslo' },
    ]);
  });
});

describe("a run's end", () => {
  const run = { id: 'run-1', dataset: dataset.id } as Parameters<ReturnType<typeof finishRun>>[0];

  it('a heavy run sends its VACUUM once, then ends when that job has', async () => {
    const reports: Record<string, number>[] = [];
    const t = deps({ server: server({ chunks: vi.fn(async () => 500) }) });
    const finish = finishRun(t.deps, async (_id, counts) => {
      reports.push(counts);
    });
    expect(await finish(run)).toBe(false);
    expect(reports).toEqual([{ vacuumSent: 1 }]);
    expect(
      await finish({ ...run, report: { stored: 1, skipped: 0, failed: [], vacuumSent: 1 } }),
    ).toBe(true);
    expect(t.sent).toHaveLength(1);
  });

  it('a run of a dataset with no generation on the server ends without a VACUUM', async () => {
    const t = deps({ datasets: () => [] });
    expect(await finishRun(t.deps, async () => undefined)(run)).toBe(true);
    expect(t.deps.server.vacuum).not.toHaveBeenCalled();
  });

  it('a run whose VACUUM fails stays open for the next pass', async () => {
    const t = deps({
      server: server({ vacuum: vi.fn(async () => Promise.reject(new Error('connection reset'))) }),
    });
    expect(await finishRun(t.deps, async () => undefined)(run)).toBe(false);
    const gone = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const dropped = deps({ server: server({ chunks: vi.fn(async () => Promise.reject(gone)) }) });
    expect(await finishRun(dropped.deps, async () => undefined)(run)).toBe(true);
  });

  it('a cancelled run ends without building its standalone generation', async () => {
    const cancelled = {
      ...run,
      generation: 'g-20261104-7f3c2a',
      engineSwitch: 'docs:1',
      cancelRequestedAt: '2026-11-04T10:00:00Z',
    };
    const standalone = deps({
      server: server({ state: vi.fn(async () => 'standalone' as const) }),
    });
    expect(await finishRun(standalone.deps, async () => undefined)(cancelled)).toBe(true);
    expect(standalone.deps.server.build).not.toHaveBeenCalled();
    expect(standalone.sent).toEqual([]);
  });

  it('a run on a standalone generation ends by building and attaching it, as a build job above the heavy threshold', async () => {
    const switched: DatasetConfig = { ...dataset, generation: 'g-20261104-7f3c2a' };
    const own = { ...run, generation: 'g-20261104-7f3c2a', engineSwitch: 'docs:1' };
    // At or below the threshold: built and attached at once, then its VACUUM (ANALYZE).
    const small = deps({
      server: server({ state: vi.fn(async () => 'standalone' as const) }),
      datasetOfGeneration: async (g) => (g === switched.generation ? switched : undefined),
    });
    expect(await finishRun(small.deps, async () => undefined)(own)).toBe(true);
    expect(small.deps.server.build).toHaveBeenCalledWith(
      expect.objectContaining({ id: dataset.id }),
      'g-20261104-7f3c2a',
      expect.anything(),
    );
    expect(small.deps.server.vacuum).toHaveBeenCalledWith(
      'g-20261104-7f3c2a',
      expect.objectContaining({ analyze: true }),
    );
    expect(small.sent).toEqual([]);
    // Above it: a build job that names the run, which stays open until the job has ended.
    const reports: Record<string, number>[] = [];
    const large = deps({
      server: server({
        state: vi.fn(async () => 'standalone' as const),
        chunks: vi.fn(async () => 500),
      }),
      datasetOfGeneration: async () => switched,
    });
    expect(
      await finishRun(large.deps, async (_id, counts) => {
        reports.push(counts);
      })(own),
    ).toBe(false);
    expect(large.sent).toEqual([
      {
        queue: 'knowledge.build',
        data: { tenant: '991825827', generation: 'g-20261104-7f3c2a', kind: 'index', run: 'run-1' },
        startAfter: new Date(nextStart),
      },
    ]);
    expect(reports).toEqual([{ buildSent: 1 }]);
    expect(large.deps.server.build).not.toHaveBeenCalled();
    // The build job attached it: the run ends.
    const built = deps({ server: server({ state: vi.fn(async () => 'attached' as const) }) });
    expect(
      await finishRun(
        built.deps,
        async () => undefined,
      )({
        ...own,
        report: { stored: 1, skipped: 0, failed: [], buildSent: 1 },
      }),
    ).toBe(true);
    expect(built.deps.server.vacuum).not.toHaveBeenCalled();
  });

  it("a run on an attached generation vacuums that generation, not the dataset's active one", async () => {
    const t = deps();
    expect(
      await finishRun(t.deps, async () => undefined)({ ...run, generation: 'g-20261104-7f3c2a' }),
    ).toBe(true);
    expect(t.deps.server.vacuum).toHaveBeenCalledTimes(1);
    expect(t.deps.server.vacuum).toHaveBeenCalledWith(
      'g-20261104-7f3c2a',
      expect.objectContaining({ analyze: true }),
    );
  });

  it('a VACUUM that waited too long for the lock is tried again on the next pass', async () => {
    const busy = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    const t = deps({ server: server({ vacuum: vi.fn(async () => Promise.reject(busy)) }) });
    expect(await finishRun(t.deps, async () => undefined)(run)).toBe(false);
  });
});

describe('knowledge.build', () => {
  it("a build runs with the server's vCores minus one maintenance workers", async () => {
    const t = deps({ vcores: 4 }, night);
    await buildWork(t.deps).handler(
      job(knowledgeBuildQueue, { tenant: '991825827', generation: 'g-docs-2', kind: 'index' }),
    );
    expect(t.deps.server.build).toHaveBeenCalledWith(
      expect.objectContaining({ id: dataset.id }),
      'g-docs-2',
      expect.objectContaining({ maintenanceWorkers: 3 }),
    );
    const unset = deps({}, night);
    await buildWork(unset.deps).handler(
      job(knowledgeBuildQueue, { tenant: '991825827', generation: 'g-docs-2', kind: 'reindex' }),
    );
    expect(unset.deps.server.reindex).toHaveBeenCalledWith(
      'g-docs-2',
      expect.not.objectContaining({ maintenanceWorkers: expect.anything() }),
    );
  });

  it('an index build that ends a run vacuums the generation it attached', async () => {
    const t = deps({}, night);
    await buildWork(t.deps).handler(
      job(knowledgeBuildQueue, {
        tenant: '991825827',
        generation: 'g-docs-2',
        kind: 'index',
        run: 'run-1',
      }),
    );
    expect(t.deps.server.build).toHaveBeenCalled();
    expect(t.deps.server.vacuum).toHaveBeenCalledWith(
      'g-docs-2',
      expect.objectContaining({ analyze: true }),
    );
  });

  it("a switch's generation is built with the switch's dataset", async () => {
    const switched: DatasetConfig = {
      ...dataset,
      generation: 'g-20261104-7f3c2a',
      embedding: { model: 'other/embed', dimensions: 4 },
    };
    const t = deps({ datasetOfGeneration: async () => switched }, night);
    await buildWork(t.deps).handler(
      job(knowledgeBuildQueue, {
        tenant: '991825827',
        generation: 'g-20261104-7f3c2a',
        kind: 'index',
      }),
    );
    expect(t.deps.server.build).toHaveBeenCalledWith(
      switched,
      'g-20261104-7f3c2a',
      expect.anything(),
    );
  });

  it('the active indexes are prewarmed after a heavy job', async () => {
    const t = deps({}, night);
    await buildWork(t.deps).handler(
      job(knowledgeBuildQueue, {
        tenant: '991825827',
        generation: 'g-docs-1',
        kind: 'vacuum',
        run: 'run-1',
      }),
    );
    expect(t.deps.server.vacuum).toHaveBeenCalledWith(
      'g-docs-1',
      expect.objectContaining({ analyze: true, throttled: false }),
    );
    expect(t.deps.server.prewarm).toHaveBeenCalledWith(['g-docs-1']);
  });

  it('a build still running an hour after the window is cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let cancel: (error: Error) => void = () => undefined;
      const slow = server({
        build: vi.fn(
          (_d: DatasetConfig, _g: string, options: { onBackend?: (pid: number) => void }) =>
            new Promise<void>((_resolve, reject) => {
              options.onBackend?.(4242);
              cancel = reject;
            }),
        ),
        cancel: vi.fn(async () => cancel(new Error('canceling statement due to user request'))),
      });
      const log = vi.fn();
      // Started at 02:30 Oslo time; the window ends at 06:00, so the build is cancelled at 07:00.
      const t = deps({ server: slow, log }, night);
      const running = buildWork(t.deps).handler(
        job(knowledgeBuildQueue, { tenant: '991825827', generation: 'g-docs-2', kind: 'index' }),
      );
      const outcome = expect(running).rejects.toThrow(
        /an hour after the night window ended.*building index/,
      );
      await vi.advanceTimersByTimeAsync(4.5 * 3_600_000 - 1_000);
      expect(slow.cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await outcome;
      expect(slow.cancel).toHaveBeenCalledWith(4242);
      expect(log).toHaveBeenCalledWith(
        'knowledge build cancelled',
        expect.objectContaining({ generation: 'g-docs-2', progress: expect.anything() }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a build whose cancel fails is logged, and the build goes on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let finish: () => void = () => undefined;
      const slow = server({
        build: vi.fn(
          (_d: DatasetConfig, _g: string, options: { onBackend?: (pid: number) => void }) =>
            new Promise<void>((resolve) => {
              options.onBackend?.(4242);
              finish = resolve;
            }),
        ),
        cancel: vi.fn(async () => Promise.reject(new Error('permission denied to cancel query'))),
      });
      const log = vi.fn();
      const t = deps({ server: slow, log }, night);
      const running = buildWork(t.deps).handler(
        job(knowledgeBuildQueue, { tenant: '991825827', generation: 'g-docs-2', kind: 'index' }),
      );
      await vi.advanceTimersByTimeAsync(4.5 * 3_600_000 + 1_000);
      expect(log).toHaveBeenCalledWith(
        'knowledge build cancel failed',
        expect.objectContaining({ generation: 'g-docs-2' }),
      );
      finish();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed build is logged', async () => {
    const log = vi.fn();
    const t = deps(
      {
        log,
        server: server({ vacuum: vi.fn(async () => Promise.reject(new Error('disk full'))) }),
      },
      night,
    );
    await expect(
      buildWork(t.deps).handler(
        job(knowledgeBuildQueue, { tenant: '991825827', generation: 'g-docs-1', kind: 'freeze' }),
      ),
    ).rejects.toThrow('disk full');
    expect(log).toHaveBeenCalledWith(
      'knowledge build failed',
      expect.objectContaining({ generation: 'g-docs-1', kind: 'freeze' }),
    );
  });

  it('a catch-up build is refused until candidates exist', async () => {
    const t = deps({}, night);
    await expect(
      buildWork(t.deps).handler(
        job(knowledgeBuildQueue, { tenant: '991825827', generation: 'g-docs-1', kind: 'catch-up' }),
      ),
    ).rejects.toThrow(/catch-up/);
  });
});

describe('the nightly checks', () => {
  it('a partition past half the freeze age gets VACUUM (FREEZE) in the next window', async () => {
    const t = deps({ server: server({ toFreeze: vi.fn(async () => ['g-docs-1']) }) });
    await checkWork(t.deps).handler(job(knowledgeCheckQueue, {}));
    expect(t.sent).toContainEqual({
      queue: 'knowledge.build',
      data: { tenant: '991825827', generation: 'g-docs-1', kind: 'freeze' },
      startAfter: new Date(nextStart),
    });
  });

  it('a drop in sampled recall sends a REINDEX', async () => {
    const t = deps(
      {
        server: server({
          recall: vi.fn(async () => ({ recall: 0.9, queries: 200 })),
          baseline: vi.fn(async () => 0.995),
        }),
      },
      night,
    );
    await checkWork(t.deps).handler(job(knowledgeCheckQueue, {}));
    expect(t.sent).toEqual([
      {
        queue: 'knowledge.build',
        data: { tenant: '991825827', generation: 'g-docs-1', kind: 'reindex' },
        startAfter: night,
      },
    ]);
  });

  it("a large generation's recall check samples fewer vectors, with a margin widened to match", async () => {
    expect(recallQueries(100_000)).toEqual({ sample: 200, margin: 0.01 });
    expect(recallQueries(1_000_000).sample).toBe(100);
    expect(recallQueries(3_000_000)).toEqual({ sample: 50, margin: 0.02 });
    // A drop of 0.015 is a REINDEX on a small generation and noise on a large one.
    const drop = (chunks: number) =>
      deps(
        {
          server: server({
            chunks: vi.fn(async () => chunks),
            recall: vi.fn(async () => ({ recall: 0.98, queries: 50 })),
            baseline: vi.fn(async () => 0.995),
          }),
        },
        night,
      );
    const small = drop(100_000);
    await checkWork(small.deps).handler(job(knowledgeCheckQueue, {}));
    expect(small.deps.server.recall).toHaveBeenCalledWith('g-docs-1', { sample: 200 });
    expect(small.sent).toHaveLength(1);
    const large = drop(3_000_000);
    await checkWork(large.deps).handler(job(knowledgeCheckQueue, {}));
    expect(large.deps.server.recall).toHaveBeenCalledWith('g-docs-1', { sample: 50 });
    expect(large.sent).toEqual([]);
  });

  it('recall inside the measured margin sends nothing', async () => {
    const t = deps(
      {
        server: server({
          recall: vi.fn(async () => ({ recall: 0.995 - recallMargin / 2, queries: 200 })),
          baseline: vi.fn(async () => 0.995),
        }),
      },
      night,
    );
    await checkWork(t.deps).handler(job(knowledgeCheckQueue, {}));
    expect(t.sent).toEqual([]);
  });
});

describe('the heavy queues on an in-memory queue', () => {
  it('a fill job sent by day is not taken before the window', async () => {
    const queue = new InMemoryJobQueue({ now: () => day });
    const seen: string[] = [];
    const t = deps({ queue });
    const window = heavyWindow(t.deps, {
      build: noop(knowledgeBuildQueue),
      fill: queueWork(knowledgeFillQueue, async (j) => {
        seen.push(j.data.record);
      }),
    });
    await queue.send(
      knowledgeFillQueue,
      { run: 'run-1', tenant: '991825827', generation: 'g-docs-1', record: '7' },
      { startAfter: new Date(nextStart) },
    );
    await window.tick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toEqual([]);
    await queue.stop();
  });
});
