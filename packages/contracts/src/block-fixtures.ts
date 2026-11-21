import type { BlockData } from './block-fields.js';
import type { BlockState } from './blocks.js';

const asked: BlockData = {
  question: { text: 'Hva er klarspråk?' },
  service: { name: 'Klarspråkassistenten' },
  thread: { title: 'Klarspråk i offentlig sektor' },
  filters: {
    corpus: 'Veiledere',
    fields: [{ id: 'type', label: 'Dokumenttype', values: ['Veileder'] }],
  },
  threads: [
    { title: 'Klarspråk i offentlig sektor', updatedAt: '2026-11-21T09:00:00Z', current: true },
    { title: 'Universell utforming av skjema', updatedAt: '2026-11-20T14:30:00Z' },
  ],
  locale: 'nb',
};

const sources = [
  {
    index: 1,
    title: 'Klarspråk i staten',
    url: 'https://www.digdir.no/klarsprak/klarsprak-i-staten',
    documentType: 'Veileder',
    publisher: 'Digitaliseringsdirektoratet',
    publishedAt: '2025-03-14',
    excerpt: 'Klarspråk er korrekt, klar og brukertilpasset kommunikasjon.',
  },
  {
    index: 2,
    title: 'Språkloven',
    url: 'https://lovdata.no/dokument/NL/lov/2021-05-21-42',
    documentType: 'Lov',
    publisher: 'Kultur- og likestillingsdepartementet',
    publishedAt: '2021-05-21',
    excerpt: 'Offentlige organ skal bruke klart språk.',
  },
];

/** Made-up data a block is previewed with, one set per state; never a tenant's. */
export const blockFixtures: Record<BlockState, BlockData> = {
  empty: { service: asked.service ?? {}, locale: 'nb', threads: [] },
  loading: { ...asked, answer: { status: 'waiting' } },
  error: { ...asked, answer: { status: 'failed', text: '' } },
  partial: {
    ...asked,
    answer: { status: 'streaming', text: 'Klarspråk betyr at mottakeren finner' },
    sources: sources.slice(0, 1),
  },
  disabled: { ...asked },
  filled: {
    ...asked,
    answer: {
      status: 'done',
      text: 'Klarspråk betyr at mottakeren finner det hen trenger, forstår det og kan bruke det [1].',
      createdAt: '2026-11-21T09:00:05Z',
    },
    sources,
  },
};
