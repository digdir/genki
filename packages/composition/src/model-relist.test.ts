import { describe, expect, it } from 'vitest';
import { inMemoryDiscoveredModels } from '@genai/port-model';
import { modelDiscoveryFromEnv, scheduleModelRelist } from './model-relist.js';

const every = 30 * 60_000;
const start = Date.parse('2026-11-21T10:00:00Z');

const timers = () => {
  let now = start;
  const pending: { at: number; run: () => void }[] = [];
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      pending.sort((a, b) => a.at - b.at);
      const due = pending[0];
      if (!due || due.at > until) break;
      pending.shift();
      now = due.at;
      due.run();
      await new Promise((resolve) => setImmediate(resolve));
    }
    now = until;
  };
  return {
    clock: () => new Date(now),
    schedule: (run: () => void, ms: number) => {
      pending.push({ at: now + ms, run });
      return {};
    },
    advance,
  };
};

describe('the scheduled re-list', () => {
  it('the scheduled re-list runs on one replica per interval', async () => {
    const store = inMemoryDiscoveredModels();
    const time = timers();
    const listed: { replica: string; at: number }[] = [];
    const replicas = ['a', 'b', 'c'].map((name, i) =>
      scheduleModelRelist({
        everyMs: every,
        random: () => i / 3,
        schedule: time.schedule,
        relistIfDue: async () => {
          if (await store.claim('model-relist', time.clock(), every))
            listed.push({ replica: name, at: time.clock().getTime() });
        },
      }),
    );

    await time.advance(4 * every);
    for (const r of replicas) r.stop();

    expect(listed.length).toBeGreaterThanOrEqual(3);
    expect(listed.length).toBeLessThanOrEqual(4);
    for (const [i, run] of listed.entries())
      if (i > 0) expect(run.at - (listed[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(every);
  });

  it('stops trying once stopped', async () => {
    const time = timers();
    let tries = 0;
    const relist = scheduleModelRelist({
      everyMs: every,
      random: () => 0.5,
      schedule: time.schedule,
      relistIfDue: async () => {
        tries += 1;
      },
    });

    await time.advance(every / 4);
    relist.stop();
    await time.advance(every);

    expect(tries).toBe(1);
  });

  it('reads the interval in minutes and the grace period in hours, and refuses a value that is not a positive number', () => {
    expect(
      modelDiscoveryFromEnv({ MODEL_RELIST_MINUTES: '15', MODEL_DISCOVERY_GRACE_HOURS: '48' }),
    ).toEqual({ relistMs: 15 * 60_000, graceMs: 48 * 3_600_000 });
    expect(modelDiscoveryFromEnv({})).toEqual({});
    expect(() => modelDiscoveryFromEnv({ MODEL_RELIST_MINUTES: '0' })).toThrow(
      /MODEL_RELIST_MINUTES/,
    );
  });
});
