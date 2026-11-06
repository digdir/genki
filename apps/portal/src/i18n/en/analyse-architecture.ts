import type { Translation } from '@genai/i18n';
import type { architectureArea as source } from '../nb/analyse-architecture';

export const architectureArea = {
  architecture: {
    title: 'Architecture assistant',
    draftTag: 'Draft',
    lead: 'Answers questions about the national architecture: capabilities, principles and shared resources.',
    loading: 'Loading the architecture assistant',
    draft:
      'The assistant is being tried out, and its answers can be wrong or incomplete. Check the sources under each answer before you use it.',
    missingTitle: 'The architecture assistant does not exist in {tenant}',
    missing:
      'The page uses the service with the id "{service}", and it is not published in your organisation, or you do not have access to it. Ask someone who manages services in your organisation to publish it or give you access.',
    toServices: 'Go to services',
  },
} satisfies Translation<typeof source>;
