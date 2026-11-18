import {
  authenticatedFetch,
  embeddingErrorFromStatus,
  EmbeddingError,
  type EmbeddingAdapter,
  type EmbeddingEndpointConfig,
} from '@genai/port-embedding';
import OpenAI, { APIError, APIUserAbortError } from 'openai';
import { z } from 'zod';

const modelOptions = z.strictObject({ sendDimensions: z.boolean().default(false) });
type ModelOptions = z.infer<typeof modelOptions>;

const toEmbeddingError = (error: unknown): EmbeddingError => {
  if (error instanceof EmbeddingError) return error;
  if (error instanceof APIUserAbortError)
    return new EmbeddingError('cancelled', 'the request was cancelled');
  if (error instanceof APIError)
    return embeddingErrorFromStatus(error.status, error.message, error.headers);
  return new EmbeddingError('unavailable', error instanceof Error ? error.message : String(error));
};

export const openAiEmbeddingsApi = 'openai/embeddings@1';

export const openAiEmbeddings: EmbeddingAdapter<ModelOptions> = {
  api: { id: openAiEmbeddingsApi, family: 'openai' },
  modelOptions,

  connect(endpoint: EmbeddingEndpointConfig) {
    const client = new OpenAI({
      baseURL: endpoint.baseURL,
      apiKey: 'replaced-by-fetch',
      fetch: authenticatedFetch(
        endpoint.credential,
        'authorization',
        ['authorization'],
        endpoint.fetch,
      ),
      maxRetries: endpoint.maxRetries,
      timeout: endpoint.timeoutMs,
    });

    return {
      embed: async (model, texts, signal, options = {}) => {
        try {
          const response = await client.embeddings.create(
            {
              model: model.deployment,
              input: texts,
              encoding_format: 'float',
              ...(model.options.sendDimensions ? { dimensions: model.dimensions } : {}),
            },
            {
              signal,
              ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
            },
          );
          const vectors: number[][] = new Array<number[]>(texts.length);
          for (const item of response.data) vectors[item.index] = item.embedding;
          return {
            vectors: Array.from(vectors, (v) => v ?? []),
            usage: { inputTokens: response.usage?.prompt_tokens ?? 0 },
          };
        } catch (error) {
          throw toEmbeddingError(error);
        }
      },
    };
  },
};
