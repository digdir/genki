import type { Translation } from '@genai/i18n';
import type { architectureArea as source } from '../nb/analyse-architecture';

export const architectureArea = {
  architecture: {
    title: 'Architecture assistant',
    draftTag: 'Draft',
    lead: 'Analyses the architecture of a solution and points out what to consider.',
    draftTitle: 'The architecture assistant is being built',
    draft:
      'This is a draft. The assistant is not connected to the platform yet, so it cannot answer.',
  },
} satisfies Translation<typeof source>;
