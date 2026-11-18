import { describe, expect, it } from 'vitest';
import { kudosRateLimiter } from './kudos-rate.js';

/** A clock that only moves when the limiter sleeps, so a test runs at once. */
const fakeClock = () => {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
};

const sendTimes = async (count: number, limits: { perMinute: number; perHour: number }) => {
  const clock = fakeClock();
  const limiter = kudosRateLimiter({ ...limits, now: clock.now, sleep: clock.sleep });
  const sent: number[] = [];
  for (let i = 0; i < count; i++) {
    await limiter.take();
    sent.push(clock.now());
  }
  return sent;
};

const most = (sent: number[], windowMs: number) =>
  Math.max(...sent.map((t) => sent.filter((s) => s >= t && s < t + windowMs).length));

describe('kudos rate limiter', () => {
  it('the Kudos client sends at most 180 requests a minute', async () => {
    const sent = await sendTimes(400, { perMinute: 180, perHour: 5000 });

    expect(most(sent, 60_000)).toBe(180);
    expect(sent.slice(0, 180).every((t) => t === 0)).toBe(true);
    expect(sent[180]).toBeGreaterThanOrEqual(60_000);
  });

  it('the Kudos client sends at most 5,000 requests an hour', async () => {
    const sent = await sendTimes(5200, { perMinute: 180, perHour: 5000 });

    expect(most(sent, 3_600_000)).toBe(5000);
    expect(sent[5000]).toBeGreaterThanOrEqual(3_600_000);
  });

  it('holds every request back while KUDOS has asked it to wait', async () => {
    const clock = fakeClock();
    const limiter = kudosRateLimiter({ now: clock.now, sleep: clock.sleep });
    await limiter.take();
    limiter.pause(30_000);
    await limiter.take();

    expect(clock.now()).toBe(30_000);
  });
});
