import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  dimensions: { label: 'Dimensjoner' },
  maxBatch: { label: 'Flest tekster per kall' },
  prompts: {
    label: 'Tekst foran hver inndata',
    help: 'Tekst modellen vil ha foran spørsmål og tekstbiter, som «query: » og «passage: »',
  },
  'prompts.query': { label: 'Foran spørsmål' },
  'prompts.document': { label: 'Foran tekstbiter' },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  dimensions: { label: 'Dimensions' },
  maxBatch: { label: 'Most texts per call' },
  prompts: {
    label: 'Text before each input',
    help: "Text the model wants before questions and passages, such as 'query: ' and 'passage: '",
  },
  'prompts.query': { label: 'Before questions' },
  'prompts.document': { label: 'Before passages' },
};

export const embeddingCatalogSchemaLabels: SchemaLabels = { nb, en };
