import { defineNamespace, type Translation } from '@genai/i18n';

export const nbAnswer = defineNamespace({
  said: '{name} svarte:',
  saidUnnamed: 'KI-assistenten svarte:',
  footnote: 'Utdrag {n}: {title}',
  footnoteDocument: 'Kilde: {title}',
  sourceLost: 'Kilden kom ikke fram',
  sourceLostNote: '(kilden kom ikke fram)',
  writing: 'Skriver svar …',
  noSources: 'Svaret har ingen kilder. Kontroller det mot originaldokumentene før du bruker det.',
  aborted: 'Svaret ble avbrutt, så kildene bak det kom aldri fram.',
  abortedBeforeAnswer: 'Du stoppet søket før svaret begynte.',
  failed: 'Dette spørsmålet fikk ikke noe svar. Noe gikk galt underveis.',
  regenerate: 'Generer på nytt',
  closingQuestion: 'Er det noe mer jeg kan hjelpe deg med?',
  sourcesUsed: 'Kilder brukt i svaret',
  excerpts: { one: 'Utdrag {numbers}', other: 'Utdrag {numbers}' },
  table: 'Tabell',
  tableNumber: 'Tabell {n}',
  tableColumns: { one: '{table} med kolonnen {columns}', other: '{table} med kolonnene {columns}' },
  moreColumns: '{more} til',
});

export const enAnswer = {
  said: '{name} answered:',
  saidUnnamed: 'The AI assistant answered:',
  footnote: 'Excerpt {n}: {title}',
  footnoteDocument: 'Source: {title}',
  sourceLost: 'The source never arrived',
  sourceLostNote: '(the source never arrived)',
  writing: 'Writing the answer …',
  noSources:
    'The answer has no sources. Check it against the original documents before you use it.',
  aborted: 'The answer was stopped, so the sources behind it never arrived.',
  abortedBeforeAnswer: 'You stopped the search before the answer began.',
  failed: 'This question got no answer. Something went wrong on the way.',
  regenerate: 'Generate again',
  closingQuestion: 'Is there anything else I can help you with?',
  sourcesUsed: 'Sources used in the answer',
  excerpts: { one: 'Excerpt {numbers}', other: 'Excerpts {numbers}' },
  table: 'Table',
  tableNumber: 'Table {n}',
  tableColumns: {
    one: '{table} with the column {columns}',
    other: '{table} with the columns {columns}',
  },
  moreColumns: '{more} more',
} satisfies Translation<typeof nbAnswer>;
