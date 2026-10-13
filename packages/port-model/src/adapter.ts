import type { Credential } from '@genai/kernel';
import type { z } from 'zod';
import { ModelError, type ChatChunk, type ChatRequest, type ChatResult } from './port.js';

export interface EndpointConfig<O = unknown> {
  baseURL: string;
  credential: Credential;
  options: O;
  maxRetries: number;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface DeploymentConfig<O = unknown> {
  deployment: string;
  options: O;
}

export interface ModelConnection<M = unknown> {
  chat(model: DeploymentConfig<M>, request: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
  chatStream(
    model: DeploymentConfig<M>,
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatChunk>;
}

export interface ModelAdapter<E = unknown, M = unknown> {
  protocol: string;
  endpointOptions: z.ZodType<E>;
  modelOptions: z.ZodType<M>;
  connect(endpoint: EndpointConfig<E>): ModelConnection<M>;
}

export const errorFromStatus = (
  status: number | undefined,
  message: string,
  providerCode?: string,
): ModelError => {
  if (status === 429) return new ModelError('rate_limited', 'the model is rate limited');
  if (status === 401 || status === 403)
    return new ModelError('unauthorized', 'the model refused the credentials');
  if (providerCode === 'content_filter')
    return new ModelError('content_filtered', 'the model provider filtered the content');
  if (status !== undefined && status >= 400 && status < 500)
    return new ModelError('bad_request', message);
  return new ModelError('unavailable', 'the model is unavailable');
};

export { authenticatedFetch, authHeaders, type Credential } from '@genai/kernel';

export interface DiscoveredDeployment {
  deployment: string;
  model?: string;
}

export interface DiscoverySource {
  kind: string;
  list(
    endpoint: Pick<EndpointConfig, 'baseURL' | 'credential' | 'timeoutMs'>,
  ): Promise<DiscoveredDeployment[]>;
}
