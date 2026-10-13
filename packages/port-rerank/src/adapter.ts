import type { Credential } from '@genai/kernel';
import type { z } from 'zod';
import type { Ranked, RerankRequest } from './port.js';

export interface RerankEndpointConfig<O = unknown> {
  baseURL: string;
  credential: Credential;
  options: O;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface RerankerConfig<O = unknown> {
  id: string;
  options: O;
}

export interface RerankConnection<M = unknown> {
  rerank(
    reranker: RerankerConfig<M>,
    request: RerankRequest,
    signal: AbortSignal,
  ): Promise<Ranked[]>;
}

export interface RerankAdapter<E = unknown, M = unknown> {
  engine: string;
  endpointOptions: z.ZodType<E>;
  rerankerOptions: z.ZodType<M>;
  connect(endpoint: RerankEndpointConfig<E>): RerankConnection<M>;
}
