export type Language = 'nb' | 'nn' | 'en';

const markers: Record<Language, string[]> = {
  nn: 'ikkje eg ein eit kva korleis kvifor kven frå berre vere vore desse dei noko nokre mykje kvar heile fekk gjer òg saman sjølv utan høyrer skal då medan difor meir mange sine hjå aldri tenesta tenester verksemda verksemder arbeidet kommunane'.split(
    ' ',
  ),
  nb: 'ikke jeg en et hva hvordan hvorfor hvem fra bare være vært disse de noe noen mye hver hele fikk gjør også sammen selv uten hører skal da mens derfor mer mange sine hos aldri tjenesten tjenester virksomheten virksomheter arbeidet kommunene'.split(
    ' ',
  ),
  en: 'the and is are of to what how why who with this that from only be been these they some much every whole got does also together without should when while therefore more many their never service services agency agencies work municipalities'.split(
    ' ',
  ),
};

const lookup = new Map<string, Language[]>();
for (const [language, words] of Object.entries(markers) as [Language, string[]][]) {
  for (const word of words) lookup.set(word, [...(lookup.get(word) ?? []), language]);
}

export interface LanguageGuess {
  language: Language | 'unknown';
  scores: Record<Language, number>;
}

export const detectLanguage = (text: string): LanguageGuess => {
  const scores: Record<Language, number> = { nb: 0, nn: 0, en: 0 };
  const words =
    text
      .toLowerCase()
      .replace(/\[\d+\]/g, ' ')
      .match(/[a-zæøåòé]+/g) ?? [];
  for (const word of words) {
    const hits = lookup.get(word);
    if (!hits || hits.length > 1) continue;
    scores[hits[0] as Language] += 1;
  }
  const ranked = (Object.entries(scores) as [Language, number][]).sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked as [[Language, number], [Language, number]];
  if (first[1] < 2 || first[1] < second[1] * 1.5) return { language: 'unknown', scores };
  return { language: first[0], scores };
};

export const languageInstruction: Record<Language, string> = {
  nb: 'Svar på bokmål.',
  nn: 'Svar på nynorsk.',
  en: 'Answer in English.',
};

export const languageName: Record<Language, string> = {
  nb: 'bokmål',
  nn: 'nynorsk',
  en: 'English',
};

export const writtenStandards = ['user', 'bokmal', 'nynorsk'] as const;
export type WrittenStandard = (typeof writtenStandards)[number];

const nynorskWords = new Set(
  'ikkje eg ein eit kva korleis kvifor kven kvar kor frå berre vere vore desse dei noko nokon nokre mykje heile fekk gjer gjere òg sjølv utan høyrer medan difor meir hjå seier gjekk kjem kome mogleg moglegheit særleg tenesta tenester tenestene verksemda verksemder verksemdene kommunane rapportane søkje søkjer tilskot heimeside bustad skule dykk dykkar ho vart vert berekna fylka spørsmåla reglane'.split(
    ' ',
  ),
);
const bokmalWords = new Set(
  'ikke jeg en et hva hvordan hvorfor hvem hvor fra bare være vært disse de noe noen mye hele fikk gjør gjøre også selv uten hører mens derfor mer hos sier gikk kommer komme mulig mulighet særlig tjenesten tjenester tjenestene virksomheten virksomheter virksomhetene kommunene rapportene søke søker tilskudd hjemmeside bolig skole dere deres hun ble blir beregnet fylkene spørsmålene svarene reglene'.split(
    ' ',
  ),
);

export const detectWrittenStandard = (text: string): 'bokmal' | 'nynorsk' | undefined => {
  const words =
    text
      .toLowerCase()
      .replace(/\[\d+\]/g, ' ')
      .match(/[a-zæøåòé]+/g) ?? [];
  const nn = words.filter((w) => nynorskWords.has(w)).length;
  const nb = words.filter((w) => bokmalWords.has(w)).length;
  if (nn > nb) return 'nynorsk';
  if (nb > nn) return 'bokmal';
  return undefined;
};

export const answerLanguage = (
  standard: WrittenStandard | undefined,
  question: string,
): Language | undefined => {
  const chosen = standard === 'user' ? detectWrittenStandard(question) : standard;
  return chosen === 'nynorsk' ? 'nn' : chosen === 'bokmal' ? 'nb' : undefined;
};

export const defaultServiceLanguages: Language[] = ['nb', 'en'];

export const servesLanguage = (languages: readonly Language[], language: Language) =>
  languages.includes(language) || (language === 'nn' && languages.includes('nb'));
