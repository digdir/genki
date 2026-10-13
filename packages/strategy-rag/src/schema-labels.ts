import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  generate: { label: 'Skriv et svar', help: 'Av betyr at tjenesten bare søker.' },
  topK: { label: 'Treff når den bare søker' },
  generationPrompt: { label: 'Ledetekst for svaret', help: 'Tomt bruker den innebygde.' },
  synthesisTemperature: { label: 'Temperatur for svaret' },
  synthesisMaxTokens: { label: 'Lengste svar (tokens)' },
  contextTopK: { label: 'Tekstbiter som grunnlag for svaret' },
  maxDocs: { label: 'Flest dokumenter i svaret' },
  budget: { label: 'Budsjett per oppgave' },
  'budget.searches': { label: 'Flest søk' },
  'budget.reads': { label: 'Flest dokumenter som leses' },
  'budget.readChars': { label: 'Flest tegn som leses' },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  generate: { label: 'Write an answer', help: 'Off means the service only searches.' },
  topK: { label: 'Results when it only searches' },
  generationPrompt: { label: 'Prompt for the answer', help: 'Empty uses the built-in one.' },
  synthesisTemperature: { label: 'Temperature for the answer' },
  synthesisMaxTokens: { label: 'Longest answer (tokens)' },
  contextTopK: { label: 'Text chunks the answer is based on' },
  maxDocs: { label: 'Most documents in the answer' },
  budget: { label: 'Budget per task' },
  'budget.searches': { label: 'Most searches' },
  'budget.reads': { label: 'Most documents read' },
  'budget.readChars': { label: 'Most characters read' },
};

export const ragSchemaLabels: SchemaLabels = {
  nb,
  en,
  meta: {
    generationPrompt: { 'x-widget': 'prompt', 'x-advanced': true },
    budget: { 'x-advanced': true },
    topK: { 'x-showIf': { field: 'generate', equals: false } },
  },
  titles: {
    'rag-single-shot': { nb: 'Ett søk og ett svar', en: 'One search and one answer' },
  },
};
