import { defineNamespace } from '@genai/i18n';

export const schemas = defineNamespace({
  page: 'Skjemaer',
  eyebrow: 'For utviklere',
  intro:
    'Alt som kan settes opp på plattformen, beskrevet med skjemaene API-et håndhever. Skjemaet under er laget direkte fra skjemaet, uten egen kode for skjermbildet.',
  loading: 'Henter skjemaer',
  choose: 'Skjema',
  empty: 'API-et har ingen skjemaer ennå.',
  formTitle: 'Utfylling',
  preview: 'Dette ville blitt sendt',
  check: 'Sjekk utfyllingen',
  valid: 'Utfyllingen passer med skjemaet.',
  reset: 'Tøm',
  version: 'Versjon {version}',
});
