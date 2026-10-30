import { sourceLinkRules, type Principal } from '@genai/contracts';
import { testCase, testSet, type TestSet, type TestSetStore } from '@genai/eval';
import { guardrailSchemas, ruleKinds } from '@genai/guardrails';
import {
  filterValueTypes,
  type DatasetDraft,
  type FieldFilter,
  type IndexWriterRouter,
  type KnowledgeAdapter,
} from '@genai/port-knowledge';
import { residencies, type Residency } from '@genai/port-model';
import type { Context, Env, Hono, Schema } from 'hono';
import { z } from 'zod';
import { enterTenant, tenantAccess } from './access.js';
import type { Admin, AdminHandler, AdminOutcome } from './admin.js';
import {
  catalogKinds,
  type CatalogItem,
  type CatalogKind,
  type CatalogRegistry,
} from './catalog-registry.js';
import { platformScope } from './config-store.js';
import { keyReachesDataset } from './tenant-gate.js';
import {
  unboundedKudos,
  unboundedKudosMessage,
  type IngestionService,
  type IngestionTarget,
  type Pipeline,
} from './ingestion.js';
import type { EngineDescription } from './knowledge-engines.js';
import { rightRefused, seesUsage, type Right } from './rights.js';
import type { GateRegistry, GuardrailRuleRegistry, ScopedResult } from './scoped-registry.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { datasetStatus } from './dataset-status.js';
import { candidateRelease, tenantModelRefusal } from './model-access.js';
import { effectiveResidency, locationOf } from './residency.js';

export interface ConfigDeps {
  catalog: CatalogRegistry;
  gates: GateRegistry;
  rules: GuardrailRuleRegistry;
  ingestion: IngestionService;
  testSets: TestSetStore;
  engines: () => EngineDescription[];
  adapters: KnowledgeAdapter[];
  writers?: IndexWriterRouter;
  embeddingResidency?: (model: string) => Residency | undefined;
  documentCount?: (input: {
    dataset: string;
    tenant: string;
    principal: Principal;
  }) => Promise<number | undefined>;
}

export const ingestionTarget = (item: CatalogItem): IngestionTarget => ({
  dataset: item.id,
  endpoint: String(item.spec.endpoint),
  collections:
    (item.spec.options as { collections?: Record<string, string> } | undefined)?.collections ?? {},
});

type Problem = { path: string; message: string };

const actor = (p: Principal) => `${p.kind}:${p.issuer}:${p.subject}`;

const mayWrite = (principal: Principal, scope: string) =>
  principal.kind === 'operator' || (scope !== platformScope && principal.tenant === scope);

const refused = (target: string, message: string): AdminOutcome => ({
  ok: false,
  errors: [{ path: 'principal', message }],
  target,
});

const fromScoped = <T>(
  result: ScopedResult<T>,
  target: string,
  audit: Record<string, unknown>,
): AdminOutcome =>
  result.ok
    ? { ok: true, value: result.value, target: `${target}@${result.value.version}`, audit }
    : { ok: false, errors: result.errors, target };

const scopeOf = (input: Record<string, unknown>) => String(input.scope ?? platformScope);

const phraseModelErrors = (
  catalog: Pick<CatalogRegistry, 'get'>,
  spec: unknown,
  tenant: string,
) => {
  const phrases = (spec as { phrases?: Record<string, unknown> } | undefined)?.phrases;
  return (['model', 'fallbackModel'] as const).flatMap((field) => {
    const model = phrases?.[field];
    const message =
      typeof model === 'string' ? tenantModelRefusal(catalog, model, tenant) : undefined;
    return message ? [{ path: `spec.phrases.${field}`, message }] : [];
  });
};

const releaseKept = (
  kind: CatalogKind,
  scope: string,
  before: { spec: Record<string, unknown> } | undefined,
  input: Record<string, unknown>,
) => {
  const spec = input.spec;
  if (kind !== 'model' || scope !== platformScope || !spec || typeof spec !== 'object') return spec;
  const { release, ...rest } = spec as Record<string, unknown>;
  if (input.release === true) return rest;
  return before?.spec.release === candidateRelease || release === candidateRelease
    ? { ...rest, release: candidateRelease }
    : rest;
};
const ifVersionOf = (input: Record<string, unknown>) =>
  typeof input.ifVersion === 'number' ? { ifVersion: input.ifVersion } : {};

const nextSet = (
  current: TestSet | undefined,
  input: Record<string, unknown>,
  tenant: string,
): { ok: true; set: TestSet } | { ok: false; errors: Problem[] } => {
  const op = String(input.op);
  const body = (input.body ?? {}) as Record<string, unknown>;
  const id = String(input.id ?? '');
  if (op === 'create' && current)
    return { ok: false, errors: [{ path: 'id', message: `test set ${id} already exists` }] };
  if (op !== 'create' && !current)
    return { ok: false, errors: [{ path: 'id', message: `no test set ${id}` }] };
  const base = current?.spec.cases ?? [];
  let cases: unknown[] = base;
  if (op === 'create' || (op === 'update' && body.cases !== undefined))
    cases = (body.cases as unknown[]) ?? [];
  if (op === 'put-case') {
    const caseId = String(input.caseId);
    const parsed = testCase.safeParse({ ...(body as object), id: caseId });
    if (!parsed.success)
      return {
        ok: false,
        errors: parsed.error.issues.map((i) => ({
          path: ['case', ...i.path.map(String)].join('.'),
          message: i.message,
        })),
      };
    const at = base.findIndex((c) => c.id === caseId);
    cases = at < 0 ? [...base, parsed.data] : base.map((c, i) => (i === at ? parsed.data : c));
  }
  if (op === 'delete-case') {
    const caseId = String(input.caseId);
    if (!base.some((c) => c.id === caseId))
      return { ok: false, errors: [{ path: 'case', message: `no case ${caseId}` }] };
    cases = base.filter((c) => c.id !== caseId);
  }
  const spec = {
    ...(current?.spec ?? {}),
    ...(op === 'create' || op === 'update'
      ? Object.fromEntries(
          ['service', 'corpus', 'provenance']
            .filter((k) => body[k] !== undefined)
            .map((k) => [k, body[k]]),
        )
      : {}),
    cases,
  };
  const parsed = testSet.safeParse({
    apiVersion: 'genai/v1',
    kind: 'TestSet',
    metadata: {
      tenant,
      id,
      name:
        (op === 'create' || op === 'update' ? (body.name as string | undefined) : undefined) ??
        current?.metadata.name,
      version: (current?.metadata.version ?? 0) + 1,
    },
    spec,
  });
  return parsed.success
    ? { ok: true, set: parsed.data }
    : {
        ok: false,
        errors: parsed.error.issues.map((i) => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        })),
      };
};

export const configAdminHandlers = (deps: ConfigDeps): Record<string, AdminHandler> => ({
  'platform.catalog.publish': async (input, principal) => {
    const scope = scopeOf(input);
    const kind = String(input.kind) as CatalogKind;
    const target = `catalog:${kind}/${deps.catalog.qualify(scope, String(input.id))}`;
    if (!mayWrite(principal, scope))
      return refused(
        target,
        scope === platformScope
          ? 'only operators change the platform catalog'
          : 'only the tenant or an operator changes its catalog',
      );
    const before = deps.catalog.get(kind, deps.catalog.qualify(scope, String(input.id)));
    const result = await deps.catalog.publish({
      kind,
      scope,
      id: String(input.id),
      spec: releaseKept(kind, scope, before, input),
      by: actor(principal),
      reason: input.reason,
      ...ifVersionOf(input),
    });
    if (!result.ok) return { ok: false, errors: result.errors, target };
    return {
      ok: true,
      value: result.item,
      target: `${target}@${result.item.version}`,
      audit: {
        scope,
        kind,
        before: before?.spec ?? null,
        after: result.item.spec,
        ...(input.release === true ? { matrixRun: input.matrixRun ?? false } : {}),
      },
    };
  },
  'platform.catalog.delete': async (input, principal) => {
    const scope = scopeOf(input);
    const kind = String(input.kind) as CatalogKind;
    const target = `catalog:${kind}/${deps.catalog.qualify(scope, String(input.id))}`;
    if (!mayWrite(principal, scope))
      return refused(target, 'not allowed to remove this catalog entry');
    const result = await deps.catalog.remove({
      kind,
      scope,
      id: String(input.id),
      by: actor(principal),
      reason: input.reason,
      ...ifVersionOf(input),
    });
    if (!result.ok) return { ok: false, errors: result.errors, target };
    return { ok: true, value: { deleted: result.item.id }, target, audit: { scope, kind } };
  },
  'platform.gate.save': async (input, principal) => {
    const scope = scopeOf(input);
    const id = String(input.id);
    const target = `gate:${scope}/${id}`;
    if (!mayWrite(principal, scope)) return refused(target, 'not allowed to change this gate');
    const result = await deps.gates.save({
      scope,
      id,
      spec: { ...((input.spec ?? {}) as object), id },
      mandatory: input.mandatory === true,
      by: actor(principal),
      reason: input.reason,
      ...ifVersionOf(input),
    });
    return fromScoped(result, target, { scope, mandatory: input.mandatory === true });
  },
  'platform.gate.delete': async (input, principal) => {
    const scope = scopeOf(input);
    const target = `gate:${scope}/${String(input.id)}`;
    if (!mayWrite(principal, scope)) return refused(target, 'not allowed to remove this gate');
    return fromScoped(
      await deps.gates.remove({
        scope,
        id: String(input.id),
        by: actor(principal),
        reason: input.reason,
      }),
      target,
      { scope },
    );
  },
  'platform.guardrail-rule.save': async (input, principal) => {
    const scope = scopeOf(input);
    const id = String(input.id);
    const target = `guardrail-rule:${scope}/${id}`;
    if (!mayWrite(principal, scope)) return refused(target, 'not allowed to change this rule');
    const result = await deps.rules.save({
      scope,
      id,
      spec: input.spec,
      mandatory: input.mandatory === true,
      by: actor(principal),
      reason: input.reason,
      ...ifVersionOf(input),
    });
    return fromScoped(result, target, { scope, mandatory: input.mandatory === true });
  },
  'platform.guardrail-rule.delete': async (input, principal) => {
    const scope = scopeOf(input);
    const target = `guardrail-rule:${scope}/${String(input.id)}`;
    if (!mayWrite(principal, scope)) return refused(target, 'not allowed to remove this rule');
    return fromScoped(
      await deps.rules.remove({
        scope,
        id: String(input.id),
        by: actor(principal),
        reason: input.reason,
      }),
      target,
      { scope },
    );
  },
  'platform.pipeline.save': async (input, principal) => {
    const scope = scopeOf(input);
    const dataset = String(input.dataset);
    const target = `pipeline:${dataset}/${String(input.id)}`;
    if (!mayWrite(principal, scope)) return refused(target, 'not allowed to change this pipeline');
    const modelErrors =
      scope === platformScope ? [] : phraseModelErrors(deps.catalog, input.spec, scope);
    if (modelErrors.length) return { ok: false, errors: modelErrors, target };
    const result = await deps.ingestion.save({
      scope,
      dataset,
      id: String(input.id),
      spec: input.spec,
      by: actor(principal),
      reason: input.reason,
      ...ifVersionOf(input),
    });
    return result.ok
      ? {
          ok: true,
          value: {
            ...result.value,
            nextRunAt: await deps.ingestion.nextRunAt(scope, result.value),
          },
          target: `${target}@${result.value.version}`,
          audit: { scope },
        }
      : { ok: false, errors: result.errors, target };
  },
  'platform.pipeline.delete': async (input, principal) => {
    const scope = scopeOf(input);
    const dataset = String(input.dataset);
    const target = `pipeline:${dataset}/${String(input.id)}`;
    if (!mayWrite(principal, scope)) return refused(target, 'not allowed to remove this pipeline');
    const result = await deps.ingestion.remove({
      scope,
      dataset,
      id: String(input.id),
      by: actor(principal),
      reason: input.reason,
    });
    return result.ok
      ? { ok: true, value: { deleted: result.value.id }, target, audit: { scope } }
      : { ok: false, errors: result.errors, target };
  },
  'platform.pipeline.execute': async (input, principal) => {
    const scope = scopeOf(input);
    const dataset = String(input.dataset);
    const target = `pipeline:${dataset}/${String(input.id)}`;
    if (!mayWrite(principal, scope)) return refused(target, 'not allowed to run this pipeline');
    const pipeline = await deps.ingestion.get(scope, dataset, String(input.id));
    if (!pipeline)
      return {
        ok: false,
        errors: [{ path: 'id', message: `no pipeline ${String(input.id)}` }],
        target,
      };
    const item = deps.catalog.get('dataset', dataset);
    if (!item)
      return { ok: false, errors: [{ path: 'dataset', message: `no dataset ${dataset}` }], target };
    const started = await deps.ingestion.execute({
      pipeline,
      target: ingestionTarget(item),
      by: actor(principal),
      principal,
      ...(input.tenant ? { tenant: String(input.tenant) } : {}),
    });
    return started.ok
      ? { ok: true, value: started.value, target, audit: { scope, execution: started.value.id } }
      : {
          ok: false,
          errors: started.errors,
          target,
          ...(started.conflict ? { conflict: true as const } : {}),
        };
  },
  'platform.pipeline.cancel': async (input, principal) => {
    const scope = scopeOf(input);
    const dataset = String(input.dataset);
    const target = `pipeline:${dataset}/${String(input.id)}`;
    if (!mayWrite(principal, scope)) return refused(target, 'not allowed to run this pipeline');
    const cancelled = deps.ingestion.cancel({
      dataset,
      execution: String(input.execution),
      by: actor(principal),
    });
    return cancelled.ok
      ? {
          ok: true,
          value: cancelled.value,
          target,
          audit: { scope, execution: cancelled.value.id },
        }
      : { ok: false, errors: cancelled.errors, target, conflict: true as const };
  },
  'platform.testset.save': async (input, principal) => {
    const tenant = input.tenant;
    const id = String(input.id ?? '');
    const target = `test-set:${tenant}/${id}`;
    if (!mayWrite(principal, tenant))
      return refused(target, 'only the tenant or an operator changes its test sets');
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id))
      return { ok: false, errors: [{ path: 'id', message: 'not a valid id' }], target };
    const current = await deps.testSets.get(tenant, id);
    const next = nextSet(current, input, tenant);
    if (!next.ok) return { ok: false, errors: next.errors, target };
    await deps.testSets.put(next.set);
    return {
      ok: true,
      value: next.set,
      target: `${target}@${next.set.metadata.version}`,
      audit: {
        op: input.op,
        cases: next.set.spec.cases.length,
        ...(input.caseId ? { case: input.caseId } : {}),
      },
    };
  },
});

const indexBody = z.strictObject({
  endpoint: z.string().min(1),
  collections: z.record(z.string(), z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const datasetFields = z.strictObject({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).default([]),
  residency: z.enum(residencies),
  index: indexBody.optional(),
  collection: indexBody.optional(),
  endpoint: z.string().min(1).optional(),
  embedding: z
    .strictObject({
      model: z.string().min(1),
      dimensions: z.number().int().positive(),
      residency: z.enum(residencies).optional(),
    })
    .transform(({ model, dimensions }) => ({ model, dimensions }))
    .optional(),
  facets: z.array(z.string().min(1)).optional(),
  filters: z.record(z.string(), z.unknown()).default({}),
  valueTypes: z.record(z.string(), z.enum(filterValueTypes)).optional(),
  maxFacetValues: z.number().int().positive().max(1000).optional(),
  links: z.enum(sourceLinkRules).optional(),
});

const datasetBody = datasetFields.transform(({ collection, index, endpoint, ...rest }, ctx) => {
  const chosen = index ?? collection ?? (endpoint ? { endpoint } : undefined);
  if (!chosen) {
    ctx.addIssue({ code: 'custom', path: ['index'], message: 'an index is required' });
    return z.NEVER;
  }
  return { ...rest, index: chosen };
});
type DatasetBody = z.infer<typeof datasetBody>;

export const datasetView = (item: CatalogItem) => {
  const spec = item.spec;
  const { collections, maxFacetValues, ...options } = (spec.options ?? {}) as Record<
    string,
    unknown
  >;
  const filters = (spec.filters ?? {}) as Record<string, unknown>;
  const index = {
    endpoint: spec.endpoint,
    ...(collections ? { collections } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
  return {
    id: item.scope === platformScope ? item.id : item.id.slice(item.scope.length + 1),
    fullId: item.id,
    scope: item.scope,
    origin: item.origin,
    version: item.version,
    name: (spec.name as string | undefined) ?? item.id,
    ...(spec.description ? { description: spec.description } : {}),
    aliases: (spec.aliases as string[] | undefined) ?? [],
    residency: spec.residency,
    index,
    collection: index,
    ...(spec.embedding ? { embedding: spec.embedding } : {}),
    facets: (spec.facets as string[] | undefined) ?? Object.keys(filters),
    filters,
    ...(spec.valueTypes ? { valueTypes: spec.valueTypes } : {}),
    ...(maxFacetValues !== undefined ? { maxFacetValues } : {}),
    ...(spec.links ? { links: spec.links } : {}),
  };
};

const datasetSpec = (body: DatasetBody, adapter: KnowledgeAdapter | undefined) => {
  const filters = { ...body.filters };
  for (const facet of body.facets ?? []) if (!(facet in filters)) filters[facet] = 'multiselect';
  const options: Record<string, unknown> = {
    ...(body.index.options ?? {}),
    ...(body.index.collections ? { collections: body.index.collections } : {}),
    ...(body.maxFacetValues !== undefined ? { maxFacetValues: body.maxFacetValues } : {}),
  };
  const draft: DatasetDraft = {
    filters: filters as Record<string, FieldFilter>,
    options,
    ...(body.embedding ? { embedding: body.embedding } : {}),
  };
  Object.assign(options, adapter?.defaults?.(draft) ?? {});
  return {
    name: body.name,
    ...(body.description ? { description: body.description } : {}),
    aliases: body.aliases,
    endpoint: body.index.endpoint,
    residency: body.residency,
    filters,
    ...(body.valueTypes ? { valueTypes: body.valueTypes } : {}),
    ...(body.facets ? { facets: body.facets } : {}),
    ...(body.embedding ? { embedding: body.embedding } : {}),
    ...(body.links ? { links: body.links } : {}),
    options,
  };
};

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422,
  title: string,
  errors: unknown[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

export const registerConfigRoutes = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: ConfigDeps & {
    admin: Admin;
    authenticate(request: Request): Promise<Principal | undefined>;
    platformTenant: string;
  },
) => {
  const param = (c: Context, name: string) => c.req.param(name) ?? '';
  const who = (c: Context) => deps.authenticate(c.req.raw);
  const reasonOf = (c: Context) => changeReasonOf(c)?.trim() ?? '';
  const ifVersion = (c: Context) => {
    const raw = c.req.header('if-match')?.replace(/"/g, '');
    return raw && /^\d+$/.test(raw) ? { ifVersion: Number(raw) } : {};
  };
  const body = async (c: Context) =>
    (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const perform = async (
    c: Context,
    principal: Principal,
    action: string,
    scope: string,
    data: Record<string, unknown>,
  ) => {
    const reason = reasonOf(c);
    if (!isReasonLongEnough(reason))
      return problem(c, 400, 'Invalid request', [
        { path: 'change-reason', message: reasonTooShort },
      ]);
    const tenant = scope === platformScope ? deps.platformTenant : scope;
    const acting =
      principal.kind !== 'operator'
        ? principal
        : scope === platformScope
          ? { ...principal, tenant }
          : { ...principal, tenant, actor: principal };
    const result = await deps.admin.perform(acting, action, {
      ...data,
      scope,
      tenant,
      reason,
      ...ifVersion(c),
    });
    c.header('genai-task', result.task);
    if (result.ok) return c.json(result.value as object, 200);
    if (result.problem) return rightRefused(c, result.problem);
    if (result.errors.some((e) => e.path === 'principal'))
      return problem(c, 403, 'Forbidden', result.errors);
    if (result.conflict || result.errors.some((e) => e.path === 'if-match'))
      return problem(c, 409, 'Conflict', result.errors);
    return problem(c, 400, 'Invalid request', result.errors);
  };

  const operator = async (c: Context) => {
    const principal = await who(c);
    if (!principal) return { response: problem(c, 401, 'Unauthorized') };
    if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
    return { principal };
  };
  const access = tenantAccess(deps.admin);
  const member = async (c: Context, right?: Right) => {
    const principal = await who(c);
    if (!principal) return { response: problem(c, 401, 'Unauthorized') };
    const tenant = param(c, 'tenant');
    const entered = enterTenant(c, access, principal, tenant, right);
    if ('response' in entered) return { response: entered.response };
    return { principal: entered.principal, tenant };
  };
  const catalogRight = (c: Context): Right =>
    ['dataset', 'knowledge-endpoint'].includes(param(c, 'kind'))
      ? 'manage-datasets'
      : 'manage-services';
  const kindOf = (c: Context) => {
    const kind = param(c, 'kind');
    return (catalogKinds as readonly string[]).includes(kind) ? (kind as CatalogKind) : undefined;
  };

  app.get('/operator/catalog/entries', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    const kind = c.req.query('kind') as CatalogKind | undefined;
    const scope = c.req.query('scope');
    return c.json({
      data: deps.catalog.list({ ...(kind ? { kind } : {}), ...(scope ? { scope } : {}) }),
      kinds: catalogKinds,
      tenantKinds: deps.catalog.tenantKinds,
      skipped: deps.catalog.skipped(),
    });
  });
  app.get('/operator/catalog/:kind/:id', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    const kind = kindOf(c);
    const item = kind && deps.catalog.get(kind, param(c, 'id'));
    return item ? c.json(item) : problem(c, 404, 'Not found');
  });
  app.get('/operator/catalog/:kind/:id/versions', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    const kind = kindOf(c);
    if (!kind) return problem(c, 404, 'Not found');
    return c.json({ data: await deps.catalog.history(kind, param(c, 'id')) });
  });
  app.put('/operator/catalog/:kind/:id', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    const kind = kindOf(c);
    if (!kind) return problem(c, 404, 'Not found');
    return perform(c, guard.principal, 'platform.catalog.publish', platformScope, {
      kind,
      id: param(c, 'id'),
      spec: await body(c),
    });
  });
  app.delete('/operator/catalog/:kind/:id', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    const kind = kindOf(c);
    if (!kind) return problem(c, 404, 'Not found');
    return perform(c, guard.principal, 'platform.catalog.delete', platformScope, {
      kind,
      id: param(c, 'id'),
    });
  });

  app.get('/tenants/:tenant/catalog', async (c) => {
    const guard = await member(c);
    if (guard.response) return guard.response;
    const kind = c.req.query('kind');
    return c.json({
      data: deps.catalog.visibleTo(guard.tenant).filter((i) => !kind || i.kind === kind),
      tenantKinds: deps.catalog.tenantKinds,
    });
  });
  app.get('/tenants/:tenant/catalog/:kind/:id/versions', async (c) => {
    const guard = await member(c);
    if (guard.response) return guard.response;
    const kind = kindOf(c);
    if (!kind) return problem(c, 404, 'Not found');
    return c.json({
      data: await deps.catalog.history(kind, deps.catalog.qualify(guard.tenant, param(c, 'id'))),
    });
  });
  app.put('/tenants/:tenant/catalog/:kind/:id', async (c) => {
    const guard = await member(c, catalogRight(c));
    if (guard.response) return guard.response;
    const kind = kindOf(c);
    if (!kind) return problem(c, 404, 'Not found');
    return perform(c, guard.principal, 'platform.catalog.publish', guard.tenant, {
      kind,
      id: param(c, 'id'),
      spec: await body(c),
    });
  });
  app.delete('/tenants/:tenant/catalog/:kind/:id', async (c) => {
    const guard = await member(c, catalogRight(c));
    if (guard.response) return guard.response;
    const kind = kindOf(c);
    if (!kind) return problem(c, 404, 'Not found');
    return perform(c, guard.principal, 'platform.catalog.delete', guard.tenant, {
      kind,
      id: param(c, 'id'),
    });
  });

  const adapterOf = (scope: string, endpoint: string) => {
    const own = deps.catalog.get('knowledge-endpoint', deps.catalog.qualify(scope, endpoint));
    const found = own ?? deps.catalog.get('knowledge-endpoint', endpoint);
    return deps.adapters.find((a) => a.engine === found?.spec.engine);
  };
  const freeSlug = (scope: string, name: string) => {
    const base =
      name
        .toLowerCase()
        .replace(/æ/g, 'ae')
        .replace(/ø/g, 'o')
        .replace(/å/g, 'a')
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'datasett';
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if (!deps.catalog.get('dataset', deps.catalog.qualify(scope, candidate))) return candidate;
    }
  };
  const saveDataset = async (
    c: Context,
    principal: Principal,
    scope: string,
    id: string | undefined,
    create: boolean,
  ) => {
    const raw = await body(c);
    const existing = id ? deps.catalog.get('dataset', deps.catalog.qualify(scope, id)) : undefined;
    if (!create && (!existing || existing.scope !== scope)) return problem(c, 404, 'Not found');
    const datasetId =
      id ?? (raw.id === undefined ? freeSlug(scope, String(raw.name ?? '')) : String(raw.id));
    if (create && deps.catalog.get('dataset', deps.catalog.qualify(scope, datasetId)))
      return problem(c, 409, 'Conflict', [{ path: 'id', message: `dataset ${datasetId} exists` }]);
    const merged = existing
      ? (() => {
          const view = datasetView(existing);
          return {
            name: view.name,
            ...(view.description ? { description: view.description } : {}),
            aliases: view.aliases.map((a) =>
              scope !== platformScope && a.startsWith(`${scope}/`) ? a.slice(scope.length + 1) : a,
            ),
            residency: view.residency,
            index: {
              ...view.index,
              endpoint:
                scope !== platformScope && String(view.index.endpoint).startsWith(`${scope}/`)
                  ? String(view.index.endpoint).slice(scope.length + 1)
                  : view.index.endpoint,
              ...((raw.index ?? raw.collection ?? {}) as object),
            },
            ...(view.embedding ? { embedding: view.embedding } : {}),
            facets: view.facets,
            filters: view.filters,
            ...(view.maxFacetValues !== undefined ? { maxFacetValues: view.maxFacetValues } : {}),
            ...Object.fromEntries(
              Object.entries(raw).filter(
                ([k]) => !['collection', 'index', 'id', 'endpoint'].includes(k),
              ),
            ),
          };
        })()
      : raw;
    const parsed = datasetBody.safeParse(merged);
    if (!parsed.success)
      return problem(
        c,
        400,
        'Invalid request',
        parsed.error.issues.map((i) => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        })),
      );
    const response = await perform(c, principal, 'platform.catalog.publish', scope, {
      kind: 'dataset',
      id: datasetId,
      spec: datasetSpec(parsed.data, adapterOf(scope, parsed.data.index.endpoint)),
    });
    if (response.status !== 200) return response;
    const item = deps.catalog.get('dataset', deps.catalog.qualify(scope, datasetId));
    return c.json(item ? datasetView(item) : {}, create ? 201 : 200);
  };

  app.get('/operator/knowledge/engines', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    return c.json({ data: deps.engines() });
  });
  app.get('/tenants/:tenant/knowledge/engines', async (c) => {
    const guard = await member(c);
    if (guard.response) return guard.response;
    const own = deps.catalog.tenantKinds.includes('knowledge-endpoint');
    const reachable = new Set(
      deps.catalog
        .visibleTo(guard.tenant)
        .filter((i) => i.kind === 'knowledge-endpoint')
        .map((i) => String(i.spec.engine)),
    );
    return c.json({ data: deps.engines().filter((e) => own || reachable.has(e.engine)) });
  });

  app.get('/operator/datasets', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    return c.json({ data: deps.catalog.list({ kind: 'dataset' }).map(datasetView) });
  });
  app.post('/operator/datasets', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    return saveDataset(c, guard.principal, platformScope, undefined, true);
  });
  app.get('/operator/datasets/:id', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    const item = deps.catalog.get('dataset', param(c, 'id'));
    return item ? c.json(datasetView(item)) : problem(c, 404, 'Not found');
  });
  app.put('/operator/datasets/:id', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    return saveDataset(c, guard.principal, platformScope, param(c, 'id'), false);
  });

  const statusDeps = {
    ingestion: deps.ingestion,
    ...(deps.writers ? { writers: deps.writers } : {}),
    countable: (engine: string) => deps.engines().some((e) => e.engine === engine && e.builtin),
    engineOf: (item: CatalogItem) => {
      const endpoint = String(item.spec.endpoint);
      const found =
        deps.catalog.get('knowledge-endpoint', deps.catalog.qualify(item.scope, endpoint)) ??
        deps.catalog.get('knowledge-endpoint', endpoint);
      return typeof found?.spec.engine === 'string' ? found.spec.engine : undefined;
    },
  };
  const withStatus = async (
    item: CatalogItem,
    tenant: string,
    principal: Principal,
    detail: boolean,
  ) => {
    const { skipped, ...status } = await datasetStatus(
      {
        ...statusDeps,
        documentCount: (i) =>
          deps.documentCount?.({ dataset: i.id, tenant, principal }) ?? Promise.resolve(undefined),
      },
      item,
    );
    const location = locationOf(
      {
        catalog: deps.catalog,
        engines: deps.engines,
        embeddingResidency: deps.embeddingResidency ?? (() => undefined),
      },
      item,
    );
    return {
      ...datasetView(item),
      effectiveResidency: effectiveResidency(location),
      ...(location.embedding ? { embeddingResidency: location.embedding.residency ?? null } : {}),
      editable: item.scope === tenant,
      ...status,
      ...(detail ? { skipped } : {}),
    };
  };

  app.get('/tenants/:tenant/datasets', async (c) => {
    const guard = await member(c);
    if (guard.response) return guard.response;
    return c.json({
      data: await Promise.all(
        deps.catalog
          .visibleTo(guard.tenant)
          .filter((i) => i.kind === 'dataset')
          .map((i) => withStatus(i, guard.tenant, guard.principal, false)),
      ),
    });
  });
  app.post('/tenants/:tenant/datasets', async (c) => {
    const guard = await member(c, 'manage-datasets');
    if (guard.response) return guard.response;
    return saveDataset(c, guard.principal, guard.tenant, undefined, true);
  });
  app.get('/tenants/:tenant/datasets/:id', async (c) => {
    const guard = await member(c);
    if (guard.response) return guard.response;
    const id = param(c, 'id');
    const item = deps.catalog
      .visibleTo(guard.tenant)
      .find(
        (i) =>
          i.kind === 'dataset' && (i.id === id || i.id === deps.catalog.qualify(guard.tenant, id)),
      );
    return item
      ? c.json(await withStatus(item, guard.tenant, guard.principal, true))
      : problem(c, 404, 'Not found');
  });
  app.put('/tenants/:tenant/datasets/:id', async (c) => {
    const guard = await member(c, 'manage-datasets');
    if (guard.response) return guard.response;
    return saveDataset(c, guard.principal, guard.tenant, param(c, 'id'), false);
  });

  const withNextRun = async (scope: string, pipeline: Pipeline) => ({
    ...pipeline,
    nextRunAt: await deps.ingestion.nextRunAt(scope, pipeline),
  });

  const pipelineRoutes = (
    base: string,
    access: (
      c: Context,
      right?: Right,
    ) => Promise<{ response: Response } | { principal: Principal; scope: string }>,
  ) => {
    const itemFor = (c: Context, scope: string) => {
      const item = deps.catalog.get('dataset', deps.catalog.qualify(scope, param(c, 'dataset')));
      return item && item.scope === scope ? item : undefined;
    };
    const datasetFor = (c: Context, scope: string) => itemFor(c, scope)?.id;
    const keyRefused = (c: Context, principal: Principal, item: { id: string }) =>
      keyReachesDataset(principal, [item.id, param(c, 'dataset')])
        ? undefined
        : problem(c, 403, 'Forbidden');
    app.get(`${base}/datasets/:dataset/pipelines`, async (c) => {
      const guard = await access(c);
      if ('response' in guard) return guard.response;
      const item = itemFor(c, guard.scope);
      if (!item) return problem(c, 404, 'Not found');
      return c.json({
        data: await Promise.all(
          (await deps.ingestion.list(guard.scope, item.id)).map((p) => withNextRun(guard.scope, p)),
        ),
        backend: deps.ingestion.availability(ingestionTarget(item)),
      });
    });
    const save = async (c: Context, id: string | undefined) => {
      const guard = await access(c, 'manage-datasets');
      if ('response' in guard) return guard.response;
      const dataset = datasetFor(c, guard.scope);
      if (!dataset) return problem(c, 404, 'Not found');
      const raw = await body(c);
      const { id: bodyId, ...spec } = raw;
      if (unboundedKudos(spec))
        return problem(c, 422, unboundedKudosMessage, [
          { path: 'spec.source', message: unboundedKudosMessage },
        ]);
      const pipelineId = id ?? String(bodyId ?? '');
      if (!id && (await deps.ingestion.get(guard.scope, dataset, pipelineId)))
        return problem(c, 409, 'Conflict', [
          { path: 'id', message: `pipeline ${pipelineId} exists` },
        ]);
      if (id && !(await deps.ingestion.get(guard.scope, dataset, pipelineId)))
        return problem(c, 404, 'Not found');
      const response = await perform(c, guard.principal, 'platform.pipeline.save', guard.scope, {
        dataset,
        id: pipelineId,
        spec,
      });
      return !id && response.status === 200 ? c.json(await response.json(), 201) : response;
    };
    app.post(`${base}/datasets/:dataset/pipelines`, (c) => save(c, undefined));
    app.get(`${base}/datasets/:dataset/pipelines/:id`, async (c) => {
      const guard = await access(c);
      if ('response' in guard) return guard.response;
      const dataset = datasetFor(c, guard.scope);
      const found = dataset && (await deps.ingestion.get(guard.scope, dataset, param(c, 'id')));
      return found ? c.json(await withNextRun(guard.scope, found)) : problem(c, 404, 'Not found');
    });
    app.get(`${base}/datasets/:dataset/pipelines/:id/estimate`, async (c) => {
      const guard = await access(c, 'manage-datasets');
      if ('response' in guard) return guard.response;
      const dataset = datasetFor(c, guard.scope);
      const found = dataset && (await deps.ingestion.get(guard.scope, dataset, param(c, 'id')));
      if (!found) return problem(c, 404, 'Not found');
      const estimate = await deps.ingestion.estimate(found).catch(() => undefined);
      return estimate
        ? c.json({
            pipeline: found.id,
            source: found.spec.source.kind,
            estimate: true,
            ...estimate,
          })
        : problem(c, 409, 'Antallet dokumenter kan ikke anslås for denne kilden', [
            { path: 'source', message: found.spec.source.kind },
          ]);
    });
    app.get(`${base}/datasets/:dataset/pipelines/:id/versions`, async (c) => {
      const guard = await access(c);
      if ('response' in guard) return guard.response;
      const dataset = datasetFor(c, guard.scope);
      if (!dataset) return problem(c, 404, 'Not found');
      return c.json({ data: await deps.ingestion.versions(guard.scope, dataset, param(c, 'id')) });
    });
    app.put(`${base}/datasets/:dataset/pipelines/:id`, (c) => save(c, param(c, 'id')));
    app.delete(`${base}/datasets/:dataset/pipelines/:id`, async (c) => {
      const guard = await access(c, 'manage-datasets');
      if ('response' in guard) return guard.response;
      const dataset = datasetFor(c, guard.scope);
      if (!dataset || !(await deps.ingestion.get(guard.scope, dataset, param(c, 'id'))))
        return problem(c, 404, 'Not found');
      return perform(c, guard.principal, 'platform.pipeline.delete', guard.scope, {
        dataset,
        id: param(c, 'id'),
      });
    });
    app.post(`${base}/datasets/:dataset/pipelines/:id/execute`, async (c) => {
      const guard = await access(c, 'manage-datasets');
      if ('response' in guard) return guard.response;
      const item = itemFor(c, guard.scope);
      if (!item) return problem(c, 404, 'Not found');
      const refusedKey = keyRefused(c, guard.principal, item);
      if (refusedKey) return refusedKey;
      const dataset = item.id;
      const pipeline = await deps.ingestion.get(guard.scope, dataset, param(c, 'id'));
      if (!pipeline) return problem(c, 404, 'Not found');
      const status = deps.ingestion.availability(ingestionTarget(item), pipeline);
      if (!status.available)
        return problem(c, 409, 'Ingestion is not available', [
          { path: 'backend', message: status.reason ?? 'not available' },
        ]);
      const response = await perform(c, guard.principal, 'platform.pipeline.execute', guard.scope, {
        dataset,
        id: param(c, 'id'),
      });
      return response.status === 200 ? c.json(await response.json(), 202) : response;
    });
    app.post(`${base}/datasets/:dataset/pipelines/:id/executions/:execution/cancel`, async (c) => {
      const guard = await access(c, 'manage-datasets');
      if ('response' in guard) return guard.response;
      const item = itemFor(c, guard.scope);
      if (!item) return problem(c, 404, 'Not found');
      return perform(c, guard.principal, 'platform.pipeline.cancel', guard.scope, {
        dataset: item.id,
        id: param(c, 'id'),
        execution: param(c, 'execution'),
      });
    });
    app.get(`${base}/datasets/:dataset/pipelines/:id/executions`, async (c) => {
      const guard = await access(c);
      if ('response' in guard) return guard.response;
      const item = itemFor(c, guard.scope);
      if (!item) return problem(c, 404, 'Not found');
      const refusedKey = keyRefused(c, guard.principal, item);
      if (refusedKey) return refusedKey;
      const pipeline = await deps.ingestion.get(guard.scope, item.id, param(c, 'id'));
      const executions = await deps.ingestion.executions(item.id, param(c, 'id'));
      return c.json({
        data: seesUsage(guard.principal, guard.scope)
          ? executions
          : executions.map(({ report, ...rest }) => {
              if (!report) return rest;
              const shown = { ...report };
              delete shown.usage;
              return { ...rest, report: shown };
            }),
        backend: deps.ingestion.availability(ingestionTarget(item)),
        nextRunAt: pipeline ? await deps.ingestion.nextRunAt(guard.scope, pipeline) : null,
      });
    });
  };
  pipelineRoutes('/operator', async (c) => {
    const guard = await operator(c);
    return guard.response
      ? { response: guard.response }
      : { principal: guard.principal, scope: platformScope };
  });
  pipelineRoutes('/tenants/:tenant', async (c, right) => {
    const guard = await member(c, right);
    return guard.response
      ? { response: guard.response }
      : { principal: guard.principal, scope: guard.tenant };
  });

  const scopedRoutes = (
    path: string,
    registry: GateRegistry | GuardrailRuleRegistry,
    actions: { save: string; remove: string },
    extra: () => Record<string, unknown> = () => ({}),
  ) => {
    app.get(`/operator/${path}`, async (c) => {
      const guard = await operator(c);
      if (guard.response) return guard.response;
      return c.json({ data: await registry.list(), ...extra() });
    });
    app.put(`/operator/${path}/:id`, async (c) => {
      const guard = await operator(c);
      if (guard.response) return guard.response;
      const { mandatory, ...spec } = await body(c);
      return perform(c, guard.principal, actions.save, platformScope, {
        id: param(c, 'id'),
        spec,
        mandatory: mandatory === true,
      });
    });
    app.delete(`/operator/${path}/:id`, async (c) => {
      const guard = await operator(c);
      if (guard.response) return guard.response;
      return perform(c, guard.principal, actions.remove, platformScope, { id: param(c, 'id') });
    });
    app.get(`/operator/${path}/:id/versions`, async (c) => {
      const guard = await operator(c);
      if (guard.response) return guard.response;
      return c.json({ data: await registry.history(platformScope, param(c, 'id')) });
    });
    app.get(`/tenants/:tenant/${path}`, async (c) => {
      const guard = await member(c);
      if (guard.response) return guard.response;
      return c.json({
        data: (await registry.list(guard.tenant)).map((d) => ({
          ...d,
          editable: d.scope === guard.tenant,
        })),
        ...extra(),
      });
    });
    app.put(`/tenants/:tenant/${path}/:id`, async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { mandatory, ...spec } = await body(c);
      return perform(c, guard.principal, actions.save, guard.tenant, {
        id: param(c, 'id'),
        spec,
        mandatory: mandatory === true,
      });
    });
    app.delete(`/tenants/:tenant/${path}/:id`, async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      return perform(c, guard.principal, actions.remove, guard.tenant, { id: param(c, 'id') });
    });
    app.get(`/tenants/:tenant/${path}/:id/versions`, async (c) => {
      const guard = await member(c);
      if (guard.response) return guard.response;
      return c.json({ data: await registry.history(guard.tenant, param(c, 'id')) });
    });
  };
  scopedRoutes(
    'gates',
    deps.gates,
    { save: 'platform.gate.save', remove: 'platform.gate.delete' },
    () => ({
      kinds: ['threshold', 'no-regression'],
    }),
  );
  scopedRoutes(
    'guardrail-rules',
    deps.rules,
    { save: 'platform.guardrail-rule.save', remove: 'platform.guardrail-rule.delete' },
    () => ({
      kinds: ruleKinds,
      builtins: [...guardrailSchemas.keys()].filter((k) => k !== 'custom-rules'),
    }),
  );

  app.post('/tenants/:tenant/test-sets', async (c) => {
    const guard = await member(c, 'manage-services');
    if (guard.response) return guard.response;
    const raw = await body(c);
    const response = await perform(c, guard.principal, 'platform.testset.save', guard.tenant, {
      op: 'create',
      id: String(raw.id ?? ''),
      body: raw,
    });
    if (response.status !== 200) return response;
    const created = (await response.json()) as { metadata?: { id?: string } };
    return c.json({ id: created.metadata?.id, ...created }, 201);
  });
  app.get('/tenants/:tenant/test-sets/:id', async (c) => {
    const guard = await member(c);
    if (guard.response) return guard.response;
    const version = c.req.query('version');
    const found = await deps.testSets.get(
      guard.tenant,
      param(c, 'id'),
      version ? Number(version) : undefined,
    );
    return found ? c.json(found) : problem(c, 404, 'Not found');
  });
  app.put('/tenants/:tenant/test-sets/:id', async (c) => {
    const guard = await member(c, 'manage-services');
    if (guard.response) return guard.response;
    return perform(c, guard.principal, 'platform.testset.save', guard.tenant, {
      op: 'update',
      id: param(c, 'id'),
      body: await body(c),
    });
  });
  app.put('/tenants/:tenant/test-sets/:id/cases/:case', async (c) => {
    const guard = await member(c, 'manage-services');
    if (guard.response) return guard.response;
    return perform(c, guard.principal, 'platform.testset.save', guard.tenant, {
      op: 'put-case',
      id: param(c, 'id'),
      caseId: param(c, 'case'),
      body: await body(c),
    });
  });
  app.delete('/tenants/:tenant/test-sets/:id/cases/:case', async (c) => {
    const guard = await member(c, 'manage-services');
    if (guard.response) return guard.response;
    return perform(c, guard.principal, 'platform.testset.save', guard.tenant, {
      op: 'delete-case',
      id: param(c, 'id'),
      caseId: param(c, 'case'),
    });
  });
};
