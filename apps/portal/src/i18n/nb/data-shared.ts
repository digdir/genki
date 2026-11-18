import { defineNamespace } from '@genai/i18n';

export const sharedServicesMore = defineNamespace({
  lead: 'Ferdige tjenester fra Digdir. Bruk dem direkte, kall dem fra et system, eller legg dem inn i en av tjenestene deres.',
  pricePerThousandTokens: '{input} kr inn og {output} kr ut per 1 000 tokens',
  notPriced: 'Ikke beregnet',
  notPricedLine: 'pris ikke beregnet',
  priceUnavailable: 'Kunne ikke hente prisen',
  priceUnavailableLine: 'kunne ikke hente prisen',
  stored: 'Lagres',
  price: 'Pris',
  languages: 'Språk',
  notStatedYet: 'Ikke oppgitt ennå',
  orgNumber: 'Organisasjonsnummer {org}',
});

export const sharedLane = { sharedServicesMore } as const;
