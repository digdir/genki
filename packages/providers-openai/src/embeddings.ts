import {
  authenticatedFetch,
  embeddingErrorFromStatus,
  EmbeddingError,
  type EmbeddingAdapter,
  type EmbeddingEndpointConfig,
} from '@genai/port-embedding';
import OpenAI, { APIError, APIUserAbortError } from 'openai';
import { z } from 'zod';

const endpointOptions = z.strictObject({ apiVersion: z.string().min(1).optional() });
const modelOptions = z.strictObject({ sendDimensions: z.boolean().default(false) });
type EndpointOptions = z.infer<typeof endpointOptions>;
type ModelOptions = z.infer<typeof modelOptions>;

const toEmbeddingError = (error: unknown): EmbeddingError => {
  if (error instanceof EmbeddingError) return error;
  if (error instanceof APIUserAbortError)
    return new EmbeddingError('cancelled', 'the request was cancelled');
  if (error instanceof APIError) return embeddingErrorFromStatus(error.status, error.message);
  return new EmbeddingError('unavailable', error instanceof Error ? error.message : String(error));
};

export const openAiEmbeddings: EmbeddingAdapter<EndpointOptions, ModelOptions> = {
  protocol: 'openai-embeddings',
  endpointOptions,
  modelOptions,

  connect(endpoint: EmbeddingEndpointConfig<EndpointOptions>) {
    const client = new OpenAI({
      baseURL: endpoint.baseURL,
      apiKey: 'replaced-by-fetch',
      fetch: authenticatedFetch(endpoint.credential, 'authorization', ['authorization']),
      maxRetries: endpoint.maxRetries,
      timeout: endpoint.timeoutMs,
      ...(endpoint.options.apiVersion
        ? { defaultQuery: { 'api-version': endpoint.options.apiVersion } }
        : {}),
    });

    return {
      embed: async (model, texts, signal) => {
        try {
          const response = await client.embeddings.create(
            {
              model: model.deployment,
              input: texts,
              encoding_format: 'float',
              ...(model.options.sendDimensions ? { dimensions: model.dimensions } : {}),
            },
            { signal },
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
