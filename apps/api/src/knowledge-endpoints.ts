import type { Principal } from '@genai/contracts';
import { secretRefPattern, type SecretResolver, type TokenProviders } from '@genai/kernel';
import {
  probeKnowledgeEndpoint,
  type KnowledgeAdapter,
  type KnowledgeCapability,
  type KnowledgeErrorCode,
  type Residency,
} from '@genai/port-knowledge';
import type { Context } from 'hono';
import type { CatalogItem } from './catalog-registry.js';
import { platformScope } from './config-store.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import type { EmbedderSource } from './index-ingestion.js';
import { writeKeyEngines, type EngineDescription } from './knowledge-engines.js';
import type { ModuleDeps, PlatformModuleFactory } from './platform-modules.js';

export interface SearchModuleExtras {
  knowledgeAdapters?: KnowledgeAdapter[];
  secrets?: SecretResolver;
  tokenProviders?: TokenProviders;
  embedders?: EmbedderSource;
  ingestFolderRoot?: string;
  now?: () => Date;
}

export const searchExtras = (deps: ModuleDeps, extras: SearchModuleExtras): SearchModuleExtras => {
  const given = deps as ModuleDeps & SearchModuleExtras;
  return {
    ...(given.knowledgeAdapters ? { knowledgeAdapters: given.knowledgeAdapters } : {}),
    ...(given.secrets ? { secrets: given.secrets } : {}),
    ...(given.tokenProviders ? { tokenProviders: given.tokenProviders } : {}),
    ...(given.embedders ? { embedders: given.embedders } : {}),
    ...(given.ingestFolderRoot ? { ingestFolderRoot: given.ingestFolderRoot } : {}),
    ...extras,
  };
};

export const engineCapabilities = [
  'text_search',
  'vector_search',
  'hybrid',
  'filters',
  'facets',
  'full_document',
  'ordered_passages',
] as const;
export type EngineCapability = (typeof engineCapabilities)[number];

const fromPort: Record<EngineCapability, (found: Set<KnowledgeCapability>) => boolean> = {
  text_search: (found) => found.has('search.text'),
  vector_search: (found) => found.has('search.vector'),
  hybrid: (found) => found.has('search.hybrid'),
  filters: (found) => [...found].some((c) => c.startsWith('filter.')),
  facets: (found) => found.has('facets'),
  full_document: (found) => found.has('fetch'),
  ordered_passages: (found) => found.has('range'),
};

export interface CapabilitySummary {
  supported: EngineCapability[];
  missing: EngineCapability[];
}

export const summarizeCapabilities = (capabilities: readonly KnowledgeCapability[]) => {
  const found = new Set(capabilities);
  const supported = engineCapabilities.filter((c) => fromPort[c](found));
  return {
    supported,
    missing: engineCapabilities.filter((c) => !supported.includes(c)),
  } satisfies CapabilitySummary;
};

export type EndpointStatus = 'ok' | 'unused' | 'skipped';

export interface KnowledgeEndpointView {
  id: string;
  name: string;
  scope: string;
  engine: string;
  title: string;
  tech?: string;
  builtin: boolean;
  runsAt: string;
  dataLocation?: Residency;
  embeddingModel?: string;
  writeKeyRequired: boolean;
  capabilities: CapabilitySummary;
  datasetCount: number;
  status: EndpointStatus;
  shared: boolean;
  version: number;
}

export interface StoredSecretView {
  ref: string;
  name: string;
  updatedAt?: string;
}

const refsIn = (value: unknown, out: Set<string>): Set<string> => {
  if (typeof value === 'string') {
    if (secretRefPattern.test(value) && !value.startsWith('secret://tenant')) out.add(value);
  } else if (Array.isArray(value)) for (const v of value) refsIn(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) refsIn(v, out);
  return out;
};

export const platformSecrets = (deps: ModuleDeps, names: readonly string[] = []) => {
  const refs = new Set(names.map((n) => `secret://env/${n}`));
  for (const item of deps.catalog.list({ scope: platformScope })) refsIn(item.spec, refs);
  return [...refs]
    .filter((ref) => secretRefPattern.test(ref))
    .sort()
    .map((ref): StoredSecretView => ({ ref, name: ref.slice(ref.lastIndexOf('/') + 1) }));
};

export interface EndpointTestResult {
  ok: boolean;
  engine?: string;
  code?: KnowledgeErrorCode;
  message: string;
  ms: number;
}

export const runsAtOf = (spec: Record<string, unknown>, builtin: boolean) => {
  if (builtin) return 'platform';
  try {
    return new URL(String(spec.baseURL)).hostname;
  } catch {
    return 'unknown';
  }
};

export const engineOf = (deps: ModuleDeps, engine: unknown): EngineDescription | undefined =>
  deps.engines().find((e) => e.engine === engine);

export const datasetsOn = (deps: ModuleDeps, endpoint: string) =>
  deps.catalog.list({ kind: 'dataset' }).filter((d) => d.spec.endpoint === endpoint);

const embeddingModelOf = (datasets: CatalogItem[]) => {
  const models = new Set(
    datasets.flatMap((d) => {
      const model = (d.spec.embedding as { model?: string } | undefined)?.model;
      return model ? [model] : [];
    }),
  );
  return models.size === 1 ? [...models][0] : undefined;
};

export const endpointView = (
  deps: ModuleDeps,
  item: CatalogItem,
  datasets = datasetsOn(deps, item.id),
): KnowledgeEndpointView => {
  const description = engineOf(deps, item.spec.engine);
  const builtin = description?.builtin ?? false;
  const embeddingModel = embeddingModelOf(datasets);
  const skipped = deps.catalog.skipped().includes(`knowledge-endpoint ${item.id}`);
  return {
    id: item.id,
    name: typeof item.spec.name === 'string' ? item.spec.name : item.id,
    scope: item.scope,
    engine: String(item.spec.engine),
    title: description?.title ?? String(item.spec.engine),
    ...(description?.tech ? { tech: description.tech } : {}),
    builtin,
    runsAt: runsAtOf(item.spec, builtin),
    ...(description?.dataLocation ? { dataLocation: description.dataLocation } : {}),
    ...(embeddingModel ? { embeddingModel } : {}),
    writeKeyRequired:
      description?.writeKeyRequired ?? writeKeyEngines.has(String(item.spec.engine)),
    capabilities: summarizeCapabilities(description?.capabilities ?? []),
    datasetCount: datasets.length,
    status: skipped ? 'skipped' : datasets.length === 0 ? 'unused' : 'ok',
    shared: item.scope === platformScope && item.spec.sharing !== undefined,
    version: item.version,
  };
};

export const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

export const operatorOf = async (
  c: Context,
  authenticate: (request: Request) => Promise<Principal | undefined>,
): Promise<{ principal: Principal } | { response: Response }> => {
  const principal = await authenticate(c.req.raw);
  if (!principal) return { response: problem(c, 401, 'Unauthorized') };
  if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
  return { principal };
};

const withoutRegistryFields = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => !['sharing', 'name', 'id'].includes(k)));

export const testEndpoint = async (
  extras: SearchModuleExtras,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<EndpointTestResult> => {
  if (!extras.knowledgeAdapters || !extras.secrets)
    return {
      ok: false,
      code: 'unsupported',
      message: 'Tilkoblingstesten er ikke satt opp på denne plattformen.',
      ms: 0,
    };
  const result = await probeKnowledgeEndpoint(
    withoutRegistryFields(body),
    {
      adapters: extras.knowledgeAdapters,
      secrets: extras.secrets,
      ...(extras.tokenProviders ? { tokenProviders: extras.tokenProviders } : {}),
      timeoutMs: 10_000,
    },
    signal,
  );
  return result.ok
    ? { ok: true, engine: result.engine, message: 'Tilkoblingen virker.', ms: result.ms }
    : {
        ok: false,
        ...(result.engine ? { engine: result.engine } : {}),
        code: result.code,
        message: result.message,
        ms: result.ms,
      };
};

export interface KnowledgeEndpointsOptions extends SearchModuleExtras {
  secretNames?: string[];
}

export const createKnowledgeEndpointsModule =
  (extras: KnowledgeEndpointsOptions = {}): PlatformModuleFactory =>
  (deps) => ({
    id: 'knowledge-endpoints',
    mount: (app, mounted) => {
      const settings = searchExtras(deps, extras);
      app.get('/operator/knowledge/endpoints', async (c) => {
        const guard = await operatorOf(c, mounted.authenticate);
        if ('response' in guard) return guard.response;
        return c.json({
          data: deps.catalog
            .list({ kind: 'knowledge-endpoint' })
            .map((item) => endpointView(deps, item)),
        });
      });
      app.get('/operator/knowledge/secrets', async (c) => {
        const guard = await operatorOf(c, mounted.authenticate);
        if ('response' in guard) return guard.response;
        return c.json({ data: platformSecrets(deps, extras.secretNames) });
      });
      app.get('/tenants/:tenant/knowledge/endpoints', async (c) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return problem(c, 401, 'Unauthorized');
        const tenant = c.req.param('tenant') ?? '';
        if (!mounted.access(principal, tenant, c.req.raw)) return problem(c, 404, 'Not found');
        const visible = deps.catalog.visibleTo(tenant);
        const datasets = visible.filter((i) => i.kind === 'dataset');
        return c.json({
          data: visible
            .filter((i) => i.kind === 'knowledge-endpoint')
            .map((item) =>
              endpointView(
                deps,
                item,
                datasets.filter((d) => d.spec.endpoint === item.id),
              ),
            ),
          defaultEmbedding: deps.defaultEmbedding ?? null,
        });
      });
      app.delete('/operator/knowledge/endpoints/:id', async (c) => {
        const guard = await operatorOf(c, mounted.authenticate);
        if ('response' in guard) return guard.response;
        const id = c.req.param('id') ?? '';
        const endpoint = deps.catalog.get('knowledge-endpoint', id);
        if (!endpoint || endpoint.scope !== platformScope) return problem(c, 404, 'Not found');
        const reason = changeReasonOf(c)?.trim() ?? '';
        if (!isReasonLongEnough(reason))
          return problem(c, 400, 'Invalid request', [
            { path: 'change-reason', message: reasonTooShort },
          ]);
        const names = await mounted.admin.tenantNames();
        const datasets = deps.catalog
          .list({ kind: 'dataset' })
          .filter((d) => d.spec.endpoint === id)
          .map((d) => {
            const tenant = d.scope === platformScope ? deps.platformTenant : d.scope;
            return {
              dataset: d.id,
              name: typeof d.spec.name === 'string' ? d.spec.name : d.id,
              tenant,
              tenantName: names.get(tenant) ?? tenant,
            };
          });
        if (datasets.length > 0)
          return c.json(
            {
              type: 'about:blank',
              title: 'Søkemotoren brukes av datasett',
              status: 409,
              errors: datasets.map((d) => ({
                path: 'datasets',
                message: `${d.tenant}/${d.dataset} uses ${id}`,
              })),
              datasets,
            },
            409,
            { 'content-type': 'application/problem+json' },
          );
        const result = await mounted.admin.perform(
          { ...guard.principal, tenant: deps.platformTenant },
          'platform.catalog.delete',
          {
            scope: platformScope,
            tenant: deps.platformTenant,
            kind: 'knowledge-endpoint',
            id,
            reason,
          },
        );
        c.header('genai-task', result.task);
        if (!result.ok) return problem(c, 400, 'Invalid request', result.errors);
        return c.body(null, 204);
      });
      app.post('/operator/knowledge/endpoints/test', async (c) => {
        const guard = await operatorOf(c, mounted.authenticate);
        if ('response' in guard) return guard.response;
        const body = (await c.req.json().catch(() => undefined)) as unknown;
        if (!body || typeof body !== 'object' || Array.isArray(body))
          return problem(c, 400, 'Invalid request', [
            { path: 'body', message: 'send the endpoint as a JSON object' },
          ]);
        return c.json(
          await testEndpoint(settings, body as Record<string, unknown>, c.req.raw.signal),
        );
      });
    },
  });

export const knowledgeEndpointsModule: PlatformModuleFactory = createKnowledgeEndpointsModule();
