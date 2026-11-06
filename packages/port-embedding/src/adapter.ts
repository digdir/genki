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

export interface EmbeddingCallOptions {
  /** The SDK's retries for this call, in place of the connection's `maxRetries`. */
  maxRetries?: number;
}

export interface EmbeddingConnection<M = unknown> {
  embed(
    model: EmbeddingModelConfig<M>,
    texts: string[],
    signal: AbortSignal,
    options?: EmbeddingCallOptions,
  ): Promise<EmbedResult>;
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

/** The wait a 429 asks for, from `retry-after-ms` or `retry-after` (seconds or a date). */
export const retryAfterMsOf = (headers: Headers | undefined): number | undefined => {
  if (!headers) return undefined;
  const ms = Number(headers.get('retry-after-ms') ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const after = headers.get('retry-after');
  if (after === null) return undefined;
  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
};

export const embeddingErrorFromStatus = (
  status: number | undefined,
  message: string,
  headers?: Headers,
): EmbeddingError => {
  if (status === 429) {
    const retryAfterMs = retryAfterMsOf(headers);
    return new EmbeddingError(
      'rate_limited',
      'the embedder is rate limited',
      retryAfterMs === undefined ? {} : { retryAfterMs },
    );
  }
  if (status === 401 || status === 403)
    return new EmbeddingError('unauthorized', 'the embedder refused the credentials');
  if (status !== undefined && status >= 400 && status < 500)
    return new EmbeddingError('bad_request', message);
  return new EmbeddingError('unavailable', 'the embedder is unavailable');
};

export { authenticatedFetch, authHeaders, type Credential } from '@genai/kernel';
