export const formatConversation = (turns: { role: 'user' | 'assistant'; text: string }[]) =>
  turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: "${t.text}"`).join('\n\n');

export const defaultPlannerPrompt = (
  messages: string,
  corpusLanguage: string | undefined,
  salientNoun: boolean,
) => {
  const translate = corpusLanguage !== undefined && corpusLanguage.trim() !== '';
  return (
    "You plan retrieval queries against a documentation corpus. The user's " +
    'message may contain instructional scaffolding or conversation context.\n\n' +
    'Conversation:\n' +
    messages +
    '\n\n' +
    'Do two things in a single response:\n\n' +
    "1. **Extract the user's topical intent** as a short clean question or phrase " +
    '(5-15 words). ' +
    (translate
      ? `Translate it to the corpus language: ${corpusLanguage}. `
      : "LANGUAGE: Use EXACTLY the same language as the user's message. " +
        'If the user wrote in English, the user-intent MUST be in English. ' +
        'If Norwegian, Norwegian. Do NOT translate between languages even ' +
        'if the corpus has docs in a different language — the retriever ' +
        'searches the same language as the query, so translation moves the ' +
        'search away from same-language matches. ') +
    'Strip instructional scaffolding ("propose phrases", "run eval", etc.) — ' +
    'keep only what the user wants to LEARN ABOUT. Resolve anaphora using ' +
    'conversation context. This becomes the canonical query for the retriever.\n\n' +
    '2. **Generate 4-6 diverse search phrases** the retriever should try, ' +
    'covering the same intent from different angles. ' +
    (translate
      ? ''
      : "Every phrase MUST be in the same language as the user's message " +
        '(see LANGUAGE rule above). ') +
    '\n\nPhrase-generation rules:\n' +
    '- Prefer phrases that could appear verbatim in an answer passage, not just ' +
    'topical keywords. For "Når ble X lansert?" include phrases like "X ble ' +
    'lansert" or "første versjon av X".\n' +
    '- Include one short precise phrase (2-4 words) and one longer specific ' +
    'phrase (5-10 words). Avoid single-word phrases that match everything in ' +
    'the corpus.\n' +
    '- Vary the angle (entity+fact, entity+time, entity+event) but stay on-topic. ' +
    'Do not restate the same phrase with trivial word-order changes.\n' +
    (salientNoun
      ? '- SALIENT-NOUN COVERAGE (REQUIRED): the FIRST TWO search phrases ' +
        "MUST be short (2-5 words) phrases naming the question's single most " +
        'specific feature, API, endpoint, file, or concept — ONE in ' +
        "Norwegian (bokmål) and ONE in English — regardless of the user's " +
        'language. They pin the exact vocabulary the answer passage uses. ' +
        'Examples: adding a PDF step → "PDF service task" + ' +
        '"PDF-tjenesteoppgave"; publishing events → "POST /events publish" ' +
        '+ "publisere hendelse"; recipient filter → "recipient filter" + ' +
        '"mottakerfilter". Put these two FIRST; never lead with generic ' +
        'topic words like "Altinn events" or "process editor". Emit at ' +
        'most these two — do not pad with many near-duplicate short phrases.'
      : '- The first search phrase should be the user-intent verbatim — this ' +
        'is the no-regression baseline against the literal query.')
  );
};

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n');

export const groundingPrompt = (query: string, blindPhrases: string[], candidates: string[]) =>
  'You refine retrieval queries for a documentation corpus.\n\n' +
  "User's question:\n" +
  query +
  '\n\n' +
  'A first-pass expansion produced these phrases (generated WITHOUT seeing the corpus):\n' +
  bullets(blindPhrases) +
  '\n\n' +
  'The following phrases were harvested from the corpus near this topic, ordered ' +
  "best-match first — this is the corpus's REAL vocabulary:\n" +
  bullets(candidates) +
  '\n\n' +
  'Produce 6-10 search phrases that will retrieve the passages answering the ' +
  "user's question.\n" +
  "- Build them from the corpus's actual terminology above — prefer the harvested " +
  'wording (keep strong ones VERBATIM) over generic paraphrases.\n' +
  '- Keep SPECIFIC and PROCEDURAL phrasings (exact feature/property names, step ' +
  'wording), not only general/topical ones.\n' +
  '- Each phrase should read like text that appears in an answer passage.';

export const oneCallPrompt = (query: string, candidates: string[]) =>
  'You plan retrieval queries for a documentation corpus.\n\n' +
  "User's question:\n" +
  query +
  '\n\n' +
  'The phrases below were harvested from the corpus near this topic, ordered ' +
  "best-match first — this is the corpus's REAL vocabulary:\n" +
  bullets(candidates) +
  '\n\n' +
  'Do two things:\n' +
  "1. Extract the user's topical intent as a short clean question or phrase " +
  "(5-15 words), in the user's own language.\n" +
  '2. Produce 6-10 search phrases that will retrieve the passages answering the ' +
  'question. Build them from the harvested corpus vocabulary above — prefer the ' +
  'harvested wording (keep strong ones VERBATIM) over generic paraphrases; keep ' +
  'SPECIFIC and PROCEDURAL phrasings; drop clearly off-topic ones.';

export const planSchema = {
  name: 'planQueries',
  schema: {
    type: 'object',
    properties: {
      user_intent: {
        type: 'string',
        description:
          "The user's topical intent as a short clean question or phrase (5-15 words). Translate to the corpus language. Drop instructional scaffolding.",
      },
      search_phrases: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Diverse search phrases the retriever should try, covering the same intent from different angles.',
      },
    },
    required: ['user_intent', 'search_phrases'],
    additionalProperties: false,
  },
};

export const groundingSchema = {
  name: 'groundedQueries',
  schema: {
    type: 'object',
    properties: {
      search_phrases: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Search phrases built from the corpus's own terminology that will retrieve the answer passages.",
      },
    },
    required: ['search_phrases'],
    additionalProperties: false,
  },
};

export const probeStopwords = new Set(
  'how do i the a an to in my of for on and or is are can what when without each time with that this it as by from into at be should would could you your we our them they if only some one another has have does me so but not no up out get got use using want'.split(
    ' ',
  ),
);
