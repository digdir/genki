import type { SecretResolver, TokenProviders } from '@genai/kernel';
import type { z } from 'zod';
import type { DatasetConfig, KnowledgeAdapter, LocalEndpointConfig } from './adapter.js';

export type { DatasetOverrides } from './resolve.js';
import {
  parseKnowledgeCatalog,
  type CatalogDataset,
  type CatalogKnowledgeEndpoint,
  type KnowledgeCatalog,
} from './catalog.js';
import { KnowledgeError } from './port.js';
import {
  aliasesOf,
  datasetConfig,
  endpointConfig,
  relocate,
  type DatasetOverrides,
} from './resolve.js';

export interface IndexChunk {
  id: string;
  position: number;
  text: string;
  metadata?: Record<string, unknown>;
  vector?: number[];
}

export interface IndexPhrase {
  id: string;
  chunkId: string;
  text: string;
  vector?: number[];
}

export interface IndexDocument {
  id: string;
  title?: string;
  url?: string;
  fields: Record<string, unknown>;
  chunks: IndexChunk[];
  phrases: IndexPhrase[];
}

export interface IndexStats {
  documents: number;
  chunks: number;
  phrases: number;
}

export interface DropOptions {
  force?: boolean;
}

export interface IndexWriter<D = unknown> {
  prepare(dataset: DatasetConfig<D>, generation: string): Promise<void>;
  store(dataset: DatasetConfig<D>, generation: string, doc: IndexDocument): Promise<void>;
  /** Makes the generation the one searches read and returns the generation it replaced. */
  promote(dataset: DatasetConfig<D>, generation: string): Promise<string | undefined>;
  /** Refuses the active generation unless forced; a forced drop still refuses the served one. */
  drop(dataset: DatasetConfig<D>, generation: string, options?: DropOptions): Promise<void>;
  active(dataset: DatasetConfig<D>): Promise<string | undefined>;
  stats(dataset: DatasetConfig<D>, generation: string): Promise<IndexStats>;
  /** Streams the stored documents of a generation, by default the active one. */
  read?(dataset: DatasetConfig<D>, generation?: string): AsyncIterable<IndexDocument>;
}

export interface IndexWriterContext {
  signal: AbortSignal;
}

export interface IndexWriterAdapter<E = unknown, D = unknown> {
  engine: string;
  needs: { vectors: boolean };
  endpointOptions?: z.ZodType<E>;
  datasetOptions?: z.ZodType<D>;
  connect(endpoint: LocalEndpointConfig<E>, context: IndexWriterContext): IndexWriter<D>;
}

export interface IndexWriterRoute {
  engine: string;
  endpoint: string;
  needs: { vectors: boolean };
  dataset: DatasetConfig;
  writer: IndexWriter;
}

export interface IndexWriterRouterOptions {
  catalog: unknown;
  adapters: IndexWriterAdapter[];
  knowledgeAdapters: KnowledgeAdapter[];
  secrets: SecretResolver;
  tokenProviders?: TokenProviders;
  timeoutMs?: number;
}

export class IndexWriterRouter {
  #catalog: KnowledgeCatalog = { endpoints: {}, datasets: [] };
  #aliases = new Map<string, string>();

  constructor(private readonly options: IndexWriterRouterOptions) {
    this.reload(options.catalog);
  }

  reload(catalog: unknown) {
    const result = parseKnowledgeCatalog(catalog, this.options.knowledgeAdapters);
    if (!result.ok)
      throw new Error(
        `invalid knowledge catalog: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      );
    this.#catalog = result.catalog;
    this.#aliases = aliasesOf(result.catalog);
  }

  engines(): string[] {
    return this.options.adapters.map((a) => a.engine);
  }

  #dataset(idOrAlias: string): CatalogDataset | undefined {
    const id = this.#aliases.get(idOrAlias) ?? idOrAlias;
    return this.#catalog.datasets.find((d) => d.id === id);
  }

  #adapter(engine: string | undefined) {
    return this.options.adapters.find((a) => a.engine === engine);
  }

  supports(idOrAlias: string): boolean {
    const dataset = this.#dataset(idOrAlias);
    return (
      dataset !== undefined &&
      this.#adapter(this.#catalog.endpoints[dataset.endpoint]?.engine) !== undefined
    );
  }

  open(idOrAlias: string, context: IndexWriterContext): IndexWriterRoute {
    const dataset = this.#required(idOrAlias);
    const endpoint = this.#catalog.endpoints[dataset.endpoint];
    const adapter = this.#adapter(endpoint?.engine);
    if (!endpoint || !adapter) throw this.#unsupported(endpoint?.engine);
    return this.#route(
      adapter,
      dataset,
      endpoint,
      adapter.endpointOptions ? adapter.endpointOptions.parse(endpoint.options) : endpoint.options,
      adapter.datasetOptions ? adapter.datasetOptions.parse(dataset.options) : dataset.options,
      context,
    );
  }

  /** Opens the dataset as if it lived on another catalog endpoint, without changing the catalog. */
  openAt(
    idOrAlias: string,
    endpointId: string,
    context: IndexWriterContext,
    overrides: DatasetOverrides = {},
  ): IndexWriterRoute {
    const dataset = this.#required(idOrAlias);
    const engine = this.#catalog.endpoints[endpointId]?.engine;
    const adapter = this.#adapter(engine);
    if (engine !== undefined && !adapter) throw this.#unsupported(engine);
    const moved = relocate(
      dataset,
      endpointId,
      this.#catalog,
      this.options.knowledgeAdapters,
      overrides,
    );
    const writer = adapter as IndexWriterAdapter;
    return this.#route(
      writer,
      moved.dataset,
      moved.endpoint,
      writer.endpointOptions
        ? writer.endpointOptions.parse(moved.endpoint.options)
        : moved.endpointOptions,
      writer.datasetOptions
        ? writer.datasetOptions.parse(moved.dataset.options)
        : moved.datasetOptions,
      context,
    );
  }

  #required(idOrAlias: string) {
    const dataset = this.#dataset(idOrAlias);
    if (!dataset) throw new KnowledgeError('bad_request', `no dataset ${idOrAlias} in the catalog`);
    return dataset;
  }

  #unsupported(engine: string | undefined) {
    return new KnowledgeError('unsupported', `no index writer for engine ${engine ?? 'unknown'}`);
  }

  async #refuseServed(id: string, engine: string, generation: string, context: IndexWriterContext) {
    const served = this.#required(id);
    if (this.#catalog.endpoints[served.endpoint]?.engine !== engine) return;
    let active: string | undefined;
    try {
      const route = this.open(id, context);
      active = await route.writer.active(route.dataset);
    } catch (error) {
      throw new KnowledgeError(
        'bad_request',
        `cannot tell which generation of ${id} the catalog serves: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (active === generation)
      throw new KnowledgeError(
        'bad_request',
        `generation ${generation} of ${id} is the one the catalog serves`,
      );
  }

  #route(
    adapter: IndexWriterAdapter,
    dataset: CatalogDataset,
    endpoint: CatalogKnowledgeEndpoint,
    endpointOptions: unknown,
    datasetOptions: unknown,
    context: IndexWriterContext,
  ): IndexWriterRoute {
    const connected = adapter.connect(
      endpointConfig(endpoint, endpointOptions, this.options, this.options.timeoutMs ?? 60_000),
      context,
    );
    const writer: IndexWriter = Object.assign(Object.create(connected) as IndexWriter, {
      drop: async (config: DatasetConfig, generation: string, options: DropOptions = {}) => {
        if (options.force)
          await this.#refuseServed(dataset.id, adapter.engine, generation, context);
        return connected.drop(config, generation, options);
      },
    });
    return {
      engine: adapter.engine,
      endpoint: dataset.endpoint,
      needs: adapter.needs,
      dataset: datasetConfig(dataset, datasetOptions),
      writer,
    };
  }
}
