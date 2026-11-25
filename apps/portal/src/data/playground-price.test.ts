import { describe, expect, it } from 'vitest';
import type { PlaygroundModelOption, PlaygroundPrice } from '../api/playground';
import { priceText } from './playground';

const option = (price: PlaygroundPrice | null): PlaygroundModelOption => ({
  id: 'm',
  name: 'M',
  dataLocation: 'norway',
  status: 'allowed',
  price,
});

describe('the price of a model in the playground', () => {
  it('calls a model priced at nothing free, and keeps "Ikke priset" for a model without a price', () => {
    expect(priceText(option({ inputPerThousand: 0, outputPerThousand: 0 }))).toBe('Gratis');
    expect(priceText(option(null))).toBe('Ikke priset');
  });

  it('gives the price in and out per 1M tokens with two decimals', () => {
    expect(priceText(option({ inputPerThousand: 0.0011125, outputPerThousand: 0.0055624 }))).toBe(
      'inn 1,11 kr / ut 5,56 kr per 1M tokens',
    );
  });
});
