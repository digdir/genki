import type { Format } from '@genai/i18n';
import type { AsyncState } from '../../hooks';
import type { T } from '../../i18n';
import type { ModelOption, SharedService } from '../../types';

export interface SharedServiceFacts extends SharedService {
  storage?: { keepsText: boolean; logDays: number };
  languages?: { in: string[]; out: 'same' | string };
  estimatedCostPerThousandRuns?: { microNok: number; basis: string };
}

export const priceText = (
  t: T,
  f: Format,
  service: Pick<SharedServiceFacts, 'model' | 'estimatedCostPerThousandRuns'>,
  models: AsyncState<ModelOption[]>,
  inLine = false,
) => {
  const perRun = service.estimatedCostPerThousandRuns;
  if (perRun) {
    const price = f.number(perRun.microNok / 1_000_000, { maximumFractionDigits: 2 });
    return inLine
      ? t('sharedServicesMore.perRunsLine', { price })
      : t('sharedServicesMore.perRuns', { price, basis: perRun.basis });
  }
  if (models.status === 'error')
    return t(
      inLine ? 'sharedServicesMore.priceUnavailableLine' : 'sharedServicesMore.priceUnavailable',
    );
  const model = service.model;
  const price =
    model && models.status === 'ready' ? models.data.find((m) => m.id === model)?.price : undefined;
  if (!price)
    return t(inLine ? 'sharedServicesMore.notPricedLine' : 'sharedServicesMore.notPriced');
  return t('sharedServicesMore.pricePerThousandTokens', {
    input: f.number(price.inputPerThousand, { maximumFractionDigits: 4 }),
    output: f.number(price.outputPerThousand, { maximumFractionDigits: 4 }),
  });
};

const languageKeys = {
  nb: 'sharedServicesMore.langNb',
  nn: 'sharedServicesMore.langNn',
  en: 'sharedServicesMore.langEn',
} as const;

const languageName = (t: T, code: string) =>
  code in languageKeys ? t(languageKeys[code as keyof typeof languageKeys]) : code;

export const storageText = (t: T, storage: SharedServiceFacts['storage']) =>
  !storage
    ? t('sharedServicesMore.notStatedYet')
    : storage.keepsText
      ? t('sharedServicesMore.keepsText', { days: storage.logDays })
      : t('sharedServicesMore.keepsNoText', { days: storage.logDays });

export const languagesText = (t: T, languages: SharedServiceFacts['languages']) => {
  if (!languages?.in.length) return t('sharedServicesMore.notStatedYet');
  const names = languages.in.map((code) => languageName(t, code));
  const last = names.pop() ?? '';
  const list = names.length
    ? t('sharedServicesMore.andList', { first: names.join(', '), last })
    : last;
  const input = list.charAt(0).toUpperCase() + list.slice(1);
  return languages.out === 'same'
    ? t('sharedServicesMore.languagesSame', { input })
    : t('sharedServicesMore.languagesTo', { input, output: languageName(t, languages.out) });
};
