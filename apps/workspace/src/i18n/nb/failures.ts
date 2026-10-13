import { defineNamespace } from '@genai/i18n';

export const failures = defineNamespace({
  platformTopic: 'Dette spørsmålet kan ikke besvares i denne tjenesten.',
  platformSources: 'Jeg fant ikke kilder som støtter et svar, så jeg svarer ikke på dette.',
  paused: 'Modellen tjenesten bruker er tatt ut av bruk',
  quotaTitle: 'Kvoten er brukt opp',
  quotaText:
    '{organisation} har brukt hele kvoten for {month}. Tjenesten virker igjen 1. {next}, eller når en administrator øker kvoten. Det du skrev, er ikke lagret.',
  unavailableTitle: 'Språkmodellen svarer ikke akkurat nå',
  unavailableText: 'Det er ikke noe galt med spørsmålet ditt. Prøv igjen om noen minutter.',
  tryAgain: 'Prøv igjen',
  serviceFailedTitle: 'Tjenesten feilet',
  serviceFailedText:
    'Noe gikk galt i tjenesten, ikke i spørsmålet ditt. Prøv igjen, eller se Feilmeldinger.',
  refusedTitle: 'Dette kan jeg ikke svare på',
  refusedText: 'Tjenesten svarer ikke på denne typen spørsmål.',
  noSourcesTitle: 'Fant ingen kilder',
  noSourcesText:
    'Jeg fant ikke noe i kildene som svarer på dette, så jeg svarer ikke. Prøv andre ord.',
  signedOutTitle: 'Du er logget ut',
  signedOutText: 'Last siden på nytt for å logge inn igjen. Det du skrev, er ikke lagret.',
  pausedTitle: 'Satt på pause',
  invalidTitle: 'Tjenesten kunne ikke bruke det du sendte',
  invalidText: 'Sjekk det du skrev, eller feltene i skjemaet, og send igjen.',
  noAccessTitle: 'Du har ikke tilgang til denne tjenesten',
  noAccessText:
    'Be den som gir tilganger i virksomheten din om tilgang, eller velg en annen tjeneste.',
  runFailed: 'Tjenesten feilet underveis.',
});
