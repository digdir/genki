import { authHeaders } from '@genai/kernel';
import {
  RerankError,
  type Ranked,
  type RerankAdapter,
  type RerankEndpointConfig,
  type RerankerConfig,
  type RerankRequest,
} from '@genai/port-rerank';
import { z } from 'zod';

const rerankerOptions = z.strictObject({
  maxInputLength: z.number().int().positive().default(1000),
});
type Options = z.infer<typeof rerankerOptions>;

const statusError = (status: number, text: string) => {
  if (status === 429) return new RerankError('rate_limited', 'the reranker is rate limited');
  if (status === 401 || status === 403)
    return new RerankError('unauthorized', 'the reranker refused the key');
  if (status >= 400 && status < 500) return new RerankError('bad_request', text.slice(0, 500));
  return new RerankError('unavailable', 'the reranker is unavailable');
};

const toRanked = (body: unknown): Ranked[] => {
  if (!Array.isArray(body))
    throw new RerankError('unavailable', 'unexpected response from the reranker');
  return body.flatMap((entry: unknown) => {
    const e = entry as { index?: unknown; score?: unknown; rank?: unknown };
    return typeof e.index === 'number'
      ? [{ index: e.index, score: Number(e.score ?? 0), rank: Number(e.rank ?? 0) }]
      : [];
  });
};

export const colbert: RerankAdapter<Record<string, never>, Options> = {
  engine: 'colbert',
  endpointOptions: z.strictObject({}),
  rerankerOptions,

  connect(endpoint: RerankEndpointConfig) {
    return {
      rerank: async (
        reranker: RerankerConfig<Options>,
        request: RerankRequest,
        signal: AbortSignal,
      ) => {
        const response = await (endpoint.fetch ?? fetch)(endpoint.baseURL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(await authHeaders(endpoint.credential, 'x-api-key')),
          },
          body: JSON.stringify({
            user_input: request.query.slice(0, reranker.options.maxInputLength),
            k: request.documents.length,
            documents: request.documents,
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(endpoint.timeoutMs)]),
        });
        const text = await response.text();
        if (!response.ok) throw statusError(response.status, text);
        if (text.trim() === '') return [];
        return toRanked(JSON.parse(text) as unknown);
      },
    };
  },
};
