import { pricedUsage, type Ref, type UnitPrices } from '@genai/contracts';
import {
  createGate,
  credentialFor,
  embedShape,
  type Credential,
  type Gate,
  type GatePayload,
  type GateRefusal,
  type GateTarget,
  type PortContext,
  type PortProvider,
  type SecretResolver,
  type TokenProviders,
} from '@genai/kernel';
import {
  describedSend,
  type DescribedEndpoint,
  type Descriptor,
  type DescriptorRegistry,
} from '@genai/operations';
import {
  embeddingErrorFromStatus,
  type EmbeddingAdapter,
  type EmbeddingConnection,
  type EmbeddingModelConfig,
} from './adapter.js';
import { parseEmbedders, type CatalogEmbedder } from './catalog.js';
import { EmbeddingError, type EmbeddingPort, type EmbedResult, type Residency } from './port.js';

export interface EmbeddingRouterOptions {
  /** The model catalogue; its models that bind `embed` are the embedders. */
  catalog: unknown;
  adapters: EmbeddingAdapter[];
  secrets: SecretResolver;
  tokenProviders?: TokenProviders;
  priceOf?: (id: string) => UnitPrices | undefined;
  maxResidency?: Residency;
  maxRetries?: number;
  timeoutMs?: number;
  gate?: Gate;
  descriptors?: DescriptorRegistry;
}

export interface EmbeddingOpenOptions {
  maxResidency?: Residency;
  /**
   * The SDK's own retries for this embedder's calls, in place of the router's `maxRetries`. A
   * knowledge job opens with 0 and retries itself, so a 429 pauses every job at once (#400).
   */
  retries?: number;
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
  connection?: EmbeddingConnection;
  described?: { descriptor: Descriptor; endpoint: DescribedEndpoint };
}

const refusalCodes: Record<GateRefusal, EmbeddingError['code']> = {
  admission: 'unauthorized',
  disabled: 'bad_request',
  'not-shared': 'bad_request',
  residency: 'residency',
  maturity: 'bad_request',
  processor: 'bad_request',
  media: 'bad_request',
  shape: 'bad_request',
};

const batches = <T>(items: T[], size: number | undefined): T[][] => {
  if (!size || items.length <= size) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export class EmbeddingRouter implements PortProvider<EmbeddingPort> {
  readonly #routes = new Map<string, Route>();
  readonly #gate: Gate;

  constructor(private readonly options: EmbeddingRouterOptions) {
    this.#gate = options.gate ?? createGate();
    this.reload(options.catalog);
  }

  /** What keeps the embedders of a model catalogue from running. */
  problems(catalog: unknown): { path: string; message: string }[] {
    const result = parseEmbedders(catalog, this.options.adapters, this.options.descriptors);
    return result.ok ? [] : result.errors;
  }

  reload(catalog: unknown) {
    const options = this.options;
    const result = parseEmbedders(catalog, options.adapters, options.descriptors);
    if (!result.ok) {
      throw new Error(
        `invalid embedding models: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      );
    }
    const credentials = new Map<string, Credential>();
    for (const [name, spec] of Object.entries(result.catalog.connections))
      credentials.set(
        name,
        credentialFor(spec.auth, options.secrets, options.tokenProviders, spec.baseURL),
      );
    const timeoutMs = options.timeoutMs ?? 60_000;
    const connections = new Map<string, EmbeddingConnection>();
    const routes = new Map<string, Route>();
    for (const model of result.catalog.embedders) {
      const credential = credentials.get(model.endpoint) as Credential;
      const fetch = this.#gate.egress(model.endpoint);
      const adapter = options.adapters.find((a) => a.api.id === model.api);
      const key = `${model.endpoint}\u0000${model.api}`;
      if (adapter && !connections.has(key))
        connections.set(
          key,
          adapter.connect({
            baseURL: model.baseURL,
            credential,
            maxRetries: options.maxRetries ?? 3,
            timeoutMs,
            fetch,
          }),
        );
      const descriptor = adapter ? undefined : options.descriptors?.get(model.api);
      routes.set(model.id, {
        model,
        config: {
          deployment: model.deployment,
          dimensions: model.dimensions,
          options: adapter ? adapter.modelOptions.parse(model.options) : {},
        },
        ...(adapter ? { connection: connections.get(key) as EmbeddingConnection } : {}),
        ...(descriptor
          ? {
              described: {
                descriptor,
                endpoint: { baseURL: model.baseURL, credential, fetch, timeoutMs },
              },
            }
          : {}),
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
    const { model, config, connection, described } = route;
    const embedderRef: Ref = { kind: 'embedder', id: model.id };
    const target: GateTarget = {
      port: 'embedding',
      operation: 'embed',
      model: embedderRef,
      endpoint: model.endpoint,
      residency: model.residency,
      admission: 'open',
      ...(model.tenants ? { tenants: model.tenants } : {}),
      tenant: ref.tenant ?? ctx.tenant,
      ...(this.options.maxResidency ? { routerResidency: this.options.maxResidency } : {}),
      ...(request.maxResidency ? { requestResidency: request.maxResidency } : {}),
      refuse: (refusal, message) => new EmbeddingError(refusalCodes[refusal], message),
    };
    const payload: GatePayload<EmbedResult> = {
      shape: embedShape,
      usage: (result) =>
        pricedUsage(
          { inputTokens: result.usage.inputTokens, requests: 1 },
          this.options.priceOf?.(model.id),
        ),
    };

    const send = async (texts: string[], dropped: (n: number) => void): Promise<EmbedResult> => {
      let result: EmbedResult;
      try {
        if (described) {
          const answer = await describedSend<EmbedResult>(
            described.descriptor,
            described.endpoint,
            config.deployment,
            texts,
            {
              signal: ctx.signal,
              fail: (status, message) => embeddingErrorFromStatus(status, message),
            },
          );
          dropped(answer.dropped);
          result = answer.result;
        } else if (connection)
          result = await connection.embed(
            config,
            texts,
            ctx.signal,
            request.retries === undefined ? {} : { maxRetries: request.retries },
          );
        else throw new EmbeddingError('unavailable', `${model.api} has no implementation`);
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
      return result;
    };
    const call = (texts: string[]) => {
      let dropped = 0;
      const gated = described ? { ...target, descriptor: described.descriptor.id } : target;
      return this.#gate.call(ctx, gated, { ...payload, dropped: () => dropped }, texts, (sent) =>
        send(sent, (n) => {
          dropped = n;
        }),
      );
    };

    return {
      info: () => ({
        id: model.id,
        residency: model.residency,
        dimensions: model.dimensions,
        ...(model.maxBatch === undefined ? {} : { maxBatch: model.maxBatch }),
      }),
      embed: async (texts) => {
        if (texts.length === 0) return { vectors: [], usage: { inputTokens: 0 } };
        const vectors: number[][] = [];
        let inputTokens = 0;
        for (const batch of batches(texts, model.maxBatch)) {
          const result = await call(batch);
          vectors.push(...result.vectors);
          inputTokens += result.usage.inputTokens;
        }
        return { vectors, usage: { inputTokens } };
      },
    };
  }
}
