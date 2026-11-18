import type { Principal } from '@genai/contracts';
import { KernelError, type PortContext } from '@genai/kernel';
import { mayUseModels, withModelAdmission } from '@genai/composition';
import { uploadDocumentId, uploadPrefix } from '@genai/ingest';
import type { BlobStore } from '@genai/port-blob';
import {
  capabilitiesOf,
  documentSortKeys,
  KnowledgeError,
  maxDocumentQueryLength,
  type DocumentListing,
  type DocumentSortKey,
  type Hit,
  type KnowledgePort,
  type KnowledgeRouter,
} from '@genai/port-knowledge';
import type { Context, Env, Hono, Schema } from 'hono';
import { z } from 'zod';
import { enterTenant, type Access } from './access.js';
import { readBlockPolicy } from './building-blocks.js';
import type { CatalogRegistry } from './catalog-registry.js';
import { latestOf, writerCounts } from './dataset-status.js';
import type { IngestionService } from './ingestion.js';
import { platformScope, type ConfigEntryStore } from './config-store.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import type { TrackedWork } from './tracked-work.js';
import { t } from './i18n/index.js';
import { verdict } from './playground.js';
import { quotaRefused } from './rate-limit.js';
import { requireRight, type Right } from './rights.js';

export interface DatasetSearchHit {
  id: string;
  document?: string;
  title?: string;
  url?: string;
  position?: number;
  page?: number;
  pageEnd?: number;
  score: number;
  text: string;
  fields: Record<string, unknown>;
}

/** What a direct search answers: the hits in order, and what was searched. */
export interface DatasetSearchAnswer {
  dataset: string;
  profile: string;
  filters: Record<string, unknown>;
  limit: number;
  found?: number;
  warning?: string;
  tookMs: number;
  hits: DatasetSearchHit[];
}

export interface DatasetSearchDeps {
  knowledge: Pick<KnowledgeRouter, 'open' | 'resolve' | 'datasets'>;
  catalog: Pick<CatalogRegistry, 'get' | 'visibleTo' | 'qualify'>;
  configEntries: Pick<ConfigEntryStore, 'latest'>;
  platformTenant: string;
  authenticate(request: Request): Promise<Principal | undefined>;
  access: Access;
  /** Runs the search as a kernel task, so the query's embedding counts against the tenant's budget as a run's does. */
  searchTask: TrackedWork;
  logger?: (message: string, fields: Record<string, unknown>) => void;
  blobs?: Pick<BlobStore, 'list'>;
  ingestion?: Pick<IngestionService, 'list' | 'executions'>;
  documentCount?(dataset: string): Promise<number | undefined>;
  /** Milliseconds for `tookMs`; tests pass a fixed one. */
  clock?: () => number;
}

/** The router clamps a search at 100 hits; the route refuses more instead of cutting it silently. */
export const maxSearchLimit = 100;

export const datasetSearchBody = z.strictObject({
  query: z.string().trim().min(1).max(2000),
  filters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Filters in the shape a run takes, on the dataset's declared fields"),
  profile: z
    .string()
    .min(1)
    .optional()
    .describe("One of the dataset's search profiles; default its first"),
  limit: z.number().int().min(1).max(maxSearchLimit).optional().describe('Default 10'),
});

const manageRights: Right[] = ['manage-services', 'manage-datasets'];

type ProblemStatus = 401 | 403 | 404 | 422 | 502 | 504;

const problem = (
  c: Context,
  status: ProblemStatus,
  title: string,
  extra: Record<string, unknown> = {},
) =>
  c.json({ type: 'about:blank', title, status, ...extra }, status, {
    'content-type': 'application/problem+json',
  });

const pageOf = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const hitView = (hit: Hit): DatasetSearchHit => {
  const page = pageOf(hit.fields.page);
  const pageEnd = pageOf(hit.fields.pageEnd);
  return {
    id: hit.id,
    ...(hit.document === undefined ? {} : { document: hit.document }),
    ...(hit.title === undefined ? {} : { title: hit.title }),
    ...(hit.url === undefined ? {} : { url: hit.url }),
    ...(hit.position === undefined ? {} : { position: hit.position }),
    ...(page === undefined ? {} : { page }),
    ...(pageEnd === undefined ? {} : { pageEnd }),
    score: hit.score,
    text: hit.text,
    fields: hit.fields,
  };
};

const codeOf = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Only people search a dataset directly; API keys are not in this route (#678). */
const searchers = new Set<Principal['kind']>(['employee', 'operator']);

/** The scope with which the kernel's invoke policy admits a platform system principal. */
const systemScope = 'legacy:query';

/** The task runs as the platform for the tenant, the person as actor: the route checked their rights, which may lack use-services. */
const searcher = (person: Principal, tenant: string): Principal => {
  const system: Principal = {
    kind: 'agency-system',
    issuer: 'platform',
    subject: 'dataset-search',
    tenant,
    scopes: [systemScope],
    actor: person,
  };
  return mayUseModels(person) ? withModelAdmission(system) : system;
};

export const mountDatasetSearch = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: DatasetSearchDeps,
) => {
  const clock = deps.clock ?? (() => performance.now());

  const search = async (
    c: Context,
    principal: Principal,
    tenant: string,
    dataset: string,
    sharedWith = tenant,
  ): Promise<Response> => {
    const parsed = datasetSearchBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return problem(c, 422, t('problems.invalidRequest'), {
        errors: parsed.error.issues.map((i) => ({
          path: i.path.join('.') || 'body',
          message: i.message,
        })),
      });
    const body = parsed.data;
    const started = clock();
    try {
      // The same router a service run searches through: its filter checks, limit cap and timeout.
      const open = (ctx: PortContext) =>
        deps.knowledge.open(
          { kind: 'dataset', id: dataset, tenant: sharedWith },
          { ...ctx, signal: AbortSignal.any([ctx.signal, c.req.raw.signal]) },
        );
      const info = open({
        tenant,
        principal,
        task: 'dataset-search-info',
        signal: c.req.raw.signal,
        meter: async () => undefined,
      }).info();
      const profile = body.profile ?? info.profiles[0];
      if (!profile || !info.profiles.includes(profile))
        return problem(c, 422, t('problems.diagnosticsSearchInvalid'), {
          errors: [
            {
              path: 'profile',
              message: t('problems.datasetSearchNoProfile', {
                dataset,
                profile: body.profile ?? '',
              }),
            },
          ],
        });
      const undeclared = Object.keys(body.filters ?? {}).filter((f) => !(f in info.filters));
      if (undeclared.length)
        return problem(c, 422, t('problems.diagnosticsSearchInvalid'), {
          errors: undeclared.map((field) => ({
            path: `filters.${field}`,
            message: t('problems.datasetSearchUndeclaredFilter', { dataset, field }),
          })),
        });
      const filters = (body.filters ?? {}) as Record<string, never>;
      const limit = body.limit ?? 10;
      const { value: result } = await deps.searchTask(searcher(principal, tenant), (ctx) =>
        open(ctx).search({
          query: body.query,
          profile,
          ...(body.filters ? { filters } : {}),
          limit,
        }),
      );
      const answer: DatasetSearchAnswer = {
        dataset,
        profile,
        filters,
        limit,
        ...(result.found === undefined ? {} : { found: result.found }),
        ...(result.warning === undefined ? {} : { warning: result.warning }),
        tookMs: Math.round(clock() - started),
        hits: result.hits.map(hitView),
      };
      return c.json(answer);
    } catch (error) {
      const spent = quotaRefused(c, error);
      if (spent) return spent;
      const code = codeOf(error);
      const message = messageOf(error);
      if (error instanceof KnowledgeError && code === 'forbidden')
        return problem(c, 404, t('problems.diagnosticsDatasetNotFound'));
      if (error instanceof KernelError && code === 'forbidden')
        return problem(c, 403, t('problems.datasetSearchRefused'), {
          errors: [{ path: 'kernel', message }],
        });
      if (code === 'bad_request' || code === 'unsupported')
        return problem(c, 422, t('problems.diagnosticsSearchInvalid'), {
          errors: [{ path: body.filters ? 'filters' : 'body', message }],
        });
      // Never the query: it can hold personal data, and a run's question is not logged either.
      deps.logger?.('dataset search failed', {
        dataset,
        tenant,
        code: code ?? 'unknown',
        ms: Math.round(clock() - started),
      });
      if (code === 'timeout')
        return problem(c, 504, t('problems.datasetSearchTimedOut'), {
          errors: [{ path: 'knowledge', message }],
        });
      return problem(c, 502, t('problems.diagnosticsSearchFailed'), {
        errors: [{ path: 'knowledge', message }],
      });
    }
  };

  app.post('/tenants/:tenant/datasets/:id/search', async (c) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, t('problems.notSignedIn'));
    // An API key's dataset grants are checked by the kernel, which this route's system principal skips.
    if (!searchers.has(principal.kind))
      return problem(c, 403, t('problems.datasetSearchPeopleOnly'));
    const tenant = c.req.param('tenant') ?? '';
    const entered = enterTenant(c, deps.access, principal, tenant);
    if ('response' in entered) return entered.response;
    if (!manageRights.some((right) => requireRight(entered.principal, tenant, right).ok))
      return problem(c, 403, t('problems.datasetSearchNeedsRight'), {
        errors: manageRights.map((right) => ({ path: 'right', message: right })),
      });
    const asked = c.req.param('id') ?? '';
    const ids = new Set(
      [asked, deps.catalog.qualify(tenant, asked)].map((id) => deps.knowledge.resolve(id) ?? id),
    );
    // The tenant's catalogue: its own datasets and the platform datasets shared with it, as a run may search.
    const item = deps.catalog.visibleTo(tenant).find((i) => i.kind === 'dataset' && ids.has(i.id));
    if (!item) return problem(c, 404, t('problems.diagnosticsDatasetNotFound'));
    const residency = deps.knowledge.datasets().get(item.id)?.residency ?? null;
    const policy = await readBlockPolicy(deps.configEntries, tenant);
    const refused = verdict(policy, 'dataset', item.id, residency);
    if (refused.status !== 'allowed')
      return problem(c, 403, t('problems.datasetSearchBlocked', { dataset: item.id }), {
        policy: refused.policy,
      });
    return search(c, entered.principal, tenant, item.id);
  });

  app.post('/operator/datasets/:id/search', async (c) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, t('problems.notSignedIn'));
    if (principal.kind !== 'operator') return problem(c, 403, t('problems.notAllowed'));
    const asked = c.req.param('id') ?? '';
    const item = deps.catalog.get('dataset', deps.knowledge.resolve(asked) ?? asked);
    if (!item || item.scope !== platformScope)
      return problem(c, 404, t('problems.diagnosticsDatasetNotFound'));
    // A platform dataset shared with listed tenants is read as the first of them; usage stays the platform's.
    const shared = deps.knowledge.datasets().get(item.id)?.tenants?.[0];
    return search(
      c,
      { ...principal, tenant: deps.platformTenant },
      deps.platformTenant,
      item.id,
      shared ?? deps.platformTenant,
    );
  });

  mountDatasetDocuments(app, deps);
};

export const datasetDocumentsPeopleOnlyType = 'urn:genai:problem:dataset-documents-people-only';
export const datasetDocumentsUnsupportedType = 'urn:genai:problem:dataset-documents-unsupported';
export const datasetDocumentsFailedType = 'urn:genai:problem:dataset-documents-failed';

export const maxDocumentsLimit = 100;

export const datasetDocumentNotFoundType = 'urn:genai:problem:dataset-document-not-found';

export const documentExcerptLength = 500;

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const filtersParam = z
  .string()
  .optional()
  .transform((text, ctx) => {
    if (text === undefined || text === '') return undefined;
    const value = parsedJson(text);
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
    ctx.addIssue({ code: 'custom', message: t('problems.datasetDocumentsFiltersNotObject') });
    return z.NEVER;
  });

export const documentStatuses = ['indexed', 'failed', 'pending'] as const;
export type DocumentStatus = (typeof documentStatuses)[number];

export const datasetDocumentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(maxDocumentsLimit).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  filters: filtersParam,
  query: z.string().trim().max(maxDocumentQueryLength).optional(),
  sort: z.enum(documentSortKeys).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  status: z.enum(documentStatuses).default('indexed'),
});

export interface OriginalFile {
  name: string;
  size: number;
  type: string;
}

interface DocumentView {
  id: string;
  title?: string;
  url?: string;
  fields: Record<string, unknown>;
  original?: OriginalFile;
  status: DocumentStatus;
  chunkCount?: number;
  reason?: string;
}

export interface DocumentStatusCounts {
  indexed: number | null;
  failed: number;
  pending: number;
}

export interface DatasetDocumentsPage {
  dataset: string;
  limit: number;
  offset: number;
  found?: number;
  total: number;
  totalExact: boolean;
  status: DocumentStatus;
  statusCounts: DocumentStatusCounts;
  listing: DocumentListing;
  query?: string;
  sort?: { key: DocumentSortKey; order: 'asc' | 'desc' };
  filters?: Record<string, unknown>;
  documents: DocumentView[];
}

export interface DocumentChunk {
  id: string;
  position?: number;
  page?: number;
  pageEnd?: number;
  text: string;
}

export interface DatasetDocumentDetail extends DocumentView {
  excerpt?: string;
  chunks?: DocumentChunk[];
}

const typed = (c: Context, type: string, status: 403 | 404 | 422 | 502, title: string) =>
  c.json({ type, title, status }, status, { 'content-type': 'application/problem+json' });

const invalid = (c: Context, errors: { path: string; message: string }[]) =>
  problem(c, 422, t('problems.invalidRequest'), { errors });

type DocumentDeps = Pick<
  DatasetSearchDeps,
  'knowledge' | 'catalog' | 'authenticate' | 'access' | 'logger'
> & {
  blobs?: Pick<BlobStore, 'list'>;
  ingestion?: Pick<IngestionService, 'list' | 'executions'>;
  documentCount?(dataset: string): Promise<number | undefined>;
};

const chunkRange = /^(\d{1,5})-(\d{1,5})$/;

const parseChunks = (text: string | undefined) => {
  if (text === undefined) return undefined;
  const found = chunkRange.exec(text);
  const from = Number(found?.[1]);
  const to = Number(found?.[2]);
  if (!found || to < from || to - from >= 50) return null;
  return { from, to };
};

const chunkCountOf = (fields: Record<string, unknown>) => {
  const count = fields.total_chunks;
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : undefined;
};

const noListing: DocumentListing = { query: false, sort: [] };

const idBatch = 100;

interface NotIndexed {
  id: string;
  title?: string;
  reason?: string;
  original?: OriginalFile;
}

export const mountDatasetDocuments = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: DocumentDeps,
) => {
  const enter = async (c: Context) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return { response: problem(c, 401, t('problems.notSignedIn')) };
    if (!searchers.has(principal.kind))
      return {
        response: typed(
          c,
          datasetDocumentsPeopleOnlyType,
          403,
          t('problems.datasetDocumentsPeopleOnly'),
        ),
      };
    const tenant = c.req.param('tenant') ?? '';
    const entered = enterTenant(c, deps.access, principal, tenant);
    if ('response' in entered) return { response: entered.response };
    const asked = c.req.param('id') ?? '';
    const ids = new Set(
      [asked, deps.catalog.qualify(tenant, asked)].map((id) => deps.knowledge.resolve(id) ?? id),
    );
    const item = deps.catalog.visibleTo(tenant).find((i) => i.kind === 'dataset' && ids.has(i.id));
    if (!item) return { response: problem(c, 404, t('problems.diagnosticsDatasetNotFound')) };
    const port = deps.knowledge.open(
      { kind: 'dataset', id: item.id, tenant },
      {
        tenant,
        principal: entered.principal,
        task: 'dataset-documents',
        signal: c.req.raw.signal,
        meter: async () => undefined,
      },
    );
    return { tenant, item, port };
  };

  const originals = async (tenant: string, item: { id: string; scope: string }) => {
    if (item.scope !== tenant || !deps.blobs) return new Map<string, OriginalFile>();
    const prefix = uploadPrefix(item.id, tenant);
    return new Map(
      (await deps.blobs.list(tenant, prefix)).map((b) => [
        uploadDocumentId(tenant, b.path),
        { name: b.path.slice(prefix.length), size: b.size, type: b.contentType },
      ]),
    );
  };

  const failedOf = async (tenant: string, item: { id: string; scope: string }) => {
    if (item.scope !== tenant || !deps.ingestion) return [];
    const ingestion = deps.ingestion;
    const pipelines = await ingestion.list(item.scope, item.id);
    const runs = await Promise.all(
      pipelines.map(async (p) => latestOf(await ingestion.executions(item.id, p.id))),
    );
    const seen = new Map<string, string>();
    for (const report of runs.map((run) => run?.report)) {
      if (!report) continue;
      for (const skipped of report.skippedDocuments ?? [])
        if (!seen.has(skipped.document)) seen.set(skipped.document, skipped.reason);
      for (const key of report.failed) if (!seen.has(key)) seen.set(key, 'failed');
    }
    return [...seen].map(([id, reason]): NotIndexed => ({ id, reason }));
  };

  const indexedAmong = async (port: KnowledgePort, ids: string[]) => {
    const found = new Set<string>();
    if (!port.documents) return found;
    const batches: string[][] = [];
    for (let at = 0; at < ids.length; at += idBatch) batches.push(ids.slice(at, at + idBatch));
    for (const batch of batches) {
      const page = await port.documents({ ids: batch, limit: batch.length });
      for (const d of page.documents) found.add(d.id);
    }
    return found;
  };

  const notIndexed = async (
    port: KnowledgePort,
    tenant: string,
    item: { id: string; scope: string },
    kept: Map<string, OriginalFile>,
  ) => {
    const failed = (await failedOf(tenant, item)).map((f) => {
      const original = kept.get(f.id);
      return original ? { ...f, title: original.name, original } : f;
    });
    const failedIds = new Set(failed.map((f) => f.id));
    const failedNames = new Set(failed.map((f) => f.id.slice(f.id.lastIndexOf('/') + 1)));
    const candidates = [...kept].filter(
      ([id, original]) => !failedIds.has(id) && !failedNames.has(original.name),
    );
    const indexed = await indexedAmong(
      port,
      candidates.map(([id]) => id),
    );
    const pending = candidates
      .filter(([id]) => !indexed.has(id))
      .map(([id, original]): NotIndexed => ({ id, title: original.name, original }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { failed, pending };
  };

  const view = (
    d: { id: string; title?: string; url?: string; fields: Record<string, unknown> },
    kept: Map<string, OriginalFile>,
  ): DocumentView => {
    const original = kept.get(d.id);
    const chunkCount = chunkCountOf(d.fields);
    return {
      id: d.id,
      ...(d.title === undefined ? {} : { title: d.title }),
      ...(d.url === undefined ? {} : { url: d.url }),
      fields: d.fields,
      ...(original ? { original } : {}),
      status: 'indexed',
      ...(chunkCount === undefined ? {} : { chunkCount }),
    };
  };

  const notIndexedView = (d: NotIndexed, status: DocumentStatus): DocumentView => ({
    id: d.id,
    ...(d.title === undefined ? {} : { title: d.title }),
    fields: {},
    ...(d.original ? { original: d.original } : {}),
    status,
    ...(d.reason === undefined ? {} : { reason: d.reason }),
  });

  const failed = (c: Context, error: unknown, dataset: string, tenant: string) => {
    const code = codeOf(error);
    if (error instanceof KnowledgeError && code === 'forbidden')
      return problem(c, 404, t('problems.diagnosticsDatasetNotFound'));
    if (error instanceof KnowledgeError && (code === 'bad_request' || code === 'unsupported'))
      return invalid(c, [{ path: 'filters', message: messageOf(error) }]);
    deps.logger?.('dataset document listing failed', { dataset, tenant, code: code ?? 'unknown' });
    return typed(c, datasetDocumentsFailedType, 502, t('problems.datasetDocumentsFailed'));
  };

  app.get('/tenants/:tenant/datasets/:id/documents', async (c) => {
    const parsed = datasetDocumentsQuery.safeParse(c.req.query());
    const opened = await enter(c);
    if ('response' in opened) return opened.response;
    const { tenant, item, port } = opened;
    if (!parsed.success)
      return invalid(
        c,
        parsed.error.issues.map((i) => ({ path: i.path.join('.') || 'query', message: i.message })),
      );
    const { limit, offset, filters, sort, order, status } = parsed.data;
    const query = parsed.data.query || undefined;
    if (offset % limit !== 0)
      return invalid(c, [{ path: 'offset', message: t('problems.datasetDocumentsOffsetNotPage') }]);
    if (status !== 'indexed' && (filters || sort))
      return invalid(c, [
        {
          path: filters ? 'filters' : 'sort',
          message: t('problems.datasetDocumentsStatusOnlyQuery'),
        },
      ]);
    try {
      if (!port.documents)
        return typed(
          c,
          datasetDocumentsUnsupportedType,
          422,
          t('problems.datasetDocumentsUnsupported'),
        );
      const info = port.info();
      const listing = info.documentListing ?? noListing;
      if (query && !listing.query && status === 'indexed')
        return invalid(c, [
          { path: 'query', message: t('problems.datasetDocumentsQueryUnsupported') },
        ]);
      if (sort && !listing.sort.includes(sort))
        return invalid(c, [
          { path: 'sort', message: t('problems.datasetDocumentsSortUnsupported', { sort }) },
        ]);
      if (filters) {
        const undeclared = Object.keys(filters).filter((f) => !(f in info.filters));
        if (undeclared.length)
          return invalid(
            c,
            undeclared.map((field) => ({
              path: `filters.${field}`,
              message: t('problems.datasetSearchUndeclaredFilter', { dataset: item.id, field }),
            })),
          );
      }
      const narrowed = Boolean(filters || query);
      const kept = await originals(tenant, item);
      const [page, rest, datasetCount] = await Promise.all([
        status === 'indexed'
          ? port.documents({
              limit,
              offset,
              ...(filters ? { filters: filters as Record<string, never> } : {}),
              ...(query ? { query } : {}),
              ...(sort ? { sort: { key: sort, direction: order } } : {}),
            })
          : undefined,
        notIndexed(port, tenant, item, kept),
        deps.documentCount?.(item.id).catch(() => undefined),
      ]);
      const indexedCount =
        !narrowed && status === 'indexed' && page?.found !== undefined
          ? page.found
          : datasetCount !== undefined
            ? datasetCount
            : ((await port.documents({ limit: 1 }).catch(() => undefined))?.found ?? null);
      const statusCounts: DocumentStatusCounts = {
        indexed: indexedCount,
        failed: rest.failed.length,
        pending: rest.pending.length,
      };
      const sortView = sort ? { sort: { key: sort, order } } : {};
      if (status !== 'indexed') {
        const needle = query?.toLowerCase();
        const all = rest[status].filter(
          (d) =>
            !needle ||
            d.id.toLowerCase().includes(needle) ||
            (d.title?.toLowerCase().includes(needle) ?? false),
        );
        const answer: DatasetDocumentsPage = {
          dataset: item.id,
          limit,
          offset,
          found: all.length,
          total: all.length,
          totalExact: true,
          status,
          statusCounts,
          listing,
          ...(query ? { query } : {}),
          documents: all.slice(offset, offset + limit).map((d) => notIndexedView(d, status)),
        };
        return c.json(answer);
      }
      const documents = (page?.documents ?? []).map((d) => view(d, kept));
      const fallback = narrowed ? undefined : (datasetCount ?? undefined);
      const total =
        page?.found ??
        fallback ??
        offset + documents.length + (documents.length === limit ? limit : 0);
      const answer: DatasetDocumentsPage = {
        dataset: item.id,
        limit,
        offset,
        ...(page?.found === undefined ? {} : { found: page.found }),
        total,
        totalExact: page?.found !== undefined || fallback !== undefined,
        status,
        statusCounts,
        listing,
        ...(query ? { query } : {}),
        ...sortView,
        ...(filters ? { filters } : {}),
        documents,
      };
      return c.json(answer);
    } catch (error) {
      return failed(c, error, item.id, tenant);
    }
  });

  app.get('/tenants/:tenant/datasets/:id/documents/:doc', async (c) => {
    const opened = await enter(c);
    if ('response' in opened) return opened.response;
    const { tenant, item, port } = opened;
    const doc = c.req.param('doc') ?? '';
    const range = parseChunks(c.req.query('chunks'));
    if (range === null)
      return invalid(c, [{ path: 'chunks', message: t('problems.datasetDocumentsChunksInvalid') }]);
    try {
      if (!port.documents)
        return typed(
          c,
          datasetDocumentsUnsupportedType,
          422,
          t('problems.datasetDocumentsUnsupported'),
        );
      const [page, kept] = await Promise.all([
        port.documents({ ids: [doc], limit: 1 }),
        originals(tenant, item),
      ]);
      const found = page.documents.find((d) => d.id === doc);
      if (!found)
        return typed(c, datasetDocumentNotFoundType, 404, t('problems.datasetDocumentNotFound'));
      const readsPassages = capabilitiesOf(port.info()).includes('range');
      if (range && !readsPassages)
        return typed(
          c,
          datasetDocumentsUnsupportedType,
          422,
          t('problems.datasetDocumentsChunksUnsupported'),
        );
      const passages = readsPassages ? await port.range(doc, 0, 2).catch(() => []) : [];
      const text = passages
        .map((p) => p.text)
        .join('\n\n')
        .trim();
      const chunks = range ? (await port.range(doc, range.from, range.to)).map(chunkView) : [];
      const answer: DatasetDocumentDetail = {
        ...view(found, kept),
        ...(text ? { excerpt: text.slice(0, documentExcerptLength) } : {}),
        ...(range ? { chunks } : {}),
      };
      return c.json(answer);
    } catch (error) {
      return failed(c, error, item.id, tenant);
    }
  });
};

const chunkView = (hit: Hit): DocumentChunk => {
  const page = pageOf(hit.fields.page);
  const pageEnd = pageOf(hit.fields.pageEnd);
  return {
    id: hit.id,
    ...(hit.position === undefined ? {} : { position: hit.position }),
    ...(page === undefined ? {} : { page }),
    ...(pageEnd === undefined ? {} : { pageEnd }),
    text: hit.text,
  };
};

const missingSearchTask: TrackedWork = async () => {
  throw new Error('dataset search runs only where the platform registers its tracked work');
};

export const datasetSearchModule: PlatformModuleFactory = () => ({
  id: 'dataset-search',
  mount: <E extends Env, S extends Schema, B extends string>(app: Hono<E, S, B>, deps: MountDeps) =>
    mountDatasetSearch(app, {
      blobs: deps.blobs,
      ingestion: deps.ingestion,
      documentCount: async (dataset) =>
        (
          await writerCounts(
            {
              writers: deps.writers,
              countable: (engine) => deps.engines().some((e) => e.engine === engine && e.builtin),
            },
            dataset,
          )
        )?.documents,
      knowledge: deps.knowledge,
      catalog: deps.catalog,
      configEntries: deps.configEntries,
      platformTenant: deps.platformTenant,
      authenticate: deps.authenticate,
      access: deps.access,
      searchTask: deps.datasetSearchTask ?? missingSearchTask,
      ...(deps.logger ? { logger: deps.logger } : {}),
    }),
});
