import { defineNamespace } from '@genai/i18n';

export const form = defineNamespace({
  required: 'Må fylles ut',
  fillIn: 'Fyll ut «{label}».',
  chooseFirst: 'Velg {label} først',
  noMatches: 'Ingen treff',
  clear: 'Tøm {label}',
  searchAmong: 'Skriv for å søke blant {count} valg.',
  chooseMany: 'Du kan velge flere.',
  choose: 'Velg',
});
