import { defineNamespace } from '@genai/i18n';

export const errors = defineNamespace({
  heading: 'Feilmeldinger',
  intro: 'Dine kjøringer som feilet de siste 30 dagene.',
  loading: 'Henter kjøringer som feilet …',
  loadFailed: 'Vi kunne ikke hente kjøringene dine.',
  noAccess: 'Du har ikke tilgang til å se kjøringer i denne virksomheten.',
  tryAgain: 'Prøv igjen',
  empty: 'Ingen av kjøringene dine har feilet de siste 30 dagene.',
  today: 'I dag kl. {time}',
  yesterday: 'I går kl. {time}',
  onDay: '{day} kl. {time}',
  retryWith: 'Prøv igjen med {service}',
});
