import { withListPrice, type Ref, type UsagePrice } from '@genai/contracts';
import {
  createGate,
  credentialFor,
  embedShape,
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
import { parseEmbeddingCatalog, type CatalogEmbedder } from './catalog.js';
import { EmbeddingError, type EmbeddingPort, type EmbedResult, type Residency } from './port.js';

export interface EmbeddingRouterOptions {
  catalog: unknown;
  adapters: EmbeddingAdapter[];
  secrets: SecretResolver;
  tokenProviders?: TokenProviders;
  priceOf?: (id: string) => UsagePrice | undefined;
  maxResidency?: Residency;
  maxRetries?: number;
  timeoutMs?: number;
  gate?: Gate;
  descriptors?: DescriptorRegistry;
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
  described?: { descriptor: Descriptor; endpoint: DescribedEndpoint };
}

const refusalCodes: Record<GateRefusal, EmbeddingError['code']> = {
  admission: 'unauthorized',
  disabled: 'bad_request',
  'not-shared': 'bad_request',
  residency: 'residency',
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

  reload(catalog: unknown) {
    const result = parseEmbeddingCatalog(catalog, this.options.adapters);
    if (!result.ok) {
      throw new Error(
        `invalid embedding catalog: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      );
    }
    const options = this.options;
    const adapters = new Map(options.adapters.map((a) => [a.protocol, a]));
    const problems: string[] = [];
    for (const model of result.catalog.models) {
      const id = model.descriptors?.embed;
      if (!id) continue;
      const descriptor = options.descriptors?.get(id);
      const protocol = result.catalog.endpoints[model.endpoint]?.protocol;
      if (!descriptor) problems.push(`${model.id}: no descriptor ${id}`);
      else if (descriptor.status !== 'typed' || descriptor.operation !== 'embed')
        problems.push(`${model.id}: ${id} is not a typed embed descriptor`);
      else if (descriptor.api.protocol !== protocol)
        problems.push(`${model.id}: ${id} is for ${descriptor.api.protocol}, not ${protocol}`);
    }
    if (problems.length > 0) throw new Error(`invalid embedding catalog: ${problems.join('; ')}`);
    const connections = new Map<string, EmbeddingConnection>();
    const endpoints = new Map<string, DescribedEndpoint>();
    for (const [name, endpoint] of Object.entries(result.catalog.endpoints)) {
      const adapter = adapters.get(endpoint.protocol) as EmbeddingAdapter;
      const credential = credentialFor(
        endpoint.auth,
        options.secrets,
        options.tokenProviders,
        endpoint.baseURL,
      );
      const timeoutMs = options.timeoutMs ?? 60_000;
      const fetch = this.#gate.egress(name);
      endpoints.set(name, { baseURL: endpoint.baseURL, credential, fetch, timeoutMs });
      connections.set(
        name,
        adapter.connect({
          baseURL: endpoint.baseURL,
          credential,
          options: adapter.endpointOptions.parse(endpoint.options),
          maxRetries: options.maxRetries ?? 3,
          timeoutMs,
          fetch,
        }),
      );
    }
    const routes = new Map<string, Route>();
    for (const model of result.catalog.models) {
      const descriptor = model.descriptors?.embed
        ? options.descriptors?.get(model.descriptors.embed)
        : undefined;
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
        ...(descriptor
          ? {
              described: {
                descriptor,
                endpoint: endpoints.get(model.endpoint) as DescribedEndpoint,
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
        withListPrice(
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
            { signal: ctx.signal, fail: embeddingErrorFromStatus },
          );
          dropped(answer.dropped);
          result = answer.result;
        } else result = await connection.embed(config, texts, ctx.signal);
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
