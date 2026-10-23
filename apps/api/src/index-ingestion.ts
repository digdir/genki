import { readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import type { Principal, Ref, Usage } from '@genai/contracts';
import {
  convertibleExtensions,
  crawlSitemap,
  databaseSource,
  defaultFetchPolicy,
  blobPhraseCache,
  defaultSearchPhrasesPrompt,
  displayNames,
  episerverPages,
  episerverSource,
  fetchKudosFile,
  filterEpiserverPages,
  findFolderFiles,
  folderSource,
  guardedFetchBytes,
  kudosClient,
  kudosProfiles,
  kudosSource,
  memoryPhraseCache,
  runIndexIngest,
  tableQuery,
  uploadSource,
  websiteFetchPolicy,
  websiteSkipReasonFor,
  websiteSource,
  type ChunkDocumentConfig,
  type ChunkStrategy,
  type ParquetReader,
  type DeclaredPhraseArchive,
  type DocumentConverter,
  type GuardedFetchOptions,
  type IngestSource,
  type KudosDocument,
  type KudosSearch,
  type KudosProfile,
  type MetadataStyle,
  type PhraseCache,
  type RowReader,
  type SkippedDocument,
} from '@genai/ingest';
import { parquetSourceOf } from './parquet-files.js';
export { parquetLocation, parquetReadTimeoutMs } from './parquet-files.js';
import { withModelAdmission } from '@genai/composition';
import type { BlobStore } from '@genai/port-blob';
import type { PortContext } from '@genai/kernel';
import type { EmbeddingOpenOptions, EmbeddingPort } from '@genai/port-embedding';
import type { IndexWriterRouter } from '@genai/port-knowledge';
import type { ModelPort, Residency } from '@genai/port-model';
import {
  unboundedKudos,
  unboundedKudosMessage,
  type IngestionBackend,
  type IngestionJob,
  type IngestionReport,
  type IngestionTarget,
  type Pipeline,
  type PipelineSpec,
  type SourceEstimate,
} from './ingestion.js';

export interface EmbedderSource {
  has(model: string): boolean;
  open(ref: Ref, ctx: PortContext, options?: EmbeddingOpenOptions): EmbeddingPort;
}

export interface KudosAccess {
  profiles?: Partial<Record<KudosProfile['name'], KudosProfile>>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface ParquetAccess {
  reader: ParquetReader;
  workingDirectory?: string;
  fetch?: typeof fetch;
  readTimeoutMs?: number;
}

export interface DatabaseAccess {
  reader: RowReader;
  secrets: { resolve(ref: string): Promise<string | undefined> };
  privateNetworks?: (tenant: string) => Promise<string[]>;
  network?: (
    host: string,
    privateNetworks: string[],
  ) => Promise<{ network: 'public' | 'private' | 'blocked' | 'unknown'; allowed: boolean }>;
}

export interface PhraseStorage {
  blobs?: Pick<BlobStore, 'get' | 'put'>;
  archive?: DeclaredPhraseArchive;
}

export interface IngestSourceOptions {
  folderRoot?: string;
  phrases?: PhraseStorage;
  web?: GuardedFetchOptions;
  converter?: DocumentConverter;
  uploads?: Pick<BlobStore, 'list' | 'get'>;
  kudos?: KudosAccess;
  database?: DatabaseAccess;
  parquet?: ParquetAccess;
}

type DatabaseSpec = Extract<PipelineSpec['source'], { kind: 'database' }>;

export const tenantSecretPrefix = (tenant: string) => `secret://tenant/${tenant}/`;

export const resolvedConnection = async (
  access: DatabaseAccess,
  source: DatabaseSpec,
  tenant: string,
) => {
  const { password, ...connection } = source.connection;
  if (!password.startsWith(tenantSecretPrefix(tenant)))
    throw new Error('the database password must be a secret of the tenant that owns the dataset');
  const value = await access.secrets.resolve(password);
  if (!value) throw new Error('the database password is not in the vault');
  const privateNetworks = (await access.privateNetworks?.(tenant)) ?? [];
  return { ...connection, password: value, privateNetworks };
};

export interface IndexIngestionOptions extends IngestSourceOptions {
  writers: IndexWriterRouter;
  residencyOf(dataset: string): Residency | undefined;
  embedders?: EmbedderSource;
  models?: { open(ref: Ref, ctx: PortContext): ModelPort };
  platformTenant: string;
}

export const maxDocumentBytes = 50 * 1024 * 1024;

export const kudosFileReadTimeoutMs = 120_000;

export const phraseCacheDirectory = (kind: PipelineSpec['source']['kind']) =>
  kind === 'kudos' ? 'search-phrases' : `${kind}-search-phrases`;

const phraseCacheFor = (
  storage: PhraseStorage | undefined,
  tenant: string,
  kind: PipelineSpec['source']['kind'],
): PhraseCache =>
  storage?.blobs
    ? blobPhraseCache(storage.blobs, tenant, phraseCacheDirectory(kind))
    : memoryPhraseCache();

export const uploadPrefix = (dataset: string, tenant: string) =>
  `datasets/${dataset.startsWith(`${tenant}/`) ? dataset.slice(tenant.length + 1) : dataset}/uploads/`;

const metadataStyles: Record<PipelineSpec['chunking']['metadataStyle'], MetadataStyle> = {
  edn: 'pr',
  json: 'pr',
  none: 'pr',
};

const strategyOf = (spec: PipelineSpec['chunking']['strategy']): ChunkStrategy =>
  spec.kind === 'fixed-width'
    ? { kind: 'fixed-width', width: spec.width, overlap: spec.overlap }
    : {
        kind: 'header-based',
        ...(spec.splitMaxLength === undefined ? {} : { splitMaxLength: spec.splitMaxLength }),
        ...(spec.overlap === undefined ? {} : { overlap: spec.overlap }),
      };

export const chunkingOf = (spec: PipelineSpec['chunking']): ChunkDocumentConfig => ({
  strategy: strategyOf(spec.strategy),
  minimumLength: spec.minimumLength,
  maximumLength: spec.maximumLength,
  metadataStyle: metadataStyles[spec.metadataStyle],
});

const globPattern = (glob: string) => {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      out += '.*';
      i += 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
};

const matches = (globs: string[], value: string) => globs.some((g) => globPattern(g).test(value));

const selected = (value: string, include: string[], exclude: string[] = []) =>
  (include.length === 0 || matches(include, value)) && !matches(exclude, value);

const withoutMetadata = (source: IngestSource): IngestSource => ({
  ...source,
  documents: async function* () {
    for await (const document of source.documents())
      yield {
        ...document,
        storedChunks: (chunks) =>
          document
            .storedChunks(chunks)
            .map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'metadata'))),
      };
  },
});

const withIngestedAt = (source: IngestSource, at: string): IngestSource => ({
  ...source,
  documents: async function* () {
    for await (const document of source.documents())
      yield { ...document, stored: (chunks) => ({ ...document.stored(chunks), ingested_at: at }) };
  },
});

const inside = (root: string, path: string) => {
  const base = resolve(root);
  const full = resolve(base, path);
  return full === base || full.startsWith(`${base}${sep}`) ? full : undefined;
};

const sourceProblem = (spec: PipelineSpec, options: IngestSourceOptions) => {
  if (spec.source.kind === 'kudos') {
    if (!options.converter)
      return 'KUDOS sources need a document converter, and none is configured on this platform';
    if (unboundedKudos(spec)) return unboundedKudosMessage;
  }
  if (spec.source.kind === 'upload' && !options.uploads)
    return 'uploads are turned off on this platform';
  if (spec.source.kind === 'database' && !options.database)
    return 'database sources are turned off on this platform';
  if (spec.source.kind === 'parquet' && !options.parquet)
    return 'Parquet sources are turned off on this platform';
  if (spec.source.kind === 'folder' || spec.source.kind === 'episerver') {
    if (!options.folderRoot) return 'folder sources are turned off on this platform';
    if (!inside(options.folderRoot, spec.source.path))
      return 'the folder lies outside the folder root of the platform';
  }
  return undefined;
};

const withSkipped = (skipped: SkippedDocument[], source: IngestSource): IngestSource =>
  skipped.length > 0 ? { ...source, skipped: [...(source.skipped ?? []), ...skipped] } : source;

const websiteSkip = (
  loc: string,
  allowedHosts: Set<string>,
  converter: DocumentConverter | undefined,
): SkippedDocument | undefined => {
  const url = new URL(loc);
  if (allowedHosts.size > 0 && !allowedHosts.has(url.hostname.toLowerCase().replace(/\.$/, '')))
    return { document: loc, reason: 'outside_access' };
  const reason = websiteSkipReasonFor(loc, converter);
  return reason ? { document: loc, reason } : undefined;
};

const lowered = (values: string[]) => new Set(values.map((v) => v.toLowerCase()));

const kudosOrgNames = (doc: KudosDocument) =>
  [...(doc.owners ?? []), ...(doc.recipients ?? []), ...(doc.publishers ?? [])].flatMap((o) => [
    ...displayNames([o]),
    ...(o.alternative_names ?? []).map((n) => n.name),
  ]);

interface KudosFilter {
  profile?: KudosProfile['name'] | undefined;
  startingPage?: number | undefined;
  types?: string[] | undefined;
  since?: string | undefined;
  orgs?: string[] | undefined;
}

const kudosMatcher = (filter: KudosFilter) => {
  const orgs = filter.orgs && filter.orgs.length > 0 ? lowered(filter.orgs) : undefined;
  const types = filter.types && filter.types.length > 0 ? lowered(filter.types) : undefined;
  return (doc: KudosDocument) =>
    (!types || types.has(String(doc.type).toLowerCase())) &&
    (!filter.since || (doc.publish_date ?? '') >= filter.since) &&
    (!orgs || kudosOrgNames(doc).some((name) => orgs.has(name.toLowerCase())));
};

const kudosSearches = (filter: KudosFilter): KudosSearch[] => {
  const types = filter.types && filter.types.length > 0 ? filter.types : [undefined];
  const queries = filter.orgs && filter.orgs.length > 0 ? filter.orgs : [undefined];
  return types.flatMap((type) =>
    queries.map((query) => ({ ...(type ? { type } : {}), ...(query ? { query } : {}) })),
  );
};

const kudosDocuments = async function* (
  client: ReturnType<typeof kudosClientFor>,
  filter: KudosFilter,
) {
  const matches = kudosMatcher(filter);
  for (const search of kudosSearches(filter))
    for await (const doc of client.documents(filter.startingPage ?? 1, search))
      if (matches(doc)) yield doc;
};

export const estimateKudos = async (
  access: KudosAccess,
  filter: KudosFilter,
): Promise<SourceEstimate> => {
  const client = kudosClientFor(access, filter.profile);
  const matches = kudosMatcher(filter);
  let listed = 0;
  let sampled = 0;
  let matching = 0;
  let documents = 0;
  for (const search of kudosSearches(filter)) {
    const first = await client.page(1, search);
    const total =
      first.meta.total ??
      (first.meta.last_page <= first.meta.current_page
        ? first.data.length
        : first.meta.last_page * Math.max(first.data.length, 1));
    const hits = first.data.filter(matches).length;
    listed += total;
    sampled += first.data.length;
    matching += hits;
    documents += first.data.length === 0 ? 0 : Math.round((total * hits) / first.data.length);
  }
  return { documents, exact: listed === sampled, basis: { listed, sampled, matching } };
};

export const kudosProfileFor = (access: KudosAccess, name: KudosProfile['name'] = 'prod') => {
  const profile = access.profiles?.[name] ?? kudosProfiles[name];
  if (!profile) throw new Error(`the KUDOS profile ${name} is not configured on this platform`);
  return profile;
};

export const kudosClientFor = (access: KudosAccess = {}, name?: KudosProfile['name']) =>
  kudosClient({
    profile: kudosProfileFor(access, name),
    ...(access.fetch ? { fetch: access.fetch } : {}),
    ...(access.sleep ? { sleep: access.sleep } : {}),
  });

const sourceOf = async (
  spec: PipelineSpec,
  options: IngestSourceOptions,
  scope: { tenant: string; dataset: string },
  signal: AbortSignal,
): Promise<IngestSource> => {
  const source = spec.source;
  const converter = options.converter;
  const problem = sourceProblem(spec, options);
  if (problem) throw new Error(problem);
  if (source.kind === 'website') {
    const policy = websiteFetchPolicy({
      sitemapUrl: source.sitemap,
      ...(source.baseUrl ? { baseUrl: source.baseUrl } : {}),
    });
    const listed = (
      await crawlSitemap(source.sitemap, source.baseUrl, policy, {
        ...options.web,
        signal,
        includeHtml: true,
      })
    ).filter((e) => selected(new URL(e.loc).pathname, source.include, source.exclude));
    const skipOf = (loc: string) => websiteSkip(loc, policy.allowedHosts, converter);
    const documentLimit = (loc: string) =>
      convertibleExtensions(converter).includes(extname(new URL(loc).pathname).toLowerCase())
        ? maxDocumentBytes
        : policy.maxMarkdownBytes;
    return withSkipped(
      listed.flatMap((e) => skipOf(e.loc) ?? []),
      websiteSource({
        entries: listed.filter((e) => !skipOf(e.loc)),
        ...(source.baseUrl ? { baseUrl: source.baseUrl } : {}),
        ...(converter ? { converter } : {}),
        fetchBody: (entry) =>
          guardedFetchBytes(entry.loc, policy, documentLimit(entry.loc), {
            ...options.web,
            signal,
          }),
      }),
    );
  }
  if (source.kind === 'folder') {
    const root = inside(options.folderRoot ?? '', source.path);
    if (!options.folderRoot || !root) throw new Error('the folder is not allowed');
    const name = (path: string) => relative(root, path).split(sep).join('/');
    const listed = (await findFolderFiles(root, 'all')).filter((e) =>
      selected(name(e.path), source.include, source.exclude),
    );
    return folderSource({
      entries: listed,
      basePath: `${root}${sep}`,
      ...(source.baseUrl ? { baseUrl: source.baseUrl } : {}),
      ...(source.keepExtension ? { keepExtension: true } : {}),
      ...(source.titleFrom ? { titleFrom: source.titleFrom } : {}),
      ...(source.extensions ? { extensions: source.extensions } : {}),
      ...(converter ? { converter } : {}),
    });
  }
  if (source.kind === 'upload') {
    if (!options.uploads) throw new Error('uploads are turned off on this platform');
    return uploadSource({
      blobs: options.uploads,
      tenant: scope.tenant,
      prefix: uploadPrefix(scope.dataset, scope.tenant),
      ...(converter ? { converter } : {}),
    });
  }
  if (source.kind === 'database') {
    if (!options.database) throw new Error('database sources are turned off on this platform');
    const connection = await resolvedConnection(options.database, source, scope.tenant);
    const { host, port, database } = source.connection;
    return databaseSource({
      rows: options.database.reader.rows(connection, tableQuery(source.mapping)),
      mapping: source.mapping,
      origin: `postgres://${host}:${port}/${database}/${source.mapping.schema}.${source.mapping.table}`,
    });
  }
  if (source.kind === 'parquet') {
    if (!options.parquet) throw new Error('Parquet sources are turned off on this platform');
    return parquetSourceOf(options.parquet, source, { ...options.web, signal });
  }
  if (source.kind === 'episerver') {
    const root = inside(options.folderRoot ?? '', source.path);
    if (!options.folderRoot || !root) throw new Error('the export file is not allowed');
    const pages = filterEpiserverPages(episerverPages(await readFile(root, 'utf8')), {
      language: source.language,
      pageTypes: source.pageTypes,
      offset: source.offset,
      ...(source.limit === undefined ? {} : { limit: source.limit }),
    });
    return episerverSource({ pages, ...(source.baseUrl ? { baseUrl: source.baseUrl } : {}) });
  }
  if (!converter) throw new Error('KUDOS sources need a document converter');
  const kudos = options.kudos ?? {};
  const filePolicy = {
    ...defaultFetchPolicy,
    readTimeoutMs: kudosFileReadTimeoutMs,
    allowedHosts: new Set<string>(),
  };
  return kudosSource({
    documents: kudosDocuments(kudosClientFor(kudos, source.profile), source),
    profile: kudosProfileFor(kudos, source.profile),
    fetchFile: (file) =>
      fetchKudosFile(
        file,
        async (url) =>
          (
            await guardedFetchBytes(url, filePolicy, maxDocumentBytes, {
              ...options.web,
              signal,
              ...(kudos.fetch ? { fetch: kudos.fetch } : {}),
            })
          ).bytes,
      ),
    converter,
  });
};

const addUsage = (total: Usage | undefined, usage: Usage): Usage => {
  const sum = (a?: number, b?: number) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const out: Usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'requests', 'costMicroNok'] as const) {
    const value = sum(total?.[key], usage[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
};

export const indexIngestionBackend = (options: IndexIngestionOptions): IngestionBackend => {
  const probe = (target: IngestionTarget) => {
    if (!options.writers.supports(target.dataset))
      return {
        reason: `dataset ${target.dataset} is on an engine without an index writer; create it on an engine with one, such as pgvector`,
      };
    try {
      return {
        route: options.writers.open(target.dataset, { signal: new AbortController().signal }),
      };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    name: 'index-writer',
    available: true,
    unavailableFor: (target: IngestionTarget, pipeline?: Pipeline) => {
      const probed = probe(target);
      if (!probed.route) return probed.reason;
      const embedding = probed.route.dataset.embedding;
      if (probed.route.needs.vectors && embedding && !options.embedders?.has(embedding.model))
        return `dataset ${target.dataset} embeds with ${embedding.model}, which is not configured`;
      if (pipeline?.spec.phrases && !options.models)
        return 'search phrases need a model, and no model router is configured';
      return pipeline ? sourceProblem(pipeline.spec, options) : undefined;
    },
    estimate: async (pipeline: Pipeline) => {
      const source = pipeline.spec.source;
      if (source.kind !== 'kudos') return undefined;
      return estimateKudos(options.kudos ?? {}, source);
    },
    run: async (job: IngestionJob, signal: AbortSignal): Promise<IngestionReport> => {
      const tenant = job.tenant ?? options.platformTenant;
      const usage: Record<string, Usage> = {};
      const system: Principal = {
        kind: 'agency-system',
        issuer: 'platform',
        subject: 'ingestion',
        tenant,
      };
      const principal = job.admitted ? withModelAdmission(system) : system;
      const ctx: PortContext = {
        tenant,
        principal,
        task: `ingestion:${job.execution}`,
        signal,
        meter: async (used, ref) => {
          const key = ref ? `${ref.kind}:${ref.id}` : 'other';
          usage[key] = addUsage(usage[key], used);
        },
      };
      const route = options.writers.open(job.target.dataset, { signal });
      const embedding = route.needs.vectors ? route.dataset.embedding : undefined;
      const residency = options.residencyOf(job.target.dataset);
      const embedder =
        embedding && options.embedders
          ? options.embedders.open({ kind: 'embedder', id: embedding.model }, ctx, {
              ...(residency ? { maxResidency: residency } : {}),
            })
          : undefined;
      const spec = job.pipeline.spec;
      const modelRef = (id: string): Ref => ({
        kind: 'model',
        id,
        ...(job.tenant && job.tenant !== options.platformTenant ? { tenant: job.tenant } : {}),
      });
      const phrases =
        spec.phrases && options.models
          ? {
              model: options.models.open(modelRef(spec.phrases.model), ctx),
              generation: {
                prompt: defaultSearchPhrasesPrompt,
                identity: { provider: 'platform', model: spec.phrases.model },
                cache: phraseCacheFor(options.phrases, tenant, spec.source.kind),
                cacheEmpty: spec.source.kind === 'kudos',
                ...(spec.phrases.fallbackModel
                  ? { fallback: options.models.open(modelRef(spec.phrases.fallbackModel), ctx) }
                  : {}),
                ...(spec.source.kind === 'folder' && options.phrases?.archive
                  ? { declared: options.phrases.archive }
                  : {}),
              },
            }
          : undefined;
      const source = await sourceOf(spec, options, { tenant, dataset: job.target.dataset }, signal);
      const result = await runIndexIngest({
        source: withIngestedAt(
          spec.chunking.metadataStyle === 'none' ? withoutMetadata(source) : source,
          new Date().toISOString(),
        ),
        chunking: chunkingOf(spec.chunking),
        ...(phrases ? { phrases } : {}),
        parallelism: spec.parallelism,
        maxDocumentFailures: spec.maxDocumentFailures,
        signal,
        target: {
          engine: route.engine,
          needs: { vectors: embedding !== undefined },
          dataset: route.dataset,
          writer: route.writer,
          generation: job.execution,
          ...(embedder ? { embedder } : {}),
        },
      });
      return {
        stored: result.stored,
        skipped: result.skipped,
        ...(result.skippedDocuments ? { skippedDocuments: result.skippedDocuments } : {}),
        failed: result.failed,
        generation: result.generation,
        promoted: result.promoted,
        ...(result.previous === undefined ? {} : { previous: result.previous }),
        ...(Object.keys(usage).length > 0 ? { usage } : {}),
        ...(source.summary ? { source: source.summary() } : {}),
      };
    },
  };
};
