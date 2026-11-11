import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  generationPrompt: { label: 'Ledetekst for svaret', help: 'Tomt bruker den innebygde.' },
  budget: { label: 'Budsjett per oppgave' },
  'budget.searches': { label: 'Flest søk' },
  'budget.reads': { label: 'Flest dokumenter som leses' },
  'budget.readChars': { label: 'Flest tegn som leses' },
  maxIterations: { label: 'Flest runder' },
  temperature: { label: 'Temperatur mens agenten jobber' },
  synthesisTemperature: { label: 'Temperatur for svaret' },
  synthesisMaxTokens: { label: 'Lengste svar (tokens)' },
  evaluatorTemperature: { label: 'Temperatur for egenvurderingen' },
  noToolCallRetry: {
    label: 'Krev søk før svar',
    help: 'Svarer modellen på et spørsmål uten å søke, bes den søke inntil to ganger. Gjør den det ikke, blir svaret at kildene ikke dekker spørsmålet. Et oppfølgingsspørsmål kan bygge på samtalen og slipper gjennom etter det. Hilsener og spørsmål om hva tjenesten kan hjelpe med besvares som vanlig.',
  },
  noAnswerText: {
    label: 'Svar når kildene ikke dekker spørsmålet',
    help: 'Erstatter modellens egen formulering når den søkte og ikke fant noe i kildene. Ikke satt lar modellen formulere det selv.',
  },
  instructionsInAnswer: {
    label: 'Gi instruksjonene også til svaret',
    help: 'Svaret skrives i et eget kall uten verktøy. Slått på følger det også tjenestens instruksjoner om innhold, kilder og form.',
  },
  search: { label: 'Søk' },
  'search.titleOverlapWeight': { label: 'Vekt på treff i tittelen' },
  'search.strategyQuota': { label: 'Treff sikret per søkemåte' },
  'search.autoReadTopK': { label: 'Dokumenter som leses automatisk' },
  'search.displayLimit': { label: 'Treff som vises til modellen' },
  'search.snippets': { label: 'Vis utdrag i treffene' },
  ablate: {
    label: 'Steg som slås av',
    help: 'Bare for testing av kvalitet.',
    values: {
      'read-signal-eval': 'Vurdering av det som er lest',
      'sufficiency-gate': 'Sjekk av om grunnlaget er nok',
      'grounding-gate': 'Sjekk av at svaret har grunnlag',
      'response-validation': 'Kontroll av svaret',
    },
  },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  generationPrompt: { label: 'Prompt for the answer', help: 'Empty uses the built-in one.' },
  budget: { label: 'Budget per task' },
  'budget.searches': { label: 'Most searches' },
  'budget.reads': { label: 'Most documents read' },
  'budget.readChars': { label: 'Most characters read' },
  maxIterations: { label: 'Most rounds' },
  temperature: { label: 'Temperature while the agent works' },
  synthesisTemperature: { label: 'Temperature for the answer' },
  synthesisMaxTokens: { label: 'Longest answer (tokens)' },
  evaluatorTemperature: { label: 'Temperature for the self-check' },
  noToolCallRetry: {
    label: 'Require a search before answering',
    help: 'When the model answers a question without searching, it is asked to search, up to twice. If it still does not, the answer is that the sources do not cover the question. A follow-up may rest on the conversation and passes after that. Greetings and questions about what the service can help with are answered as usual.',
  },
  noAnswerText: {
    label: 'Answer when the sources do not cover the question',
    help: "Replaces the model's own wording when it searched and found nothing in the sources. Not set lets the model put it in its own words.",
  },
  instructionsInAnswer: {
    label: 'Give the instructions to the answer too',
    help: "The answer is written in a call of its own, without tools. When on, it also follows the service's instructions on content, sources and form.",
  },
  search: { label: 'Search' },
  'search.titleOverlapWeight': { label: 'Weight of matches in the title' },
  'search.strategyQuota': { label: 'Results kept per search method' },
  'search.autoReadTopK': { label: 'Documents read automatically' },
  'search.displayLimit': { label: 'Results shown to the model' },
  'search.snippets': { label: 'Show excerpts in the results' },
  ablate: {
    label: 'Steps turned off',
    help: 'Only for quality testing.',
    values: {
      'read-signal-eval': 'Assessment of what was read',
      'sufficiency-gate': 'Check that the basis is enough',
      'grounding-gate': 'Check that the answer is grounded',
      'response-validation': 'Check of the answer',
    },
  },
};

export const agentLoopSchemaLabels: SchemaLabels = {
  nb,
  en,
  meta: {
    generationPrompt: { 'x-widget': 'prompt', 'x-advanced': true },
    budget: { 'x-advanced': true },
    search: { 'x-advanced': true },
    ablate: { 'x-advanced': true, 'x-operator': true },
    evaluatorTemperature: { 'x-advanced': true },
    noToolCallRetry: { 'x-advanced': true },
  },
  titles: { 'agent-loop': { nb: 'Agent (søker selv)', en: 'Agent (searches by itself)' } },
};
