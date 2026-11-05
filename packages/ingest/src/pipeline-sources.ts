import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import type { BlobInfo, BlobStore } from '@genai/port-blob';
import { z } from 'zod';
import type { ChunkDocumentConfig, ChunkStrategy } from './chunk-document.js';
import type { MetadataStyle } from './chunking.js';
import type { DocumentConverter } from './converter.js';
import {
  databaseConnection,
  databaseSource,
  rowMapping,
  tableQuery,
  type RowReader,
} from './database.js';
import {
  convertibleExtensions,
  readableTextExtensions,
  websiteSkipReasonFor,
} from './documents.js';
import { episerverPages, episerverSource, filterEpiserverPages } from './episerver.js';
import { findFolderFiles, type FolderEntry } from './folder.js';
import {
  displayNames,
  fetchKudosFile,
  fillInKudosFields,
  kudosClient,
  kudosProfiles,
  type KudosDocument,
  type KudosProfile,
  type KudosSearch,
} from './kudos.js';
import type { DeclaredPhraseArchive } from './phrases.js';
import { huggingFaceSource, parquetMapping, parquetTableName } from './parquet.js';
import { PageGone, type ListedDocument, type Listing } from './document-records.js';
import type { IngestSource, SkippedDocument } from './pipeline.js';
import {
  folderDocumentId,
  folderSource,
  kudosSource,
  uploadDocumentId,
  uploadSource,
  websiteSource,
} from './sources.js';
import {
  crawlSitemap,
  defaultFetchPolicy,
  guardedFetchBytes,
  HttpStatusError,
  urlToDoc,
  websiteFetchPolicy,
  type SitemapEntry,
  type GuardedFetchOptions,
} from './website.js';

const glob = z.string().min(1).max(500);

const chunkStrategy = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('header-based'),
    splitMaxLength: z.number().int().positive().optional(),
    overlap: z.number().int().min(0).optional(),
  }),
  z.strictObject({
    kind: z.literal('fixed-width'),
    width: z.number().int().positive(),
    overlap: z.number().int().min(0),
  }),
]);

export const pipelineSpec = z.strictObject({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('website'),
      sitemap: z.url({ protocol: /^https$/ }),
      include: z.array(glob).default([]),
      exclude: z.array(glob).default([]),
      baseUrl: z.url().optional(),
    }),
    z.strictObject({
      kind: z.literal('folder'),
      path: z.string().min(1),
      include: z.array(glob).default(['**/*.md']),
      exclude: z.array(glob).optional(),
      baseUrl: z.url().optional(),
      keepExtension: z.boolean().optional(),
      titleFrom: z
        .enum(['file-name', 'heading'])
        .optional()
        .describe('heading: the first # heading, or the top-level name: of a YAML file'),
      extensions: z
        .array(z.enum(readableTextExtensions))
        .min(1)
        .optional()
        .describe('File types read as text; default .md, .txt, .html, .htm'),
    }),
    z.strictObject({
      kind: z.literal('upload'),
    }),
    z.strictObject({
      kind: z.literal('kudos'),
      profile: z.enum(['prod', 'preprod']).default('prod'),
      startingPage: z.number().int().positive().default(1),
      types: z.array(z.string().min(1)).default([]),
      since: z.iso.date().optional(),
      orgs: z.array(z.string().min(1)).optional(),
    }),
    z.strictObject({
      kind: z.literal('episerver'),
      path: z.string().min(1),
      language: z.string().min(1).default('no'),
      pageTypes: z.array(z.string().min(1)).default([]),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().positive().optional(),
      baseUrl: z.url().optional(),
    }),
    z
      .strictObject({
        kind: z.literal('parquet'),
        url: z.url({ protocol: /^https$/ }).optional(),
        huggingface: huggingFaceSource.optional(),
        urls: z
          .array(z.url({ protocol: /^https$/ }))
          .min(1)
          .max(1000)
          .optional(),
        table: parquetTableName.optional(),
        mapping: parquetMapping,
        maxBytes: z
          .number()
          .int()
          .min(1024)
          .max(20 * 1024 * 1024 * 1024)
          .default(1024 * 1024 * 1024)
          .describe(
            'Disk byte cap per shard, up to the platform ceiling; shards download sequentially',
          ),
      })
      .refine((s) => [s.url, s.urls, s.huggingface].filter((v) => v !== undefined).length === 1, {
        message: 'a Parquet source needs exactly one of url, urls and huggingface',
        path: ['url'],
      })
      .refine((s) => (s.urls ? s.table !== undefined : s.table === undefined), {
        message: 'table is required exactly when urls is set',
        path: ['table'],
      })
      .refine((s) => s.huggingface !== undefined || s.mapping.lookups.every((l) => !l.file), {
        message: 'a lookup file needs a huggingface source; use url otherwise',
        path: ['mapping', 'lookups'],
      }),
    z.strictObject({
      kind: z.literal('database'),
      connection: databaseConnection,
      mapping: rowMapping,
    }),
  ]),
  chunking: z
    .strictObject({
      strategy: chunkStrategy.default({ kind: 'header-based' }),
      minimumLength: z.number().int().min(0).default(200),
      maximumLength: z.number().int().positive().default(4000),
      metadataStyle: z.enum(['edn', 'json', 'none']).default('json'),
    })
    .prefault({}),
  phrases: z
    .strictObject({
      model: z.string().min(1),
      fallbackModel: z.string().min(1).optional(),
      perChunk: z.number().int().min(1).max(20).default(5),
    })
    .optional(),
  parallelism: z.number().int().min(1).max(16).default(2),
  maxDocumentFailures: z.number().int().positive().max(100_000).default(10),
  enabled: z.boolean().default(true),
  schedule: z.enum(['none', 'daily', 'weekly']).default('none'),
});

export type PipelineSpec = z.infer<typeof pipelineSpec>;

export type ParquetSourceSpec = Extract<PipelineSpec['source'], { kind: 'parquet' }>;

type DatabaseSpec = Extract<PipelineSpec['source'], { kind: 'database' }>;

export const unboundedKudos = (spec: { source?: unknown }) => {
  const source = (spec.source ?? {}) as { kind?: unknown; types?: unknown; since?: unknown };
  return (
    source.kind === 'kudos' &&
    !(Array.isArray(source.types) && source.types.length > 0) &&
    !source.since
  );
};

export const unboundedKudosMessage =
  'En innlesing fra Kudos må avgrenses med dokumenttyper eller en startdato, ellers leses hele arkivet inn.';

export interface SourceEstimate {
  documents: number;
  exact: boolean;
  basis: { listed: number; sampled: number; matching: number };
}

export interface KudosAccess {
  profiles?: Partial<Record<KudosProfile['name'], KudosProfile>>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
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

/** Builds the source of a Parquet pipeline; the platform passes its reader and download limits in. */
export interface ParquetSources {
  source(spec: ParquetSourceSpec, web: GuardedFetchOptions): IngestSource | Promise<IngestSource>;
}

export interface IngestSourceOptions {
  folderRoot?: string;
  phrases?: PhraseStorage;
  web?: GuardedFetchOptions;
  converter?: DocumentConverter;
  uploads?: Pick<BlobStore, 'list' | 'get'>;
  kudos?: KudosAccess;
  database?: DatabaseAccess;
  parquet?: ParquetSources;
}

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

export const maxDocumentBytes = 50 * 1024 * 1024;

export const kudosFileReadTimeoutMs = 120_000;

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

const inside = (root: string, path: string) => {
  const base = resolve(root);
  const full = resolve(base, path);
  return full === base || full.startsWith(`${base}${sep}`) ? full : undefined;
};

/** Why this platform cannot read the pipeline's source, or undefined when it can. */
export const sourceProblem = (spec: PipelineSpec, options: IngestSourceOptions) => {
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

export interface KudosFilter {
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

/** Lists the pipeline's source and returns it as an ingest source that fetches each document. */
export const sourceOf = async (
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
    return options.parquet.source(source, { ...options.web, signal });
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

/** The source kinds a dataset on the knowledge database takes; the others come with their first dataset there (issue 139). */
export const knowledgeSourceKinds = ['folder', 'upload', 'website', 'kudos'] as const;

export const knowledgeSourceRefusal = (kind: PipelineSpec['source']['kind']) =>
  (knowledgeSourceKinds as readonly string[]).includes(kind)
    ? undefined
    : `a source of kind ${kind} cannot fill a dataset on the knowledge database yet`;

/**
 * Whom a knowledge listing lists for: `tenant` reads uploads and connections, `owner` (`platform`
 * or the organisation number, as the dataset's scope) names folder documents.
 */
export interface KnowledgeListingScope {
  tenant: string;
  dataset: string;
  owner: string;
}

/**
 * Lists a pipeline's source for a run on the knowledge database without fetching what it can
 * compare by its listing, and loads one document from its record for an index job (ADR 0042).
 */
const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const firstDocument = async (source: IngestSource, what: string) => {
  for await (const doc of source.documents()) return doc;
  throw new Error(`${what} is gone from its source`);
};

/** A listing that counts as complete once it has been read to its end without an error. */
const listingOf = (
  deletes: Listing['deletes'],
  list: () => AsyncIterable<ListedDocument>,
  load: Listing['load'],
  whole = true,
): Listing => {
  let complete = false;
  return {
    deletes,
    documents: async function* () {
      complete = false;
      yield* list();
      complete = whole;
    },
    complete: () => complete,
    load,
  };
};

/**
 * Lists a pipeline's source for a run on the knowledge database without fetching what it can
 * compare by its listing, and loads one document from its record for an index job (ADR 0042).
 * Every fetch goes through the same guard and policies as `sourceOf`.
 */
export const knowledgeListingOf = async (
  spec: PipelineSpec,
  options: IngestSourceOptions,
  scope: KnowledgeListingScope,
  signal: AbortSignal,
): Promise<Listing> => {
  const source = spec.source;
  const converter = options.converter;
  const refused = knowledgeSourceRefusal(source.kind) ?? sourceProblem(spec, options);
  if (refused) throw new Error(refused);
  if (source.kind === 'website') {
    const policy = websiteFetchPolicy({
      sitemapUrl: source.sitemap,
      ...(source.baseUrl ? { baseUrl: source.baseUrl } : {}),
    });
    const crawl = async () =>
      (
        await crawlSitemap(source.sitemap, source.baseUrl, policy, {
          ...options.web,
          signal,
          includeHtml: true,
        })
      ).filter(
        (e) =>
          selected(new URL(e.loc).pathname, source.include, source.exclude) &&
          !websiteSkip(e.loc, policy.allowedHosts, converter),
      );
    const documentLimit = (loc: string) =>
      convertibleExtensions(converter).includes(extname(new URL(loc).pathname).toLowerCase())
        ? maxDocumentBytes
        : policy.maxMarkdownBytes;
    const fetchBody = async (entry: SitemapEntry) => {
      try {
        return await guardedFetchBytes(entry.loc, policy, documentLimit(entry.loc), {
          ...options.web,
          signal,
        });
      } catch (error) {
        if (error instanceof HttpStatusError && (error.status === 404 || error.status === 410))
          throw new PageGone(`${entry.loc} answered HTTP ${error.status}`);
        throw error;
      }
    };
    return listingOf(
      'crawled',
      async function* () {
        for (const entry of await crawl()) {
          const metadata = { loc: entry.loc, ...(entry.lastmod ? { lastmod: entry.lastmod } : {}) };
          // A page without lastmod has nothing to compare by until it is downloaded.
          const files = entry.lastmod
            ? []
            : [
                await fetchBody(entry).then(
                  (body) => ({ name: entry.loc, sha256: sha256Of(body.bytes) }),
                  (error: unknown) => {
                    if (error instanceof PageGone) return { name: entry.loc };
                    throw error;
                  },
                ),
              ];
          yield { id: urlToDoc(entry).id, record: { ...entry }, metadata, files };
        }
      },
      (record) =>
        firstDocument(
          websiteSource({
            entries: [record as unknown as SitemapEntry],
            ...(source.baseUrl ? { baseUrl: source.baseUrl } : {}),
            ...(converter ? { converter } : {}),
            fetchBody,
          }),
          'the page',
        ),
    );
  }
  if (source.kind === 'folder') {
    const root = inside(options.folderRoot ?? '', source.path);
    if (!options.folderRoot || !root) throw new Error('the folder is not allowed');
    const name = (path: string) => relative(root, path).split(sep).join('/');
    const fromRoot = resolve(options.folderRoot);
    const idOf = (path: string) =>
      folderDocumentId(scope.owner, relative(fromRoot, path).split(sep).join('/'));
    const list = async () =>
      (await findFolderFiles(root, 'all')).filter((e) =>
        selected(name(e.path), source.include, source.exclude),
      );
    const folder = (entry: FolderEntry) =>
      folderSource({
        entries: [entry],
        basePath: `${root}${sep}`,
        ...(source.baseUrl ? { baseUrl: source.baseUrl } : {}),
        ...(source.keepExtension ? { keepExtension: true } : {}),
        ...(source.titleFrom ? { titleFrom: source.titleFrom } : {}),
        ...(source.extensions ? { extensions: source.extensions } : {}),
        ...(converter ? { converter } : {}),
        documentId: idOf,
      });
    return listingOf(
      'listed',
      async function* () {
        for (const entry of await list())
          yield {
            id: idOf(entry.path),
            record: { path: entry.path, lastmod: entry.lastmod },
            metadata: { path: name(entry.path) },
            files: [{ name: name(entry.path), sha256: sha256Of(await readFile(entry.path)) }],
          };
      },
      (record) => {
        const path = String(record.path);
        if (!inside(root, path)) throw new Error('the file lies outside the folder');
        return firstDocument(folder({ path, lastmod: String(record.lastmod) }), 'the file');
      },
    );
  }
  if (source.kind === 'upload') {
    const uploads = options.uploads;
    if (!uploads) throw new Error('uploads are turned off on this platform');
    const prefix = uploadPrefix(scope.dataset, scope.tenant);
    return listingOf(
      'explicit',
      async function* () {
        for (const info of await uploads.list(scope.tenant, prefix)) {
          const name = info.path.slice(prefix.length);
          yield {
            id: uploadDocumentId(scope.tenant, info.path),
            record: { ...info },
            metadata: { path: name, contentType: info.contentType },
            files: [{ name, sha256: info.sha256 }],
          };
        }
      },
      (record) => {
        const info = record as unknown as BlobInfo;
        if (info.tenant !== scope.tenant || !info.path.startsWith(prefix))
          throw new Error('the upload lies outside its dataset');
        return firstDocument(
          uploadSource({
            blobs: { list: async () => [info], get: (i) => uploads.get(i) },
            tenant: scope.tenant,
            prefix,
            ...(converter ? { converter } : {}),
          }),
          'the upload',
        );
      },
    );
  }
  if (source.kind !== 'kudos') throw new Error(knowledgeSourceRefusal(source.kind));
  if (!converter) throw new Error('KUDOS sources need a document converter');
  const kudos = options.kudos ?? {};
  const filePolicy = {
    ...defaultFetchPolicy,
    readTimeoutMs: kudosFileReadTimeoutMs,
    allowedHosts: new Set<string>(),
  };
  const client = kudosClientFor(kudos, source.profile);
  const profile = kudosProfileFor(kudos, source.profile);
  return listingOf(
    'listed',
    async function* () {
      for await (const raw of kudosDocuments(client, source)) {
        const { files, ...metadata } = raw;
        yield {
          id: fillInKudosFields(raw).id,
          record: { ...raw },
          metadata,
          files: (files ?? []).map((f) => ({
            name: f.url,
            ...(f.sha256 ? { sha256: f.sha256 } : {}),
          })),
        };
      }
    },
    async (record) => {
      const doc = await firstDocument(
        kudosSource({
          documents: [record as KudosDocument],
          profile,
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
        }),
        'the document',
      );
      return doc.prepare ? doc.prepare() : doc;
    },
    // A listing that starts after page 1 does not see the documents before it.
    (source.startingPage ?? 1) <= 1,
  );
};
