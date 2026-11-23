import type { Ref } from '@genai/contracts';
import {
  createGate,
  credentialFor,
  rerankShape,
  type Gate,
  type GatePayload,
  type GateRefusal,
  type GateTarget,
  type PortContext,
  type PortProvider,
  type SecretResolver,
  type FederatedTokens,
  type TokenProviders,
} from '@genai/kernel';
import {
  describedSend,
  type DescribedEndpoint,
  type Descriptor,
  type DescriptorRegistry,
} from '@genai/operations';
import type { RerankAdapter, RerankConnection, RerankerConfig } from './adapter.js';
import { parseRerankCatalog, type CatalogReranker } from './catalog.js';
import { parseModelRerankers } from './models.js';
import { RerankError, type Ranked, type RerankPort, type Residency } from './port.js';

export interface RerankRouterOptions {
  catalog: unknown;
  /** The model catalogue; its models that bind `rerank` are rerankers too. */
  models?: unknown;
  adapters: RerankAdapter[];
  secrets: SecretResolver;
  tokenProviders?: TokenProviders;
  federatedTokens?: FederatedTokens;
  maxResidency?: Residency;
  timeoutMs?: number;
  maxDocuments?: number;
  onWarning?: (message: string) => void;
  gate?: Gate;
  descriptors?: DescriptorRegistry;
}

interface Route {
  reranker: CatalogReranker;
  config: RerankerConfig;
  connection?: RerankConnection;
  described?: { descriptor: Descriptor; endpoint: DescribedEndpoint; deployment: string };
}

const refusalCodes: Record<GateRefusal, RerankError['code']> = {
  admission: 'unauthorized',
  disabled: 'bad_request',
  'not-shared': 'forbidden',
  residency: 'residency',
  maturity: 'forbidden',
  processor: 'forbidden',
  media: 'bad_request',
  shape: 'bad_request',
  quota: 'forbidden',
};

const rerankPayload: GatePayload<Ranked[]> = {
  shape: rerankShape,
  usage: () => ({ requests: 1 }),
};

/** A fixed message per status: the provider's text can echo the query or documents. */
const rerankErrorFromStatus = (status: number | undefined): RerankError => {
  if (status === 429) return new RerankError('rate_limited', 'the reranker is rate limited');
  if (status === 401 || status === 403)
    return new RerankError('unauthorized', 'the reranker refused the key');
  if (status !== undefined && status >= 400 && status < 500)
    return new RerankError('bad_request', `the reranker refused the request with HTTP ${status}`);
  return new RerankError(
    'unavailable',
    status === undefined ? 'the reranker is unavailable' : `the reranker answered HTTP ${status}`,
  );
};

const valid = (ranking: Ranked[], count: number) =>
  ranking.filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < count);

export class RerankRouter implements PortProvider<RerankPort> {
  readonly #routes = new Map<string, Route>();
  #engineRoutes = new Map<string, Route>();
  #modelRoutes = new Map<string, Route>();
  readonly #warned = new Set<string>();
  readonly #gate: Gate;

  constructor(private readonly options: RerankRouterOptions) {
    this.#gate = options.gate ?? createGate();
    this.reload(options.catalog);
    if (options.models !== undefined) this.reloadModels(options.models);
  }

  #publish() {
    this.#routes.clear();
    for (const [k, v] of [...this.#engineRoutes, ...this.#modelRoutes]) this.#routes.set(k, v);
  }

  /** What keeps the rerankers of a model catalogue from running. */
  problems(models: unknown): { path: string; message: string }[] {
    const result = parseModelRerankers(models, this.options.adapters, this.options.descriptors);
    return result.ok ? [] : result.errors;
  }

  reloadModels(models: unknown) {
    const result = parseModelRerankers(models, this.options.adapters, this.options.descriptors);
    if (!result.ok)
      throw new Error(
        `invalid rerank models: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      );
    const options = this.options;
    const routes = new Map<string, Route>();
    for (const m of result.rerankers) {
      const credential = credentialFor(
        m.auth,
        options.secrets,
        options.tokenProviders,
        m.baseURL,
        options.federatedTokens,
      );
      const fetch = this.#gate.egress(m.endpoint, { tenantHeader: m.gateway });
      const timeoutMs = options.timeoutMs ?? 10_000;
      const reranker: CatalogReranker = {
        id: m.id,
        endpoint: m.endpoint,
        residency: m.residency,
        onFailure: m.onFailure,
        ...(m.tenants ? { tenants: m.tenants } : {}),
        options: m.options,
      };
      const descriptor = m.described ? options.descriptors?.get(m.api) : undefined;
      if (descriptor) {
        routes.set(m.id, {
          reranker,
          config: { id: m.id, options: {} },
          described: {
            descriptor,
            endpoint: {
              baseURL: m.baseURL,
              credential,
              fetch,
              timeoutMs,
              connection: m.endpoint,
              ...(options.descriptors?.module
                ? { modules: (sha: string) => options.descriptors?.module?.(sha) }
                : {}),
              ...(m.settings ? { settings: m.settings } : {}),
              ...(m.keys
                ? {
                    keys: Object.fromEntries(
                      Object.entries(m.keys).map(([name, ref]) => {
                        const named = credentialFor(
                          { kind: 'api-key', secret: ref },
                          options.secrets,
                          options.tokenProviders,
                          m.baseURL,
                        );
                        return [name, named.kind === 'api-key' ? named.key : named.token];
                      }),
                    ),
                  }
                : {}),
            },
            deployment: m.deployment as string,
          },
        });
        continue;
      }
      const adapter = options.adapters.find((a) => a.api?.id === m.api) as RerankAdapter;
      routes.set(m.id, {
        reranker,
        config: { id: m.id, options: adapter.rerankerOptions.parse(m.options) },
        connection: adapter.connect({
          baseURL: m.baseURL,
          credential,
          options: adapter.endpointOptions.parse({}),
          timeoutMs,
          fetch,
        }),
      });
    }
    this.#modelRoutes = routes;
    this.#publish();
  }

  reload(catalog: unknown) {
    const result = parseRerankCatalog(catalog, this.options.adapters);
    if (!result.ok) {
      throw new Error(
        `invalid rerank catalog: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      );
    }
    const options = this.options;
    const adapters = new Map(options.adapters.map((a) => [a.engine, a]));
    const connections = new Map<string, RerankConnection>();
    for (const [name, endpoint] of Object.entries(result.catalog.endpoints)) {
      const adapter = adapters.get(endpoint.engine) as RerankAdapter;
      connections.set(
        name,
        adapter.connect({
          baseURL: endpoint.baseURL,
          credential: credentialFor(
            endpoint.auth,
            options.secrets,
            options.tokenProviders,
            endpoint.baseURL,
          ),
          options: adapter.endpointOptions.parse(endpoint.options),
          timeoutMs: options.timeoutMs ?? 10_000,
          fetch: this.#gate.egress(name),
        }),
      );
    }
    const routes = new Map<string, Route>();
    for (const reranker of result.catalog.rerankers) {
      const endpoint = result.catalog.endpoints[reranker.endpoint];
      const adapter = adapters.get(endpoint?.engine ?? '') as RerankAdapter;
      routes.set(reranker.id, {
        reranker,
        config: { id: reranker.id, options: adapter.rerankerOptions.parse(reranker.options) },
        connection: connections.get(reranker.endpoint) as RerankConnection,
      });
    }
    this.#engineRoutes = routes;
    this.#publish();
  }

  rerankers(): string[] {
    return [...this.#routes.keys()];
  }

  residency(id: string): Residency | undefined {
    return this.#routes.get(id)?.reranker.residency;
  }

  #warnOnce(key: string, message: string) {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.options.onWarning?.(message);
  }

  open(ref: Ref, ctx: PortContext): RerankPort {
    const route = this.#routes.get(ref.id);
    if (!route) throw new RerankError('bad_request', `no reranker ${ref.id} in the catalog`);
    const { reranker, config, connection, described } = route;
    const max = this.options.maxResidency;
    const maxDocuments = this.options.maxDocuments ?? 200;
    const refusals = new WeakSet<RerankError>();
    const target: GateTarget = {
      port: 'rerank',
      operation: 'rerank',
      model: { kind: 'reranker', id: reranker.id },
      endpoint: reranker.endpoint,
      ...(described ? { descriptor: described.descriptor.id } : {}),
      residency: reranker.residency,
      admission: 'admitted',
      ...(reranker.tenants ? { tenants: reranker.tenants } : {}),
      tenant: ref.tenant ?? ctx.tenant,
      ...(max ? { routerResidency: max } : {}),
      refuse: (refusal, message) => {
        const error = new RerankError(refusalCodes[refusal], message);
        refusals.add(error);
        return error;
      },
    };

    return {
      info: () => ({
        id: reranker.id,
        residency: reranker.residency,
        onFailure: reranker.onFailure,
      }),
      rerank: async (request) => {
        if (request.documents.length > maxDocuments)
          throw new RerankError('bad_request', `at most ${maxDocuments} documents per rerank`);
        if (request.documents.length === 0) return { ranking: [] };
        try {
          const ranking = await this.#gate.call(ctx, target, rerankPayload, request, (sent) =>
            described
              ? describedSend<Ranked[]>(
                  described.descriptor,
                  described.endpoint,
                  described.deployment,
                  sent,
                  { signal: ctx.signal, fail: (status) => rerankErrorFromStatus(status) },
                ).then(
                  (answer) => answer.result,
                  (error: unknown) => {
                    if (error instanceof RerankError || ctx.signal.aborted) throw error;
                    throw new RerankError('unavailable', 'the reranker is unavailable');
                  },
                )
              : (connection as RerankConnection).rerank(config, sent, ctx.signal),
          );
          return { ranking: valid(ranking, request.documents.length) };
        } catch (error) {
          if (error instanceof RerankError && refusals.has(error)) throw error;
          if (ctx.signal.aborted) throw new RerankError('cancelled', 'the rerank was cancelled');
          const failure =
            error instanceof RerankError
              ? error
              : new RerankError(
                  'unavailable',
                  error instanceof Error ? error.message : String(error),
                );
          if (reranker.onFailure === 'fail') throw failure;
          this.#warnOnce(
            `${ctx.tenant}:${reranker.id}`,
            `RERANKING DEGRADED for tenant '${ctx.tenant}' on ${reranker.id}: ${failure.message}. Results keep retrieval order.`,
          );
          return { ranking: [], degraded: { reason: 'error', message: failure.message } };
        }
      },
    };
  }
}
