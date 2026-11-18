import type { Format } from '@genai/i18n';
import type { AsyncState } from '../../hooks';
import type { T } from '../../i18n';
import type { ModelOption } from '../../types';

export const priceText = (
  t: T,
  f: Format,
  model: string | null | undefined,
  models: AsyncState<ModelOption[]>,
  inLine = false,
) => {
  if (models.status === 'error')
    return t(
      inLine ? 'sharedServicesMore.priceUnavailableLine' : 'sharedServicesMore.priceUnavailable',
    );
  const price =
    model && models.status === 'ready' ? models.data.find((m) => m.id === model)?.price : undefined;
  if (!price)
    return t(inLine ? 'sharedServicesMore.notPricedLine' : 'sharedServicesMore.notPriced');
  return t('sharedServicesMore.pricePerThousandTokens', {
    input: f.number(price.inputPerThousand, { maximumFractionDigits: 4 }),
    output: f.number(price.outputPerThousand, { maximumFractionDigits: 4 }),
  });
};
