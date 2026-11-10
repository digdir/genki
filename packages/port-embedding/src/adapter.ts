import type { Credential } from '@genai/kernel';
import type { z } from 'zod';
import { EmbeddingError, type EmbedResult } from './port.js';

export interface EmbeddingEndpointConfig {
  baseURL: string;
  credential: Credential;
  maxRetries: number;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface EmbeddingModelConfig<O = unknown> {
  deployment: string;
  dimensions: number;
  options: O;
}

export interface EmbeddingConnection<M = unknown> {
  embed(model: EmbeddingModelConfig<M>, texts: string[], signal: AbortSignal): Promise<EmbedResult>;
}

/** The API an adapter implements in code, registered under its API id (ADR 0048). */
export interface EmbeddingApi {
  id: string;
  family: string;
}

export interface EmbeddingAdapter<M = unknown> {
  api: EmbeddingApi;
  modelOptions: z.ZodType<M>;
  connect(endpoint: EmbeddingEndpointConfig): EmbeddingConnection<M>;
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
