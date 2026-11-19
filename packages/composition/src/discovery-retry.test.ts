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
      random: () => 1,
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

  it('waits between half and all of the backoff delay, chosen at random', async () => {
    const timer = manual();
    const discovery = await discoverWithRetry({
      refresh: async () => ({ failed: [{ endpoint: 'foundry', error: '408' }] }),
      delaysMs: [1000, 4000],
      random: () => 0,
      schedule: timer.schedule,
    });
    await timer.next();

    expect(discovery.state()).toMatchObject({ state: 'retrying', attempts: 2 });
    expect(timer.queued.map((q) => q.ms)).toEqual([2000]);
  });

  it('gives up after the attempt limit and reports failed', async () => {
    const timer = manual();
    const warnings: string[] = [];
    const discovery = await discoverWithRetry({
      refresh: async () => ({ failed: [{ endpoint: 'foundry', error: '408 timeout' }] }),
      maxAttempts: 3,
      delaysMs: [5],
      schedule: timer.schedule,
      onWarning: (m) => warnings.push(m),
      now: () => new Date('2026-11-18T09:00:00Z'),
    });
    await timer.next();
    await timer.next();

    expect(discovery.state()).toEqual({
      state: 'failed',
      attempts: 3,
      lastError: 'foundry: 408 timeout',
      since: '2026-11-18T09:00:00.000Z',
    });
    expect(timer.queued).toEqual([]);
    expect(warnings).toContain('model discovery gave up after 3 attempts');
  });

  it('a manual refresh after giving up recovers and resets the limit', async () => {
    const timer = manual();
    let up = false;
    const discovery = await discoverWithRetry({
      refresh: async () => ({
        discovered: up ? 4 : 0,
        failed: up ? [] : [{ endpoint: 'foundry', error: '408' }],
      }),
      maxAttempts: 1,
      schedule: timer.schedule,
    });
    expect(discovery.state()).toMatchObject({ state: 'failed', attempts: 1 });

    up = true;
    expect(await discovery.refresh()).toEqual({ discovered: 4, failed: [] });
    expect(discovery.state()).toEqual({ state: 'ok', attempts: 2 });
  });

  it('never runs two discoveries at once; a refresh while one is in flight shares it', async () => {
    const timer = manual();
    let calls = 0;
    let release: (value: { failed: never[] }) => void = () => undefined;
    const discovery = await discoverWithRetry({
      refresh: async () => {
        calls += 1;
        if (calls === 1) return { failed: [{ endpoint: 'foundry', error: '408' }] };
        return new Promise<{ failed: never[] }>((resolve) => {
          release = resolve;
        });
      },
      schedule: timer.schedule,
    });
    await timer.next();
    const manualRefresh = discovery.refresh();
    release({ failed: [] });
    await manualRefresh;

    expect(calls).toBe(2);
    expect(discovery.state()).toEqual({ state: 'ok', attempts: 2 });
  });

  it('a pending retry does nothing once a manual refresh has succeeded', async () => {
    const timer = manual();
    let calls = 0;
    const discovery = await discoverWithRetry({
      refresh: async () => {
        calls += 1;
        return { failed: calls === 1 ? [{ endpoint: 'foundry', error: '408' }] : [] };
      },
      schedule: timer.schedule,
    });
    await discovery.refresh();
    await timer.next();

    expect(calls).toBe(2);
    expect(discovery.state()).toEqual({ state: 'ok', attempts: 2 });
  });

  it('a refresh that throws is recorded and the error reaches the caller', async () => {
    const timer = manual();
    let calls = 0;
    const discovery = await discoverWithRetry({
      refresh: async () => {
        calls += 1;
        if (calls > 1) throw new Error('network down');
        return { failed: [] };
      },
      schedule: timer.schedule,
    });

    await expect(discovery.refresh()).rejects.toThrow('network down');
    expect(discovery.state()).toMatchObject({ state: 'retrying', lastError: '*: network down' });
  });
});
