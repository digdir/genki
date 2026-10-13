import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  examples: { label: 'Eksempler' },
  temperature: { label: 'Temperatur', help: 'Lav gir like svar, høy gir mer variasjon.' },
  maxTokens: { label: 'Lengste svar (tokens)' },
  reasoning: {
    label: 'Hvor grundig modellen resonnerer',
    values: { low: 'Lite', medium: 'Middels', high: 'Mye' },
  },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  examples: { label: 'Examples' },
  temperature: {
    label: 'Temperature',
    help: 'Low gives similar answers, high gives more variety.',
  },
  maxTokens: { label: 'Longest answer (tokens)' },
  reasoning: {
    label: 'How thoroughly the model reasons',
    values: { low: 'Little', medium: 'Medium', high: 'A lot' },
  },
};

export const singleCallSchemaLabels: SchemaLabels = {
  nb,
  en,
  meta: { examples: { 'x-advanced': true } },
  titles: { 'single-call': { nb: 'Ett steg', en: 'One step' } },
};
