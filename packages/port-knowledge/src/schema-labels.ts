import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  name: { label: 'Navn' },
  description: { label: 'Beskrivelse' },
  aliases: { label: 'Andre navn' },
  endpoint: { label: 'Søkemotor' },
  engine: { label: 'Type søkemotor' },
  filters: { label: 'Felt som kan filtreres' },
  valueTypes: {
    label: 'Verditype per filterfelt',
    help: 'string eller integer. Standard er string.',
  },
  links: { label: 'Regel for lenker til kildene', values: { 'kudos-legacy': 'Kudos' } },
  embedding: { label: 'Innbygging' },
  'embedding.model': { label: 'Innbyggingsmodell' },
  'embedding.dimensions': { label: 'Dimensjoner' },
  options: { label: 'Valg for søkemotoren' },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  name: { label: 'Name' },
  description: { label: 'Description' },
  aliases: { label: 'Other names' },
  endpoint: { label: 'Search engine' },
  engine: { label: 'Kind of search engine' },
  filters: { label: 'Fields that can be filtered' },
  valueTypes: {
    label: 'Value type per filter field',
    help: 'string or integer. The default is string.',
  },
  links: { label: 'Rule for links to the sources', values: { 'kudos-legacy': 'Kudos' } },
  embedding: { label: 'Embedding' },
  'embedding.model': { label: 'Embedding model' },
  'embedding.dimensions': { label: 'Dimensions' },
  options: { label: 'Options for the search engine' },
};

export const knowledgeCatalogSchemaLabels: SchemaLabels = {
  nb,
  en,
  meta: {
    description: { 'x-widget': 'textarea' },
    filters: { 'x-widget': 'map' },
    valueTypes: { 'x-widget': 'map' },
  },
};
