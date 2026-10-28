import type { Ref } from '@genai/contracts';
import {
  credentialFor,
  type PortContext,
  type PortProvider,
  type SecretResolver,
  type TokenProviders,
} from '@genai/kernel';
import type { EmbeddingAdapter, EmbeddingConnection, EmbeddingModelConfig } from './adapter.js';
import { parseEmbeddingCatalog, type CatalogEmbedder } from './catalog.js';
import {
  EmbeddingError,
  residencyAllows,
  type EmbeddingPort,
  type EmbedResult,
  type Residency,
} from './port.js';

export interface EmbeddingRouterOptions {
  catalog: unknown;
  adapters: EmbeddingAdapter[];
  secrets: SecretResolver;
  tokenProviders?: TokenProviders;
  maxResidency?: Residency;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface EmbeddingOpenOptions {
  maxResidency?: Residency;
}

export interface EmbedderDescription {
  id: string;
  endpoint: string;
  deployment: string;
  residency: Residency;
  dimensions: number;
  maxBatch?: number;
}

interface Route {
  model: CatalogEmbedder;
  config: EmbeddingModelConfig;
  connection: EmbeddingConnection;
}

const batches = <T>(items: T[], size: number | undefined): T[][] => {
  if (!size || items.length <= size) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export class EmbeddingRouter implements PortProvider<EmbeddingPort> {
  readonly #routes = new Map<string, Route>();

  constructor(private readonly options: EmbeddingRouterOptions) {
    this.reload(options.catalog);
  }

  reload(catalog: unknown) {
    const result = parseEmbeddingCatalog(catalog, this.options.adapters);
    if (!result.ok) {
      throw new Error(
        `invalid embedding catalog: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      );
    }
    const options = this.options;
    const adapters = new Map(options.adapters.map((a) => [a.protocol, a]));
    const connections = new Map<string, EmbeddingConnection>();
    for (const [name, endpoint] of Object.entries(result.catalog.endpoints)) {
      const adapter = adapters.get(endpoint.protocol) as EmbeddingAdapter;
      connections.set(
        name,
        adapter.connect({
          baseURL: endpoint.baseURL,
          credential: credentialFor(endpoint.auth, options.secrets, options.tokenProviders),
          options: adapter.endpointOptions.parse(endpoint.options),
          maxRetries: options.maxRetries ?? 3,
          timeoutMs: options.timeoutMs ?? 60_000,
        }),
      );
    }
    const routes = new Map<string, Route>();
    for (const model of result.catalog.models) {
      const endpoint = result.catalog.endpoints[model.endpoint];
      const adapter = adapters.get(endpoint?.protocol ?? '') as EmbeddingAdapter;
      routes.set(model.id, {
        model,
        config: {
          deployment: model.deployment,
          dimensions: model.dimensions,
          options: adapter.modelOptions.parse(model.options),
        },
        connection: connections.get(model.endpoint) as EmbeddingConnection,
      });
    }
    this.#routes.clear();
    for (const [k, v] of routes) this.#routes.set(k, v);
  }

  describe(): EmbedderDescription[] {
    return [...this.#routes.values()]
      .map(({ model }) => ({
        id: model.id,
        endpoint: model.endpoint,
        deployment: model.deployment,
        residency: model.residency,
        dimensions: model.dimensions,
        ...(model.maxBatch === undefined ? {} : { maxBatch: model.maxBatch }),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  open(ref: Ref, ctx: PortContext, request: EmbeddingOpenOptions = {}): EmbeddingPort {
    const route = this.#routes.get(ref.id);
    if (!route) throw new EmbeddingError('bad_request', `no embedder ${ref.id} in the catalog`);
    const { model, config, connection } = route;
    for (const max of [this.options.maxResidency, request.maxResidency]) {
      if (max && !residencyAllows(max, model.residency))
        throw new EmbeddingError('residency', `embedder ${model.id} runs outside ${max}`);
    }
    const embedderRef: Ref = { kind: 'embedder', id: model.id };

    const call = async (texts: string[]): Promise<EmbedResult> => {
      let result: EmbedResult;
      try {
        result = await connection.embed(config, texts, ctx.signal);
      } catch (error) {
        if (error instanceof EmbeddingError) throw error;
        if (ctx.signal.aborted) throw new EmbeddingError('cancelled', 'the request was cancelled');
        throw new EmbeddingError(
          'unavailable',
          error instanceof Error ? error.message : String(error),
        );
      }
      if (result.vectors.length !== texts.length)
        throw new EmbeddingError(
          'invalid_response',
          `embedder ${model.id} returned ${result.vectors.length} vectors for ${texts.length} texts`,
        );
      const wrong = result.vectors.findIndex((v) => v.length !== model.dimensions);
      if (wrong >= 0)
        throw new EmbeddingError(
          'invalid_response',
          `embedder ${model.id} returned a vector of ${result.vectors[wrong]?.length} dimensions, expected ${model.dimensions}`,
        );
      await ctx.meter({ inputTokens: result.usage.inputTokens, requests: 1 }, embedderRef);
      return result;
    };

    return {
      info: () => ({
        id: model.id,
        residency: model.residency,
        dimensions: model.dimensions,
        ...(model.maxBatch === undefined ? {} : { maxBatch: model.maxBatch }),
      }),
      embed: async (texts, { purpose = 'document' } = {}) => {
        if (texts.length === 0) return { vectors: [], usage: { inputTokens: 0 } };
        const prompt = model.prompts?.[purpose] ?? '';
        const inputs = prompt ? texts.map((t) => prompt + t) : texts;
        const vectors: number[][] = [];
        let inputTokens = 0;
        for (const batch of batches(inputs, model.maxBatch)) {
          const result = await call(batch);
          vectors.push(...result.vectors);
          inputTokens += result.usage.inputTokens;
        }
        return { vectors, usage: { inputTokens } };
      },
    };
  }
}
