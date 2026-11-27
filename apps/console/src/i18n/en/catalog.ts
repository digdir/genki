import type { Translation } from '@genai/i18n';
import type { catalog as source } from '../nb/catalog';

export const catalog = {
  title: 'Endpoints and prices',
  introTenant:
    "The organisation's own endpoints, models and document collections, alongside what the platform shares with it. Every change becomes a new edition.",
  introPlatform:
    'Endpoints, models, document collections and prices the platform uses. Every change becomes a new edition and is logged.',
  secretsNote: 'Secrets are given as a reference (for example env:NAME), never as a value.',
  chooseTenant: 'Choose an organisation',
  loadingKinds: 'Loading what the organisation can register',
  platformOnly:
    'Only the platform can register {kind}. Switch to the platform view to see and change them.',
  tabModelEndpoint: 'Model endpoints',
  tabModel: 'Models',
  tabKnowledgeEndpoint: 'Knowledge endpoints',
  tabDataset: 'Document collections',
  tabPrice: 'Prices',
} satisfies Translation<typeof source>;
