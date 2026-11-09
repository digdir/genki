import { describe, expect, it } from 'vitest';
import type { Job, JobQueue } from '@genai/jobs';
import {
  InMemoryUsageBuckets,
  memoryUsageSource,
  toUsageRow,
  UsageGatewayError,
  type UsageSource,
} from '@genai/port-usage';
import { scheduleUsagePolls, usagePollWork } from './usage-poll.js';

const tenant = '991825827';
const day = Date.parse('2026-10-12T00:00:00Z');
const hourMs = 3_600_000;

const job = (source: string): Job<{ source: string }> => ({
  id: 'j1',
  queue: 'usage-gateway-poll',
  data: { source },
  retryCount: 0,
  signal: new AbortController().signal,
});

const setup = (source?: UsageSource) => {
  let now = new Date(day + 30 * 60_000);
  const fake = memoryUsageSource({ now: () => now });
  fake.addKey({ id: 'k', subject: { kind: 'org', id: tenant } });
  const store = new InMemoryUsageBuckets(() => [tenant]);
  const logged: string[] = [];
  const work = usagePollWork({
    sources: [{ source: source ?? fake, since: new Date(day) }],
    store,
    now: () => now,
    log: (msg) => logged.push(msg),
  });
  const record = (hour: number) => {
    now = new Date(Math.max(now.getTime(), day + hour * hourMs + 2 * 60_000));
    fake.record({
      key: 'k',
      model: 'gpt-test',
      at: new Date(day + hour * hourMs + 60_000),
      inputTokens: 100,
      outputTokens: 10,
      costMicros: 1000,
    });
  };
  const fakeRows = async () =>
    (
      await fake.query({
        from: new Date(day),
        to: new Date(day + 24 * hourMs),
        bucket: 'hour',
        groupBy: ['model', 'subject'],
      })
    ).data
      .map((r) => JSON.stringify(toUsageRow(fake.id, r)))
      .sort();
  const storedRows = () =>
    store
      .all()
      .map((r) => {
        const rest: typeof r & { tenant?: string } = { ...r };
        delete rest.tenant;
        return JSON.stringify(rest);
      })
      .sort();
  return {
    fake,
    store,
    work,
    logged,
    record,
    fakeRows,
    storedRows,
    setNow: (at: number) => (now = new Date(at)),
  };
};

describe('the usage-gateway-poll job', () => {
  it("leaves the stored rows equal to the fake's after a second poll, and after an open bucket closes", async () => {
    const { work, record, fakeRows, storedRows, setNow } = setup();
    record(0);
    await work.handler(job('gateway'));
    record(0);
    record(1);
    await work.handler(job('gateway'));
    await work.handler(job('gateway'));
    expect(storedRows()).toEqual(await fakeRows());

    setNow(day + 5 * hourMs);
    await work.handler(job('gateway'));
    expect(storedRows()).toEqual(await fakeRows());
  });

  it('polls only a configured source, whatever the job names', async () => {
    const { fake, work, logged } = setup();
    await work.handler(job('elsewhere'));

    expect(fake.seen).toEqual([]);
    expect(logged).toEqual(['usage poll skipped: no such source']);
  });

  it('waits for the next run on 429 or 502, and fails the job on 401 or 403 so operators are told', async () => {
    let status = 429;
    const failing: UsageSource = {
      id: 'gateway',
      usage: () => Promise.reject(new UsageGatewayError(status, 'refused')),
    };
    const { work, store } = setup(failing);
    await expect(work.handler(job('gateway'))).resolves.toBeUndefined();
    status = 502;
    await expect(work.handler(job('gateway'))).resolves.toBeUndefined();
    for (status of [401, 403])
      await expect(work.handler(job('gateway'))).rejects.toThrow('refused');

    expect(await store.closedThrough('gateway')).toBeUndefined();
  });

  it('schedules one poll per source at twenty past every hour, Oslo time', async () => {
    const scheduled: unknown[] = [];
    const jobs = {
      schedule: async (...args: unknown[]) => {
        scheduled.push(args.slice(1));
      },
    } as unknown as JobQueue;
    await scheduleUsagePolls(jobs, [{ source: memoryUsageSource(), since: new Date(day) }]);

    expect(scheduled).toEqual([
      ['20 * * * *', { source: 'gateway' }, { tz: 'Europe/Oslo', key: 'gateway' }],
    ]);
  });
});
