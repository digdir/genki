import { describe, expect, it } from 'vitest';
import {
  kernelOwnedEventTypes,
  perThousandView,
  pricedUsage,
  strategyEventTypes,
  textPart,
  unitPricesFor,
} from './index.js';

describe('contracts', () => {
  it('builds a tagged plain text part', () => {
    expect(textPart('hei')).toEqual({ mime: 'text/plain', body: { kind: 'text', text: 'hei' } });
  });

  it('keeps every core event type in the kernel namespace', () => {
    expect(
      [...strategyEventTypes, ...kernelOwnedEventTypes].every((t) => t.startsWith('kernel.')),
    ).toBe(true);
  });

  it('never lets a strategy emit an event the kernel owns', () => {
    const owned = new Set<string>(kernelOwnedEventTypes);
    expect(strategyEventTypes.some((t) => owned.has(t))).toBe(false);
  });
});

describe('prices per unit', () => {
  const prices = { 'input-token': 0.00001, 'output-token': 0.00004 };

  it('a call is priced per unit it reports, in micro-kroner', () => {
    expect(pricedUsage({ inputTokens: 1000, outputTokens: 500, requests: 1 }, prices)).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      requests: 1,
      costMicroNok: 30_000,
    });
  });

  it('a call that reports a unit without a price is metered and left unpriced', () => {
    const usage = { inputTokens: 10, images: 2, requests: 1 };
    expect(pricedUsage(usage, prices)).toEqual(usage);
    expect(pricedUsage(usage, undefined)).toEqual(usage);
  });

  it('a unit a descriptor names is priced like a built-in unit, and an unpriced one leaves the call unpriced', () => {
    const usage = { requests: 1, units: { page: 4 } };
    expect(pricedUsage(usage, { page: 0.25 }).costMicroNok).toBe(1_000_000);
    expect(pricedUsage(usage, { 'input-token': 0.01 })).toEqual(usage);
  });

  it('a request costs nothing unless the price names request', () => {
    expect(pricedUsage({ requests: 3 }, prices).costMicroNok).toBe(0);
    expect(pricedUsage({ requests: 3 }, { request: 0.5 }).costMicroNok).toBe(1_500_000);
  });

  it('cached input tokens take their own price when it is set, and the input price otherwise', () => {
    const usage = { inputTokens: 1000, cachedInputTokens: 600 };
    expect(pricedUsage(usage, prices).costMicroNok).toBe(10_000);
    expect(pricedUsage(usage, { ...prices, 'cached-input-token': 0.000001 }).costMicroNok).toBe(
      4_600,
    );
  });

  it('a cost the provider reported is kept', () => {
    expect(pricedUsage({ inputTokens: 5, costMicroNok: 7 }, prices).costMicroNok).toBe(7);
  });

  it('a price per 1,000 tokens from before ADR 0048 holds for every kind, and reads back the same', () => {
    const legacy = { inputPerThousand: 0.0238, outputPerThousand: 0.0952 };
    expect(unitPricesFor(legacy, 'decide')).toEqual({
      'input-token': 0.0000238,
      'output-token': 0.0000952,
    });
    expect(perThousandView({ embed: { 'input-token': 0.0000012 } })).toEqual({
      inputPerThousand: 0.0012,
      outputPerThousand: 0,
    });
    expect(perThousandView({ chat: unitPricesFor(legacy, 'chat') ?? {} })).toEqual(legacy);
  });
});
