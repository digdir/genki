import type { Format, T } from '../../i18n';
import type { ModelPrice } from '../../types';

export const priceText = (price: ModelPrice | null | undefined, f: Format, t: T) =>
  price
    ? t('models.priceText', {
        input: f.number(price.inputPerThousand, { maximumFractionDigits: 4 }),
        output: f.number(price.outputPerThousand, { maximumFractionDigits: 4 }),
      })
    : t('models.unpriced');
