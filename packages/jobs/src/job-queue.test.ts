import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineQueue, InMemoryJobQueue, JobQueueError } from './job-queue.js';
import { describeJobQueueContract, waitFor } from './testing/index.js';

describeJobQueueContract('in memory', async () => {
  const queue = new InMemoryJobQueue({ pollMs: 10 });
  return {
    queue,
    transaction: async () => queue.transaction(),
    withPlatformAccess: (read) => read(),
  };
});

const nightly = defineQueue({
  name: 'test.nightly',
  policy: 'singleton',
  payload: z.strictObject({}),
  expireInSeconds: 60,
  heartbeatSeconds: 10,
  retryLimit: 0,
  deadLetter: false,
});

describe('job queue definitions', () => {
  it('refuses a heartbeat shorter than pg-boss allows', () => {
    expect(() => defineQueue({ ...nightly, heartbeatSeconds: 5 })).toThrow(JobQueueError);
  });

  it('refuses a queue that expires before its heartbeat', () => {
    expect(() => defineQueue({ ...nightly, expireInSeconds: 10 })).toThrow(JobQueueError);
  });

  it('refuses an expiry longer than 24 hours', () => {
    expect(() => defineQueue({ ...nightly, expireInSeconds: 86_401 })).toThrow(JobQueueError);
    expect(defineQueue({ ...nightly, expireInSeconds: 86_400 }).expireInSeconds).toBe(86_400);
  });

  it('refuses a queue name that reads as a dead-letter queue', () => {
    expect(() => defineQueue({ ...nightly, name: 'test.dead' })).toThrow(JobQueueError);
  });
});

describe('in-memory schedules', () => {
  it('sends one job per occurrence in the time zone', async () => {
    let now = new Date('2026-10-28T23:59:00Z');
    const queue = new InMemoryJobQueue({ now: () => now, pollMs: 10 });
    const fired: string[] = [];
    await queue.work(nightly, async () => {
      fired.push(now.toISOString());
    });
    await queue.schedule(nightly, '0 1 * * *', {}, { tz: 'Europe/Oslo' });
    now = new Date('2026-10-29T00:00:30Z');
    await waitFor(() => fired.length === 1);
    now = new Date('2026-10-29T00:30:00Z');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fired).toEqual(['2026-10-29T00:00:30.000Z']);
    await queue.stop();
  });
});
