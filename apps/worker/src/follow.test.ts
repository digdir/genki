import { afterEach, describe, expect, it, vi } from 'vitest';
import { followPublished } from './follow.js';

afterEach(() => {
  vi.useRealTimers();
});

const feed = () => {
  const listeners = new Map<string, () => void | Promise<void>>();
  return {
    listeners,
    on: (topic: string, fn: () => void | Promise<void>) => {
      listeners.set(topic, fn);
      return () => listeners.delete(topic);
    },
  };
};

describe('followPublished', () => {
  it('syncs when definitions or trigger pauses change and stops listening', async () => {
    const changes = feed();
    const sync = vi.fn(async () => ({ active: true }));
    const following = followPublished({ sync, feed: changes });

    await changes.listeners.get('definitions')?.();
    await changes.listeners.get('config-entries')?.();
    expect(sync).toHaveBeenCalledTimes(2);

    following.stop();
    expect(changes.listeners.size).toBe(0);
  });

  it('keeps going after a failed sync and reports it', async () => {
    const changes = feed();
    const onError = vi.fn();
    const sync = vi
      .fn<() => Promise<{ active: boolean }>>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({ active: true });
    followPublished({ sync, feed: changes, onError });

    await changes.listeners.get('definitions')?.();
    await changes.listeners.get('definitions')?.();
    expect(onError).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('re-syncs when leadership changes and not otherwise', async () => {
    vi.useFakeTimers();
    let leader = false;
    const sync = vi.fn(async () => ({ active: leader }));
    const following = followPublished({
      sync,
      leadership: { tryAcquire: async () => leader },
      leaderPollMs: 1000,
    });
    await following.run();
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(sync).toHaveBeenCalledTimes(1);

    leader = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync).toHaveBeenCalledTimes(2);
    following.stop();
  });
});
