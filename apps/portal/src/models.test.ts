import { describe, expect, it } from 'vitest';
import type { CatalogModel } from './api/models';
import { entriesOf, pageOf, priceBandOf, sortEntries } from './models';

const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id,
  residency: 'eu',
  capabilities: [],
  operations: ['chat'],
  price: null,
  available: true,
  ...extra,
});

describe('model entries', () => {
  it('takes in use and pending approval from the building blocks but never lets them override what /models says the tenant may use', () => {
    const [used, pending, stale, free] = entriesOf(
      [
        model('used'),
        model('pending', { available: false, reason: 'requires_approval' }),
        model('stale', { available: false, reason: 'not_allowed' }),
        model('free'),
      ],
      [
        { id: 'used', status: 'in_use', usedBy: [{ id: 's', name: 'S' }] },
        { id: 'pending', status: 'pending_approval', usedBy: [] },
        { id: 'stale', status: 'in_use', usedBy: [] },
        { id: 'free', status: 'not_allowed', usedBy: [] },
      ],
    );
    expect(used).toMatchObject({ status: 'in_use', usedBy: [{ name: 'S' }] });
    expect(pending?.status).toBe('pending_approval');
    expect(stale?.status).toBe('not_allowed');
    expect(free?.status).toBe('available');
  });

  it('puts a model in a price band by its input price per 1M tokens', () => {
    const per1k = (input: number) => ({ inputPerThousand: input, outputPerThousand: input });
    expect(priceBandOf(model('a'))).toBe('unpriced');
    expect(priceBandOf(model('a', { price: per1k(0.0099) }))).toBe('under10');
    expect(priceBandOf(model('a', { price: per1k(0.05) }))).toBe('from10to50');
    expect(priceBandOf(model('a', { price: per1k(0.051) }))).toBe('over50');
  });

  it('sorts recommended models first, then the ones the tenant can use', () => {
    const sorted = sortEntries(
      entriesOf([
        model('a', { available: false, reason: 'requires_approval' }),
        model('b'),
        model('c', { recommended: true }),
      ]),
      'recommended',
    ).map((m) => m.id);
    expect(sorted).toEqual(['c', 'b', 'a']);
  });

  it('clamps a page past the end to the last page', () => {
    expect(pageOf([1, 2, 3], 9, 2)).toMatchObject({ current: 2, from: 3, to: 3, items: [3] });
  });
});
