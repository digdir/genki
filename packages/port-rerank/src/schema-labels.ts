import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  engine: { label: 'Type omrangering' },
  onFailure: {
    label: 'Hvis omrangeringen feiler',
    values: { degrade: 'Bruk treffene uten omrangering', fail: 'Stopp med feil' },
  },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  engine: { label: 'Kind of reranker' },
  onFailure: {
    label: 'If reranking fails',
    values: { degrade: 'Use the results without reranking', fail: 'Stop with an error' },
  },
};

export const rerankCatalogSchemaLabels: SchemaLabels = { nb, en };
