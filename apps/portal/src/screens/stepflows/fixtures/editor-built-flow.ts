import type { Flow } from '../../../data/stepflows';

export const editorBuiltFlow: Flow = {
  id: 'redigert-flyt',
  name: 'Redigert flyt',
  desc: 'Lager en tabell over dokumentene',
  version: 1,
  changed: '',
  usedBy: [],
  input: [['virksomheter', 'liste']],
  steps: [
    {
      kind: 'block',
      id: 'finn',
      label: 'Finn dokumentene',
      block: 'documents',
      in: {},
      raw: { filters: { orgs_short: '{{input.virksomheter}}' } },
      p: { limit: 20 },
      err: 'stop',
    },
    {
      kind: 'foreach',
      id: 'hver',
      label: 'For hvert dokument',
      over: 'steps.finn.documents',
      as: 'dok',
      err: 'skip',
      steps: [
        {
          kind: 'block',
          id: 'les',
          label: 'Les',
          block: 'read-document',
          in: { document: 'dok' },
          p: { topK: 10 },
          err: 'stop',
        },
        {
          kind: 'block',
          id: 'ut',
          label: 'Hent ut',
          block: 'extract',
          in: { chunks: 'steps.les.chunks' },
          raw: { prompt: 'Finn målene i {{dok.title}}.' },
          p: {
            schema: {
              type: 'object',
              properties: { goal: { type: 'string' } },
              required: ['goal'],
            },
          },
          err: 'stop',
        },
      ],
    },
    {
      kind: 'block',
      id: 'tabell',
      label: 'Tabell',
      block: 'table',
      in: { items: 'steps.hver', documents: 'steps.finn.documents' },
      p: {
        columns: [
          { key: 'doc', label: 'Dokument', from: 'document.title' },
          { key: 'goal', label: 'Mål', from: 'goal' },
        ],
      },
      err: 'stop',
    },
  ],
};
