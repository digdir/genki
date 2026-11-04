import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  dimensions: { label: 'Dimensjoner' },
  maxBatch: { label: 'Flest tekster per kall' },
  descriptors: {
    label: 'Beskrivelser',
    help: 'Kjør innbyggingen gjennom en gjennomgått beskrivelse i stedet for den håndskrevne adapteren.',
  },
  'descriptors.embed': { label: 'Beskrivelse for innbygging' },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  dimensions: { label: 'Dimensions' },
  maxBatch: { label: 'Most texts per call' },
  descriptors: {
    label: 'Descriptors',
    help: 'Run the embedding through a reviewed descriptor instead of the hand-written adapter.',
  },
  'descriptors.embed': { label: 'Descriptor for embedding' },
};

export const embeddingCatalogSchemaLabels: SchemaLabels = { nb, en };
