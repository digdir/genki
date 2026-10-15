import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { toJSONSchema } from 'zod';
import type { Principal, Task } from '@genai/contracts';
import { parameterRuleProblems, parameterRules } from '@genai/port-model';
import {
  exportTenant,
  importTenant,
  type DefinitionStore,
  type ServiceSettings,
  type SettingsRegistry,
} from '@genai/definitions';
import { refusedRight, type Access } from './access.js';
import { requireRight, rights, rightsOf } from './rights.js';
import {
  settingsConflictMessage,
  type Admin,
  type AdminResult,
  type AuditEntry as AuditRecord,
  type ModelAdmin,
} from './admin.js';
import {
  actorNameOf,
  type Authenticator,
  changeReason,
  changeReasonOf,
  isReasonLongEnough,
  problem,
  problemContent,
  problems,
  reasonTooShort,
} from './http.js';
import { originOf, serviceOrigin, type DraftOrigin } from './draft-runner.js';
import { toTimeline, type TaskReader } from './timeline.js';
import type { ActorNames } from './actor-names.js';

const draftOriginNames: Record<DraftOrigin, string> = {
  builder: 'Byggeren (utkast)',
  playground: 'Prøveområdet (utkast)',
  'skill-test': 'Test av ferdighet (utkast)',
  assistant: 'Byggeassistenten',
};

export interface PlatformApiOptions {
  store: DefinitionStore;
  settings: SettingsRegistry;
  auth: Authenticator;
  admin: Admin;
  access: Access;
  tasks: TaskReader;
  models?: ModelAdmin;
  tenantDirectory?: () => Promise<
    { orgNumber: string; name: string; status?: 'active' | 'onboarding' | 'paused' }[]
  >;
  organisationName?: (orgNumber: string) => string | undefined;
  tenantQuota?: (tenant: string) => Promise<{ usedPercent: number }>;
  lifecycle?: (tenant: string, service: string) => Promise<{ state: string }>;
  names?: ActorNames;
  now?: () => Date;
}

const tenantParam = z
  .string()
  .openapi({ param: { name: 'tenant', in: 'path' }, example: '991825827' });
const keyParam = z.string().openapi({ param: { name: 'key', in: 'path' }, example: 'search.topK' });
const dryRunQuery = z.object({
  dryRun: z
    .enum(['true', 'false'])
    .optional()
    .openapi({ param: { name: 'dryRun', in: 'query' } }),
});

const optionalSchema = (schema: unknown) => {
  try {
    return {
      schema: toJSONSchema(schema as Parameters<typeof toJSONSchema>[0]) as Record<string, unknown>,
    };
  } catch {
    return {};
  }
};

const conflict = {
  content: problemContent,
  description: 'Changed elsewhere since it was read; reload and try again',
};

const json = (schema: z.ZodType, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

const SettingInfo = z
  .object({
    key: z.string(),
    description: z.string(),
    category: z.string(),
    axis: z.enum(['service', 'dataset']),
    sensitivity: z.enum(['normal', 'secret']),
    default: z.unknown(),
    settableAt: z.array(z.string()),
    schema: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('SettingInfo');

const TenantSettingsShape = z.object({
  values: z.record(z.string(), z.unknown()),
  pins: z.record(z.string(), z.number()),
});

const SettingOverrides = z
  .object({
    tenants: z.record(z.string(), TenantSettingsShape),
    services: z.array(
      z.object({
        tenant: z.string(),
        service: z.string(),
        version: z.number(),
        settings: z.record(z.string(), z.unknown()),
      }),
    ),
  })
  .openapi('SettingOverrides');

const DefaultVersion = z
  .object({
    key: z.string(),
    version: z.number().int(),
    value: z.unknown(),
    changedAt: z.string().optional(),
    changedBy: z.string().optional(),
    reason: z.string().optional(),
  })
  .openapi('DefaultVersion');

const TenantSettings = TenantSettingsShape.openapi('TenantSettings');

const Effective = z
  .record(
    z.string(),
    z.object({
      key: z.string(),
      value: z.unknown(),
      source: z.string(),
      pinnedVersion: z.number().optional(),
      defaultVersion: z.number(),
      overridden: z.array(z.object({ layer: z.string(), value: z.unknown() })),
      rejected: z.array(z.object({ layer: z.string(), reason: z.string() })),
      locked: z.string().optional(),
    }),
  )
  .openapi('EffectiveSettings');

const Impact = z
  .object({
    tenant: z.string(),
    service: z.string(),
    version: z.number(),
    status: z.enum(['changes', 'pinned', 'overridden', 'unchanged']),
    before: z.unknown(),
    after: z.unknown(),
  })
  .openapi('ServiceImpact');

const Preview = z
  .object({ dryRun: z.literal(true), services: z.array(Impact) })
  .catchall(z.unknown())
  .openapi('Preview');

const Applied = z.object({ task: z.string(), value: z.unknown() }).openapi('AppliedChange');

const Session = z
  .object({
    id: z.string(),
    operator: z.string(),
    operatorName: z.string().optional(),
    tenant: z.string(),
    reason: z.string(),
    openedAt: z.string(),
    expiresAt: z.string(),
  })
  .openapi('SupportSession');

const AuditEntry = z
  .object({
    task: z.string(),
    tenant: z.string(),
    action: z.string(),
    actor: z.string(),
    actorName: z.string().optional(),
    onBehalfOf: z.string().optional(),
    at: z.string(),
    outcome: z.enum(['applied', 'rejected']),
    target: z.string(),
    reason: z.string(),
  })
  .openapi('AuditEntry');

const ImportPlan = z
  .object({
    dryRun: z.boolean(),
    task: z.string().optional(),
    plan: z.array(z.object({ target: z.string(), action: z.string(), conflict: z.boolean() })),
  })
  .openapi('ImportPlan');

const valueBody = {
  required: true,
  content: { 'application/json': { schema: z.object({ value: z.unknown() }) } },
};

const Block = z.object({
  kind: z.enum(['quote', 'kv', 'list', 'tags', 'answer', 'note', 'error', 'reasoning']),
  label: z.string().optional(),
  text: z.string().optional(),
  rows: z.array(z.tuple([z.string(), z.string()])).optional(),
  items: z.union([z.array(z.string()), z.array(z.tuple([z.string(), z.string()]))]).optional(),
  sources: z.array(z.string()).optional(),
  calls: z.literal(true).optional(),
  usage: z.literal(true).optional(),
});

const RunStats = z
  .object({
    iterations: z.number().int(),
    toolCalls: z.number().int(),
    chunksRead: z.number().int(),
    documents: z.number().int(),
    warnings: z.array(z.string()),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    cachedInputTokens: z.number().int().optional(),
    byModel: z.array(
      z.object({
        model: z.string(),
        inputTokens: z.number().int(),
        outputTokens: z.number().int(),
        calls: z.number().int(),
      }),
    ),
  })
  .openapi('RunStats');

const Timeline = z
  .object({
    id: z.string(),
    service: z.string(),
    serviceName: z.string().optional(),
    status: z.enum(['running', 'interrupted', 'completed', 'failed', 'cancelled']),
    trigger: z.string(),
    caller: z.string(),
    startedAt: z.string(),
    durationSeconds: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costOre: z.number(),
    steps: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        title: z.string(),
        summary: z.string(),
        at: z.number(),
        durationSeconds: z.number().optional(),
        blocks: z.array(Block),
        state: z.enum(['running', 'failed', 'skipped', 'partial', 'waiting']).optional(),
        depth: z.number().int().optional(),
        tokens: z.number().int().optional(),
        model: z.string().optional(),
        iteration: z.number().int().optional(),
        warning: z.literal(true).optional(),
        raw: z.unknown().optional(),
      }),
    ),
    stats: RunStats,
  })
  .openapi('TaskTimeline');

const OperatorTenant = z
  .object({
    orgNumber: z.string(),
    name: z.string(),
    status: z.enum(['active', 'onboarding', 'paused']),
    services: z.number().int(),
    quotaUsedPercent: z.number(),
  })
  .openapi('OperatorTenant');

const MyOrganisation = z
  .object({
    orgNumber: z.string(),
    name: z.string(),
    rights: z.array(z.enum(rights as [string, ...string[]])),
  })
  .openapi('MyOrganisation');

const routes = {
  me: createRoute({
    method: 'get',
    path: '/me',
    summary:
      'The organisations the signed-in person may act for, with names and rights, for logins whose token lists none',
    responses: {
      200: json(z.object({ organisations: z.array(MyOrganisation) }), 'Organisations'),
      401: problems[401],
    },
  }),
  timeline: createRoute({
    method: 'get',
    path: '/tenants/{tenant}/tasks/{task}/timeline',
    summary: 'A task as a timeline: status, numbers and steps, from what the client may see',
    request: {
      params: z.object({
        tenant: tenantParam,
        task: z.string().openapi({ param: { name: 'task', in: 'path' } }),
      }),
    },
    responses: {
      200: json(Timeline, 'Timeline'),
      401: problems[401],
      403: problems[403],
      404: problems[404],
    },
  }),
  settingOverrides: createRoute({
    method: 'get',
    path: '/operator/settings/overrides',
    summary:
      'Every tenant value, pin and service value set on top of the platform defaults (operators)',
    responses: {
      200: json(SettingOverrides, 'Overrides'),
      401: problems[401],
      403: problems[403],
    },
  }),
  operatorTenants: createRoute({
    method: 'get',
    path: '/operator/tenants',
    summary: 'Every tenant on the platform (operators)',
    responses: {
      200: json(z.object({ data: z.array(OperatorTenant) }), 'Tenants'),
      401: problems[401],
      403: problems[403],
    },
  }),
  settings: createRoute({
    method: 'get',
    path: '/settings',
    summary: 'List the settings the platform defines',
    responses: {
      200: json(z.object({ data: z.array(SettingInfo) }), 'Setting definitions'),
      401: problems[401],
    },
  }),
  defaults: createRoute({
    method: 'get',
    path: '/settings/defaults',
    summary: 'Current platform default for every setting, with its version',
    responses: {
      200: json(z.object({ data: z.array(DefaultVersion) }), 'Defaults'),
      401: problems[401],
    },
  }),
  changelog: createRoute({
    method: 'get',
    path: '/settings/defaults/{key}/changelog',
    summary: 'Every change to a platform default',
    request: { params: z.object({ key: keyParam }) },
    responses: {
      200: json(z.object({ data: z.array(DefaultVersion) }), 'Changes'),
      401: problems[401],
      404: problems[404],
    },
  }),
  setDefault: createRoute({
    method: 'put',
    path: '/settings/defaults/{key}',
    summary:
      'Change a platform default (operators); dryRun shows which services change and which are pinned',
    request: {
      params: z.object({ key: keyParam }),
      query: dryRunQuery,
      headers: changeReason,
      body: valueBody,
    },
    responses: {
      200: json(z.union([Applied, Preview]), 'Applied or previewed'),
      400: problems[400],
      401: problems[401],
      403: problems[403],
      422: problems[422],
    },
  }),
  tenantSettings: createRoute({
    method: 'get',
    path: '/tenants/{tenant}/settings',
    summary: "A tenant's own values and pins",
    request: { params: z.object({ tenant: tenantParam }) },
    responses: {
      200: json(TenantSettings, 'Tenant settings'),
      401: problems[401],
      403: problems[403],
      404: problems[404],
    },
  }),
  effective: createRoute({
    method: 'get',
    path: '/tenants/{tenant}/settings/effective',
    summary: 'Effective settings with provenance: winning layer, what it overrode, pinned version',
    request: {
      params: z.object({ tenant: tenantParam }),
      query: z.object({
        service: z
          .string()
          .optional()
          .openapi({ param: { name: 'service', in: 'query' } }),
      }),
    },
    responses: {
      200: json(Effective, 'Effective settings'),
      401: problems[401],
      403: problems[403],
      404: problems[404],
    },
  }),
  setTenant: createRoute({
    method: 'put',
    path: '/tenants/{tenant}/settings/{key}',
    summary: 'Set a tenant value; dryRun shows before, after and affected services',
    request: {
      params: z.object({ tenant: tenantParam, key: keyParam }),
      query: dryRunQuery,
      headers: changeReason,
      body: valueBody,
    },
    responses: {
      200: json(z.union([Applied, Preview]), 'Applied or previewed'),
      400: problems[400],
      401: problems[401],
      403: problems[403],
      409: conflict,
      422: problems[422],
      404: problems[404],
    },
  }),
  unsetTenant: createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/settings/{key}',
    summary: 'Remove a tenant value so the platform default applies',
    request: { params: z.object({ tenant: tenantParam, key: keyParam }), headers: changeReason },
    responses: {
      200: json(Applied, 'Removed'),
      401: problems[401],
      403: problems[403],
      409: conflict,
      422: problems[422],
      404: problems[404],
    },
  }),
  pin: createRoute({
    method: 'put',
    path: '/tenants/{tenant}/pins/{key}',
    summary: 'Pin a platform default to a version, or unpin with null',
    request: {
      params: z.object({ tenant: tenantParam, key: keyParam }),
      headers: changeReason,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({ version: z.number().int().positive().nullable() }),
          },
        },
      },
    },
    responses: {
      200: json(Applied, 'Pinned'),
      400: problems[400],
      401: problems[401],
      403: problems[403],
      409: conflict,
      422: problems[422],
      404: problems[404],
    },
  }),
  exportTenant: createRoute({
    method: 'get',
    path: '/tenants/{tenant}/export',
    summary: "Export a tenant's definitions, prompt files and settings; secrets stay references",
    request: { params: z.object({ tenant: tenantParam }) },
    responses: {
      200: json(z.record(z.string(), z.unknown()), 'Bundle'),
      401: problems[401],
      403: problems[403],
      404: problems[404],
    },
  }),
  importTenant: createRoute({
    method: 'post',
    path: '/tenants/{tenant}/import',
    summary: 'Import a bundle into a tenant, with dry run and a conflict choice',
    request: {
      params: z.object({ tenant: tenantParam }),
      query: dryRunQuery.extend({
        onConflict: z
          .enum(['skip', 'overwrite'])
          .default('skip')
          .openapi({ param: { name: 'onConflict', in: 'query' } }),
      }),
      headers: changeReason,
      body: {
        required: true,
        content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
      },
    },
    responses: {
      200: json(ImportPlan, 'Plan'),
      400: problems[400],
      401: problems[401],
      403: problems[403],
      409: conflict,
      422: problems[422],
      404: problems[404],
    },
  }),
  openSession: createRoute({
    method: 'post',
    path: '/support-sessions',
    summary:
      "Open a time-limited support session in a tenant (operators); it is logged in the tenant's audit",
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              tenant: z.string().regex(/^\d{9}$/),
              reason: z.string().refine(isReasonLongEnough, reasonTooShort),
              minutes: z.number().int().positive().default(60),
            }),
          },
        },
      },
    },
    responses: {
      201: json(Session, 'Opened'),
      400: problems[400],
      401: problems[401],
      403: problems[403],
      422: problems[422],
    },
  }),
  audit: createRoute({
    method: 'get',
    path: '/tenants/{tenant}/audit',
    summary: 'Administrative changes in a tenant, each backed by a platform task',
    request: { params: z.object({ tenant: tenantParam }) },
    responses: {
      200: json(z.object({ data: z.array(AuditEntry) }), 'Audit log'),
      401: problems[401],
      403: problems[403],
      404: problems[404],
    },
  }),
  auditTask: createRoute({
    method: 'get',
    path: '/tenants/{tenant}/audit/{task}',
    summary: 'One administrative task with its audit events',
    request: {
      params: z.object({
        tenant: tenantParam,
        task: z.string().openapi({ param: { name: 'task', in: 'path' } }),
      }),
    },
    responses: {
      200: json(
        z.object({
          task: z.record(z.string(), z.unknown()),
          events: z.array(z.record(z.string(), z.unknown())),
        }),
        'Task',
      ),
      401: problems[401],
      403: problems[403],
      404: problems[404],
    },
  }),
};

const OperatorModel = z
  .looseObject({
    id: z.string(),
    endpoint: z.string().optional(),
    deployment: z.string().optional(),
    family: z.string().optional(),
    residency: z.string(),
    capabilities: z.array(z.string()),
    enabled: z.boolean(),
    origin: z.string().optional(),
    classified: z.boolean().optional(),
    parameters: parameterRules.optional(),
    rejectedParameters: z.record(z.string(), z.string()).optional(),
  })
  .openapi('OperatorModel');

const ModelClassificationBody = z
  .strictObject({
    residency: z.enum(['norway', 'eu', 'global']).optional(),
    capabilities: z.array(z.enum(['stream', 'tools', 'json-schema', 'reasoning'])).optional(),
    enabled: z.boolean().optional(),
    parameters: parameterRules.optional(),
  })
  .openapi('ModelClassification');

const RefreshResult = z
  .object({
    discovered: z.number(),
    failed: z.array(z.object({ endpoint: z.string(), error: z.string() })),
  })
  .openapi('ModelRefreshResult');

const modelRoutes = {
  list: createRoute({
    method: 'get',
    path: '/operator/models',
    summary: 'Every model on the platform, discovered or from the catalog (operators)',
    responses: {
      200: json(z.object({ data: z.array(OperatorModel) }), 'Models'),
      401: problems[401],
      403: problems[403],
    },
  }),
  refresh: createRoute({
    method: 'post',
    path: '/operator/models/refresh',
    summary: 'Discover models from every endpoint again (operators, audited)',
    request: { headers: changeReason },
    responses: {
      200: json(RefreshResult, 'What was found'),
      400: problems[400],
      401: problems[401],
      403: problems[403],
    },
  }),
};

const modelFailureStatus = (errors: { path: string }[]) =>
  errors.some((e) => e.path === 'principal')
    ? 403
    : errors.some((e) => e.path === 'id')
      ? 404
      : 422;

const registerModelRoutes = (app: OpenAPIHono, options: PlatformApiOptions, models: ModelAdmin) => {
  const { auth, admin } = options;

  app.openapi(modelRoutes.list, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    if (principal.kind !== 'operator') return problem(c, 403, 'Only operators manage models');
    return c.json({ data: models.describe() }, 200);
  });

  app.openapi(modelRoutes.refresh, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const result = await admin.refreshModels(principal, changeReasonOf(c) ?? '');
    c.header('genai-task', result.task);
    if (!result.ok)
      return problem(c, 403, 'Only operators manage models', { errors: result.errors });
    return c.json(result.value, 200);
  });

  app.openAPIRegistry.registerPath({
    method: 'patch',
    path: '/operator/models/{id}',
    summary:
      'Classify a model: residency, capabilities, on or off (operators, audited). The id may contain slashes.',
    request: {
      params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }),
      headers: changeReason,
      body: { content: { 'application/json': { schema: ModelClassificationBody } } },
    },
    responses: {
      200: json(OperatorModel, 'The model after the change'),
      400: problems[400],
      401: problems[401],
      403: problems[403],
      404: problems[404],
    },
  });

  app.patch('/operator/models/:id{.+}', async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const reason = changeReason.safeParse({ 'change-reason': changeReasonOf(c) ?? '' });
    if (!reason.success)
      return problem(c, 400, 'Invalid request', {
        errors: [{ path: 'change-reason', message: reasonTooShort }],
      });
    const body = ModelClassificationBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success)
      return problem(c, 400, 'Invalid request', {
        errors: body.error.issues.map((i) => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        })),
      });
    const invalid = parameterRuleProblems(body.data.parameters ?? {});
    if (invalid.length > 0)
      return problem(c, 400, 'Invalid request', {
        errors: invalid.map((message) => ({ path: 'parameters', message })),
      });
    const id = c.req.param('id');
    const result = await admin.classifyModel(
      principal,
      id,
      body.data as Parameters<ModelAdmin['classify']>[1],
      reason.data['change-reason'],
    );
    c.header('genai-task', result.task);
    if (!result.ok) {
      const status = modelFailureStatus(result.errors);
      return problem(
        c,
        status,
        status === 403 ? 'Only operators manage models' : `No model ${id}`,
        {
          errors: result.errors,
        },
      );
    }
    return c.json(result.value, 200);
  });
};

const startedBy = (task: Task, principal: Principal) =>
  task.principal.id === JSON.stringify([principal.issuer, principal.subject]);

export const visibleToTenant = (entry: AuditRecord, tenant: string) =>
  !entry.actor.startsWith('operator:') ||
  entry.onBehalfOf === tenant ||
  new RegExp(`(^|[:/])${tenant}([/:@]|$)`).test(entry.target);

export const registerPlatformRoutes = (app: OpenAPIHono, options: PlatformApiOptions) => {
  const { store, settings, auth, admin, access } = options;
  if (options.models) registerModelRoutes(app, options, options.models);

  const services = async (): Promise<ServiceSettings[]> => {
    const seen = new Map<string, ServiceSettings>();
    for (const c of await store.capabilities()) {
      const key = `${c.service.tenant}/${c.service.id}`;
      if (seen.has(key)) continue;
      const config = c.capability.config as { settings?: Record<string, unknown> };
      seen.set(key, { ...c.service, service: c.service.id, settings: config.settings ?? {} });
    }
    return [...seen.values()];
  };

  const now = options.now ?? (() => new Date());

  const serviceNameOf = async (capability: string) => {
    const origin = originOf(capability);
    if (origin !== serviceOrigin) return draftOriginNames[origin];
    return (await store.capabilities()).find((c) => c.capability.descriptor.id === capability)
      ?.capability.descriptor.title;
  };

  app.openapi(routes.timeline, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant, task } = c.req.valid('param');
    const acting = access(principal, tenant, c.req.raw);
    if (!acting) return problem(c, 404, 'Not found');
    const found = await options.tasks.task(task);
    if (!found || found.tenant !== tenant) return problem(c, 404, 'Not found');
    const lacking =
      !startedBy(found, principal) && refusedRight(c, acting, tenant, 'manage-services');
    if (lacking) return lacking;
    return c.json(
      toTimeline(
        found,
        await options.tasks.events(task),
        now(),
        await serviceNameOf(found.service.capability.id),
        { details: requireRight(acting, tenant, 'manage-services').ok },
      ),
      200,
    );
  });

  app.openapi(routes.settingOverrides, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    if (principal.kind !== 'operator') return problem(c, 403, 'Only operators see every tenant');
    const all = await services();
    const directory = (await options.tenantDirectory?.()) ?? [];
    const orgs = [...new Set([...directory.map((d) => d.orgNumber), ...all.map((s) => s.tenant)])];
    return c.json(
      {
        tenants: Object.fromEntries(orgs.sort().map((org) => [org, settings.tenant(org)])),
        services: all.filter((s) => Object.keys(s.settings).length > 0),
      },
      200,
    );
  });

  app.openapi(routes.me, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const orgs = [
      ...new Set([
        ...(principal.authorizedFor ?? []).map((a) => a.org),
        ...(principal.tenant ? [principal.tenant] : []),
      ]),
    ];
    const directory = orgs.length > 0 ? ((await options.tenantDirectory?.()) ?? []) : [];
    return c.json(
      {
        organisations: orgs.map((orgNumber) => ({
          orgNumber,
          name:
            directory.find((d) => d.orgNumber === orgNumber)?.name ??
            options.organisationName?.(orgNumber) ??
            orgNumber,
          rights: [...rightsOf(principal, orgNumber)],
        })),
      },
      200,
    );
  });

  app.openapi(routes.operatorTenants, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    if (principal.kind !== 'operator') return problem(c, 403, 'Only operators list tenants');
    const counts = new Map<string, number>();
    for (const s of await services()) {
      const archived = (await options.lifecycle?.(s.tenant, s.service))?.state === 'archived';
      counts.set(s.tenant, (counts.get(s.tenant) ?? 0) + (archived ? 0 : 1));
    }
    const directory = (await options.tenantDirectory?.()) ?? [];
    const orgs = [...new Set([...directory.map((d) => d.orgNumber), ...counts.keys()])].sort();
    const used = await Promise.all(
      orgs.map(async (org) => (await options.tenantQuota?.(org))?.usedPercent ?? 0),
    );
    return c.json(
      {
        data: orgs.map((orgNumber, i) => {
          const entry = directory.find((d) => d.orgNumber === orgNumber);
          const count = counts.get(orgNumber) ?? 0;
          return {
            orgNumber,
            name: entry?.name ?? options.organisationName?.(orgNumber) ?? orgNumber,
            status: entry?.status ?? (count > 0 ? ('active' as const) : ('onboarding' as const)),
            services: count,
            quotaUsedPercent: used[i] ?? 0,
          };
        }),
      },
      200,
    );
  });

  const conflicted = (c: Context) =>
    c.json(
      {
        type: 'about:blank',
        title: 'Changed elsewhere',
        status: 409,
        detail: settingsConflictMessage,
      },
      409,
      { 'content-type': 'application/problem+json' },
    );

  const applied = <T>(result: AdminResult<T> & { ok: true }) => ({
    task: result.task,
    value: result.value as unknown,
  });

  app.openapi(routes.settings, async (c) => {
    if (!(await auth.authenticate(c.req.raw))) return problem(c, 401, 'Not authenticated');
    return c.json(
      {
        data: settings.definitions().map((d) => ({
          key: d.key,
          description: d.description,
          category: d.category,
          axis: d.axis,
          sensitivity: d.sensitivity,
          default: d.default,
          settableAt: d.settableAt,
          ...optionalSchema(d.schema),
        })),
      },
      200,
    );
  });

  app.openapi(routes.defaults, async (c) => {
    if (!(await auth.authenticate(c.req.raw))) return problem(c, 401, 'Not authenticated');
    return c.json(
      { data: settings.definitions().flatMap((d) => settings.defaultOf(d.key) ?? []) },
      200,
    );
  });

  app.openapi(routes.changelog, async (c) => {
    if (!(await auth.authenticate(c.req.raw))) return problem(c, 401, 'Not authenticated');
    const { key } = c.req.valid('param');
    if (!settings.defaultOf(key)) return problem(c, 404, 'Not found');
    return c.json({ data: settings.changelog(key) }, 200);
  });

  app.openapi(routes.setDefault, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    if (principal.kind !== 'operator')
      return problem(c, 403, 'Only operators change platform defaults');
    const { key } = c.req.valid('param');
    const { value } = c.req.valid('json');
    if (c.req.valid('query').dryRun === 'true') {
      const preview = settings.previewDefault(key, value, await services());
      if (!preview.ok) return problem(c, 422, 'Invalid setting', { errors: preview.errors });
      return c.json({ dryRun: true as const, services: preview.value }, 200);
    }
    const result = await admin.setDefault(principal, key, value, changeReasonOf(c) ?? '');
    c.header('genai-task', result.task);
    if (!result.ok) return problem(c, 422, 'Invalid setting', { errors: result.errors });
    return c.json(applied(result), 200);
  });

  app.openapi(routes.tenantSettings, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant } = c.req.valid('param');
    if (!access(principal, tenant, c.req.raw)) return problem(c, 404, 'Not found');
    return c.json(settings.tenant(tenant), 200);
  });

  app.openapi(routes.effective, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant } = c.req.valid('param');
    if (!access(principal, tenant, c.req.raw)) return problem(c, 404, 'Not found');
    const { service } = c.req.valid('query');
    if (service === undefined) return c.json(settings.effective(tenant), 200);
    const latest = await store.get('Service', tenant, service);
    if (!latest || latest.definition.kind !== 'Service') return problem(c, 404, 'Not found');
    return c.json(
      settings.effective(tenant, {
        tenant,
        service,
        version: latest.version,
        settings: latest.definition.spec.settings,
      }),
      200,
    );
  });

  app.openapi(routes.setTenant, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant, key } = c.req.valid('param');
    const acting = access(principal, tenant, c.req.raw);
    if (!acting) return problem(c, 404, 'Not found');
    const lacking = refusedRight(c, acting, tenant, 'manage-services');
    if (lacking) return lacking;
    const { value } = c.req.valid('json');
    if (c.req.valid('query').dryRun === 'true') {
      const preview = settings.previewTenant(tenant, key, value, await services());
      if (!preview.ok) return problem(c, 422, 'Invalid setting', { errors: preview.errors });
      return c.json({ dryRun: true as const, ...preview.value }, 200);
    }
    const result = await admin.setTenantSetting(
      acting,
      tenant,
      key,
      value,
      changeReasonOf(c) ?? '',
    );
    c.header('genai-task', result.task);
    if (!result.ok && result.conflict) return conflicted(c);
    if (!result.ok) return problem(c, 422, 'Invalid setting', { errors: result.errors });
    return c.json(applied(result), 200);
  });

  app.openapi(routes.unsetTenant, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant, key } = c.req.valid('param');
    const acting = access(principal, tenant, c.req.raw);
    if (!acting) return problem(c, 404, 'Not found');
    const lacking = refusedRight(c, acting, tenant, 'manage-services');
    if (lacking) return lacking;
    const result = await admin.setTenantSetting(acting, tenant, key, null, changeReasonOf(c) ?? '');
    c.header('genai-task', result.task);
    if (!result.ok && result.conflict) return conflicted(c);
    if (!result.ok) return problem(c, 422, 'Invalid setting', { errors: result.errors });
    return c.json(applied(result), 200);
  });

  app.openapi(routes.pin, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant, key } = c.req.valid('param');
    const acting = access(principal, tenant, c.req.raw);
    if (!acting) return problem(c, 404, 'Not found');
    const lacking = refusedRight(c, acting, tenant, 'manage-services');
    if (lacking) return lacking;
    const result = await admin.pin(
      acting,
      tenant,
      key,
      c.req.valid('json').version,
      changeReasonOf(c) ?? '',
    );
    c.header('genai-task', result.task);
    if (!result.ok && result.conflict) return conflicted(c);
    if (!result.ok) return problem(c, 422, 'Invalid pin', { errors: result.errors });
    return c.json(applied(result), 200);
  });

  app.openapi(routes.exportTenant, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant } = c.req.valid('param');
    const acting = access(principal, tenant, c.req.raw);
    if (!acting) return problem(c, 404, 'Not found');
    const lacking = refusedRight(c, acting, tenant, 'manage-services');
    if (lacking) return lacking;
    return c.json((await exportTenant(tenant, store, settings)) as Record<string, unknown>, 200);
  });

  app.openapi(routes.importTenant, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant } = c.req.valid('param');
    const acting = access(principal, tenant, c.req.raw);
    if (!acting) return problem(c, 404, 'Not found');
    const lacking = refusedRight(c, acting, tenant, 'manage-services');
    if (lacking) return lacking;
    const { dryRun, onConflict } = c.req.valid('query');
    const bundle = c.req.valid('json');
    const reason = changeReasonOf(c) ?? '';
    if (dryRun === 'true') {
      const plan = await importTenant(bundle, store, settings, {
        tenant,
        dryRun: true,
        onConflict,
        actor: '',
        reason,
        check: admin.check,
      });
      if (!plan.ok) return problem(c, 422, 'Invalid bundle', { errors: plan.errors });
      return c.json({ dryRun: true, plan: plan.plan }, 200);
    }
    const result = await admin.importTenant(acting, tenant, bundle, onConflict, reason);
    c.header('genai-task', result.task);
    if (!result.ok && result.conflict) return conflicted(c);
    if (!result.ok) return problem(c, 422, 'Invalid bundle', { errors: result.errors });
    return c.json({ dryRun: false, task: result.task, plan: result.value }, 200);
  });

  app.openapi(routes.openSession, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    if (principal.kind !== 'operator')
      return problem(c, 403, 'Only operators open support sessions');
    const { tenant, reason, minutes } = c.req.valid('json');
    const result = await admin.openSupportSession(
      principal,
      tenant,
      reason,
      minutes,
      actorNameOf(c),
    );
    c.header('genai-task', result.task);
    if (!result.ok) return problem(c, 422, 'Invalid support session', { errors: result.errors });
    return c.json(result.value, 201);
  });

  app.openapi(routes.audit, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant } = c.req.valid('param');
    const acting = access(principal, tenant, c.req.raw);
    if (!acting) return problem(c, 404, 'Not found');
    const lacking = refusedRight(c, acting, tenant, 'manage-services');
    if (lacking) return lacking;
    const all = await admin.audit(tenant);
    const entries =
      principal.kind === 'operator' ? all : all.filter((e) => visibleToTenant(e, tenant));
    const names = await options.names?.namesOf(
      entries.filter((e) => e.actor.startsWith('employee:')).map((e) => e.actor),
    );
    return c.json(
      {
        data: entries.map((e) => {
          const actorName = e.actor.startsWith('employee:') ? names?.get(e.actor) : undefined;
          return actorName ? { ...e, actorName } : e;
        }),
      },
      200,
    );
  });

  app.openapi(routes.auditTask, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant, task } = c.req.valid('param');
    const acting = access(principal, tenant, c.req.raw);
    if (!acting) return problem(c, 404, 'Not found');
    const lacking = refusedRight(c, acting, tenant, 'manage-services');
    if (lacking) return lacking;
    if (!(await admin.audit(tenant)).some((a) => a.task === task))
      return problem(c, 404, 'Not found');
    const found = await admin.task(task);
    if (!found) return problem(c, 404, 'Not found');
    return c.json(
      {
        task: found as unknown as Record<string, unknown>,
        events: (await admin.events(task)) as unknown as Record<string, unknown>[],
      },
      200,
    );
  });
};
