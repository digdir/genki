// Invented drafts, as the portal's builder holds a service before it is published.
export const draftWithDataset = {
  apiVersion: 'genki/v1',
  kind: 'Service',
  metadata: { id: 'byggesak', name: 'Byggesaksveileder', tenant: 'eksempel' },
  spec: {
    output: { kind: 'answer' },
    variants: ['standard', { id: 'kort', chat: false }],
    knowledge: {
      datasets: [
        {
          dataset: 'felles/byggeregler',
          filters: { kommune: 'multiselect', aar: ['multiselect', 'contains'], tekst: 'contains' },
        },
      ],
      runtimeDocuments: false,
    },
  },
};

export const draftWithFields = {
  kind: 'Service',
  metadata: { id: 'skjemahjelp', name: 'Skjemahjelp', tenant: 'eksempel' },
  spec: { output: { kind: 'fields' }, knowledge: { datasets: [] } },
};

export const draftWithDocuments = {
  kind: 'Service',
  metadata: { id: 'vedleggsleser', tenant: 'eksempel' },
  spec: { output: { kind: 'answer' }, knowledge: { datasets: [], runtimeDocuments: true } },
};
