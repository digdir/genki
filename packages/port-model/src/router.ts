import type { Principal, Ref } from '@genai/contracts';
import {
  credentialFor,
  type Credential,
  type PortContext,
  type PortProvider,
  type SecretResolver,
} from '@genai/kernel';
import type {
  DeploymentConfig,
  DiscoverySource,
  ModelAdapter,
  ModelConnection,
} from './adapter.js';
import {
  parseCatalog,
  type CatalogEndpoint,
  type CatalogModel,
  type ModelCatalog,
} from './catalog.js';
import { applyParameterRules, type ParameterRules, type TunableParameter } from './parameters.js';
import {
  ModelError,
  residencyAllows,
  type Capability,
  type ChatChunk,
  type ChatRequest,
  type ChatResult,
  type ModelPort,
  type Residency,
} from './port.js';

export interface ModelClassification {
  residency?: Residency;
  capabilities?: Capability[];
  enabled?: boolean;
  parameters?: ParameterRules;
  observed?: Partial<Record<TunableParameter, string>>;
}

export interface ModelClassificationStore {
  load(): Promise<Record<string, ModelClassification>>;
  save(id: string, classification: ModelClassification): Promise<void>;
}

export interface ModelRouterOptions {
  catalog: unknown;
  adapters: ModelAdapter[];
  secrets: SecretResolver;
  sources?: DiscoverySource[];
  classifications?: ModelClassificationStore;
  priceOf?: (id: string) => ModelPrice | undefined;
  tokenProviders?: Record<string, () => Promise<string>>;
  maxResidency?: Residency;
  maxRetries?: number;
  timeoutMs?: number;
  onParameterDropped?: (model: string, parameter: TunableParameter) => void;
  fetchFor?: (endpoint: string) => typeof fetch | undefined;
  admits?: (principal: Principal) => boolean;
}

export interface ModelPrice {
  inputPerThousand: number;
  outputPerThousand: number;
}

export interface ModelDescription {
  id: string;
  endpoint: string;
  deployment: string;
  family?: string;
  residency: Residency;
  capabilities: Capability[];
  enabled: boolean;
  origin: 'catalog' | 'discovered';
  classified: boolean;
  price?: ModelPrice | null;
  parameters: ParameterRules;
  rejectedParameters: Partial<Record<TunableParameter, string>>;
}

export interface RefreshResult {
  discovered: number;
  failed: { endpoint: string; error: string }[];
}

interface Route {
  model: CatalogModel;
  family?: string;
  origin: 'catalog' | 'discovered';
  options: unknown;
}

const needed = (request: ChatRequest): Capability[] => [
  ...(request.tools?.length ? (['tools'] as const) : []),
  ...(request.jsonSchema ? (['json-schema'] as const) : []),
  ...(request.reasoning ? (['reasoning'] as const) : []),
];

const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

const matches = (name: string, include: string[], exclude: string[]) =>
  include.some((p) => glob(p).test(name)) && !exclude.some((p) => glob(p).test(name));

export class ModelRouter implements PortProvider<ModelPort> {
  #catalog: ModelCatalog;
  readonly #adapters: Map<string, ModelAdapter>;
  readonly #connections = new Map<string, ModelConnection>();
  readonly #credentials = new Map<string, Credential>();
  readonly #static = new Map<string, Route>();
  #discovered = new Map<string, Route>();
  #classes: Record<string, ModelClassification> = {};
  readonly #live = new Map<string, { residency: Residency; capabilities: Capability[] }>();

  constructor(private readonly options: ModelRouterOptions) {
    this.#adapters = new Map(options.adapters.map((a) => [a.protocol, a]));
    this.#catalog = this.#load(options.catalog);
  }

  #load(input: unknown): ModelCatalog {
    const options = this.options;
    const result = parseCatalog(
      input,
      options.adapters,
      (options.sources ?? []).map((s) => s.kind),
    );
    if (!result.ok) {
      throw new Error(
        `invalid model catalog: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      );
    }
    const connections = new Map<string, ModelConnection>();
    const credentials = new Map<string, Credential>();
    for (const [name, endpoint] of Object.entries(result.catalog.endpoints)) {
      if (
        endpoint.auth.kind === 'token-provider' &&
        !options.tokenProviders?.[endpoint.auth.provider]
      )
        throw new Error(`endpoint ${name} uses unknown token provider ${endpoint.auth.provider}`);
      const adapter = this.#adapters.get(endpoint.protocol) as ModelAdapter;
      const credential = credentialFor(endpoint.auth, options.secrets, options.tokenProviders);
      credentials.set(name, credential);
      const guarded = options.fetchFor?.(name);
      connections.set(
        name,
        adapter.connect({
          baseURL: endpoint.baseURL,
          credential,
          options: adapter.endpointOptions.parse(endpoint.options),
          maxRetries: options.maxRetries ?? 3,
          timeoutMs: options.timeoutMs ?? 120_000,
          ...(guarded ? { fetch: guarded } : {}),
        }),
      );
    }
    const modelOptions = (endpoint: string, raw: unknown) =>
      (
        this.#adapters.get(
          (result.catalog.endpoints[endpoint] as CatalogEndpoint).protocol,
        ) as ModelAdapter
      ).modelOptions.parse(raw ?? {});
    const routes = new Map<string, Route>();
    for (const model of result.catalog.models)
      routes.set(model.id, {
        model,
        ...(model.family ? { family: model.family } : {}),
        origin: 'catalog',
        options: modelOptions(model.endpoint, model.options),
      });
    this.#connections.clear();
    this.#credentials.clear();
    this.#static.clear();
    for (const [k, v] of connections) this.#connections.set(k, v);
    for (const [k, v] of credentials) this.#credentials.set(k, v);
    for (const [k, v] of routes) this.#static.set(k, v);
    this.#discovered = new Map(
      [...this.#discovered].filter(([, r]) => result.catalog.endpoints[r.model.endpoint]),
    );
    this.#catalog = result.catalog;
    this.#rebuild();
    return result.catalog;
  }

  reload(catalog: unknown) {
    this.#load(catalog);
  }

  #modelOptions(endpoint: string, options: unknown) {
    const protocol = (this.#catalog.endpoints[endpoint] as CatalogEndpoint).protocol;
    return (this.#adapters.get(protocol) as ModelAdapter).modelOptions.parse(options ?? {});
  }

  #routes(): Map<string, Route> {
    return new Map([...this.#discovered, ...this.#static]);
  }

  #effective(route: Route): CatalogModel & { enabled: boolean } {
    const c = this.#classes[route.model.id] ?? {};
    return {
      ...route.model,
      residency: c.residency ?? route.model.residency,
      capabilities: c.capabilities ?? route.model.capabilities,
      enabled: c.enabled ?? true,
      ...((c.parameters ?? route.model.parameters)
        ? { parameters: c.parameters ?? route.model.parameters }
        : {}),
    };
  }

  #rebuild() {
    this.#live.clear();
    for (const route of this.#routes().values()) {
      const model = this.#effective(route);
      if (model.enabled)
        this.#live.set(model.id, { residency: model.residency, capabilities: model.capabilities });
    }
  }

  async refresh(): Promise<RefreshResult> {
    if (this.options.classifications) this.#classes = await this.options.classifications.load();
    const sources = new Map((this.options.sources ?? []).map((s) => [s.kind, s]));
    const discovered = new Map<string, Route>();
    const failed: RefreshResult['failed'] = [];
    const listed = new Map<string, Promise<{ deployment: string; model?: string }[]>>();
    const staticPairs = new Set(
      [...this.#static.values()].map((r) => `${r.model.endpoint}/${r.model.deployment}`),
    );

    for (const [name, endpoint] of Object.entries(this.#catalog.endpoints)) {
      const discovery = endpoint.discovery;
      if (!discovery) continue;
      const source = sources.get(discovery.source);
      if (!source) continue;
      const from = discovery.from ?? name;
      const listing = this.#catalog.endpoints[from] as CatalogEndpoint;
      const key = `${discovery.source}:${from}`;
      if (!listed.has(key)) {
        listed.set(
          key,
          source.list({
            baseURL: listing.baseURL,
            credential: this.#credentials.get(from) as Credential,
            timeoutMs: this.options.timeoutMs ?? 15_000,
          }),
        );
      }
      try {
        for (const found of await (listed.get(key) as Promise<
          { deployment: string; model?: string }[]
        >)) {
          if (!matches(found.deployment, discovery.include, discovery.exclude)) continue;
          if (staticPairs.has(`${name}/${found.deployment}`)) continue;
          const id = `${name}/${found.deployment}`.toLowerCase();
          discovered.set(id, {
            model: {
              id,
              endpoint: name,
              deployment: found.deployment,
              residency: 'global',
              capabilities: discovery.capabilities,
              options: {},
            },
            ...(found.model ? { family: found.model } : {}),
            origin: 'discovered',
            options: this.#modelOptions(name, {}),
          });
        }
      } catch (error) {
        failed.push({
          endpoint: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.#discovered = discovered;
    this.#rebuild();
    return { discovered: discovered.size, failed };
  }

  async classify(id: string, classification: ModelClassification): Promise<ModelDescription> {
    const route = this.#routes().get(id);
    if (!route) throw new ModelError('bad_request', `no model ${id}`);
    const next = { ...this.#classes[id], ...classification };
    if (classification.parameters && next.observed) {
      const set = new Set(Object.keys(classification.parameters));
      next.observed = Object.fromEntries(
        Object.entries(next.observed).filter(([name]) => !set.has(name)),
      );
    }
    await this.options.classifications?.save(id, next);
    this.#classes = { ...this.#classes, [id]: next };
    this.#rebuild();
    return this.#describe(route);
  }

  #describe(route: Route): ModelDescription {
    const model = this.#effective(route);
    return {
      id: model.id,
      endpoint: model.endpoint,
      deployment: model.deployment,
      ...(route.family ? { family: route.family } : {}),
      residency: model.residency,
      capabilities: model.capabilities,
      enabled: model.enabled,
      origin: route.origin,
      classified: Object.keys(this.#classes[model.id] ?? {}).some(
        (k) => k !== 'observed' && k !== 'parameters',
      ),
      ...(this.options.priceOf ? { price: this.options.priceOf(model.id) ?? null } : {}),
      parameters: model.parameters ?? {},
      rejectedParameters: this.#classes[model.id]?.observed ?? {},
    };
  }

  describe(): ModelDescription[] {
    return [...this.#routes().values()]
      .map((r) => this.#describe(r))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  models(): Map<string, { residency: Residency; capabilities: Capability[] }> {
    return this.#live;
  }

  async #observe(model: string, dropped: TunableParameter[]) {
    const current = this.#classes[model] ?? {};
    const fresh = dropped.filter((p) => !current.observed?.[p]);
    if (fresh.length === 0) return;
    const at = new Date().toISOString();
    const next = {
      ...current,
      observed: { ...current.observed, ...Object.fromEntries(fresh.map((p) => [p, at])) },
    };
    this.#classes = { ...this.#classes, [model]: next };
    for (const parameter of fresh) this.options.onParameterDropped?.(model, parameter);
    await this.options.classifications?.save(model, next).catch(() => undefined);
  }

  open(ref: Ref, ctx: PortContext): ModelPort {
    if (this.options.admits && !this.options.admits(ctx.principal))
      throw new ModelError('unauthorized', 'this caller may not use models in this environment');
    const route = this.#routes().get(ref.id);
    if (!route) throw new ModelError('bad_request', `no model ${ref.id} in the catalog`);
    const model = this.#effective(route);
    if (!model.enabled) throw new ModelError('bad_request', `model ${model.id} is turned off`);
    if (model.tenants && !model.tenants.includes(ref.tenant ?? ctx.tenant))
      throw new ModelError('bad_request', `model ${model.id} is not shared with this tenant`);
    if (this.options.maxResidency && !residencyAllows(this.options.maxResidency, model.residency))
      throw new ModelError(
        'residency',
        `model ${model.id} runs outside ${this.options.maxResidency}`,
      );
    const connection = this.#connections.get(model.endpoint) as ModelConnection;
    const deployment: DeploymentConfig = { deployment: model.deployment, options: route.options };
    const modelRef: Ref = { kind: 'model', id: model.id };

    const require = (request: ChatRequest, extra: Capability[] = []) => {
      const missing = [...needed(request), ...extra].filter((c) => !model.capabilities.includes(c));
      if (missing.length > 0)
        throw new ModelError(
          'unsupported',
          `model ${model.id} does not support ${missing.join(', ')}`,
        );
    };
    const failure = (error: unknown) => {
      if (error instanceof ModelError) return error;
      if (ctx.signal.aborted) return new ModelError('cancelled', 'the request was cancelled');
      return new ModelError('unavailable', error instanceof Error ? error.message : String(error));
    };
    const served = { id: model.id, endpoint: model.endpoint, deployment: model.deployment };
    const meter = async (result: ChatResult) => {
      await ctx.meter(result.usage, modelRef);
      await ctx.provenance?.({ model: served });
    };
    const observe = (result: ChatResult): ChatResult => {
      const { droppedParameters, ...rest } = result;
      if (droppedParameters?.length) void this.#observe(model.id, droppedParameters);
      return rest;
    };
    const bounded = (input: ChatRequest): ChatRequest => {
      const request = applyParameterRules(input, model.parameters);
      const left = ctx.outputLimit?.();
      if (left === undefined) return request;
      const most = Math.max(1, Math.floor(left));
      return request.maxTokens !== undefined && request.maxTokens <= most
        ? request
        : { ...request, maxTokens: most };
    };

    return {
      info: () => ({
        id: model.id,
        residency: model.residency,
        capabilities: model.capabilities,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.parameters ? { parameters: model.parameters } : {}),
      }),

      chat: async (input) => {
        const request = bounded(input);
        require(request);
        let result: ChatResult;
        try {
          result = await connection.chat(deployment, request, ctx.signal);
        } catch (error) {
          throw failure(error);
        }
        await meter(result);
        return observe(result);
      },

      chatStream: async function* (input): AsyncIterable<ChatChunk> {
        const request = bounded(input);
        require(request, ['stream']);
        let result: ChatResult | undefined;
        try {
          for await (const chunk of connection.chatStream(deployment, request, ctx.signal)) {
            if (chunk.kind === 'done') result = chunk.result;
            else yield chunk;
          }
        } catch (error) {
          throw failure(error);
        }
        if (!result) throw new ModelError('unavailable', 'the stream ended without a result');
        await meter(result);
        yield { kind: 'done', result: observe(result) };
      },
    };
  }
}
