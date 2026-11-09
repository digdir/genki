// The assembly's words, with bokmål as the source and English held to it, as the blocks keep
// theirs. The blocks' catalogue is part of it, so a word a block already has is read from there:
// the blocks' names from `builder`, «Ny tråd» from `threads`, «Avgrenset til» from `conversation`.
import { defineCatalogue, defineNamespace, intlLocale, type Translation } from '@genai/i18n';
import { defineTranslations } from '@genai/i18n/react';
import { uiBlocksEn, uiBlocksNb } from '@genai/ui-blocks';

const nbAssembly = defineNamespace({
  threadNotFoundTitle: 'Fant ikke tråden',
  threadNotFound: 'Den kan være slettet, eller lenken kan være feil.',
  threadFailed: 'Kunne ikke hente tråden',
  emptyThreadTitle: 'Tråden har ingen meldinger ennå',
  emptyThread: 'Still et spørsmål for å starte samtalen.',
  serviceFailedTitle: 'Fikk ikke kontakt med tjenesten',
  serviceFailed: 'Spørsmål kan ikke sendes før tjenesten svarer. Feilen var: {error}',
  technicalDetails: 'Tekniske detaljer',
  stripChange: 'Endre',
  stripClose: 'Lukk',
  showInDocument: 'Vis i dokumentet',
  approachEmpty: 'Fremgangsmåten vises her når du stiller et spørsmål.',
  approachNotKept:
    'Fremgangsmåten lagres ikke med svarene i tråden. Den vises her når du stiller et nytt spørsmål.',
  approachWaiting: 'Venter på det første steget …',
  noChatTitle: 'Legg Chat i innholdet for å prøve assistenten.',
  noChat: 'Uten Chat er det ingen samtale å prøve.',
  emptyMain: 'Ingen klosser i innholdet.',
  skipToField: 'Hopp til skrivefeltet ({modifier} + /)',
  corpusChanged: 'Byttet til {corpus}. Du har fått en ny tråd, og filteret er tømt.',
  tabTitle: '{page} – {assistant}',
  aboutDocument: 'Om «{title}»: {question}',
  stepPlanQueries: 'Forsto spørsmålet',
  stepInspectFilters: 'Så på hvilke kilder tråden leser fra',
  stepSearch: 'Lette etter steder som handler om spørsmålet',
  stepReadChunks: 'Leste de relevante delene nøye',
  stepRerankResults: 'Valgte ut det som svarer på spørsmålet',
  stepReportGaps: 'Det jeg ikke fant',
  stepGenerateResponse: 'Skrev svaret',
  stepPassages: { one: 'Leste {count} utdrag nøye', other: 'Leste {count} utdrag nøye' },
  stepRepeated: { one: '{title} ({count} gang)', other: '{title} ({count} ganger)' },
});

const enAssembly = {
  threadNotFoundTitle: 'Thread not found',
  threadNotFound: 'It may have been deleted, or the link may be wrong.',
  threadFailed: 'Could not load the thread',
  emptyThreadTitle: 'The thread has no messages yet',
  emptyThread: 'Ask a question to start the conversation.',
  serviceFailedTitle: 'Could not reach the service',
  serviceFailed: 'Questions cannot be sent until the service answers. The error was: {error}',
  technicalDetails: 'Technical details',
  stripChange: 'Change',
  stripClose: 'Close',
  showInDocument: 'Show in the document',
  approachEmpty: 'The approach shows here when you ask a question.',
  approachNotKept:
    'The approach is not kept with the answers in the thread. It shows here when you ask a new question.',
  approachWaiting: 'Waiting for the first step …',
  noChatTitle: 'Put Chat in the content to try the assistant.',
  noChat: 'Without Chat there is no conversation to try.',
  emptyMain: 'No blocks in the content.',
  skipToField: 'Skip to the question field ({modifier} + /)',
  corpusChanged: 'Switched to {corpus}. You have a new thread, and the filter is cleared.',
  tabTitle: '{page} – {assistant}',
  aboutDocument: 'About “{title}”: {question}',
  stepPlanQueries: 'Understood the question',
  stepInspectFilters: 'Looked at which sources the thread reads from',
  stepSearch: 'Looked for passages about the question',
  stepReadChunks: 'Read the relevant parts closely',
  stepRerankResults: 'Picked what answers the question',
  stepReportGaps: 'What I did not find',
  stepGenerateResponse: 'Wrote the answer',
  stepPassages: { one: 'Read {count} excerpt closely', other: 'Read {count} excerpts closely' },
  stepRepeated: { one: '{title} ({count} time)', other: '{title} ({count} times)' },
} satisfies Translation<typeof nbAssembly>;

export const nb = defineCatalogue({ ...uiBlocksNb, assembly: nbAssembly });
export const en = { ...uiBlocksEn, assembly: enAssembly } satisfies Translation<typeof nb>;

export const { useT, translator } = defineTranslations({ nb, en });

export type AssemblyTranslator = ReturnType<typeof translator>;

/**
 * A panel named after what is in it, as one phrase in the reader's language: «Tråder og filter»,
 * «Fremgangsmåte, kilder og dokumentvisning».
 */
export const phrase = (t: AssemblyTranslator, parts: readonly string[]) => {
  const tag = intlLocale(t.locale);
  return new Intl.ListFormat(tag, { type: 'conjunction' }).format(
    parts.map((part, at) => (at === 0 ? part : part.toLocaleLowerCase(tag))),
  );
};
