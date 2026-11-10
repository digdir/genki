import type { Money } from './usage.js';

export interface CurrencyRate {
  currency: string;
  /** The day the rate applies from, `YYYY-MM-DD`. */
  day: string;
  nokPerUnit: number;
}

export const nok = 'NOK';

/** The rate for a day, or the latest day before it. */
export const rateFor = (
  currency: string,
  day: string,
  rates: readonly CurrencyRate[],
): CurrencyRate | undefined => {
  let found: CurrencyRate | undefined;
  for (const rate of rates)
    if (rate.currency === currency && rate.day <= day && (!found || rate.day > found.day))
      found = rate;
  return found;
};

/** An amount in millionths of a krone, with the rate used; none when no rate is known, never 0. */
export const inNok = (
  money: Money,
  day: string,
  rates: readonly CurrencyRate[],
): { micros: number; rate?: CurrencyRate } | undefined => {
  if (money.currency === nok) return { micros: money.micros };
  const rate = rateFor(money.currency, day, rates);
  return rate ? { micros: Math.round(money.micros * rate.nokPerUnit), rate } : undefined;
};
