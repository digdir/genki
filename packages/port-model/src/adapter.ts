import { providerBodyLength, type PriceUnit } from '@genai/contracts';
import type { Credential, Shape } from '@genai/kernel';
import type { z } from 'zod';
import type { DecisionRequest, DecisionResult } from './decision.js';
import {
  ModelError,
  type ChatChunk,
  type ChatRequest,
  type ChatResult,
  type ModelErrorCode,
} from './port.js';

export interface EndpointConfig {
  baseURL: string;
  credential: Credential;
  maxRetries: number;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface DeploymentConfig<O = unknown> {
  deployment: string;
  api: string;
  options: O;
}

export interface ModelTransport {
  api: string;
  source: 'configured' | 'learned' | 'default';
}

export interface ModelConnection<M = unknown> {
  describe?(model: DeploymentConfig<M>): ModelTransport;
  chat(model: DeploymentConfig<M>, request: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
  chatStream(
    model: DeploymentConfig<M>,
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatChunk>;
  decide?(
    model: DeploymentConfig<M>,
    request: DecisionRequest,
    signal: AbortSignal,
  ): Promise<DecisionResult>;
}

/** One wire API an adapter implements in code, registered under its API id (ADR 0048). */
export interface BuiltInApi {
  id: string;
  kind: string;
  family: string;
  modelOptions: z.ZodObject;
  units?: PriceUnit[];
  /** The API a model binds for this kind when it names none and its connection offers only this family. */
  default?: boolean;
}

export interface ModelAdapter<M = unknown> {
  apis: BuiltInApi[];
  /** The closed shape of the replay state this adapter puts in `continuation`. */
  continuation?: Shape;
  connect(endpoint: EndpointConfig): ModelConnection<M>;
}

const providerFailure = (status: number | undefined, body: string | undefined) =>
  status === undefined
    ? undefined
    : { status, ...(body ? { body: body.slice(0, providerBodyLength) } : {}) };

export const errorFromStatus = (
  status: number | undefined,
  message: string,
  providerCode?: string,
  body?: string,
): ModelError => {
  const provider = providerFailure(status, body);
  if (status === 429) return new ModelError('rate_limited', 'the model is rate limited', provider);
  if (status === 401 || status === 403)
    return new ModelError('unauthorized', 'the model refused the credentials', provider);
  if (providerCode === 'content_filter')
    return new ModelError('content_filtered', 'the model provider filtered the content', provider);
  if (status !== undefined && status >= 400 && status < 500)
    return new ModelError('bad_request', message, provider);
  return new ModelError('unavailable', 'the model is unavailable', provider);
};

const errorCodeOfKind: Record<string, ModelErrorCode> = {
  invalid: 'bad_request',
  unavailable: 'unavailable',
  'rate-limited': 'rate_limited',
  refused: 'refused',
  processor: 'refused',
};

/** The model error for a descriptor call: the error kind the descriptor maps, else the status. */
export const describedError = (
  status: number | undefined,
  message: string,
  kind?: string,
  body?: string,
): ModelError => {
  const code = kind ? errorCodeOfKind[kind] : undefined;
  return code
    ? new ModelError(code, message, providerFailure(status, body))
    : errorFromStatus(status, message, undefined, body);
};

export { authenticatedFetch, authHeaders, shape, type Credential } from '@genai/kernel';

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
