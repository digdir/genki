import { manifest, type PluginRegistration } from '@genai/plugins';
import {
  rerankContract,
  rerankContractTarget,
  rerankContractVersion,
  type RerankContractFixture,
} from '@genai/port-rerank/contract';
import { colbert } from './index.js';

export const colbertFixture: RerankContractFixture = {
  adapter: colbert,
  basePath: '/rerank',
  inputs: (body) => ({
    query: String(body.user_input ?? ''),
    documents: Array.isArray(body.documents) ? body.documents.map(String) : [],
  }),
  ranking: (ranked) => ({ status: 200, json: ranked }),
  failure: (status) => ({ status, json: { detail: `HTTP ${status}` } }),
};

export const colbertPlugins: PluginRegistration[] = [
  {
    manifest: manifest({
      kind: 'rerank',
      id: 'rerank.colbert',
      version: '1',
      contract: rerankContractVersion,
      title: 'ColBERT',
      description: 'Late-interaction reranking over the ColBERT service protocol.',
      configSchema: {
        type: 'object',
        properties: { maxInputLength: { type: 'integer', minimum: 1 } },
      },
      secrets: ['api-key'],
    }),
    suite: rerankContract,
    target: () => rerankContractTarget(colbertFixture),
  } as PluginRegistration,
];
