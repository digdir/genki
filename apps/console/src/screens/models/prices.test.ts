import { createFormat } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { translator } from '../../i18n';
import { fromPerMillion, priceInputText, priceText } from './prices';

const price = { inputPerThousand: 0.0025, outputPerThousand: 0.075 };

describe('model prices in the console', () => {
  it('shows the per-thousand price from the API as kroner per 1M tokens', () => {
    expect(priceText(price, createFormat('nb'), translator('nb'))).toBe('2,5 kr inn, 75 kr ut');
    expect(priceText(price, createFormat('en'), translator('en'))).toContain('2.5');
  });

  it('labels the price column per 1M tokens', () => {
    expect(translator('nb')('models.colPrice')).toBe('Pris per 1M tokens');
    expect(translator('en')('models.colPrice')).toBe('Price per 1M tokens');
  });

  it('fills the price dialog per 1M tokens without digit grouping', () => {
    expect(priceInputText(0.0025, createFormat('nb'))).toBe('2,5');
    expect(priceInputText(15, createFormat('nb'))).toBe('15000');
  });

  it('saves a price entered per 1M tokens as per thousand for the API', () => {
    expect(fromPerMillion(2.5, 75)).toEqual(price);
  });
});
