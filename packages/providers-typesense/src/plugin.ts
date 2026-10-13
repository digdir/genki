import { manifest, type ContractTarget, type PluginRegistration } from '@genai/plugins';
import { knowledgeProfiles } from '@genai/port-knowledge';
import {
  fixtureDocuments,
  knowledgeContract,
  knowledgeContractSubject,
  knowledgeContractVersion,
  type KnowledgeContractSubject,
} from '@genai/port-knowledge/contract';
import { envSecrets } from '@genai/kernel';
import { fakeTypesense } from './fake.js';
import { typesense, typesenseDatasetOptions } from './index.js';

export const typesenseContractOptions = {
  collections: { docs: 'kontrakt_docs', chunks: 'kontrakt_chunks', phrases: 'kontrakt_phrases' },
  profiles: {
    [knowledgeProfiles.content]: {
      collection: 'chunks',
      queryBy: ['content_markdown'],
      textField: 'content_markdown',
    },
    [knowledgeProfiles.phrase]: {
      collection: 'phrases',
      queryBy: ['search_phrase'],
      textField: 'search_phrase',
    },
    [knowledgeProfiles.docTitle]: { collection: 'docs', queryBy: ['title'], textField: 'title' },
  },
};

export const typesenseContractTarget = async (): Promise<
  ContractTarget<KnowledgeContractSubject>
> => {
  const fake = await fakeTypesense(
    fixtureDocuments,
    typesenseDatasetOptions.parse(typesenseContractOptions),
  );
  return {
    subject: knowledgeContractSubject(
      {
        adapter: typesense,
        baseURL: fake.url,
        auth: { kind: 'api-key', secret: 'secret://env/contract-key' },
        datasetOptions: typesenseContractOptions,
        secrets: envSecrets({ CONTRACT_KEY: 'kun-sok' }),
      },
      () => fake.writes.length,
    ),
    close: fake.close,
  };
};

export const typesensePlugins: PluginRegistration[] = [
  {
    manifest: manifest({
      kind: 'knowledge',
      id: 'knowledge.typesense',
      version: '1',
      contract: knowledgeContractVersion,
      title: 'Typesense',
      description:
        'Searches and exports Typesense collections with a search-only key; never writes.',
      capabilities: ['search.text', 'fetch', 'range', 'facets', 'filter.*', 'export'],
      secrets: ['api-key'],
    }),
    suite: knowledgeContract,
    target: typesenseContractTarget,
  } as PluginRegistration,
];
