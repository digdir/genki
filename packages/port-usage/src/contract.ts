import { check, checkEqual, failure, type ContractSuite } from '@genai/plugins';
import { memoryUsageSource, type FakeCall, type FakeKey } from './memory.js';
import {
  UsageGatewayError,
  type GatewayUsageQuery,
  type GatewayUsageRow,
  type UsageGateway,
} from './usage.js';

export const usageContractVersion = 'usage@1';

/** What a check arranges calls in; for genki's own targets, the fake behind them. */
export interface UsageArrange {
  addKey(key: FakeKey): void;
  moveKey(id: string, subject: FakeKey['subject']): void;
  record(call: FakeCall): void;
}

export interface UsageContractSubject {
  gateway: UsageGateway;
  arrange: UsageArrange;
  clock: { now(): Date; set(at: Date): void };
}

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

let runs = 0;
const next = () => (runs += 1);
const org = (n: number) => String(900_000_000 + n * 1000 + (runs % 1000));

/** Moves the clock to a day nobody has used, half an hour in, and returns the day's start. */
const freshDay = (subject: UsageContractSubject) => {
  const today = Math.floor(subject.clock.now().getTime() / dayMs) * dayMs;
  const day = today + 2 * dayMs;
  subject.clock.set(new Date(day + 30 * 60_000));
  return day;
};

const closeAll = (subject: UsageContractSubject) =>
  subject.clock.set(new Date(subject.clock.now().getTime() + 2 * dayMs));

const all = async (gateway: UsageGateway, query: GatewayUsageQuery) => {
  const rows: GatewayUsageRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await gateway.query({ ...query, ...(cursor ? { cursor } : {}) });
    rows.push(...page.data);
    cursor = page.next ?? undefined;
  } while (cursor);
  return rows;
};

const statusOf = async (run: () => Promise<unknown>) => {
  const error = await failure(run);
  return error instanceof UsageGatewayError ? error.status : undefined;
};

const hours = (day: number, from: number, to: number) => ({
  from: new Date(day + from * hourMs),
  to: new Date(day + to * hourMs),
  bucket: 'hour' as const,
});

const call = (key: string, at: number, extra: Partial<FakeCall> = {}): FakeCall => ({
  key,
  model: 'gpt-test',
  at: new Date(at),
  inputTokens: 100,
  outputTokens: 10,
  costMicros: 1000,
  ...extra,
});

const figures = (rows: GatewayUsageRow[]) =>
  rows.map((r) => ({
    start: r.start,
    model: r.model,
    subject: r.subject,
    inputTokens: r.inputTokens,
    requests: r.requests,
    cost: r.cost.micros,
  }));

export const usageContract: ContractSuite<UsageContractSubject> = {
  contract: usageContractVersion,
  checks: [
    {
      name: 'answers hourly rows grouped by model and owner, with tokens, requests and cost',
      run: async (s) => {
        const n = next();
        const day = freshDay(s);
        const owner = { kind: 'service', id: `svc-${n}`, org: org(1) };
        s.arrange.addKey({ id: `k-${n}`, subject: owner });
        s.arrange.record(call(`k-${n}`, day + 60_000));
        s.arrange.record(call(`k-${n}`, day + 120_000, { outputTokens: 30, costMicros: 3000 }));
        s.arrange.record(call(`k-${n}`, day + 180_000, { model: 'other-model' }));
        const rows = await all(s.gateway, {
          ...hours(day, 0, 1),
          groupBy: ['model', 'subject'],
          subject: `service:svc-${n}`,
          org: org(1),
        });
        checkEqual(
          rows.map((r) => [r.model, r.subject, r.inputTokens, r.outputTokens, r.requests]),
          [
            ['gpt-test', owner, 200, 40, 2],
            ['other-model', owner, 100, 10, 1],
          ],
          'rows',
        );
        checkEqual(rows[0]?.cost.micros, 4000, 'cost');
        check(/^[A-Z]{3}$/.test(rows[0]?.cost.currency ?? ''), 'cost has a currency code');
        checkEqual(rows[0]?.start, new Date(day).toISOString(), 'start');
      },
    },
    {
      name: 'counts cached and cache-write tokens inside the input tokens',
      run: async (s) => {
        const n = next();
        const day = freshDay(s);
        s.arrange.addKey({ id: `k-${n}`, subject: { kind: 'org', id: org(2) } });
        s.arrange.record(
          call(`k-${n}`, day + 60_000, { cachedInputTokens: 40, cacheWriteTokens: 10 }),
        );
        const [row] = await all(s.gateway, {
          ...hours(day, 0, 1),
          groupBy: ['model'],
          subject: `org:${org(2)}`,
        });
        checkEqual(
          [row?.inputTokens, row?.cachedInputTokens, row?.cacheWriteTokens],
          [100, 40, 10],
          'tokens',
        );
      },
    },
    {
      name: 'puts a call in the bucket it started in',
      run: async (s) => {
        const n = next();
        const day = freshDay(s);
        s.arrange.addKey({ id: `k-${n}`, subject: { kind: 'org', id: org(3) } });
        s.arrange.record(call(`k-${n}`, day + 59 * 60_000 + 59_000));
        const rows = await all(s.gateway, { ...hours(day, 0, 2), subject: `org:${org(3)}` });
        checkEqual(
          rows.map((r) => r.start),
          [new Date(day).toISOString()],
          'buckets',
        );
      },
    },
    {
      name: 'keeps a closed bucket the same on every request',
      run: async (s) => {
        const n = next();
        const day = freshDay(s);
        s.arrange.addKey({ id: `k-${n}`, subject: { kind: 'org', id: org(4) } });
        s.arrange.record(call(`k-${n}`, day + 60_000));
        const query = {
          ...hours(day, 0, 1),
          groupBy: ['model', 'subject'],
          subject: `org:${org(4)}`,
        };
        checkEqual((await all(s.gateway, query))[0]?.closed, false, 'open before it settles');
        closeAll(s);
        const first = await all(s.gateway, query);
        const second = await all(s.gateway, query);
        checkEqual(first[0]?.closed, true, 'closed after it settles');
        checkEqual(second, first, 'a closed bucket on a second request');
      },
    },
    {
      name: 'counts calls it could not price in unpricedRequests and leaves them out of cost',
      run: async (s) => {
        const n = next();
        const day = freshDay(s);
        s.arrange.addKey({ id: `k-${n}`, subject: { kind: 'org', id: org(5) } });
        s.arrange.record(call(`k-${n}`, day + 60_000));
        const unpriced = call(`k-${n}`, day + 120_000);
        delete unpriced.costMicros;
        s.arrange.record(unpriced);
        const [row] = await all(s.gateway, { ...hours(day, 0, 1), subject: `org:${org(5)}` });
        checkEqual(
          [row?.requests, row?.unpricedRequests, row?.cost.micros],
          [2, 1, 1000],
          'requests and cost',
        );
      },
    },
    {
      name: 'gives a row without a subject for a key without one',
      run: async (s) => {
        const n = next();
        const day = freshDay(s);
        s.arrange.addKey({ id: `k-${n}` });
        s.arrange.record(call(`k-${n}`, day + 60_000, { model: `lonely-${n}` }));
        const rows = (
          await all(s.gateway, { ...hours(day, 0, 1), groupBy: ['model', 'subject'] })
        ).filter((r) => r.model === `lonely-${n}`);
        checkEqual(rows.length, 1, 'rows');
        checkEqual(rows[0]?.subject, undefined, 'subject');
      },
    },
    {
      name: "records genki's calls under genki:<tenant>, and a filter on the organisation of genki's key does not hold them",
      run: async (s) => {
        const n = next();
        const day = freshDay(s);
        const runner = org(6);
        const tenant = org(7);
        s.arrange.addKey({
          id: `genki-${n}`,
          subject: { kind: 'service', id: 'genki', org: runner },
          consumer: 'genki',
        });
        s.arrange.record(call(`genki-${n}`, day + 60_000, { genkiTenant: tenant }));
        const owned = await all(s.gateway, {
          ...hours(day, 0, 1),
          groupBy: ['subject'],
          subject: `org:${tenant}`,
        });
        checkEqual(
          owned.map((r) => r.subject),
          [{ kind: 'genki', id: tenant, org: tenant }],
          'owner',
        );
        checkEqual(
          await all(s.gateway, { ...hours(day, 0, 1), subject: `org:${runner}` }),
          [],
          "rows under the organisation of genki's key",
        );
        checkEqual(
          await all(s.gateway, {
            ...hours(day, 0, 1),
            subject: 'service:genki',
            org: runner,
          }),
          [],
          "rows under the subject of genki's key",
        );
      },
    },
    {
      name: 'matches a subject filter against the chain a call was made with, not the key as it is now',
      run: async (s) => {
        const n = next();
        const day = freshDay(s);
        s.arrange.addKey({ id: `k-${n}`, subject: { kind: 'team', id: 'a', org: org(8) } });
        s.arrange.record(call(`k-${n}`, day + 60_000));
        s.arrange.moveKey(`k-${n}`, { kind: 'team', id: 'b', org: org(8) });
        const before = await all(s.gateway, {
          ...hours(day, 0, 1),
          subject: 'team:a',
          org: org(8),
        });
        const after = await all(s.gateway, {
          ...hours(day, 0, 1),
          subject: 'team:b',
          org: org(8),
        });
        checkEqual([before.length, after.length], [1, 0], 'rows for the old and new team');
      },
    },
    {
      name: 'needs org with a team, service or user subject',
      run: async (s) => {
        const day = freshDay(s);
        checkEqual(
          await statusOf(() => s.gateway.query({ ...hours(day, 0, 1), subject: 'service:x' })),
          400,
          'status',
        );
      },
    },
    {
      name: 'refuses a query off a bucket boundary or longer than 31 days of hours',
      run: async (s) => {
        const day = freshDay(s);
        checkEqual(
          await statusOf(() =>
            s.gateway.query({
              from: new Date(day + 60_000),
              to: new Date(day + hourMs),
              bucket: 'hour',
            }),
          ),
          400,
          'off a boundary',
        );
        checkEqual(
          await statusOf(() =>
            s.gateway.query({
              from: new Date(day),
              to: new Date(day + 32 * dayMs),
              bucket: 'hour',
            }),
          ),
          400,
          'too long',
        );
      },
    },
    {
      name: 'keeps a page boundary where it was while an open bucket grows',
      run: async (s) => {
        const n = next();
        const day = freshDay(s);
        s.arrange.addKey({ id: `k-${n}`, subject: { kind: 'org', id: org(9) } });
        for (const model of ['m-b', 'm-c', 'm-d', 'm-e'])
          s.arrange.record(call(`k-${n}`, day + 60_000, { model }));
        const query = {
          ...hours(day, 0, 1),
          groupBy: ['model'],
          subject: `org:${org(9)}`,
        };
        const seen: string[] = [];
        let page = await s.gateway.query(query);
        seen.push(...page.data.map((r) => r.model ?? ''));
        check(page.next !== null, 'the answer is paged; the target needs a small page size');
        s.arrange.record(call(`k-${n}`, day + 120_000, { model: 'm-a' }));
        while (page.next) {
          page = await s.gateway.query({ ...query, cursor: page.next });
          seen.push(...page.data.map((r) => r.model ?? ''));
        }
        checkEqual(seen, ['m-b', 'm-c', 'm-d', 'm-e'], 'rows over every page');
      },
    },
    {
      name: 'returns rows by start, then group, in the same order on every request',
      run: async (s) => {
        const n = next();
        const day = freshDay(s);
        s.arrange.addKey({ id: `k-${n}`, subject: { kind: 'org', id: org(10) } });
        s.arrange.record(call(`k-${n}`, day + hourMs + 60_000, { model: 'z' }));
        s.arrange.record(call(`k-${n}`, day + 60_000, { model: 'y' }));
        s.arrange.record(call(`k-${n}`, day + 60_000, { model: 'x' }));
        const query = { ...hours(day, 0, 2), groupBy: ['model'], subject: `org:${org(10)}` };
        const first = await all(s.gateway, query);
        checkEqual(
          first.map((r) => r.model),
          ['x', 'y', 'z'],
          'order',
        );
        checkEqual(figures(await all(s.gateway, query)), figures(first), 'second request');
      },
    },
  ],
};

/** The fake itself as a contract target, with a clock the checks move. */
export const memoryUsageContractTarget = async () => {
  let now = new Date('2026-10-12T00:00:00Z');
  const fake = memoryUsageSource({ now: () => now, pageSize: 2 });
  return {
    subject: {
      gateway: fake,
      arrange: fake,
      clock: { now: () => now, set: (at: Date) => (now = at) },
    },
  };
};
