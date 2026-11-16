// Kunnskapsassistenten's words for the template `knowledge-assistant-next`, as data: its name, its
// suggestions, its settings note and the Kudos collection's words. Taken from the next client's own
// profile in digdir/kunnskapsassistenten (`src/apps/web-next/src/profile.ts`). Its experiments and
// what only code can say (the reader, the sign-out, the family of services) are left out.
import type { ProfileCorpus, ProfileData } from '@genai/ui-blocks/builder';

const kudos: ProfileCorpus = {
  label: 'Kudos',
  description: 'dokumenter fra kudos.dfo.no',
  fields: [
    { id: 'type', label: 'Dokumenttyper', heading: 'Dokumenttype' },
    { id: 'orgs_long', label: 'Virksomheter', heading: 'Virksomhet' },
    { id: 'concerned_years', label: 'År', heading: 'År', kind: 'year', years: { first: 1990 } },
  ],
  typeField: 'type',
  typePlurals: {
    Evaluering: 'evalueringer',
    'Proposisjon til Stortinget': 'proposisjoner til Stortinget',
    Statusrapport: 'statusrapporter',
    Tildelingsbrev: 'tildelingsbrev',
    Årsrapport: 'årsrapporter',
  },
  documentLinks: {
    digits: 'https://kudos.dfo.no/documents/{id}',
    uuid: 'https://kudos.dfo.no/dokument/{id}',
  },
  about: { idField: 'doc_num', fields: ['type', 'orgs_long', 'concerned_years'] },
};

/** The profile with Kunnskapsassistenten's words in, the other collections' words as they were. */
export const asKnowledgeAssistant = (profile: ProfileData | undefined): ProfileData => ({
  ...profile,
  assistantName: 'Kunnskapsassistenten',
  suggestions: [
    'Hva handler dokumentene i Kudos om?',
    'Gi meg en oversikt over de viktigste temaene i Kudos.',
    'Oppsummer det viktigste i Kudos i noen få punkter.',
  ],
  settingsNote: 'Valgene huskes i denne nettleseren.',
  corpora: { ...profile?.corpora, kudos },
});
