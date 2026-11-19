import type { Principal } from '@genai/contracts';
import type { PortContext } from '@genai/kernel';
import { KnowledgeError, kindsOf, type KnowledgeRouter } from '@genai/port-knowledge';
import { Hono, type Context } from 'hono';
import { disjunctiveFacets } from './facets.js';
import { documentsRequest, facetRequest, toPortFilters } from './filters.js';

export { disjunctiveFacets, type FacetField, type FacetOption } from './facets.js';
export {
  documentsRequest,
  facetRequest,
  filterMapErrors,
  filterSpecs,
  toPortFilters,
  type FieldSpec,
} from './filters.js';

export interface Authenticator {
  authenticate(request: Request): Promise<Principal | undefined>;
}

export interface DatasetDescription {
  name: string;
  description: string;
}

export interface RestAdapterOptions {
  knowledge: KnowledgeRouter;
  auth: Authenticator;
  resolveDataset?: (tenant: string, datasetConfigKey: string) => string | undefined;
  describe?: (datasetId: string) => DatasetDescription | undefined;
  mayRead?: (principal: Principal, datasetId: string) => boolean | Promise<boolean>;
  status?: (datasetId: string) => string | Promise<string>;
  newTaskId?: () => string;
}

type Env = { Variables: { principal: Principal } };

const failure = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 500 | 501 | 502,
  message: string,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  c.json(
    {
      error: message,
      type: 'about:blank',
      title: message,
      status,
      detail: message,
      code,
      ...extra,
    },
    status,
    { 'content-type': 'application/problem+json', ...headers },
  );

const unauthenticated = (c: Context) =>
  failure(
    c,
    401,
    'Invalid or missing API key',
    'unauthorized',
    {},
    { 'WWW-Authenticate': 'Bearer' },
  );

type QueryLimits = Record<string, { min: number; max?: number; optional?: boolean }>;

const datasetQuery: QueryLimits = {
  tenant: { min: 1 },
  'dataset-config-key': { min: 1 },
  filter: { min: 1, max: 16384, optional: true },
};

const facetsQuery: QueryLimits = { ...datasetQuery, fields: { min: 1, max: 512 } };

const documentsQuery: QueryLimits = {
  ...datasetQuery,
  limit: { min: 1, max: 16, optional: true },
  offset: { min: 1, max: 16, optional: true },
};

const queryErrors = (c: Context, limits: QueryLimits) => {
  const humanized: Record<string, string[]> = {};
  for (const [name, rule] of Object.entries(limits)) {
    const value = c.req.query(name);
    if (value === undefined) {
      if (!rule.optional) humanized[name] = ['missing required key'];
    } else if (value.length < rule.min) {
      humanized[name] = [`should be at least ${rule.min} character`];
    } else if (rule.max !== undefined && value.length > rule.max) {
      humanized[name] = [`should be at most ${rule.max} characters`];
    }
  }
  return Object.keys(humanized).length > 0 ? humanized : undefined;
};

export const createRestAdapter = (options: RestAdapterOptions) => {
  const app = new Hono<Env>();
  const describe = options.describe ?? (() => undefined);
  const mayRead = options.mayRead ?? (() => true);
  const newTaskId = options.newTaskId ?? (() => crypto.randomUUID());
  const resolveDataset =
    options.resolveDataset ??
    ((tenant: string, key: string) =>
      options.knowledge.resolve(`${tenant}/${key}`) ?? options.knowledge.resolve(key));

  const visible = async (principal: Principal) => {
    const out: string[] = [];
    for (const [id, dataset] of options.knowledge.datasets()) {
      const shared =
        !dataset.tenants ||
        (principal.tenant !== undefined && dataset.tenants.includes(principal.tenant));
      if (shared && (await mayRead(principal, id))) out.push(id);
    }
    return out.sort();
  };

  const summary = async (id: string) => {
    const about = describe(id);
    const known = options.knowledge.datasets().get(id);
    const short = id.slice(id.lastIndexOf('/') + 1);
    return {
      id: short,
      ...(id.includes('/') ? { tenant: id.slice(0, id.lastIndexOf('/')) } : {}),
      name: about?.name ?? known?.name ?? short,
      description: about?.description ?? known?.description ?? null,
      'enabled?': true,
      status: (await options.status?.(id)) ?? 'configured',
    };
  };

  const notAuthorized = (c: Context) =>
    failure(
      c,
      403,
      'API key is not allowed to access the selected dataset',
      'dataset_not_authorized',
    );

  const knowledgeFailure = (c: Context, error: KnowledgeError, message: string, code: string) => {
    if (error.code === 'bad_request') return failure(c, 400, error.message, 'invalid_request');
    if (error.code === 'forbidden' || error.code === 'residency') return notAuthorized(c);
    return failure(c, 502, message, code);
  };

  /** Resolves `tenant` and `dataset-config-key` to a dataset the caller may read. */
  const openDataset = async (
    c: Context<Env>,
  ): Promise<{ ok: true; id: string; ctx: PortContext } | { ok: false; response: Response }> => {
    const principal = c.get('principal');
    const id = resolveDataset(c.req.query('tenant') ?? '', c.req.query('dataset-config-key') ?? '');
    if (!id || !(await visible(principal)).includes(id))
      return { ok: false, response: notAuthorized(c) };
    const ctx: PortContext = {
      tenant: principal.tenant ?? '',
      principal,
      task: newTaskId(),
      signal: c.req.raw.signal,
      meter: async () => undefined,
    };
    return { ok: true, id, ctx };
  };

  app.use('/api/datasets', authenticate);
  app.use('/api/datasets/*', authenticate);
  app.use('/api/facets', authenticate);
  app.use('/api/documents', authenticate);

  async function authenticate(c: Context<Env>, next: () => Promise<void>) {
    const principal = await options.auth.authenticate(c.req.raw);
    if (!principal) return unauthenticated(c);
    c.set('principal', principal);
    await next();
  }

  app.get('/api/datasets', async (c) => {
    try {
      const ids = await visible(c.get('principal'));
      return c.json({ datasets: await Promise.all(ids.map(summary)) }, 200);
    } catch {
      return failure(c, 500, 'Failed to list datasets', 'internal_error');
    }
  });

  app.get('/api/datasets/:id{.+}', async (c) => {
    try {
      const asked = c.req.param('id') ?? '';
      const ids = await visible(c.get('principal'));
      const id =
        options.knowledge.resolve(asked) ??
        ids.find((candidate) => candidate.slice(candidate.lastIndexOf('/') + 1) === asked);
      if (!id || !ids.includes(id))
        return failure(c, 404, 'Dataset not found', 'dataset_not_found');
      const principal = c.get('principal');
      const filters = (() => {
        try {
          const port = options.knowledge.open(
            { kind: 'dataset', id },
            {
              tenant: principal.tenant ?? '',
              principal,
              task: newTaskId(),
              signal: c.req.raw.signal,
              meter: async () => undefined,
            },
          );
          const valueTypes = options.knowledge.datasets().get(id)?.valueTypes ?? {};
          return Object.entries(port.info().filters).map(([field, kind]) => ({
            field,
            kinds: kindsOf(kind),
            'value-type': valueTypes[field] ?? 'string',
          }));
        } catch {
          return [];
        }
      })();
      return c.json({ dataset: { ...(await summary(id)), filters } }, 200);
    } catch {
      return failure(c, 500, 'Failed to get dataset', 'internal_error');
    }
  });

  app.get('/api/facets', async (c) => {
    const humanized = queryErrors(c, facetsQuery);
    if (humanized)
      return failure(c, 400, 'Request validation failed', 'invalid_request', {
        details: { in: ['request', 'query-params'], humanized },
      });
    const request = facetRequest(c.req.query('fields'), c.req.query('filter'));
    if (!request.ok) return failure(c, 400, request.error, 'invalid_request');

    const opened = await openDataset(c);
    if (!opened.ok) return opened.response;
    try {
      const port = options.knowledge.open({ kind: 'dataset', id: opened.id }, opened.ctx);
      const fields = await disjunctiveFacets(port, request.fields, request.specs);
      return c.json({ fields }, 200);
    } catch (error) {
      if (error instanceof KnowledgeError)
        return knowledgeFailure(
          c,
          error,
          'Facets are unavailable for this dataset.',
          'facets_unavailable',
        );
      return failure(c, 500, 'Failed to fetch facets', 'internal_error');
    }
  });

  app.get('/api/documents', async (c) => {
    const humanized = queryErrors(c, documentsQuery);
    if (humanized)
      return failure(c, 400, 'Request validation failed', 'invalid_request', {
        details: { in: ['request', 'query-params'], humanized },
      });
    const request = documentsRequest(
      c.req.query('filter'),
      c.req.query('limit'),
      c.req.query('offset'),
    );
    if (!request.ok) return failure(c, 400, request.error, 'invalid_request');

    const opened = await openDataset(c);
    if (!opened.ok) return opened.response;
    try {
      const port = options.knowledge.open({ kind: 'dataset', id: opened.id }, opened.ctx);
      if (!port.documents)
        return failure(
          c,
          501,
          'This dataset cannot list its documents.',
          'documents_not_supported',
        );
      const filters = toPortFilters(request.specs);
      const page = await port.documents({
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
        limit: request.limit,
        offset: request.offset,
      });
      const declared = Object.keys(port.info().filters);
      return c.json(
        {
          documents: page.documents.slice(0, request.limit).map((d) => ({
            id: d.id,
            ...(d.title === undefined ? {} : { title: d.title }),
            ...(d.url === undefined ? {} : { url: d.url }),
            fields: Object.fromEntries(
              declared.filter((f) => Object.hasOwn(d.fields, f)).map((f) => [f, d.fields[f]]),
            ),
          })),
          ...(page.found === undefined ? {} : { found: page.found }),
        },
        200,
      );
    } catch (error) {
      if (error instanceof KnowledgeError)
        return knowledgeFailure(
          c,
          error,
          'Documents are unavailable for this dataset.',
          'documents_unavailable',
        );
      return failure(c, 500, 'Failed to list documents', 'internal_error');
    }
  });

  return app;
};
