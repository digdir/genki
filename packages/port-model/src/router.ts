import { withListPrice, type Ref } from '@genai/contracts';
import {
  createGate,
  credentialFor,
  type Credential,
  type Gate,
  type GateTarget,
  type PortContext,
  type PortProvider,
  type SecretResolver,
  type Shape,
} from '@genai/kernel';
import { describedCall, describedSend, type DescriptorRegistry } from '@genai/operations';
import {
  errorFromStatus,
  type DeploymentConfig,
  type DiscoverySource,
  type ModelAdapter,
  type ModelConnection,
  type ModelTransport,
} from './adapter.js';
import {
  parseCatalog,
  type CatalogEndpoint,
  type CatalogModel,
  type ModelCatalog,
} from './catalog.js';
import type { DecisionPort, DecisionRequest, DecisionResult } from './decision.js';
import { unrecordedGovernance, type OperationGovernance, type OperationPort } from './operation.js';
import { chatPayload, decidePayload, modelRefusal } from './gate.js';
import { applyParameterRules, type ParameterRules, type TunableParameter } from './parameters.js';
import {
  defaultOperations,
  ModelError,
  operationKinds,
  type Capability,
  type ChatChunk,
  type ChatRequest,
  type ChatResult,
  type ModelPort,
  type Operation,
  type Residency,
} from './port.js';

export interface ModelClassification {
  residency?: Residency;
  capabilities?: Capability[];
  operations?: Operation[];
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
  gate?: Gate;
  descriptors?: DescriptorRegistry;
  governance?: OperationGovernance;
}

export interface ModelPrice {
  inputPerThousand: number;
  outputPerThousand: number;
}

export interface ModelDescription {
  transport?: ModelTransport;
  id: string;
  endpoint: string;
  deployment: string;
  family?: string;
  residency: Residency;
  capabilities: Capability[];
  operations: Operation[];
  descriptors?: { decide?: string | undefined };
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

export interface LiveModel {
  residency: Residency;
  capabilities: Capability[];
  operations: Operation[];
}

interface Route {
  model: CatalogModel;
  family?: string;
  origin: 'catalog' | 'discovered';
  options: unknown;
}

export const modelOutputCeiling = 16_384;

export const catalogDescriptorProblems = (
  catalog: ModelCatalog,
  registry: DescriptorRegistry | undefined,
): { path: string; message: string }[] => [
  ...unknownOperationProblems(catalog, registry),
  ...catalog.models.flatMap((model, index) =>
    Object.entries(model.descriptors ?? {}).flatMap(([operation, id]) => {
      if (!id) return [];
      const path = `models.${index}.descriptors.${operation}`;
      const descriptor = registry?.get(id);
      const protocol = catalog.endpoints[model.endpoint]?.protocol;
      const message = !descriptor
        ? `no descriptor ${id}`
        : descriptor.status !== 'typed'
          ? `${id} is in review and serves no service yet`
          : descriptor.operation !== operation
            ? `${id} describes ${descriptor.operation}, not ${operation}`
            : descriptor.api.protocol !== protocol
              ? `${id} is for ${descriptor.api.protocol}, not ${protocol}`
              : undefined;
      return message ? [{ path, message }] : [];
    }),
  ),
];

const unknownOperations = (operations: readonly string[], known: readonly string[]) =>
  operations.filter((o) => !known.includes(o));

const unknownOperationProblems = (
  catalog: ModelCatalog,
  registry: DescriptorRegistry | undefined,
): { path: string; message: string }[] => {
  const known = operationKinds(registry);
  return catalog.models.flatMap((model, index) =>
    unknownOperations(model.operations, known).map((o) => ({
      path: `models.${index}.operations`,
      message: `no descriptor defines the ${o} operation`,
    })),
  );
};

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
  readonly #live = new Map<string, LiveModel>();
  readonly #gate: Gate;
  readonly #continuations: Shape[];

  constructor(private readonly options: ModelRouterOptions) {
    this.#continuations = options.adapters.flatMap((a) => (a.continuation ? [a.continuation] : []));
    this.#gate = options.gate ?? createGate();
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
    this.#checkDescriptors(result.catalog);
    const connections = new Map<string, ModelConnection>();
    const credentials = new Map<string, Credential>();
    for (const [name, endpoint] of Object.entries(result.catalog.endpoints)) {
      if (
        endpoint.auth.kind === 'token-provider' &&
        !options.tokenProviders?.[endpoint.auth.provider]
      )
        throw new Error(`endpoint ${name} uses unknown token provider ${endpoint.auth.provider}`);
      const adapter = this.#adapters.get(endpoint.protocol) as ModelAdapter;
      const credential = credentialFor(
        endpoint.auth,
        options.secrets,
        options.tokenProviders,
        endpoint.baseURL,
      );
      credentials.set(name, credential);
      connections.set(
        name,
        adapter.connect({
          baseURL: endpoint.baseURL,
          credential,
          options: adapter.endpointOptions.parse(endpoint.options),
          maxRetries: options.maxRetries ?? 3,
          timeoutMs: options.timeoutMs ?? 120_000,
          fetch: this.#gate.egress(name),
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

  #checkDescriptors(catalog: ModelCatalog) {
    const problems = catalogDescriptorProblems(catalog, this.options.descriptors);
    if (problems.length > 0)
      throw new Error(
        `invalid model catalog: ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`,
      );
  }

  #described(model: CatalogModel) {
    const endpoint = this.#catalog.endpoints[model.endpoint] as CatalogEndpoint;
    return {
      baseURL: endpoint.baseURL,
      credential: this.#credentials.get(model.endpoint) as Credential,
      fetch: this.#gate.egress(model.endpoint),
      timeoutMs: this.options.timeoutMs ?? 120_000,
      protocol: endpoint.protocol,
    };
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
      operations: c.operations ?? route.model.operations,
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
        this.#live.set(model.id, {
          residency: model.residency,
          capabilities: model.capabilities,
          operations: model.operations,
        });
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
              operations: [...defaultOperations],
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
    await this.options.descriptors?.refresh?.();
    const unknown = unknownOperations(
      classification.operations ?? [],
      operationKinds(this.options.descriptors),
    );
    if (unknown.length > 0)
      throw new ModelError(
        'bad_request',
        `no descriptor defines the ${unknown.join(', ')} operation`,
      );
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
    const transport = this.#connections
      .get(model.endpoint)
      ?.describe?.({ deployment: model.deployment, options: route.options });
    return {
      ...(transport ? { transport } : {}),
      id: model.id,
      endpoint: model.endpoint,
      deployment: model.deployment,
      ...(route.family ? { family: route.family } : {}),
      residency: model.residency,
      capabilities: model.capabilities,
      operations: model.operations,
      ...(model.descriptors ? { descriptors: model.descriptors } : {}),
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

  models(): Map<string, LiveModel> {
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

  #resolve(ref: Ref, ctx: PortContext, operation: Operation) {
    const route = this.#routes().get(ref.id);
    if (!route) throw new ModelError('bad_request', `no model ${ref.id} in the catalog`);
    const model = this.#effective(route);
    const connection = this.#connections.get(model.endpoint) as ModelConnection;
    const deployment: DeploymentConfig = { deployment: model.deployment, options: route.options };
    const target: GateTarget = {
      port: operation === 'chat' ? 'model' : 'decision',
      operation,
      model: { kind: 'model', id: model.id },
      endpoint: model.endpoint,
      residency: model.residency,
      admission: 'admitted',
      enabled: model.enabled,
      ...(model.tenants ? { tenants: model.tenants } : {}),
      tenant: ref.tenant ?? ctx.tenant,
      ...(this.options.maxResidency ? { routerResidency: this.options.maxResidency } : {}),
      refuse: modelRefusal,
    };
    const failure = (error: unknown) => {
      if (error instanceof ModelError) return error;
      if (ctx.signal.aborted) return new ModelError('cancelled', 'the request was cancelled');
      return new ModelError('unavailable', error instanceof Error ? error.message : String(error));
    };
    const served = { id: model.id, endpoint: model.endpoint, deployment: model.deployment };
    const info = () => ({
      id: model.id,
      residency: model.residency,
      capabilities: model.capabilities,
      operations: model.operations,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.parameters ? { parameters: model.parameters } : {}),
    });
    const offers = (needed: string) => {
      if (!(model.operations as readonly string[]).includes(needed))
        throw new ModelError(
          'unsupported',
          `model ${model.id} does not offer the ${needed} operation`,
        );
    };
    return { model, connection, deployment, target, failure, served, info, offers };
  }

  /** The kernel port `decision`: the decide operation on the same catalogue. */
  decisions(): PortProvider<DecisionPort> {
    return { open: (ref, ctx) => this.#openDecision(ref, ctx) };
  }

  #openDecision(ref: Ref, ctx: PortContext): DecisionPort {
    const { model, connection, deployment, target, failure, served, info, offers } = this.#resolve(
      ref,
      ctx,
      'decide',
    );
    const payload = {
      ...decidePayload,
      usage: (result: DecisionResult) =>
        withListPrice(result.usage, this.options.priceOf?.(model.id)),
      provenance: () => ({ model: served }),
    };
    return {
      info,
      decide: async (request: DecisionRequest) => {
        offers('decide');
        const described = model.descriptors?.decide
          ? this.options.descriptors?.get(model.descriptors.decide)
          : undefined;
        const decide = described
          ? async (config: DeploymentConfig, sent: DecisionRequest, signal: AbortSignal) =>
              (
                await describedSend<DecisionResult>(
                  described,
                  this.#described(model),
                  config.deployment,
                  sent,
                  { signal, fail: errorFromStatus },
                )
              ).result
          : connection.decide?.bind(connection);
        if (!decide)
          throw new ModelError(
            'unsupported',
            `the adapter for ${model.endpoint} does not implement the decide operation`,
          );
        const gated = described ? { ...target, descriptor: described.id } : target;
        return this.#gate.call(ctx, gated, payload, request, async (sent) => {
          try {
            return await decide(deployment, sent, ctx.signal);
          } catch (error) {
            throw failure(error);
          }
        });
      },
    };
  }

  /** The kernel port `operation`: a descriptor call on a catalogue model, for the raw tier. */
  operations(): PortProvider<OperationPort> {
    return { open: (ref, ctx) => this.#openOperation(ref, ctx, 'raw') };
  }

  /** The kernel port `described`: a reviewed descriptor call from a service's `call-operation` step. */
  described(): PortProvider<OperationPort> {
    return { open: (ref, ctx) => this.#openOperation(ref, ctx, 'described') };
  }

  #openOperation(ref: Ref, ctx: PortContext, tier: 'raw' | 'described'): OperationPort {
    const { model, target, served, info, offers } = this.#resolve(ref, ctx, 'chat');
    const plain: GateTarget = { ...target };
    Reflect.deleteProperty(plain, 'refuse');
    const governance = this.options.governance ?? unrecordedGovernance;
    return {
      info,
      call: async (id, input, options) => {
        await this.options.descriptors?.refresh?.();
        const descriptor = this.options.descriptors?.get(id);
        if (!descriptor) throw new ModelError('bad_request', `no descriptor ${id}`);
        if (tier === 'described' && descriptor.status === 'review')
          throw new ModelError(
            'refused',
            `${id} is in review; only an operator tries it, in the raw tier`,
          );
        offers(descriptor.operation);
        const endpoint = this.#described(model);
        if (endpoint.protocol !== descriptor.api.protocol)
          throw new ModelError(
            'unsupported',
            `${id} is for ${descriptor.api.protocol}, and ${model.id} speaks ${endpoint.protocol}`,
          );
        const [maturity, processorRecord] = await Promise.all([
          governance.maturity(descriptor.operation),
          governance.processorRecorded(model.endpoint),
        ]);
        return describedCall(
          {
            gate: this.#gate,
            ctx,
            target: {
              ...plain,
              port: tier === 'raw' ? 'operation' : 'described',
              operation: descriptor.operation,
              maturity,
              synthetic: tier === 'raw',
              processorRecord,
            },
            descriptor,
            endpoint,
            deployment: model.deployment,
            priced: (usage) => withListPrice(usage, this.options.priceOf?.(model.id)),
            provenance: () => ({ model: served }),
            fail: errorFromStatus,
            ...(tier === 'raw' && options?.observe ? { observe: options.observe } : {}),
          },
          input,
        );
      },
    };
  }

  open(ref: Ref, ctx: PortContext): ModelPort {
    const { model, connection, deployment, target, failure, served, info, offers } = this.#resolve(
      ref,
      ctx,
      'chat',
    );
    const require = (request: ChatRequest, extra: Capability[] = []) => {
      offers('chat');
      const missing = [...needed(request), ...extra].filter((c) => !model.capabilities.includes(c));
      if (missing.length > 0)
        throw new ModelError(
          'unsupported',
          `model ${model.id} does not support ${missing.join(', ')}`,
        );
    };
    const gate = this.#gate;
    const payload = {
      ...chatPayload(this.#continuations),
      usage: (result: ChatResult) => withListPrice(result.usage, this.options.priceOf?.(model.id)),
      provenance: () => ({ model: served }),
    };
    const observe = (result: ChatResult): ChatResult => {
      const { droppedParameters, ...rest } = result;
      if (droppedParameters?.length) void this.#observe(model.id, droppedParameters);
      return rest;
    };
    const bounded = (input: ChatRequest): ChatRequest => {
      const request = applyParameterRules(input, model.parameters);
      const ceiling = model.maxOutputTokens ?? modelOutputCeiling;
      const left = ctx.outputLimit?.();
      if (left === undefined)
        return request.maxTokens !== undefined && request.maxTokens > ceiling
          ? { ...request, maxTokens: ceiling }
          : request;
      const most = Math.max(1, Math.min(Math.floor(left), ceiling));
      return request.maxTokens !== undefined && request.maxTokens <= most
        ? request
        : { ...request, maxTokens: most };
    };

    return {
      info,

      chat: async (input) => {
        const request = bounded(input);
        require(request);
        const result = await gate.call(ctx, target, payload, request, async (sent) => {
          try {
            return await connection.chat(deployment, sent, ctx.signal);
          } catch (error) {
            throw failure(error);
          }
        });
        return observe(result);
      },

      chatStream: async function* (input): AsyncIterable<ChatChunk> {
        const request = bounded(input);
        require(request, ['stream']);
        const upstream = async function* (sent: ChatRequest): AsyncIterable<ChatChunk> {
          let ended = false;
          try {
            for await (const chunk of connection.chatStream(deployment, sent, ctx.signal)) {
              if (chunk.kind === 'done') ended = true;
              yield chunk;
            }
          } catch (error) {
            throw failure(error);
          }
          if (!ended) throw new ModelError('unavailable', 'the stream ended without a result');
        };
        for await (const chunk of gate.stream(ctx, target, payload, request, upstream))
          yield chunk.kind === 'done' ? { kind: 'done', result: observe(chunk.result) } : chunk;
      },
    };
  }
}
