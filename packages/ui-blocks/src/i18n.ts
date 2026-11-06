import { defineCatalogue, defineNamespace, type Translation } from '@genai/i18n';
import { defineTranslations } from '@genai/i18n/react';
import { enAnswer, nbAnswer } from './answer/i18n.js';
import { enStates, nbStates } from './states/i18n.js';
import { enVariantPicker, nbVariantPicker } from './variant-picker/i18n.js';
import { enThreads, nbThreads } from './threads/i18n.js';
import { enComposer, nbComposer } from './composer/i18n.js';
import { enWelcome, nbWelcome } from './welcome/i18n.js';
import { enCorpus, nbCorpus } from './corpus/catalogue.js';
import { enDocuments, nbDocuments } from './documents/catalogue.js';
import { enFilter, nbFilter } from './filter/catalogue.js';
import { enSettings, nbSettings } from './settings/i18n.js';
import { enAnswerActions, nbAnswerActions } from './answer-actions/i18n.js';
import { enConversation, nbConversation } from './conversation/i18n.js';
import { enShell, nbShell } from './shell/i18n.js';

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

const nbSources = defineNamespace({
  title: 'Kilder',
  noneTitle: 'Ingen kilder til dette svaret',
  none: 'Svaret viser ikke til noen utdrag fra dokumentene.',
  unaskedTitle: 'Ingen kilder ennå',
  unasked: 'Kildene vises her når du har stilt et spørsmål.',
  unaskedQuote:
    'Hvert utdrag er et sitat fra et dokument på {corpus}, med samme nummer som markøren i svaret.',
  unaskedQuoteNoCorpus:
    'Hvert utdrag er et sitat fra et dokument, med samme nummer som markøren i svaret.',
  abortedTitle: 'Svaret ble avbrutt før kildene kom',
  aborted:
    'Kildene kommer sist i et svar. Still spørsmålet på nytt for å se hvilke dokumenter det bygger på.',
  failedTitle: 'Svaret kom ikke fram',
  failed: 'Da kom kildene heller ikke. Prøv spørsmålet på nytt.',
  clarificationTitle: '{name} spurte om en avklaring',
  clarificationTitleUnnamed: 'KI-assistenten spurte om en avklaring',
  clarification: 'Kildene kommer når du har svart på spørsmålet i samtalen.',
  notStoredTitle: 'Kildene er ikke lagret for denne samtalen',
  notStored:
    'Svaret viser til utdrag, men de ble ikke lagret sammen med samtalen. Still spørsmålet på nytt for å få et svar med kilder du kan åpne.',
  notKept:
    'Kildene blir ikke lagret sammen med samtalen. Still spørsmålet på nytt for å se hvilke dokumenter svaret bygger på.',
  answerOf: 'Kilder til svar {n} av {total}',
  previousAnswer: 'Forrige svar',
  nextAnswer: 'Neste svar',
  loading: 'Henter kilder …',
  untitled: 'Kilde uten tittel',
  disclaimer:
    'All tekst er sitater fra dokumentene fra {corpus}. Ikke generert av kunstig intelligens.',
  disclaimerWithOwn:
    'All tekst er sitater fra dokumentene, både fra {corpus} og fra dine egne dokumenter. Ikke generert av kunstig intelligens.',
  disclaimerNoCorpus: 'All tekst er sitater fra dokumentene. Ikke generert av kunstig intelligens.',
  sameTitle: '{title}, dokument {id}',
  ownDocument: 'Ditt dokument',
  published: 'Publisert {date}',
  version: 'versjon {version}',
  excerptNumber: 'Utdrag {n}',
  excerptUnnumbered: 'Utdrag',
  uncited: 'Ikke vist til i svaret',
  open: 'Åpne',
  close: 'Lukk',
  excerptName: 'utdrag {n}',
  excerptNameOfTotal: 'utdrag {n} av {total}',
  showPassages: 'Vis utdrag fra dokumentet ({count})',
  hidePassages: 'Skjul utdrag fra dokumentet ({count})',
  toAnswer: 'Til svaret',
  toAnswerFrom: '{label}, til svaret',
  use: 'bruk',
  useWhere: 'fotnote {n} av {total}',
  useWhereInAnswer: 'fotnote {n} av {total} i svar {answer}',
  page: 'side {page}',
  excerptUnavailable: 'Utdraget er ikke tilgjengelig.',
  excerptLoading: 'Henter utdraget …',
  backToAnswer: 'Tilbake til svaret',
  readDocument: 'Les dokumentet',
  readDocumentOn: 'Les dokumentet på {corpus}',
  readPage: 'Les side {page}',
  readPageOn: 'Les side {page} på {corpus}',
  opensInNewTab: '(åpnes i ny fane)',
  noPublicLink: 'Dokumentet har ingen offentlig lenke.',
  ownDocumentNoLink: 'Bare du har dette dokumentet, så det finnes ingen lenke til det.',
  details: 'Detaljer om {title}',
  detailDocument: 'Dokument',
  detailVersion: 'Versjon',
  detailChunk: 'Tekstbit',
  detailPart: 'del {n}',
  search: 'Søk i kildene',
  searchPlaceholder: 'Søk',
  clearSearch: 'Tøm søket',
  searchMin: 'Skriv minst {n} tegn',
  searchNone: 'Ingen treff',
  searchCount: '{n} av {total} treff',
  previous: 'Forrige',
  next: 'Neste',
  previousHit: 'Forrige treff',
  nextHit: 'Neste treff',
});

const enSources = {
  title: 'Sources',
  noneTitle: 'No sources for this answer',
  none: 'The answer cites no excerpts from the documents.',
  unaskedTitle: 'No sources yet',
  unasked: 'The sources show here once you have asked a question.',
  unaskedQuote:
    'Each excerpt is a quote from a document in {corpus}, with the same number as the marker in the answer.',
  unaskedQuoteNoCorpus:
    'Each excerpt is a quote from a document, with the same number as the marker in the answer.',
  abortedTitle: 'The answer was stopped before the sources came',
  aborted:
    'The sources come last in an answer. Ask the question again to see which documents it builds on.',
  failedTitle: 'The answer did not arrive',
  failed: 'So the sources did not either. Ask the question again.',
  clarificationTitle: '{name} asked for a clarification',
  clarificationTitleUnnamed: 'The AI assistant asked for a clarification',
  clarification: 'The sources come once you have answered the question in the conversation.',
  notStoredTitle: 'The sources are not stored for this conversation',
  notStored:
    'The answer cites excerpts, but they were not stored with the conversation. Ask the question again to get an answer with sources you can open.',
  notKept:
    'The sources are not stored with the conversation. Ask the question again to see which documents the answer builds on.',
  answerOf: 'Sources for answer {n} of {total}',
  previousAnswer: 'Previous answer',
  nextAnswer: 'Next answer',
  loading: 'Loading sources …',
  untitled: 'Untitled source',
  disclaimer:
    'All text is quoted from the documents in {corpus}. Not generated by artificial intelligence.',
  disclaimerWithOwn:
    'All text is quoted from the documents, both in {corpus} and your own documents. Not generated by artificial intelligence.',
  disclaimerNoCorpus:
    'All text is quoted from the documents. Not generated by artificial intelligence.',
  sameTitle: '{title}, document {id}',
  ownDocument: 'Your document',
  published: 'Published {date}',
  version: 'version {version}',
  excerptNumber: 'Excerpt {n}',
  excerptUnnumbered: 'Excerpt',
  uncited: 'Not cited in the answer',
  open: 'Open',
  close: 'Close',
  excerptName: 'excerpt {n}',
  excerptNameOfTotal: 'excerpt {n} of {total}',
  showPassages: 'Show excerpts from the document ({count})',
  hidePassages: 'Hide excerpts from the document ({count})',
  toAnswer: 'To the answer',
  toAnswerFrom: '{label}, to the answer',
  use: 'use',
  useWhere: 'footnote {n} of {total}',
  useWhereInAnswer: 'footnote {n} of {total} in answer {answer}',
  page: 'page {page}',
  excerptUnavailable: 'The excerpt is not available.',
  excerptLoading: 'Fetching the excerpt …',
  backToAnswer: 'Back to the answer',
  readDocument: 'Read the document',
  readDocumentOn: 'Read the document in {corpus}',
  readPage: 'Read page {page}',
  readPageOn: 'Read page {page} in {corpus}',
  opensInNewTab: '(opens in a new tab)',
  noPublicLink: 'The document has no public link.',
  ownDocumentNoLink: 'Only you have this document, so there is no link to it.',
  details: 'Details about {title}',
  detailDocument: 'Document',
  detailVersion: 'Version',
  detailChunk: 'Chunk',
  detailPart: 'part {n}',
  search: 'Search the sources',
  searchPlaceholder: 'Search',
  clearSearch: 'Clear the search',
  searchMin: 'Type at least {n} characters',
  searchNone: 'No matches',
  searchCount: '{n} of {total} matches',
  previous: 'Previous',
  next: 'Next',
  previousHit: 'Previous match',
  nextHit: 'Next match',
} satisfies Translation<typeof nbSources>;

export const nb = defineCatalogue({
  procedure: nbProcedure,
  sources: nbSources,
  answer: nbAnswer,
  states: nbStates,
  variantPicker: nbVariantPicker,
  threads: nbThreads,
  composer: nbComposer,
  welcome: nbWelcome,
  filter: nbFilter,
  corpus: nbCorpus,
  documents: nbDocuments,
  settings: nbSettings,
  answerActions: nbAnswerActions,
  conversation: nbConversation,
  shell: nbShell,
});
export const en = {
  procedure: enProcedure,
  sources: enSources,
  answer: enAnswer,
  states: enStates,
  variantPicker: enVariantPicker,
  threads: enThreads,
  composer: enComposer,
  welcome: enWelcome,
  filter: enFilter,
  corpus: enCorpus,
  documents: enDocuments,
  settings: enSettings,
  answerActions: enAnswerActions,
  conversation: enConversation,
  shell: enShell,
} satisfies Translation<typeof nb>;

export const { useT, translator } = defineTranslations({ nb, en });
