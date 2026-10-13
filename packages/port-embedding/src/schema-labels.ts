import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  dimensions: { label: 'Dimensjoner' },
  maxBatch: { label: 'Flest tekster per kall' },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  dimensions: { label: 'Dimensions' },
  maxBatch: { label: 'Most texts per call' },
};

export const embeddingCatalogSchemaLabels: SchemaLabels = { nb, en };
