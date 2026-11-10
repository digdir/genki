import { describe, expect, it } from 'vitest';
import { combine, genkiSource, sumUsage } from './combine.js';
import { inNok, rateFor } from './money.js';
import { organisationOf, type UsageRow } from './usage.js';

const tenant = '991825827';

const row = (source: string, extra: Partial<UsageRow> = {}): UsageRow => ({
  source,
  start: '2026-10-12T09:00:00.000Z',
  closed: true,
  model: 'gpt-test',
  inputTokens: 100,
  outputTokens: 10,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  requests: 1,
  unpricedRequests: 0,
  cost: { currency: 'USD', micros: 1000 },
  ...extra,
});

const own = row('gateway', { subject: { kind: 'org', id: tenant } });
const measured = row(genkiSource, { cost: { currency: 'NOK', micros: 5000 } });
const throughGenkiKey = row('gateway', {
  subject: { kind: 'genki', id: tenant, org: tenant },
  cost: { currency: 'USD', micros: 700 },
});

describe('combine', () => {
  it('stores a gateway row under genki:<tenant> but does not count it while genki calls the model directly', () => {
    const counted = combine([own, measured, throughGenkiKey]);

    expect(counted).toEqual([own, measured]);
  });

  it("counts a call through the gateway once: tokens from genki's record, cost from the gateway", () => {
    const counted = combine([own, measured, throughGenkiKey], {
      throughGateway: (model) => model === 'gpt-test',
    });
    const sum = sumUsage(counted);

    expect(sum.inputTokens).toBe(200);
    expect(sum.requests).toBe(2);
    expect(sum.cost).toEqual([
      { currency: 'NOK', micros: 0 },
      { currency: 'USD', micros: 1700 },
    ]);
  });

  it("counts a tenant's own gateway calls in full whatever genki routes", () => {
    expect(combine([own], { throughGateway: () => true })).toEqual([own]);
  });

  it('keeps one amount per currency, so a sum stays exact', () => {
    expect(sumUsage([own, measured]).cost).toEqual([
      { currency: 'NOK', micros: 5000 },
      { currency: 'USD', micros: 1000 },
    ]);
  });
});

describe('money', () => {
  const rates = [
    { currency: 'USD', day: '2026-10-09', nokPerUnit: 10.5 },
    { currency: 'USD', day: '2026-10-12', nokPerUnit: 11 },
    { currency: 'EUR', day: '2026-10-12', nokPerUnit: 11.7 },
  ];

  it("uses the rate for the row's day, or the latest day before it", () => {
    expect(rateFor('USD', '2026-10-12', rates)?.nokPerUnit).toBe(11);
    expect(rateFor('USD', '2026-10-11', rates)?.day).toBe('2026-10-09');
    expect(inNok({ currency: 'USD', micros: 1_000_000 }, '2026-10-10', rates)).toEqual({
      micros: 10_500_000,
      rate: rates[0],
    });
  });

  it('leaves an amount without a rate unpriced in kroner, never 0', () => {
    expect(inNok({ currency: 'USD', micros: 1000 }, '2026-10-01', rates)).toBeUndefined();
    expect(inNok({ currency: 'SEK', micros: 1000 }, '2026-10-12', rates)).toBeUndefined();
  });

  it('takes kroner as they are, without a rate', () => {
    expect(inNok({ currency: 'NOK', micros: 1234 }, '2026-10-01', [])).toEqual({ micros: 1234 });
  });
});

describe('subject to organisation', () => {
  it('maps org, team, service, user and genki owners to an organisation, and keys or no owner to none', () => {
    expect(organisationOf({ kind: 'org', id: tenant })).toBe(tenant);
    expect(organisationOf({ kind: 'service', id: 'ka', org: tenant })).toBe(tenant);
    expect(organisationOf({ kind: 'team', id: 'a', org: tenant })).toBe(tenant);
    expect(organisationOf({ kind: 'user', id: 'p1', org: tenant })).toBe(tenant);
    expect(organisationOf({ kind: 'genki', id: tenant, org: tenant })).toBe(tenant);
    expect(organisationOf({ kind: 'apiKey', id: 'k_1' })).toBeUndefined();
    expect(organisationOf({ kind: 'service', id: 'ka' })).toBeUndefined();
    expect(organisationOf(undefined)).toBeUndefined();
  });
});
