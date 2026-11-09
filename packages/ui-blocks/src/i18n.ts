import { defineCatalogue, defineNamespace, type Translation } from '@genai/i18n';
import { defineTranslations } from '@genai/i18n/react';
import { enAnswerActions, nbAnswerActions } from './answer-actions/i18n.js';
import { enShell, nbShell } from './shell/i18n.js';
import { enBuilder, nbBuilder } from './builder/i18n.js';

const nbProcedure = defineNamespace({
  title: 'Fremgangsmåte',
  done: 'ferdig',
  active: 'pågår',
  waiting: 'venter',
  workingFor: { one: 'Har jobbet i {count} sekund', other: 'Har jobbet i {count} sekunder' },
  read: { one: 'Leste {count} dokument', other: 'Leste {count} dokumenter' },
  used: 'brukte {count}',
  usedOnly: { one: 'Brukte {count} kilde', other: 'Brukte {count} kilder' },
  took: { one: 'tok {count} sekund', other: 'tok {count} sekunder' },
  tookOnly: { one: 'Tok {count} sekund', other: 'Tok {count} sekunder' },
  usedInAnswer: 'Brukt i svaret: kilde {sources}.',
  showRead: { one: 'Vis det som ble lest', other: 'Vis de {count} som ble lest' },
  showReadSoFar: { one: 'Vis det som er lest', other: 'Vis de {count} som er lest' },
  explainMissing: 'Utdyp hva som mangler',
  stepOf: 'Steg {n} av {total}: {title}',
  step: 'Steg {n}: {title}',
});

const enProcedure = {
  title: 'Approach',
  done: 'done',
  active: 'in progress',
  waiting: 'waiting',
  workingFor: { one: 'Has worked for {count} second', other: 'Has worked for {count} seconds' },
  read: { one: 'Read {count} document', other: 'Read {count} documents' },
  used: 'used {count}',
  usedOnly: { one: 'Used {count} source', other: 'Used {count} sources' },
  took: { one: 'took {count} second', other: 'took {count} seconds' },
  tookOnly: { one: 'Took {count} second', other: 'Took {count} seconds' },
  usedInAnswer: 'Used in the answer: source {sources}.',
  showRead: { one: 'Show what was read', other: 'Show the {count} that were read' },
  showReadSoFar: { one: 'Show what has been read', other: 'Show the {count} read so far' },
  explainMissing: 'Say more about what is missing',
  stepOf: 'Step {n} of {total}: {title}',
  step: 'Step {n}: {title}',
} satisfies Translation<typeof nbProcedure>;

export const nb = defineCatalogue({
  procedure: nbProcedure,
  answerActions: nbAnswerActions,
  shell: nbShell,
  builder: nbBuilder,
});
export const en = {
  procedure: enProcedure,
  answerActions: enAnswerActions,
  shell: enShell,
  builder: enBuilder,
} satisfies Translation<typeof nb>;

export const { useT, translator } = defineTranslations({ nb, en });
