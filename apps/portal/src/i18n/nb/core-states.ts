import { defineNamespace } from '@genai/i18n';

export const states = defineNamespace({
  fallbackRefusal: 'Du har ikke tilgang til dette for virksomheten du har valgt.',
  quotaUsedUp: 'Månedskvoten for tokens er brukt opp',
  tooManySeconds: {
    one: 'For mange kall. Prøv igjen om {count} sekund.',
    other: 'For mange kall. Prøv igjen om {count} sekunder.',
  },
  tooMany: 'For mange kall. Prøv igjen om litt.',
  signedOut: 'Du er ikke logget inn lenger. Logg inn på nytt.',
  notFound: 'Vi fant ikke det du lette etter.',
  fetchFailed: 'Noe gikk galt da vi hentet dataene. Prøv igjen om litt.',
  noAccess: 'Du har ikke tilgang',
  seeUsage: 'Se forbruket',
  couldNotFetch: 'Kunne ikke hente dataene',
});
