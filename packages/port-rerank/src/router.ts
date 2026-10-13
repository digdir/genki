import type { Ref } from '@genai/contracts';
import {
  credentialFor,
  type PortContext,
  type PortProvider,
  type SecretResolver,
  type TokenProviders,
} from '@genai/kernel';
import type { RerankAdapter, RerankConnection, RerankerConfig } from './adapter.js';
import { parseRerankCatalog, type CatalogReranker } from './catalog.js';
import { RerankError, type Ranked, type RerankPort, type Residency } from './port.js';

export interface RerankRouterOptions {
  catalog: unknown;
  adapters: RerankAdapter[];
  secrets: SecretResolver;
  tokenProviders?: TokenProviders;
  maxResidency?: Residency;
  timeoutMs?: number;
  maxDocuments?: number;
  onWarning?: (message: string) => void;
  fetchFor?: (endpoint: string) => typeof fetch | undefined;
}

interface Route {
  reranker: CatalogReranker;
  config: RerankerConfig;
  connection: RerankConnection;
}

const order: Residency[] = ['norway', 'eu', 'global'];

const valid = (ranking: Ranked[], count: number) =>
  ranking.filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < count);

export class RerankRouter implements PortProvider<RerankPort> {
  readonly #routes = new Map<string, Route>();
  readonly #warned = new Set<string>();

  constructor(private readonly options: RerankRouterOptions) {
    this.reload(options.catalog);
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
      const guarded = options.fetchFor?.(name);
      connections.set(
        name,
        adapter.connect({
          baseURL: endpoint.baseURL,
          credential: credentialFor(endpoint.auth, options.secrets, options.tokenProviders),
          options: adapter.endpointOptions.parse(endpoint.options),
          timeoutMs: options.timeoutMs ?? 10_000,
          ...(guarded ? { fetch: guarded } : {}),
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
    this.#routes.clear();
    for (const [k, v] of routes) this.#routes.set(k, v);
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
    const { reranker, config, connection } = route;
    const max = this.options.maxResidency;
    if (max && order.indexOf(reranker.residency) > order.indexOf(max))
      throw new RerankError('residency', `reranker ${reranker.id} runs outside ${max}`);
    const maxDocuments = this.options.maxDocuments ?? 200;

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
          const ranking = await connection.rerank(config, request, ctx.signal);
          return { ranking: valid(ranking, request.documents.length) };
        } catch (error) {
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
