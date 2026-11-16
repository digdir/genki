import { describe, expect, it } from 'vitest';
import type { Event } from '@genai/contracts';
import {
  costOf,
  gateQuota,
  monthlyModelQuota,
  monthlyQuotaGate,
  quotaExhaustedMessage,
} from './quota.js';

const usage = (model: string, inputTokens: number, outputTokens: number) =>
  ({
    type: 'kernel.usage',
    data: { model: { kind: 'model', id: model }, usage: { inputTokens, outputTokens } },
  }) as Event;

const stream = async function* (events: Event[]) {
  yield* events;
};

describe('the monthly token quota for runs started by the platform', () => {
  it('counts usage from the first of the month in UTC', async () => {
    let since = '';
    const admit = monthlyQuotaGate({
      monthlyTokens: () => 100,
      usedTokens: async (_tenant, from) => {
        since = from;
        return 10;
      },
      now: () => new Date('2026-10-09T03:00:00Z'),
    });

    expect(await admit('991825827')).toEqual({
      ok: true,
      budget: { inputTokens: 90, outputTokens: 90 },
    });
    expect(since).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('the cost of a run', () => {
  it('prices each model call and leaves the cost out when a model has no price', async () => {
    const prices = { a: { inputPerThousand: 0.05, outputPerThousand: 0.15 } };

    const priced = await costOf(stream([usage('a', 1000, 100), usage('a', 1000, 0)]), prices);
    const unpriced = await costOf(stream([usage('a', 1000, 0), usage('b', 10, 10)]), prices);

    expect(priced).toEqual({
      usage: { inputTokens: 2000, outputTokens: 100 },
      costMicroNok: 115_000,
    });
    expect(unpriced).toEqual({ usage: { inputTokens: 1010, outputTokens: 10 } });
  });
});

describe('the monthly token quota in the model gate', () => {
  const tenant = '991825827';
  const usedUp = gateQuota(async () => true);

  it('refuses a call in a run once the tenant has used its monthly tokens', async () => {
    expect(await usedUp({ tenant, capability: `${tenant}/klarsprak/default` })).toBe(
      quotaExhaustedMessage,
    );
    expect(
      await gateQuota(async () => false)({ tenant, capability: `${tenant}/klarsprak/default` }),
    ).toBeUndefined();
  });

  it('lets the builder assistant through, since it spends its own daily budget', async () => {
    expect(
      await usedUp({ tenant, capability: 'platform/draft/assistant/builder' }),
    ).toBeUndefined();
  });

  it('lets a call outside a run through, since the monthly quota counts only runs', async () => {
    expect(await usedUp({ tenant })).toBeUndefined();
  });
});

describe('the monthly token quota for a runtime', () => {
  const tenant = '991825827';
  const capability = `${tenant}/klarsprak/default`;

  it('reads usage at most every 15 seconds and refuses once the month is used', async () => {
    let at = new Date('2026-11-16T10:00:00Z');
    let used = 50;
    const reads: string[] = [];
    const check = monthlyModelQuota({
      monthlyTokens: () => 100,
      usedTokens: async (_tenant, since) => {
        reads.push(since);
        return used;
      },
      now: () => at,
    });

    expect(await check({ tenant, capability })).toBeUndefined();
    used = 100;
    at = new Date('2026-11-16T10:00:10Z');
    expect(await check({ tenant, capability })).toBeUndefined();
    at = new Date('2026-11-16T10:00:15Z');
    expect(await check({ tenant, capability })).toBe(quotaExhaustedMessage);
    expect(reads).toEqual(['2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z']);
  });
});
