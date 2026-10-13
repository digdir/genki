import { defineNamespace } from '@genai/i18n';

export const answer = defineNamespace({
  conversation: 'Samtale',
  attached: 'Vedlagt: {names}',
  youWrote: 'Du skrev: ',
  version: 'versjon {version}',
  excerpt: 'Utdrag',
  noAnswer: 'Fant ikke noe svar i kildene',
  aiTag: 'Svar laget med KI',
  working: 'Lager svar …',
  table: 'Tabell',
  rows: { one: '{count} rad', other: '{count} rader' },
  unreadable: ', {count} kunne ikke leses',
  openTable: 'Åpne tabellen med kilder',
  sources: 'Kilder',
  cite: 'Kilde {n}: {title}',
  untitledSource: 'Kilde uten tittel',
});
