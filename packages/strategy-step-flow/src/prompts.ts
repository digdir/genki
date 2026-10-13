export const defaultGenerationPrompt =
  'Answer the question based on the context.\n\nContext:\n{context}\n\nQuestion: {question}';

export const insufficientSentinel = 'INSUFFICIENT';

export const citationInstruction =
  'When making claims based on the provided sources, cite them using [N] notation where N is the source number. Every factual claim should have at least one citation. Place citations immediately after the relevant statement.';

export const ambiguityInstruction =
  'If the sources contain multiple plausible values, labels, or interpretations, do not hide the ambiguity. Compare the user’s wording to the source labels, preserve the source terminology, and explicitly mention ambiguity when the question is underspecified. Do not silently collapse distinct source labels into one concept. Do not merge or arithmetic-combine values from different labels, sentences, or chunks unless the source explicitly states that they belong together. If one label is clearly the closest semantic match, use it and state that label in the answer. If different chunks describe different scopes or definitions, explain that difference instead of producing a single blended number.';

export const sameLanguageRule =
  "Always respond in the SAME LANGUAGE as the user's question. " +
  'If the question is Norwegian, answer in Norwegian. ' +
  'If English, answer in English. ' +
  'Do not mix languages (e.g. never produce phrases like "altinn date"). ' +
  'Preserve source-terminology verbatim even when writing in the other language.';

const norwegianMonths = [
  'januar',
  'februar',
  'mars',
  'april',
  'mai',
  'juni',
  'juli',
  'august',
  'september',
  'oktober',
  'november',
  'desember',
];

export const systemPromptWithDate = (now: Date) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const date = `${get('day')}. ${norwegianMonths[get('month') - 1]} ${get('year')}`;
  return `You are a helpful assistant. The date this conversation was created at is ${date} (Norwegian time).`;
};

export const buildGenerationPrompt = (
  template: string | undefined,
  context: string,
  question: string,
) =>
  (template ?? defaultGenerationPrompt)
    .replaceAll('{context}', context)
    .replaceAll('{question}', question) +
  `\n\n${ambiguityInstruction}\n\n${citationInstruction}\n\n${sameLanguageRule}`;

const word = (alternatives: string) =>
  String.raw`(?<![\p{L}\p{N}_])(${alternatives})(?![\p{L}\p{N}_])`;
const gap = (max: number) => String.raw`[\s\S]{0,${max}}`;

const insufficientSignals: { signal: string; pattern: RegExp }[] = [
  {
    signal: 'not-enough-info',
    pattern: new RegExp(
      word("not enough|insufficient|don't have enough|do not have enough") +
        gap(80) +
        word('info|information|context|sources?|documents?'),
      'u',
    ),
  },
  {
    signal: 'cannot-answer-from-sources',
    pattern: new RegExp(
      word("cannot|can't|unable to|could not") +
        gap(80) +
        word('answer|determine|find|locate') +
        gap(120) +
        word('context|sources?|documents?|provided'),
      'u',
    ),
  },
  {
    signal: 'no-relevant-information',
    pattern: new RegExp(
      word('no|not') +
        gap(40) +
        word('relevant|available|matching') +
        gap(80) +
        word('info|information|context|sources?|documents?'),
      'u',
    ),
  },
  {
    signal: 'ingen-nok-informasjon',
    pattern: new RegExp(
      word('ikke nok|utilstrekkelig|ingen') + gap(80) + word('informasjon|kontekst|kilder'),
      'u',
    ),
  },
  {
    signal: 'kan-ikke-svare-fra-kilder',
    pattern: new RegExp(
      word('kan ikke|klarer ikke|kunne ikke') +
        gap(100) +
        word('svare|finne') +
        gap(120) +
        word('informasjon|kontekst|kilder'),
      'u',
    ),
  },
  {
    signal: 'finner-ikke-i-kildene',
    pattern: new RegExp(
      word('jeg (?:har|finner) ikke') + gap(120) + word('informasjon|grunnlag|kilder'),
      'u',
    ),
  },
];

export const detectInsufficientContext = (text: string) => {
  const normalised = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const match = insufficientSignals.find((s) => s.pattern.test(normalised));
  return { insufficient: Boolean(match), signal: match?.signal ?? null };
};
