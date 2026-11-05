import {
  perThousandView,
  pricedUsage,
  unitPricesFor,
  type PriceSpec,
  type Ref,
  type UnitPrices,
  type UsagePrice,
} from '@genai/contracts';
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
import { describedCall, describedSend } from '@genai/operations';
import {
  errorFromStatus,
  type BuiltInApi,
  type DeploymentConfig,
  type DiscoverySource,
  type ModelAdapter,
  type ModelConnection,
  type ModelTransport,
} from './adapter.js';
import { apiRegistry, type ApiDescriptors, type ApiRegistry } from './apis.js';
import {
  bindingProblem,
  defaultBindings,
  familyURL,
  modelOptionsSchema,
  parseCatalog,
  bindingsOf,
  type ApiBindings,
  type CatalogEndpoint,
  type CatalogModel,
  type ModelCatalog,
} from './catalog.js';
import type { DecisionPort, DecisionRequest, DecisionResult } from './decision.js';
import { unrecordedGovernance, type OperationGovernance, type OperationPort } from './operation.js';
import { chatPayload, decidePayload, modelRefusal } from './gate.js';
import { applyParameterRules, type ParameterRules, type TunableParameter } from './parameters.js';
import {
  ModelError,
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
  apis?: ApiBindings;
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
  priceOf?: (id: string) => PriceSpec | undefined;
  /** Built-in APIs other ports implement, so models can bind them. */
  portApis?: readonly BuiltInApi[];
  typedCalls?: ProcessorRecordCheck;
  onUnrecordedProcessor?: (endpoint: string, kind: string) => void;
  tokenProviders?: Record<string, () => Promise<string>>;
  maxResidency?: Residency;
  maxRetries?: number;
  timeoutMs?: number;
  onParameterDropped?: (model: string, parameter: TunableParameter) => void;
  gate?: Gate;
  descriptors?: ApiDescriptors;
  governance?: OperationGovernance;
}

export type ModelPrice = UsagePrice;

/** What a typed call on a connection without a processor record does: warn and go on, or refuse real data. */
export const processorRecordChecks = ['warn', 'enforce'] as const;
export type ProcessorRecordCheck = (typeof processorRecordChecks)[number];

export interface ModelDescription {
  transport?: ModelTransport;
  id: string;
  endpoint: string;
  deployment: string;
  family?: string;
  residency: Residency;
  capabilities: Capability[];
  apis: ApiBindings;
  operations: Operation[];
  enabled: boolean;
  origin: 'catalog' | 'discovered';
  classified: boolean;
  price?: ModelPrice | null;
  prices?: Record<string, UnitPrices>;
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
  apis: ApiBindings;
}

export const modelOutputCeiling = 16_384;

/** Kinds served by their own ports, not by the model port. */
export const otherPortKinds: readonly string[] = ['embed', 'rerank'];

/** Whether a model serves a kind of the model port, so a service may name it as its model. */
export const servesModelPort = (model: { operations: readonly string[] }) =>
  model.operations.some((kind) => !otherPortKinds.includes(kind));

const kindPorts: Readonly<Record<string, string>> = { chat: 'model', decide: 'decision' };

/** The kernel port a call of this kind goes through, named by the kind alone. */
export const portOfKind = (kind: string) => kindPorts[kind] ?? 'operation';

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
  readonly #apis: ApiRegistry;
  readonly #connections = new Map<string, Map<string, ModelConnection>>();
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
    this.#apis = apiRegistry(options.adapters, options.descriptors, options.portApis);
    this.#catalog = this.#load(options.catalog);
  }

  apis(): ApiRegistry {
    return this.#apis;
  }

  #load(input: unknown): ModelCatalog {
    const options = this.options;
    const result = parseCatalog(
      input,
      this.#apis,
      (options.sources ?? []).map((s) => s.kind),
    );
    if (!result.ok) {
      throw new Error(
        `invalid model catalog: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      );
    }
    const connections = new Map<string, Map<string, ModelConnection>>();
    const credentials = new Map<string, Credential>();
    for (const [name, endpoint] of Object.entries(result.catalog.endpoints)) {
      if (
        endpoint.auth.kind === 'token-provider' &&
        !options.tokenProviders?.[endpoint.auth.provider]
      )
        throw new Error(`endpoint ${name} uses unknown token provider ${endpoint.auth.provider}`);
      const credential = credentialFor(
        endpoint.auth,
        options.secrets,
        options.tokenProviders,
        endpoint.baseURL,
      );
      credentials.set(name, credential);
      connections.set(name, this.#connect(name, endpoint, credential));
    }
    const routes = new Map<string, Route>();
    for (const model of result.catalog.models)
      routes.set(model.id, {
        model,
        ...(model.family ? { family: model.family } : {}),
        origin: 'catalog',
        apis: bindingsOf(model, result.catalog.endpoints[model.endpoint], this.#apis),
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

  /** One client per family the connection offers and adapter that serves it, keyed by the API ids it implements. */
  #connect(name: string, endpoint: CatalogEndpoint, credential: Credential) {
    const byApi = new Map<string, ModelConnection>();
    for (const [family, base] of Object.entries(endpoint.families))
      for (const adapter of this.options.adapters) {
        const served = adapter.apis.filter((a) => a.family === family);
        if (served.length === 0) continue;
        const connection = adapter.connect({
          baseURL: familyURL(endpoint, base),
          credential,
          maxRetries: this.options.maxRetries ?? 3,
          timeoutMs: this.options.timeoutMs ?? 120_000,
          fetch: this.#gate.egress(name),
        });
        for (const api of served) byApi.set(api.id, connection);
      }
    return byApi;
  }

  reload(catalog: unknown) {
    this.#load(catalog);
  }

  #described(model: CatalogModel, family: string) {
    const endpoint = this.#catalog.endpoints[model.endpoint] as CatalogEndpoint;
    return {
      baseURL: familyURL(endpoint, endpoint.families[family] ?? ''),
      credential: this.#credentials.get(model.endpoint) as Credential,
      fetch: this.#gate.egress(model.endpoint),
      timeoutMs: this.options.timeoutMs ?? 120_000,
    };
  }

  #options(model: CatalogModel, apis: ApiBindings): unknown {
    return modelOptionsSchema(apis, this.#apis).parse(model.options ?? {});
  }

  #routes(): Map<string, Route> {
    return new Map([...this.#discovered, ...this.#static]);
  }

  #effective(route: Route): CatalogModel & { enabled: boolean; apis: ApiBindings } {
    const c = this.#classes[route.model.id] ?? {};
    return {
      ...route.model,
      residency: c.residency ?? route.model.residency,
      capabilities: c.capabilities ?? route.model.capabilities,
      apis: c.apis ?? route.apis,
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
      if (model.enabled && servesModelPort({ operations: Object.keys(model.apis) }))
        this.#live.set(model.id, {
          residency: model.residency,
          capabilities: model.capabilities,
          operations: Object.keys(model.apis),
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

    for (const [name, endpoint] of Object.entries(this.#catalog.endpoints))
      for (const rule of endpoint.discovery) {
        const source = sources.get(rule.source);
        if (!source) continue;
        const from = rule.from ?? name;
        const listing = this.#catalog.endpoints[from] as CatalogEndpoint;
        const key = `${rule.source}:${from}`;
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
        const apis = rule.apis ?? defaultBindings(Object.keys(endpoint.families), this.#apis) ?? {};
        const prefix = rule.idPrefix ?? name;
        try {
          for (const found of await (listed.get(key) as Promise<
            { deployment: string; model?: string }[]
          >)) {
            if (!matches(found.deployment, rule.include, rule.exclude)) continue;
            if (staticPairs.has(`${name}/${found.deployment}`)) continue;
            const id = `${prefix}/${found.deployment}`.toLowerCase();
            if (discovered.has(id)) continue;
            discovered.set(id, {
              model: {
                id,
                endpoint: name,
                deployment: found.deployment,
                residency: 'global',
                capabilities: rule.capabilities,
                apis,
                options: {},
              },
              ...(found.model ? { family: found.model } : {}),
              origin: 'discovered',
              apis,
            });
          }
        } catch (error) {
          if (!failed.some((f) => f.endpoint === name))
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
    if (classification.apis) {
      if (Object.keys(classification.apis).length === 0)
        throw new ModelError('bad_request', 'a model binds at least one API');
      const families = Object.keys(
        (this.#catalog.endpoints[route.model.endpoint] as CatalogEndpoint).families,
      );
      const problems = Object.entries(classification.apis).flatMap(([kind, apiId]) => {
        const problem = bindingProblem(kind, apiId, families, this.#apis);
        return problem ? [`${kind}: ${problem}`] : [];
      });
      if (problems.length > 0) throw new ModelError('bad_request', problems.join('; '));
    }
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
    const chat = model.apis.chat;
    const transport = chat
      ? this.#connections
          .get(model.endpoint)
          ?.get(chat)
          ?.describe?.({
            deployment: model.deployment,
            api: chat,
            options: this.#optionsOrEmpty(model),
          })
      : undefined;
    return {
      ...(transport ? { transport } : {}),
      id: model.id,
      endpoint: model.endpoint,
      deployment: model.deployment,
      ...(route.family ? { family: route.family } : {}),
      residency: model.residency,
      capabilities: model.capabilities,
      apis: model.apis,
      operations: Object.keys(model.apis),
      enabled: model.enabled,
      origin: route.origin,
      classified: Object.keys(this.#classes[model.id] ?? {}).some(
        (k) => k !== 'observed' && k !== 'parameters',
      ),
      ...(this.options.priceOf ? this.#priceView(model.id, Object.keys(model.apis)) : {}),
      parameters: model.parameters ?? {},
      rejectedParameters: this.#classes[model.id]?.observed ?? {},
    };
  }

  #priceView(id: string, kinds: string[]) {
    const spec = this.options.priceOf?.(id);
    const prices = Object.fromEntries(
      kinds.flatMap((kind) => {
        const units = unitPricesFor(spec, kind);
        return units ? [[kind, units] as const] : [];
      }),
    );
    return { price: perThousandView(spec) ?? null, prices };
  }

  #unitPrices(id: string, kind: string) {
    return unitPricesFor(this.options.priceOf?.(id), kind);
  }

  readonly #warnedUnrecorded = new Set<string>();

  /** The processor record and maturity a typed call carries; built-in kinds are production by construction. */
  async #typedTarget(target: GateTarget): Promise<GateTarget> {
    const endpoint = target.endpoint ?? '';
    const governance = this.options.governance ?? unrecordedGovernance;
    const recorded = await governance.processorRecorded(endpoint);
    const enforced = this.options.typedCalls === 'enforce';
    if (!recorded && !enforced && !this.#warnedUnrecorded.has(endpoint)) {
      this.#warnedUnrecorded.add(endpoint);
      this.options.onUnrecordedProcessor?.(endpoint, target.operation);
    }
    return {
      ...target,
      maturity: 'production',
      ...(recorded || enforced ? { processorRecord: recorded } : {}),
    };
  }

  #optionsOrEmpty(model: CatalogModel & { apis: ApiBindings }): unknown {
    try {
      return this.#options(model, model.apis);
    } catch {
      return {};
    }
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

  #resolve(ref: Ref, ctx: PortContext, kind: Operation) {
    const route = this.#routes().get(ref.id);
    if (!route) throw new ModelError('bad_request', `no model ${ref.id} in the catalog`);
    const model = this.#effective(route);
    const target: GateTarget = {
      port: portOfKind(kind),
      operation: kind,
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
    const operations = Object.keys(model.apis);
    const info = () => ({
      id: model.id,
      residency: model.residency,
      capabilities: model.capabilities,
      operations,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.parameters ? { parameters: model.parameters } : {}),
    });
    const bound = (needed: string): string => {
      const api = model.apis[needed];
      if (!api)
        throw new ModelError(
          'unsupported',
          `model ${model.id} does not offer the ${needed} operation`,
        );
      return api;
    };
    const implementation = (needed: string) => {
      const api = bound(needed);
      const connection = this.#connections.get(model.endpoint)?.get(api);
      const deployment: DeploymentConfig = {
        deployment: model.deployment,
        api,
        options: this.#options(model, model.apis),
      };
      return { api, connection, deployment };
    };
    return { model, target, failure, served, info, bound, implementation };
  }

  /** The kernel port `decision`: the decide operation on the same catalogue. */
  decisions(): PortProvider<DecisionPort> {
    return { open: (ref, ctx) => this.#openDecision(ref, ctx) };
  }

  #openDecision(ref: Ref, ctx: PortContext): DecisionPort {
    const { model, target, failure, served, info, implementation } = this.#resolve(
      ref,
      ctx,
      'decide',
    );
    const payload = {
      ...decidePayload,
      usage: (result: DecisionResult) =>
        pricedUsage(result.usage, this.#unitPrices(model.id, 'decide')),
      provenance: () => ({ model: served }),
    };
    return {
      info,
      decide: async (request: DecisionRequest) => {
        const { api, connection, deployment } = implementation('decide');
        const builtIn = connection?.decide?.bind(connection);
        const described = builtIn ? undefined : this.#apis.descriptor(api);
        const decide =
          builtIn ??
          (described
            ? async (config: DeploymentConfig, sent: DecisionRequest, signal: AbortSignal) =>
                (
                  await describedSend<DecisionResult>(
                    described,
                    this.#described(model, described.api.family),
                    config.deployment,
                    sent,
                    { signal, fail: errorFromStatus },
                  )
                ).result
            : undefined);
        if (!decide) throw new ModelError('unsupported', `${api} has no implementation for decide`);
        const typed = await this.#typedTarget(target);
        const gated = described ? { ...typed, descriptor: described.id } : typed;
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
    const { model, target, served, info, bound } = this.#resolve(ref, ctx, 'chat');
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
        const api = bound(descriptor.operation);
        if (api !== id)
          throw new ModelError(
            'unsupported',
            `model ${model.id} binds ${api} for ${descriptor.operation}, not ${id}`,
          );
        const families = (this.#catalog.endpoints[model.endpoint] as CatalogEndpoint).families;
        if (!(descriptor.api.family in families))
          throw new ModelError(
            'unsupported',
            `the connection of ${model.id} does not offer the ${descriptor.api.family} family`,
          );
        const endpoint = this.#described(model, descriptor.api.family);
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
            priced: (usage) => pricedUsage(usage, this.#unitPrices(model.id, descriptor.operation)),
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
    const { model, target, failure, served, info, implementation } = this.#resolve(
      ref,
      ctx,
      'chat',
    );
    const chatting = () => {
      const found = implementation('chat');
      if (!found.connection)
        throw new ModelError('unsupported', `${found.api} has no built-in implementation`);
      return { connection: found.connection, deployment: found.deployment };
    };
    const require = (request: ChatRequest, extra: Capability[] = []) => {
      const missing = [...needed(request), ...extra].filter((c) => !model.capabilities.includes(c));
      if (missing.length > 0)
        throw new ModelError(
          'unsupported',
          `model ${model.id} does not support ${missing.join(', ')}`,
        );
    };
    const gate = this.#gate;
    const typed = () => this.#typedTarget(target);
    const payload = {
      ...chatPayload(this.#continuations),
      usage: (result: ChatResult) => pricedUsage(result.usage, this.#unitPrices(model.id, 'chat')),
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
        const { connection, deployment } = chatting();
        require(request);
        const result = await gate.call(ctx, await typed(), payload, request, async (sent) => {
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
        const { connection, deployment } = chatting();
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
        for await (const chunk of gate.stream(ctx, await typed(), payload, request, upstream))
          yield chunk.kind === 'done' ? { kind: 'done', result: observe(chunk.result) } : chunk;
      },
    };
  }
}
