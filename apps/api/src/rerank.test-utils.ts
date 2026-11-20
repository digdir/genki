import { authHeaders } from '@genai/kernel';
import type { Ranked, RerankAdapter } from '@genai/port-rerank';
import { z } from 'zod';

/**
 * A rerank engine for tests, since genki has none built in (ADR 0048). It posts
 * `{ query, documents }` and reads `[{ index, score, rank }]`.
 */
export const testRerankAdapter: RerankAdapter = {
  engine: 'test-rerank',
  api: { id: 'test/rerank@1', family: 'test-rerank' },
  endpointOptions: z.strictObject({}),
  rerankerOptions: z.strictObject({}),
  connect: (endpoint) => ({
    rerank: async (_reranker, request, signal) => {
      const response = await (endpoint.fetch ?? fetch)(endpoint.baseURL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(await authHeaders(endpoint.credential, 'x-api-key')),
        },
        body: JSON.stringify({ query: request.query, documents: request.documents }),
        signal,
      });
      return (await response.json()) as Ranked[];
    },
  }),
};
