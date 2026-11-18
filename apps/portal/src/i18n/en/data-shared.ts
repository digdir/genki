import type { Translation } from '@genai/i18n';
import type { sharedLane as source } from '../nb/data-shared';

export const sharedLane = {
  sharedServicesMore: {
    lead: 'Ready-made services from Digdir. Use them directly, call them from a system, or add them to one of your services.',
    pricePerThousandTokens: '{input} kr in and {output} kr out per 1,000 tokens',
    notPriced: 'Not calculated',
    notPricedLine: 'price not calculated',
    priceUnavailable: 'Could not fetch the price',
    priceUnavailableLine: 'could not fetch the price',
    stored: 'Stored',
    price: 'Price',
    languages: 'Languages',
    notStatedYet: 'Not stated yet',
    orgNumber: 'Organisation number {org}',
  },
} satisfies Translation<typeof source>;
