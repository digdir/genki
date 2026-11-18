import { describe, expect, it } from 'vitest';
import { discoverWithRetry } from './discovery-retry.js';

const manual = () => {
  const queued: { run: () => void; ms: number }[] = [];
  return {
    queued,
    schedule: (run: () => void, ms: number) => {
      queued.push({ run, ms });
      return {};
    },
    next: async () => {
      queued.shift()?.run();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
};

describe('model discovery retry', () => {
  it('retries a failed discovery in the background until it succeeds', async () => {
    const timer = manual();
    let calls = 0;
    const discovery = await discoverWithRetry({
      refresh: async () => {
        calls += 1;
        return { failed: calls < 3 ? [{ endpoint: 'foundry', error: '408 timeout' }] : [] };
      },
      delaysMs: [5, 10],
      schedule: timer.schedule,
      now: () => new Date('2026-11-18T09:00:00Z'),
    });

    expect(discovery.state()).toEqual({
      state: 'retrying',
      attempts: 1,
      lastError: 'foundry: 408 timeout',
      since: '2026-11-18T09:00:00.000Z',
    });
    await timer.next();
    expect(discovery.state()).toMatchObject({ state: 'retrying', attempts: 2 });
    expect(timer.queued.map((q) => q.ms)).toEqual([10]);
    await timer.next();

    expect(discovery.state()).toEqual({ state: 'ok', attempts: 3 });
    expect(timer.queued).toEqual([]);
  });

  it('a discovery that throws counts as failed and is retried', async () => {
    const timer = manual();
    const discovery = await discoverWithRetry({
      refresh: async () => {
        throw new Error('network down');
      },
      schedule: timer.schedule,
    });

    expect(discovery.state()).toMatchObject({ state: 'retrying', lastError: '*: network down' });
    expect(timer.queued).toHaveLength(1);
  });

  it('schedules nothing when the first discovery succeeds', async () => {
    const timer = manual();
    const discovery = await discoverWithRetry({
      refresh: async () => ({ failed: [] }),
      schedule: timer.schedule,
    });

    expect(discovery.state()).toEqual({ state: 'ok', attempts: 1 });
    expect(timer.queued).toEqual([]);
  });
});
