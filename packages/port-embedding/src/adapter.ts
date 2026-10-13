import type { Credential } from '@genai/kernel';
import type { z } from 'zod';
import { EmbeddingError, type EmbedResult } from './port.js';

export interface EmbeddingEndpointConfig<O = unknown> {
  baseURL: string;
  credential: Credential;
  options: O;
  maxRetries: number;
  timeoutMs: number;
}

export interface EmbeddingModelConfig<O = unknown> {
  deployment: string;
  dimensions: number;
  options: O;
}

export interface EmbeddingConnection<M = unknown> {
  embed(model: EmbeddingModelConfig<M>, texts: string[], signal: AbortSignal): Promise<EmbedResult>;
}

export interface EmbeddingAdapter<E = unknown, M = unknown> {
  protocol: string;
  endpointOptions: z.ZodType<E>;
  modelOptions: z.ZodType<M>;
  connect(endpoint: EmbeddingEndpointConfig<E>): EmbeddingConnection<M>;
}

export const embeddingErrorFromStatus = (
  status: number | undefined,
  message: string,
): EmbeddingError => {
  if (status === 429) return new EmbeddingError('rate_limited', 'the embedder is rate limited');
  if (status === 401 || status === 403)
    return new EmbeddingError('unauthorized', 'the embedder refused the credentials');
  if (status !== undefined && status >= 400 && status < 500)
    return new EmbeddingError('bad_request', message);
  return new EmbeddingError('unavailable', 'the embedder is unavailable');
};

export { authenticatedFetch, authHeaders, type Credential } from '@genai/kernel';
