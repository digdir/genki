import {
  perThousandView,
  pricedUsage,
  type Usage,
  unitPricesFor,
  type PriceSpec,
  type Ref,
  type UnitPrices,
  type UsagePrice,
} from '@genai/contracts';
import {
  addUsage,
  createGate,
  credentialFor,
  type Credential,
  type FederatedTokens,
  type Gate,
  type GateTarget,
  type ObjectLedger,
  type ProviderObjectRecord,
  type PortContext,
  type PortProvider,
  type SecretResolver,
  type Shape,
} from '@genai/kernel';
import {
  describedCall,
  describedSend,
  deleteProviderObject,
  describedSession,
  describedStreamCall,
  type DescribedCall,
  type SessionIO,
} from '@genai/operations';
import {
  describedError,
  errorFromStatus,
  type BuiltInApi,
  type DeploymentConfig,
  type DiscoveredDeployment,
  type DiscoverySource,
  type ModelAdapter,
  type ModelConnection,
  type ModelTransport,
} from './adapter.js';
import { apiRegistry, type ApiDescriptors, type ApiRegistry } from './apis.js';
import {
  defaultDiscoveryGraceMs,
  failedNow,
  inMemoryDiscoveredModels,
  listedNow,
  listingTarget,
  listingErrorKind,
  listingKey,
  ListingMisconfigured,
  type DiscoveredModelStore,
  type DiscoveryListing,
  type ListingErrorKind,
} from './discovery.js';
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
import {
  unrecordedGovernance,
  type OperationCallOptions,
  type OperationGovernance,
  type OperationPort,
} from './operation.js';
import {
  checkCapability,
  checkedCapabilities,
  type CapabilityCheck,
  type LearnedCapabilities,
} from './capability-checks.js';
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
  learned?: LearnedCapabilities;
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
  discovered?: DiscoveredModelStore;
  /** How long a model a listing no longer names is kept, from when a listing last named it. */
  discoveryGraceMs?: number;
  priceOf?: (id: string) => PriceSpec | undefined;
  /** Built-in APIs other ports implement, so models can bind them. */
  portApis?: readonly BuiltInApi[];
  typedCalls?: ProcessorRecordCheck;
  onUnrecordedProcessor?: (endpoint: string, kind: string) => void;
  tokenProviders?: Record<string, () => Promise<string>>;
  federatedTokens?: FederatedTokens;
  maxResidency?: Residency;
  maxRetries?: number;
  timeoutMs?: number;
  onParameterDropped?: (model: string, parameter: TunableParameter) => void;
  gate?: Gate;
  descriptors?: ApiDescriptors;
  governance?: OperationGovernance;
  objects?: ObjectLedger;
  /** Called after discovery, a reload or a classification changes which models exist or what they are. */
  onChange?: () => void;
  /** A fetch that only reaches the listed hosts and never a private address; used for answer links. */
  foreignFetch?: (hosts: string[]) => typeof fetch;
  now?: () => Date;
}

export type ModelPrice = UsagePrice;

/** What a typed call on a connection without a processor record does: warn and go on, or refuse real data. */
export const processorRecordChecks = ['warn', 'enforce'] as const;
export type ProcessorRecordCheck = (typeof processorRecordChecks)[number];

export interface ModelDescription {
  transport?: ModelTransport;
  id: string;
  kind: string;
  kindFrom?: KindSource;
  /** The paths the provider's listing says the model answers on. */
  listedEndpoints?: string[];
  endpoint: string;
  deployment: string;
  family?: string;
  maker?: string;
  operator?: { name: string; region?: string };
  residency: Residency;
  capabilities: Capability[];
  contextWindow?: number;
  releaseDate?: string;
  apis: ApiBindings;
  operations: Operation[];
  enabled: boolean;
  origin: 'catalog' | 'discovered';
  classified: boolean;
  price?: ModelPrice | null;
  prices?: Record<string, UnitPrices>;
  parameters: ParameterRules;
  rejectedParameters: Partial<Record<TunableParameter, string>>;
  learned?: LearnedCapabilities;
}

export interface RefreshResult {
  discovered: number;
  failed: { endpoint: string; error: string }[];
}

export interface ListingStatus {
  connection: string;
  source: string;
  discovered: number;
  listed: number;
  listedAt?: string;
  lastError?: { kind: ListingErrorKind; at: string };
}

export interface LearnOptions {
  maxCalls?: number;
  freshForMs?: number;
}

export interface LearnResult {
  checked: { model: string; capability: Capability; has: boolean }[];
  calls: number;
  deferred: number;
  usage: Usage;
}

export const defaultLearnCalls = 12;
export const learnedFreshForMs = 7 * 24 * 60 * 60 * 1000;

export interface LiveModel {
  residency: Residency;
  capabilities: Capability[];
  operations: Operation[];
  /** Capabilities a check found missing, with when it checked. */
  checked?: Partial<Record<Capability, string>>;
}

interface Route {
  model: CatalogModel;
  family?: string;
  origin: 'catalog' | 'discovered';
  apis: ApiBindings;
  listed?: Capability[];
  kind?: string;
  kindFrom?: KindSource;
  endpoints?: string[];
  listing?: string;
}

/** Where a discovered model's kind came from: the provider's listing, the operator's rule, or its name. */
export type KindSource = 'listing' | 'operator' | 'name';

const kindOrder = ['chat', 'embed', 'rerank', 'decide'];

/** The kind a model is: the one discovery found, else the first kind it binds, chat before the rest. */
const kindOfBindings = (apis: ApiBindings): string | undefined =>
  kindOrder.find((k) => apis[k] !== undefined) ?? Object.keys(apis).sort()[0];

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

const modelSlug = (deployment: string) =>
  deployment
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '');

const matches = (name: string, include: string[], exclude: string[]) =>
  include.some((p) => glob(p).test(name)) && !exclude.some((p) => glob(p).test(name));

export class ModelRouter implements PortProvider<ModelPort> {
  #catalog: ModelCatalog;
  readonly #apis: ApiRegistry;
  readonly #connections = new Map<string, Map<string, ModelConnection>>();
  readonly #credentials = new Map<string, Credential>();
  readonly #static = new Map<string, Route>();
  #discovered = new Map<string, Route>();
  #listings = new Map<string, DiscoveryListing>();
  readonly #store: DiscoveredModelStore;
  #classes: Record<string, ModelClassification> = {};
  readonly #live = new Map<string, LiveModel>();
  readonly #gate: Gate;
  readonly #continuations: Shape[];

  constructor(private readonly options: ModelRouterOptions) {
    this.#continuations = options.adapters.flatMap((a) => (a.continuation ? [a.continuation] : []));
    this.#gate = options.gate ?? createGate();
    this.#apis = apiRegistry(options.adapters, options.descriptors, options.portApis);
    this.#store = options.discovered ?? inMemoryDiscoveredModels();
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
        options.federatedTokens,
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
    this.#catalog = result.catalog;
    this.#discovered = this.#discoveredFrom(this.#listings);
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
          fetch: this.#gate.egress(name, { tenantHeader: endpoint.gateway === true }),
        });
        for (const api of served) byApi.set(api.id, connection);
      }
    return byApi;
  }

  reload(catalog: unknown) {
    this.#load(catalog);
    this.options.onChange?.();
  }

  #described(connection: string, family: string) {
    const endpoint = this.#catalog.endpoints[connection] as CatalogEndpoint;
    const baseURL = familyURL(endpoint, endpoint.families[family] ?? '');
    const own = this.#gate.egress(connection, { tenantHeader: endpoint.gateway === true });
    const hosts = endpoint.allowedHosts ?? [];
    const foreign = hosts.length > 0 ? this.options.foreignFetch?.(hosts) : undefined;
    const ownHost = new URL(baseURL).host;
    return {
      baseURL,
      credential: this.#credentials.get(connection) as Credential,
      fetch: foreign
        ? (((input, init) =>
            new URL(input instanceof Request ? input.url : String(input)).host === ownHost
              ? own(input, init)
              : foreign(input, init)) satisfies typeof fetch)
        : own,
      timeoutMs: this.options.timeoutMs ?? 120_000,
      ...(this.options.descriptors?.module
        ? { modules: (sha: string) => this.options.descriptors?.module?.(sha) }
        : {}),
      ...(hosts.length > 0 ? { allowedHosts: hosts } : {}),
      ...(endpoint.settings ? { settings: endpoint.settings } : {}),
      ...(endpoint.keys
        ? {
            keys: Object.fromEntries(
              Object.entries(endpoint.keys).map(([name, secret]) => {
                const key = credentialFor(
                  { kind: 'api-key', secret },
                  this.options.secrets,
                  this.options.tokenProviders,
                  endpoint.baseURL,
                );
                return [name, key.kind === 'api-key' ? key.key : key.token];
              }),
            ),
          }
        : {}),
    };
  }

  #options(model: CatalogModel, apis: ApiBindings): unknown {
    return modelOptionsSchema(apis, this.#apis).parse(model.options ?? {});
  }

  #routes(): Map<string, Route> {
    return new Map([...this.#discovered, ...this.#static]);
  }

  #now() {
    return this.options.now?.() ?? new Date();
  }

  /** The learned results that count: none once an operator sets capabilities, and none the configuration already gives. */
  #learnedInEffect(route: Route): LearnedCapabilities | undefined {
    const c = this.#classes[route.model.id] ?? {};
    if (c.capabilities || !c.learned) return undefined;
    const entries = Object.entries(c.learned).filter(
      ([capability]) => !route.model.capabilities.includes(capability as Capability),
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  #effective(route: Route): CatalogModel & { enabled: boolean; apis: ApiBindings } {
    const c = this.#classes[route.model.id] ?? {};
    const learned = Object.entries(this.#learnedInEffect(route) ?? {}).flatMap(
      ([capability, check]) => (check.has ? [capability as Capability] : []),
    );
    return {
      ...route.model,
      residency: c.residency ?? route.model.residency,
      capabilities: c.capabilities ?? [...route.model.capabilities, ...learned],
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
      if (!model.enabled || !servesModelPort({ operations: Object.keys(model.apis) })) continue;
      const lacking = Object.entries(this.#learnedInEffect(route) ?? {}).flatMap(
        ([capability, check]) => (check.has ? [] : [[capability, check.at] as const]),
      );
      this.#live.set(model.id, {
        residency: model.residency,
        capabilities: model.capabilities,
        operations: Object.keys(model.apis),
        ...(lacking.length > 0 ? { checked: Object.fromEntries(lacking) } : {}),
      });
    }
  }

  /** The API a discovered model of a kind binds: the rule's, the kind's default, or the one API of the kind the connection offers. */
  #bindingFor(kind: string, rule: ApiBindings | undefined, families: string[]): ApiBindings {
    const named = rule?.[kind];
    if (named) return { [kind]: named };
    const defaults = families.flatMap((f) => {
      const api = this.#apis.defaultFor(kind, f);
      return api ? [api] : [];
    });
    const offered = this.#apis
      .list()
      .filter(
        (a) =>
          a.kind === kind &&
          families.includes(a.family) &&
          a.status === 'typed' &&
          a.source !== 'uploaded',
      );
    const api =
      defaults.length === 1 ? defaults[0] : offered.length === 1 ? offered[0]?.id : undefined;
    return api ? { [kind]: api } : {};
  }

  #listingsToRead() {
    const sources = new Map((this.options.sources ?? []).map((s) => [s.kind, s]));
    const read = new Map<string, { source: string; from: string; endpoints: string[] }>();
    for (const [name, endpoint] of Object.entries(this.#catalog.endpoints))
      for (const rule of endpoint.discovery) {
        if (!sources.has(rule.source)) continue;
        const from = rule.from ?? name;
        const key = listingKey(rule.source, from);
        const found = read.get(key) ?? { source: rule.source, from, endpoints: [] };
        if (!found.endpoints.includes(name)) found.endpoints.push(name);
        read.set(key, found);
      }
    return read;
  }

  #discoveredFrom(listings: Map<string, DiscoveryListing>): Map<string, Route> {
    const sources = new Set((this.options.sources ?? []).map((s) => s.kind));
    const discovered = new Map<string, Route>();
    const staticPairs = new Set(
      [...this.#static.values()].map((r) => `${r.model.endpoint}/${r.model.deployment}`),
    );
    for (const [name, endpoint] of Object.entries(this.#catalog.endpoints))
      for (const rule of endpoint.discovery) {
        if (!sources.has(rule.source)) continue;
        const from = rule.from ?? name;
        const key = listingKey(rule.source, from);
        const stored = listings.get(key);
        const url = this.#listedURL(rule.source, from);
        if (stored?.target && (url === undefined || stored.target !== listingTarget(url))) continue;
        const apis = rule.apis ?? defaultBindings(Object.keys(endpoint.families), this.#apis) ?? {};
        const prefix = rule.idPrefix ?? name;
        for (const found of stored?.deployments ?? []) {
          if (!matches(found.deployment, rule.include, rule.exclude)) continue;
          if (staticPairs.has(`${name}/${found.deployment}`)) continue;
          const slug = modelSlug(found.deployment);
          if (!slug) continue;
          const id = `${prefix.toLowerCase()}/${slug}`;
          if (discovered.has(id)) continue;
          const settings = rule.models?.[found.deployment];
          const kind = settings?.kind ?? found.kind ?? 'chat';
          const chats = kind === 'chat';
          const bound = chats
            ? Object.fromEntries(Object.entries(apis).filter(([k]) => !otherPortKinds.includes(k)))
            : this.#bindingFor(kind, rule.apis, Object.keys(endpoint.families));
          discovered.set(id, {
            model: {
              id,
              endpoint: name,
              deployment: found.deployment,
              residency: rule.residency ?? 'global',
              capabilities: chats ? rule.capabilities : [],
              apis: bound,
              ...(rule.maker ? { maker: rule.maker } : {}),
              ...(rule.releaseDates?.[found.deployment]
                ? { releaseDate: rule.releaseDates[found.deployment] }
                : {}),
              ...(settings?.embed ? { embed: settings.embed } : {}),
              ...(settings?.rerank ? { rerank: settings.rerank } : {}),
              options: {},
            },
            ...(found.model ? { family: found.model } : {}),
            origin: 'discovered',
            apis: bound,
            kind,
            kindFrom: settings?.kind ? 'operator' : (found.kindFrom ?? 'name'),
            ...(found.endpoints ? { endpoints: found.endpoints } : {}),
            ...(chats && found.capabilities?.length ? { listed: found.capabilities } : {}),
            listing: key,
          });
        }
      }
    return discovered;
  }

  #listedURL(source: string, from: string): string | undefined {
    const family = this.options.sources?.find((s) => s.kind === source)?.family;
    const listing = this.#catalog.endpoints[from];
    if (!listing) return undefined;
    if (!family) return listing.baseURL;
    const base = listing.families[family];
    return base === undefined ? undefined : familyURL(listing, base);
  }

  async #list(source: DiscoverySource, from: string): Promise<DiscoveredDeployment[]> {
    const baseURL = this.#listedURL(source.kind, from);
    if (baseURL === undefined)
      throw new ListingMisconfigured(
        `${from} does not offer the ${source.family} family to list through`,
      );
    return source.list({
      baseURL,
      credential: this.#credentials.get(from) as Credential,
      timeoutMs: this.options.timeoutMs ?? 15_000,
    });
  }

  /** Lists every connection now, keeps what each listing found in the store, and serves the stored set. */
  async refresh(): Promise<RefreshResult> {
    if (this.options.classifications) this.#classes = await this.options.classifications.load();
    const sources = new Map((this.options.sources ?? []).map((s) => [s.kind, s]));
    const graceMs = this.options.discoveryGraceMs ?? defaultDiscoveryGraceMs;
    const failed: RefreshResult['failed'] = [];
    const listings = new Map(this.#listings);
    await Promise.all(
      [...this.#listingsToRead()].map(async ([key, read]) => {
        const id = { connection: read.from, source: read.source };
        const url = this.#listedURL(read.source, read.from);
        const target = url === undefined ? undefined : listingTarget(url);
        const fail = (message: string) => {
          for (const endpoint of read.endpoints)
            if (!failed.some((f) => f.endpoint === endpoint))
              failed.push({ endpoint, error: message });
        };
        let found: DiscoveredDeployment[];
        try {
          found = await this.#list(sources.get(read.source) as DiscoverySource, read.from);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
          const kind = listingErrorKind(error);
          const at = this.#now();
          await this.#store
            .update(read.from, read.source, (current) => failedNow(current, id, kind, at, target))
            .then((stored) => listings.set(key, stored))
            .catch(() => undefined);
          return;
        }
        const at = this.#now();
        try {
          listings.set(
            key,
            await this.#store.update(read.from, read.source, (current) =>
              listedNow(current, id, found, at, graceMs, target),
            ),
          );
        } catch {
          fail('the listing was not stored');
          listings.set(key, listedNow(listings.get(key), id, found, at, graceMs, target));
        }
      }),
    );
    const order = Object.keys(this.#catalog.endpoints);
    failed.sort((a, b) => order.indexOf(a.endpoint) - order.indexOf(b.endpoint));
    this.#listings = listings;
    this.#discovered = this.#discoveredFrom(listings);
    this.#rebuild();
    const at = this.#now().toISOString();
    let remembered = false;
    for (const route of this.#discovered.values())
      if (route.listed)
        remembered =
          (await this.#remember(
            route.model.id,
            Object.fromEntries(route.listed.map((c) => [c, { has: true, at, by: 'listing' }])),
          )) || remembered;
    if (remembered) this.#rebuild();
    this.options.onChange?.();
    return { discovered: this.#discovered.size, failed };
  }

  /** Serves the stored listings and classifications another replica wrote, without listing anything. */
  async loadDiscovered(): Promise<void> {
    const [classes, stored] = await Promise.all([
      this.options.classifications?.load(),
      this.#store.load(),
    ]);
    if (classes) this.#classes = classes;
    this.#listings = new Map(stored.map((l) => [listingKey(l.source, l.connection), l]));
    this.#discovered = this.#discoveredFrom(this.#listings);
    this.#rebuild();
    this.options.onChange?.();
  }

  /** What each listing the catalogue reads last found, and its last failure; never a URL or a key. */
  discoveryStatus(): ListingStatus[] {
    const counts = new Map<string, number>();
    for (const route of this.#discovered.values())
      if (route.listing) counts.set(route.listing, (counts.get(route.listing) ?? 0) + 1);
    return [...this.#listingsToRead()]
      .map(([key, read]) => {
        const listing = this.#listings.get(key);
        return {
          connection: read.from,
          source: read.source,
          discovered: counts.get(key) ?? 0,
          listed: listing?.deployments.length ?? 0,
          ...(listing?.listedAt ? { listedAt: listing.listedAt } : {}),
          ...(listing?.errorKind && listing.failedAt
            ? { lastError: { kind: listing.errorKind, at: listing.failedAt } }
            : {}),
        };
      })
      .sort((a, b) => a.connection.localeCompare(b.connection) || a.source.localeCompare(b.source));
  }

  /** Merges what a check found into the stored row as it is now; a capability that passed once is never taken away. */
  async #remember(id: string, found: LearnedCapabilities): Promise<boolean> {
    const fresh = (merge: ModelClassification | undefined) => {
      const current = merge ?? {};
      const learned: LearnedCapabilities = { ...current.learned };
      let changed = false;
      for (const [capability, check] of Object.entries(found) as [Capability, CapabilityCheck][]) {
        if (learned[capability]?.has) continue;
        learned[capability] = check;
        changed = true;
      }
      return changed ? { ...current, learned } : undefined;
    };
    if (!fresh(this.#classes[id])) return false;
    try {
      const stored = this.options.classifications
        ? (await this.options.classifications.load())[id]
        : this.#classes[id];
      const next = fresh(stored);
      if (!next) return false;
      await this.options.classifications?.save(id, next);
      this.#classes = { ...this.#classes, [id]: next };
      return true;
    } catch {
      return false;
    }
  }

  #free(id: string) {
    const prices = unitPricesFor(this.options.priceOf?.(id), 'chat');
    return prices?.['input-token'] === 0 && prices['output-token'] === 0;
  }

  readonly #unsettled = new Map<string, number>();
  #learning: Promise<LearnResult> | undefined;

  /** Checks what discovered models can do that their rule does not say, with a few small calls through the gate. */
  learn(ctx: PortContext, options: LearnOptions = {}): Promise<LearnResult> {
    this.#learning ??= this.#learn(ctx, options).finally(() => {
      this.#learning = undefined;
    });
    return this.#learning;
  }

  async #learn(ctx: PortContext, options: LearnOptions): Promise<LearnResult> {
    const now = this.#now();
    const maxCalls = options.maxCalls ?? defaultLearnCalls;
    const freshFor = options.freshForMs ?? learnedFreshForMs;
    const settled = (check: { has: boolean; at: string } | undefined) =>
      check !== undefined && (check.has || now.getTime() - Date.parse(check.at) < freshFor);
    const result: LearnResult = { checked: [], calls: 0, deferred: 0, usage: {} };
    const due = [...this.#discovered.values()]
      .filter((route) => {
        const model = this.#effective(route);
        const chat = model.apis.chat;
        return (
          model.enabled &&
          chat !== undefined &&
          this.#connections.get(model.endpoint)?.get(chat) !== undefined &&
          !this.#classes[model.id]?.capabilities
        );
      })
      .sort(
        (a, b) =>
          Number(this.#free(b.model.id)) - Number(this.#free(a.model.id)) ||
          (this.#unsettled.get(a.model.id) ?? 0) - (this.#unsettled.get(b.model.id) ?? 0),
      );
    for (const route of due) {
      const id = route.model.id;
      const pending = checkedCapabilities.filter(
        (c) => !route.model.capabilities.includes(c) && !settled(this.#classes[id]?.learned?.[c]),
      );
      if (pending.length === 0) continue;
      const found: LearnedCapabilities = {};
      try {
        const port = this.#open({ kind: 'model', id }, ctx, true);
        for (const capability of pending) {
          // Leaves room for the plain call a refused check makes.
          if (result.calls + 2 > maxCalls) {
            result.deferred += 1;
            continue;
          }
          const outcome = await checkCapability(port, capability);
          result.calls += outcome.calls;
          if (outcome.usage)
            result.usage = addUsage(
              result.usage,
              pricedUsage(outcome.usage, this.#unitPrices(id, 'chat')),
            );
          if (outcome.has === undefined) {
            this.#unsettled.set(id, now.getTime());
            continue;
          }
          found[capability] = { has: outcome.has, at: now.toISOString(), by: 'call' };
          result.checked.push({ model: id, capability, has: outcome.has });
        }
      } catch {
        this.#unsettled.set(id, now.getTime());
      }
      await this.#remember(id, found);
    }
    if (result.checked.length > 0) this.#rebuild();
    return result;
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
    const next: ModelClassification = { ...this.#classes[id], ...classification };
    if (classification.apis) delete next.learned;
    if (classification.parameters && next.observed) {
      const set = new Set(Object.keys(classification.parameters));
      next.observed = Object.fromEntries(
        Object.entries(next.observed).filter(([name]) => !set.has(name)),
      );
    }
    await this.options.classifications?.save(id, next);
    this.#classes = { ...this.#classes, [id]: next };
    this.#rebuild();
    this.options.onChange?.();
    return this.#describe(route);
  }

  #kindOf(route: Route, apis: ApiBindings): { kind: string; kindFrom?: KindSource } {
    if (this.#classes[route.model.id]?.apis)
      return { kind: kindOfBindings(apis) ?? 'unknown', kindFrom: 'operator' };
    const kind = route.kind ?? kindOfBindings(apis) ?? 'unknown';
    return route.kindFrom ? { kind, kindFrom: route.kindFrom } : { kind };
  }

  #describe(route: Route): ModelDescription {
    const model = this.#effective(route);
    const learned = this.#learnedInEffect(route);
    const operator = this.#catalog.endpoints[model.endpoint]?.operator;
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
      ...this.#kindOf(route, model.apis),
      ...(route.endpoints ? { listedEndpoints: route.endpoints } : {}),
      endpoint: model.endpoint,
      deployment: model.deployment,
      ...(route.family ? { family: route.family } : {}),
      ...(model.maker ? { maker: model.maker } : {}),
      ...(operator
        ? {
            operator: {
              name: operator.name,
              ...(operator.region ? { region: operator.region } : {}),
            },
          }
        : {}),
      residency: model.residency,
      capabilities: model.capabilities,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.releaseDate === undefined ? {} : { releaseDate: model.releaseDate }),
      apis: model.apis,
      operations: Object.keys(model.apis),
      enabled: model.enabled,
      origin: route.origin,
      classified: Object.keys(this.#classes[model.id] ?? {}).some(
        (k) => k !== 'observed' && k !== 'parameters' && k !== 'learned',
      ),
      ...(this.options.priceOf ? this.#priceView(model.id, Object.keys(model.apis)) : {}),
      parameters: model.parameters ?? {},
      rejectedParameters: this.#classes[model.id]?.observed ?? {},
      ...(learned ? { learned } : {}),
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

  /** Discovered models other ports serve, as model catalogue entries: embedders with their dimensions, and rerankers. */
  discoveredForOtherPorts(): CatalogModel[] {
    return [...this.#discovered.values()].flatMap((route) => {
      if (this.#static.has(route.model.id)) return [];
      const model = this.#effective(route);
      if (!model.enabled) return [];
      const apis = Object.fromEntries(
        Object.entries(model.apis).filter(
          ([kind]) => otherPortKinds.includes(kind) && (kind !== 'embed' || model.embed),
        ),
      );
      if (Object.keys(apis).length === 0) return [];
      return [{ ...route.model, residency: model.residency, apis }];
    });
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
                    this.#described(model.endpoint, described.api.family),
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
    const resolved = async (id: string, options?: OperationCallOptions): Promise<DescribedCall> => {
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
      const endpoint = this.#described(model.endpoint, descriptor.api.family);
      const [maturity, processorRecord, stateAllowed] = await Promise.all([
        governance.maturity(descriptor.operation),
        governance.processorRecorded(model.endpoint),
        governance.providerStateAllowed?.(model.endpoint) ?? false,
      ]);
      const keeps = descriptor.resources.length > 0;
      return {
        gate: this.#gate,
        ctx,
        target: {
          ...plain,
          port: tier === 'raw' ? 'operation' : 'described',
          operation: descriptor.operation,
          maturity,
          synthetic: tier === 'raw',
          processorRecord: processorRecord && (!keeps || stateAllowed),
          ...(keeps && processorRecord && !stateAllowed
            ? {
                processorNote: `endpoint ${model.endpoint} keeps no state at the provider: its processor record does not name the provider's retention and allow provider-side state, which ${descriptor.id} needs`,
              }
            : {}),
        },
        descriptor,
        endpoint: {
          ...endpoint,
          connection: model.endpoint,
          tenant: ctx.tenant,
          run: ctx.task,
          ...(this.options.objects ? { ledger: this.options.objects } : {}),
        },
        deployment: model.deployment,
        priced: (usage) => pricedUsage(usage, this.#unitPrices(model.id, descriptor.operation)),
        provenance: () => ({ model: served }),
        fail: describedError,
        ...(tier === 'raw' && options?.observe ? { observe: options.observe } : {}),
      };
    };
    return {
      info,
      call: async (id, input, options) => describedCall(await resolved(id, options), input),
      stream: async function* (id, input) {
        yield* describedStreamCall(await resolved(id), input);
      },
      session: async (id: string, input: unknown, io: SessionIO) => {
        const call = await resolved(id);
        return describedSession(
          { ...call, maturity: () => governance.maturity(call.descriptor.operation) },
          input,
          io,
        );
      },
    };
  }

  /** Deletes a leftover provider object by running its descriptor's delete step; throws when it cannot. */
  async removeProviderObject(record: ProviderObjectRecord): Promise<void> {
    const descriptor = this.options.descriptors?.get(record.descriptor);
    const resource = descriptor?.resources.find(
      (r) => r.step === record.step && r.field === record.field,
    );
    if (!descriptor || !resource)
      throw new ModelError('unsupported', `${record.descriptor} is not known any more`);
    if (!this.#catalog.endpoints[record.connection])
      throw new ModelError('unsupported', `the connection ${record.connection} is gone`);
    await deleteProviderObject(
      descriptor,
      resource,
      {
        ...this.#described(record.connection, descriptor.api.family),
        connection: record.connection,
        tenant: record.tenant,
        run: record.run,
      },
      record,
      { fail: describedError },
    );
  }

  open(ref: Ref, ctx: PortContext): ModelPort {
    return this.#open(ref, ctx, false);
  }

  /** A capability check skips the capability test, and carries no real data, so it is synthetic. */
  #open(ref: Ref, ctx: PortContext, checking: boolean): ModelPort {
    const resolved = this.#resolve(ref, ctx, 'chat');
    const { model, failure, served, info, implementation } = resolved;
    const target: GateTarget = checking ? { ...resolved.target, synthetic: true } : resolved.target;
    const chatting = () => {
      const found = implementation('chat');
      if (!found.connection)
        throw new ModelError('unsupported', `${found.api} has no built-in implementation`);
      return { connection: found.connection, deployment: found.deployment };
    };
    const require = (request: ChatRequest, extra: Capability[] = []) => {
      if (checking) return;
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
