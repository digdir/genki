import type { Principal } from '@genai/contracts';
import { KernelError, type PortContext } from '@genai/kernel';
import { mayUseModels, withModelAdmission } from '@genai/composition';
import { KnowledgeError, type Hit, type KnowledgeRouter } from '@genai/port-knowledge';
import type { Context, Env, Hono, Schema } from 'hono';
import { z } from 'zod';
import { enterTenant, type Access } from './access.js';
import { readBlockPolicy } from './building-blocks.js';
import type { CatalogRegistry } from './catalog-registry.js';
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
};

const missingSearchTask: TrackedWork = async () => {
  throw new Error('dataset search runs only where the platform registers its tracked work');
};

export const datasetSearchModule: PlatformModuleFactory = () => ({
  id: 'dataset-search',
  mount: <E extends Env, S extends Schema, B extends string>(app: Hono<E, S, B>, deps: MountDeps) =>
    mountDatasetSearch(app, {
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
