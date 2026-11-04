import { describe, expect, it } from 'vitest';
import { memoryUsageSource } from './memory.js';
import { InMemoryUsageBuckets, pollUsage } from './poll.js';
import { toUsageRow, type UsageQuery, type UsageRow, type UsageSource } from './usage.js';

const tenant = '991825827';
const stranger = '889640782';
const hourMs = 3_600_000;
const day = Date.parse('2026-10-12T00:00:00Z');

const setup = (extra: { pageSize?: number } = {}) => {
  let now = new Date(day + 30 * 60_000);
  const fake = memoryUsageSource({ now: () => now, ...extra });
  fake.addKey({ id: 'k-own', subject: { kind: 'org', id: tenant } });
  fake.addKey({ id: 'k-svc', subject: { kind: 'service', id: 'ka', org: tenant } });
  fake.addKey({ id: 'k-stranger', subject: { kind: 'org', id: stranger } });
  fake.addKey({ id: 'k-none' });
  const store = new InMemoryUsageBuckets(() => [tenant]);
  const clock = {
    set: (at: number) => (now = new Date(at)),
    now: () => now,
  };
  const at = (hour: number, minute = 1) => new Date(day + hour * hourMs + minute * 60_000);
  const record = (key: string, hour: number, extraCall: { model?: string } = {}) => {
    clock.set(Math.max(now.getTime(), at(hour, 2).getTime()));
    fake.record({
      key,
      model: extraCall.model ?? 'gpt-test',
      at: at(hour),
      inputTokens: 100,
      outputTokens: 10,
      costMicros: 1000,
    });
  };
  const poll = () => pollUsage(fake, store, { firstStart: new Date(day), now: clock.now });
  const fakeRows = async () => {
    const rows: UsageRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await fake.query({
        from: new Date(day),
        to: new Date(day + 2 * 24 * hourMs),
        bucket: 'hour',
        groupBy: ['model', 'subject'],
        ...(cursor ? { cursor } : {}),
      });
      rows.push(...page.data.map((r) => toUsageRow(fake.id, r)));
      cursor = page.next ?? undefined;
    } while (cursor);
    return rows;
  };
  const sorted = (rows: UsageRow[]) =>
    rows
      .map((r) => {
        const rest: UsageRow & { tenant?: string } = { ...r };
        delete rest.tenant;
        return JSON.stringify(rest);
      })
      .sort();
  return { fake, store, clock, record, poll, fakeRows, sorted };
};

describe('the usage poll', () => {
  it("leaves the stored rows equal to the fake's after a second poll, and after an open bucket closes", async () => {
    const { store, clock, record, poll, fakeRows, sorted } = setup();
    record('k-own', 0);
    record('k-svc', 0);
    record('k-own', 1);
    await poll();
    record('k-own', 1, { model: 'later' });
    await poll();
    await poll();
    expect(sorted(store.all())).toEqual(sorted(await fakeRows()));

    clock.set(day + 6 * hourMs);
    await poll();
    expect(sorted(store.all())).toEqual(sorted(await fakeRows()));
    expect(store.all().every((r) => r.closed)).toBe(true);
  });

  it('reads a closed bucket once: hours before closedThrough are never asked for again', async () => {
    const { fake, store, clock, record, poll } = setup();
    record('k-own', 0);
    clock.set(day + 3 * hourMs);
    const first = await poll();
    fake.seen.splice(0);
    await poll();

    expect(first.closedThrough).toBe(new Date(day + 2 * hourMs).toISOString());
    expect(await store.closedThrough(fake.id)).toBe(first.closedThrough);
    expect(fake.seen.map((q) => q.from.toISOString())).toEqual([first.closedThrough]);
  });

  it("replaces an open bucket's stored rows as a whole", async () => {
    const { store, record, poll } = setup();
    record('k-own', 0);
    await poll();
    record('k-own', 0);
    await poll();

    expect(store.all().map((r) => [r.requests, r.closed])).toEqual([[2, false]]);
  });

  it('leaves closedThrough where it was after a failed run, and the next run fills the gap', async () => {
    const { fake, store, clock, record } = setup();
    record('k-own', 0);
    clock.set(day + 3 * hourMs);
    let failing = true;
    const flaky: UsageSource = {
      id: fake.id,
      usage: (query: UsageQuery) =>
        failing ? Promise.reject(new Error('502')) : fake.usage(query),
    };
    const options = { firstStart: new Date(day), now: clock.now };
    await expect(pollUsage(flaky, store, options)).rejects.toThrow('502');
    expect(await store.closedThrough(fake.id)).toBeUndefined();
    failing = false;
    await pollUsage(flaky, store, options);

    expect(store.all().map((r) => r.requests)).toEqual([1]);
    expect(await store.closedThrough(fake.id)).toBe(new Date(day + 2 * hourMs).toISOString());
  });

  it('logs a closed row that comes back different as a contract breach and keeps the stored row', async () => {
    const { fake, store, clock, record } = setup();
    record('k-own', 1);
    clock.set(day + 4 * hourMs);
    const breaches: string[] = [];
    const lying: UsageSource = {
      id: fake.id,
      usage: async (query) => {
        const page = await fake.usage(query);
        return { ...page, rows: page.rows.map((r) => ({ ...r, requests: r.requests + 5 })) };
      },
    };
    await pollUsage(fake, store, { firstStart: new Date(day), now: clock.now });
    const replay = await pollUsage(lying, new ReplayFrom(store, day), {
      firstStart: new Date(day),
      now: clock.now,
      onBreach: (_source, start) => breaches.push(start),
    });

    expect(replay.breaches).toBe(1);
    expect(breaches).toEqual([new Date(day + hourMs).toISOString()]);
    expect(store.all().map((r) => r.requests)).toEqual([1]);
  });

  it('asks in pieces of at most 31 days and reads every page', async () => {
    const { fake, store, clock, record } = setup({ pageSize: 1 });
    record('k-own', 0);
    record('k-svc', 0);
    clock.set(day + 40 * 24 * hourMs);
    await pollUsage(fake, store, { firstStart: new Date(day), now: clock.now });

    const spans = fake.seen.map((q) => (q.to.getTime() - q.from.getTime()) / (24 * hourMs));
    expect(Math.max(...spans)).toBeLessThanOrEqual(31);
    expect(fake.seen.filter((q) => q.cursor !== undefined)).toHaveLength(1);
    expect(store.all()).toHaveLength(2);
  });

  it('keeps rows of an organisation that is not a tenant, or with no organisation, out of every tenant', async () => {
    const { store, record, poll } = setup();
    record('k-own', 0);
    record('k-stranger', 0);
    record('k-none', 0);
    await poll();
    const window = [new Date(day), new Date(day + 24 * hourMs)] as const;

    expect((await store.tenantRows([tenant, stranger], ...window)).map((r) => r.tenant)).toEqual([
      tenant,
    ]);
    expect(
      (await store.unassignedRows(...window)).map((r) => r.subject?.id ?? null).sort(),
    ).toEqual([stranger, null].sort());
  });
});

/** A store whose mark starts over, so a closed bucket is read a second time. */
class ReplayFrom extends InMemoryUsageBuckets {
  constructor(
    private readonly inner: InMemoryUsageBuckets,
    private readonly from: number,
  ) {
    super(() => []);
  }

  override async closedThrough() {
    return new Date(this.from).toISOString();
  }

  override openStarts(source: string) {
    return this.inner.openStarts(source);
  }

  override store(...args: Parameters<InMemoryUsageBuckets['store']>) {
    return this.inner.store(...args);
  }

  override advance(source: string, closedThrough: string) {
    return this.inner.advance(source, closedThrough);
  }
}
