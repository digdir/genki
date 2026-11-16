import type { DatasetFilter } from '../facts.js';

// Invented drafts, as the portal's builder holds a service before it is published.
export const draftWithDataset = {
  apiVersion: 'genki/v1',
  kind: 'Service',
  metadata: { id: 'byggesak', name: 'Byggesaksveileder', tenant: 'eksempel' },
  spec: {
    output: { kind: 'answer' },
    exposure: { chat: true },
    variants: ['standard', { id: 'kort', chat: false }],
    knowledge: {
      datasets: [{ dataset: 'felles/byggeregler', filters: { kommune: ['Oslo'] } }],
      runtimeDocuments: false,
    },
  },
};

/** The fields the invented dataset declares, as `/api/datasets/{id}` lists them. */
export const byggereglerFilters: Record<string, readonly DatasetFilter[]> = {
  'felles/byggeregler': [
    { field: 'kommune', kinds: ['multiselect'] },
    { field: 'aar', kinds: ['multiselect', 'contains'], 'value-type': 'integer' },
    { field: 'tekst', kinds: ['contains'] },
  ],
};

export const draftWithFields = {
  kind: 'Service',
  metadata: { id: 'skjemahjelp', name: 'Skjemahjelp', tenant: 'eksempel' },
  spec: { output: { kind: 'fields' }, exposure: { rest: true }, knowledge: { datasets: [] } },
};

export const draftWithDocuments = {
  kind: 'Service',
  metadata: { name: 'vedleggsleser', tenant: 'eksempel' },
  spec: {
    output: { kind: 'answer' },
    exposure: { chat: true },
    knowledge: { datasets: [{ dataset: 'notater' }], runtimeDocuments: true },
  },
};
