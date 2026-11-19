import type { Format, T } from '../../i18n';
import type { ModelPrice } from '../../types';

export const perMillion = (price: ModelPrice) => ({
  input: price.inputPerThousand * 1000,
  output: price.outputPerThousand * 1000,
});

export const fromPerMillion = (input: number, output: number): ModelPrice => ({
  inputPerThousand: input / 1000,
  outputPerThousand: output / 1000,
});

export const priceText = (price: ModelPrice | null | undefined, f: Format, t: T) => {
  if (!price) return t('models.unpriced');
  const { input, output } = perMillion(price);
  return t('models.priceText', {
    input: f.number(input, { maximumFractionDigits: 4 }),
    output: f.number(output, { maximumFractionDigits: 4 }),
  });
};

export const priceInputText = (perThousand: number, f: Format) =>
  f.number(perThousand * 1000, { maximumFractionDigits: 6, useGrouping: false });
