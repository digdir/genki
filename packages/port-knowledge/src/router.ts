import { publicSourceUrl, type Ref } from '@genai/contracts';
import type { PortContext, PortProvider, SecretResolver, TokenProviders } from '@genai/kernel';
import type {
  DatasetConfig,
  KnowledgeAdapter,
  KnowledgeConnection,
  LocalEndpointConfig,
} from './adapter.js';
import {
  parseKnowledgeCatalog,
  type CatalogDataset,
  type CatalogKnowledgeEndpoint,
  type KnowledgeCatalog,
} from './catalog.js';
import { probeWith, type EndpointProbe } from './probe.js';
import {
  aliasesOf,
  datasetConfig,
  endpointConfig,
  relocate,
  type DatasetOverrides,
} from './resolve.js';
import {
  KnowledgeError,
  kindsOf,
  legacyCapabilities,
  searchCapabilities,
  type DocumentsRequest,
  type FieldFilter,
  type FilterClause,
  type FilterKind,
  type FilterValue,
  type FilterValueType,
  type Hit,
  type KnowledgeCapability,
  type KnowledgePort,
  type Residency,
  type SearchRequest,
} from './port.js';

export interface KnowledgeRouterOptions {
  catalog: unknown;
  adapters: KnowledgeAdapter[];
  secrets: SecretResolver;
  tokenProviders?: TokenProviders;
  maxResidency?: Residency;
  timeoutMs?: number;
  maxLimit?: number;
  maxBatch?: number;
}

interface Route {
  dataset: CatalogDataset;
  config: DatasetConfig;
  connection: KnowledgeConnection;
  engine: string;
  capabilities: KnowledgeCapability[];
}

const order: Residency[] = ['norway', 'eu', 'global'];

const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'number';
const scalars = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(scalar);
const only = (v: object, keys: string[]) => Object.keys(v).every((k) => keys.includes(k));

export const clauseFits = (kind: FilterKind, value: FilterClause) => {
  if (kind === 'boolean') return typeof value === 'boolean';
  if (kind === 'select') return scalar(value);
  if (typeof value !== 'object' || value === null)
    return kind === 'multiselect' || kind === 'text' ? scalar(value) : false;
  if (Array.isArray(value)) return kind === 'multiselect' && scalars(value);
  if (kind === 'multiselect') return 'not' in value && only(value, ['not']) && scalars(value.not);
  if (kind === 'text')
    return 'contains' in value && only(value, ['contains']) && scalars(value.contains);
  return kind === 'range' && only(value, ['gte', 'lte']) && ('gte' in value || 'lte' in value);
};

export const filterFits = (field: FieldFilter, value: FilterValue) => {
  const kinds = kindsOf(field);
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'all' in value) {
    return (
      only(value, ['all']) &&
      Array.isArray(value.all) &&
      value.all.length >= 2 &&
      value.all.every(
        (c) =>
          !(typeof c === 'object' && c !== null && !Array.isArray(c) && 'all' in c) &&
          kinds.some((k) => clauseFits(k, c)),
      )
    );
  }
  return kinds.some((k) => clauseFits(k, value));
};

const clausesOf = (value: FilterValue): FilterClause[] =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'all' in value
    ? value.all
    : [value];

export class KnowledgeRouter implements PortProvider<KnowledgePort> {
  readonly #routes = new Map<string, Route>();
  readonly #aliases = new Map<string, string>();
  readonly #connections = new Map<string, KnowledgeConnection>();
  #catalog: KnowledgeCatalog = { endpoints: {}, datasets: [] };

  constructor(private readonly options: KnowledgeRouterOptions) {
    this.reload(options.catalog);
  }

  reload(catalog: unknown) {
    const result = parseKnowledgeCatalog(catalog, this.options.adapters);
    if (!result.ok) {
      throw new Error(
        `invalid knowledge catalog: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      );
    }
    const adapters = new Map(this.options.adapters.map((a) => [a.engine, a]));
    const connections = new Map<string, KnowledgeConnection>();
    for (const [name, endpoint] of Object.entries(result.catalog.endpoints)) {
      const adapter = adapters.get(endpoint.engine) as KnowledgeAdapter;
      connections.set(
        name,
        this.#connect(adapter, endpoint, adapter.endpointOptions.parse(endpoint.options)),
      );
    }
    const routes = new Map<string, Route>();
    for (const dataset of result.catalog.datasets) {
      const engine = result.catalog.endpoints[dataset.endpoint]?.engine ?? '';
      const adapter = adapters.get(engine) as KnowledgeAdapter;
      const config = datasetConfig(dataset, adapter.datasetOptions.parse(dataset.options));
      routes.set(dataset.id, {
        dataset,
        config,
        connection: connections.get(dataset.endpoint) as KnowledgeConnection,
        engine,
        capabilities: adapter.capabilities?.(config) ?? [...legacyCapabilities],
      });
    }
    const aliases = aliasesOf(result.catalog);
    this.#routes.clear();
    this.#aliases.clear();
    this.#connections.clear();
    for (const [k, v] of routes) this.#routes.set(k, v);
    for (const [k, v] of aliases) this.#aliases.set(k, v);
    for (const [k, v] of connections) this.#connections.set(k, v);
    this.#catalog = result.catalog;
  }

  #connect(adapter: KnowledgeAdapter, endpoint: CatalogKnowledgeEndpoint, options: unknown) {
    const connect = adapter.connect.bind(adapter) as (
      e: LocalEndpointConfig,
    ) => KnowledgeConnection;
    return connect(
      endpointConfig(endpoint, options, this.options, this.options.timeoutMs ?? 15_000),
    );
  }

  /** Tests a catalog endpoint with its engine's read-only probe. */
  probe(endpointId: string, signal?: AbortSignal): Promise<EndpointProbe> {
    const endpoint = this.#catalog.endpoints[endpointId];
    if (!endpoint)
      return Promise.resolve({
        ok: false,
        code: 'bad_request',
        message: `no endpoint ${endpointId} in the catalog`,
        ms: 0,
      });
    return probeWith(endpoint, this.options, signal);
  }

  datasets(): Map<
    string,
    {
      residency: Residency;
      tenants?: string[];
      name?: string;
      description?: string;
      aliases: string[];
      valueTypes?: Record<string, FilterValueType>;
      filters: Record<string, unknown>;
    }
  > {
    return new Map(
      [...this.#routes.values()].map(({ dataset }) => [
        dataset.id,
        {
          residency: dataset.residency,
          aliases: dataset.aliases,
          filters: dataset.filters,
          ...(dataset.tenants ? { tenants: dataset.tenants } : {}),
          ...(dataset.name ? { name: dataset.name } : {}),
          ...(dataset.description ? { description: dataset.description } : {}),
          ...(dataset.valueTypes ? { valueTypes: dataset.valueTypes } : {}),
        },
      ]),
    );
  }

  resolve(idOrAlias: string): string | undefined {
    if (this.#routes.has(idOrAlias)) return idOrAlias;
    return this.#aliases.get(idOrAlias);
  }

  open(ref: Ref, ctx: PortContext): KnowledgePort {
    return this.#port(this.#required(ref), ref, ctx);
  }

  /** Opens the dataset as if it lived on another catalog endpoint, without changing the catalog. */
  openAt(
    ref: Ref,
    endpointId: string,
    ctx: PortContext,
    overrides: DatasetOverrides = {},
  ): KnowledgePort {
    const moved = relocate(
      this.#required(ref).dataset,
      endpointId,
      this.#catalog,
      this.options.adapters,
      overrides,
    );
    const config = datasetConfig(moved.dataset, moved.datasetOptions);
    const connection = overrides.endpointOptions
      ? this.#connect(moved.adapter, moved.endpoint, moved.endpointOptions)
      : (this.#connections.get(endpointId) as KnowledgeConnection);
    return this.#port(
      {
        dataset: moved.dataset,
        config,
        connection,
        engine: moved.adapter.engine,
        capabilities: moved.adapter.capabilities?.(config) ?? [...legacyCapabilities],
      },
      ref,
      ctx,
    );
  }

  #required(ref: Ref): Route {
    const route = this.#routes.get(this.resolve(ref.id) ?? ref.id);
    if (!route) throw new KnowledgeError('bad_request', `no dataset ${ref.id} in the catalog`);
    return route;
  }

  #port(route: Route, ref: Ref, ctx: PortContext): KnowledgePort {
    const { dataset, config, connection, engine, capabilities } = route;
    const declared = new Set(capabilities);
    const need = (capability: KnowledgeCapability) => {
      if (!declared.has(capability))
        throw new KnowledgeError(
          'unsupported',
          `dataset ${dataset.id} on ${engine} does not support ${capability}`,
        );
    };
    const owner = ref.tenant ?? ctx.tenant;
    if (dataset.tenants && !dataset.tenants.includes(owner))
      throw new KnowledgeError('forbidden', `dataset ${dataset.id} is not shared with ${owner}`);
    const max = this.options.maxResidency;
    if (max && order.indexOf(dataset.residency) > order.indexOf(max))
      throw new KnowledgeError('residency', `dataset ${dataset.id} is stored outside ${max}`);

    const checkFilters = (filters: Record<string, FilterValue> = {}) => {
      for (const [field, value] of Object.entries(filters)) {
        const kind = dataset.filters[field];
        if (!kind)
          throw new KnowledgeError(
            'bad_request',
            `dataset ${dataset.id} cannot filter on ${field}`,
          );
        if (!filterFits(kind, value))
          throw new KnowledgeError(
            'bad_request',
            `filter ${field} expects a ${kindsOf(kind).join(' or ')} value`,
          );
        for (const clause of clausesOf(value)) {
          const fitting = kindsOf(kind).filter((k) => clauseFits(k, clause));
          if (!fitting.some((k) => declared.has(`filter.${k}`)))
            throw new KnowledgeError(
              'unsupported',
              `dataset ${dataset.id} on ${engine} cannot filter ${field} as ${fitting.join(' or ')}`,
            );
        }
      }
      return filters;
    };
    const profiles = connection.profiles(config);
    const searchable = searchCapabilities.some((c) => declared.has(c));
    const check = (request: SearchRequest): SearchRequest => {
      if (!searchable)
        throw new KnowledgeError('unsupported', `dataset ${dataset.id} on ${engine} cannot search`);
      const profile = request.profile ?? profiles[0];
      if (!profile || !profiles.includes(profile))
        throw new KnowledgeError(
          'bad_request',
          `dataset ${dataset.id} has no search profile ${request.profile}`,
        );
      checkFilters(request.filters);
      const limit = Math.min(Math.max(request.limit ?? 10, 1), this.options.maxLimit ?? 100);
      return { ...request, profile, limit };
    };
    let recorded: Promise<void> | undefined;
    const record = () =>
      (recorded ??= (async () => {
        const served = await connection.served?.(config, ctx.signal).catch(() => undefined);
        await ctx.provenance?.({
          index: {
            dataset: dataset.id,
            engine,
            ...(served?.generation ? { generation: served.generation } : {}),
            ...(served?.collections?.length ? { collections: [...served.collections] } : {}),
          },
        });
      })());
    const guard = async <T>(run: () => Promise<T>): Promise<T> => {
      let result: T;
      try {
        result = await run();
      } catch (error) {
        if (error instanceof KnowledgeError) throw error;
        if (ctx.signal.aborted) throw new KnowledgeError('cancelled', 'the search was cancelled');
        throw new KnowledgeError(
          'unavailable',
          error instanceof Error ? error.message : String(error),
        );
      }
      await record();
      return result;
    };
    const rule = dataset.links;
    const linked = <T extends { url?: string; title?: string }>(item: T, document?: string): T => {
      if (!rule) return item;
      const url = publicSourceUrl({ url: item.url, document, title: item.title }, rule);
      const rest = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'url'));
      return { ...rest, ...(url ? { url } : {}) } as T;
    };
    const linkHits = (hits: Hit[]) => hits.map((hit) => linked(hit, hit.document));
    const maxBatch = this.options.maxBatch ?? 50;
    const listDocuments = connection.documents?.bind(connection);
    const exporter = connection.export;

    return {
      info: () => ({
        id: dataset.id,
        residency: dataset.residency,
        filters: dataset.filters,
        profiles,
        engine,
        capabilities: [...capabilities],
      }),
      search: async (request) => {
        const checked = check(request);
        const [result] = await guard(() => connection.search(config, [checked], ctx.signal));
        return result ? { ...result, hits: linkHits(result.hits) } : { hits: [] };
      },
      searchMany: async (requests) => {
        if (requests.length > maxBatch)
          throw new KnowledgeError('bad_request', `at most ${maxBatch} searches per batch`);
        if (requests.length === 0) return [];
        const checked = requests.map(check);
        const results = await guard(() => connection.search(config, checked, ctx.signal));
        return results.map((result) => ({ ...result, hits: linkHits(result.hits) }));
      },
      fetch: async (ids) => {
        need('fetch');
        if (ids.length === 0) return [];
        if (ids.length > (this.options.maxLimit ?? 100) * 2)
          throw new KnowledgeError('bad_request', 'too many ids in one fetch');
        return linkHits(await guard(() => connection.fetch(config, ids, ctx.signal)));
      },
      range: async (document, from, to) => {
        need('range');
        if (
          !Number.isInteger(from) ||
          !Number.isInteger(to) ||
          from < 0 ||
          to < from ||
          to - from >= 50
        )
          throw new KnowledgeError('bad_request', 'a range is 1 to 50 positions');
        return linkHits(
          await guard(() => connection.range(config, document, from, to, ctx.signal)),
        );
      },
      facets: async (fields, filters) => {
        need('facets');
        for (const field of fields) {
          if (!dataset.filters[field])
            throw new KnowledgeError('bad_request', `dataset ${dataset.id} has no facet ${field}`);
        }
        return guard(() => connection.facets(config, fields, checkFilters(filters), ctx.signal));
      },
      ...(listDocuments
        ? {
            documents: async (request: DocumentsRequest) => {
              const limit = Math.min(Math.max(request.limit ?? 100, 1), 250);
              const offset = Math.max(request.offset ?? 0, 0);
              const filters = checkFilters(request.filters);
              const page = await guard(() =>
                listDocuments(config, { ...request, filters, limit, offset }, ctx.signal),
              );
              return { ...page, documents: page.documents.map((d) => linked(d, d.id)) };
            },
          }
        : {}),
      ...(exporter
        ? {
            export: {
              vectors: exporter.vectors,
              documents: () => exporter.documents(config, ctx.signal),
              count: (cap: number) => guard(() => exporter.count(config, cap, ctx.signal)),
            },
          }
        : {}),
    };
  }
}
