import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  definitionKinds,
  definitionWarnings,
  validateDefinition,
  validateYaml,
  type Definition,
  type DefinitionStore,
  type PluginSchemas,
  type PromptFiles,
  type PublishedVersion,
  type Validated,
  type ValidationError,
} from '@genai/definitions';
import { refusedRight, type Access } from './access.js';
import type { ActorNames } from './actor-names.js';
import { actorOf, type Admin } from './admin.js';
import { confirmedBy, riskConfirmationProblems } from './governance.js';
import { t } from './i18n/index.js';
import {
  type Authenticator,
  changeReason,
  changeReasonOf,
  problem,
  problemContent,
} from './http.js';
import { draftOutdatedTitle, draftOutdatedType, type ServiceDrafts } from './service-drafts.js';
import { tenantNotRegistered } from './tenant-gate.js';

export interface DefinitionsApiOptions {
  store: DefinitionStore;
  plugins: PluginSchemas;
  auth: Authenticator;
  admin: Admin;
  access: Access;
  drafts?: Pick<ServiceDrafts, 'outdated' | 'followPublish'>;
  names?: ActorNames;
  now?: () => Date;
  registered?: (tenant: string) => Promise<boolean>;
}

const kinds = { services: 'Service', 'step-flows': 'StepFlow', skills: 'Skill' } as const;
const segments = {
  Service: 'services',
  StepFlow: 'step-flows',
  Skill: 'skills',
} as const satisfies Record<Definition['kind'], keyof typeof kinds>;

const VersionSummary = z
  .object({
    version: z.number().int(),
    publishedBy: z.string(),
    publishedByName: z.string().optional(),
    publishedAt: z.string(),
    reason: z.string(),
  })
  .openapi('VersionSummary');

const Warning = z.object({ path: z.string(), message: z.string() }).openapi('DefinitionWarning');

const PublishedDefinition = VersionSummary.extend({
  kind: z.enum(definitionKinds),
  tenant: z.string(),
  id: z.string(),
  definition: z.record(z.string(), z.unknown()),
  files: z.record(z.string(), z.string()),
  warnings: z.array(Warning).optional(),
}).openapi('PublishedDefinition');

const DefinitionOverview = z
  .object({
    kind: z.enum(definitionKinds),
    tenant: z.string(),
    id: z.string(),
    latest: PublishedDefinition,
    versions: z.array(VersionSummary),
  })
  .openapi('DefinitionOverview');

const ResolvedName = z
  .object({
    name: z.string(),
    publicName: z.string(),
    aliases: z.array(z.string()),
    tenant: z.string(),
    service: z.string(),
    variant: z.string(),
    version: z.number().int(),
  })
  .openapi('ResolvedName');

const definitionBody = {
  required: true,
  description:
    'A definition as JSON or YAML, or JSON {definition, files, draftRevision?} where definition may be YAML text, files maps prompts/<name>.md to its text, and draftRevision marks a publish of the service draft',
  content: {
    'application/json': { schema: z.record(z.string(), z.unknown()) },
    'application/yaml': { schema: z.string() },
  },
} as const;

const tenantParam = z
  .string()
  .openapi({ param: { name: 'tenant', in: 'path' }, example: '991825827' });
const kindParam = z
  .enum(['services', 'step-flows', 'skills'])
  .openapi({ param: { name: 'kind', in: 'path' } });
const idParam = z.string().openapi({ param: { name: 'id', in: 'path' } });

const routes = {
  validate: createRoute({
    method: 'post',
    path: '/definitions/validate',
    summary: 'Validate a definition without saving it',
    request: { body: definitionBody },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({ valid: z.literal(true), warnings: z.array(Warning).optional() }),
          },
        },
        description: 'The definition is valid',
      },
      400: { content: problemContent, description: 'The body could not be read' },
      401: { content: problemContent, description: 'Not authenticated' },
      403: { content: problemContent, description: 'Not allowed for this tenant' },
      422: { content: problemContent, description: 'The definition is invalid' },
    },
  }),
  publish: createRoute({
    method: 'post',
    path: '/definitions',
    summary: 'Publish a definition; the store assigns the next version',
    request: {
      body: definitionBody,
      headers: changeReason,
    },
    responses: {
      201: {
        content: { 'application/json': { schema: PublishedDefinition } },
        description: 'Published',
      },
      400: { content: problemContent, description: 'The body or reason could not be read' },
      401: { content: problemContent, description: 'Not authenticated' },
      403: { content: problemContent, description: 'Not allowed for this tenant' },
      409: {
        content: problemContent,
        description: `${draftOutdatedType}: the body's draftRevision names a draft started from an older version, and publishing it would undo newer published changes; rebase the draft first`,
      },
      422: { content: problemContent, description: 'The definition is invalid' },
    },
  }),
  list: createRoute({
    method: 'get',
    path: '/tenants/{tenant}/definitions',
    summary: "List a tenant's definitions",
    request: { params: z.object({ tenant: tenantParam }) },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              data: z.array(
                z.object({
                  kind: z.enum(definitionKinds),
                  id: z.string(),
                  latestVersion: z.number().int(),
                }),
              ),
            }),
          },
        },
        description: 'Definitions in the tenant',
      },
      401: { content: problemContent, description: 'Not authenticated' },
      403: { content: problemContent, description: 'Not allowed for this tenant' },
      404: { content: problemContent, description: 'The tenant is not reachable for the caller' },
    },
  }),
  get: createRoute({
    method: 'get',
    path: '/tenants/{tenant}/definitions/{kind}/{id}',
    summary: 'Get the latest version of a definition and its history',
    request: { params: z.object({ tenant: tenantParam, kind: kindParam, id: idParam }) },
    responses: {
      200: {
        content: { 'application/json': { schema: DefinitionOverview } },
        description: 'Found',
      },
      401: { content: problemContent, description: 'Not authenticated' },
      403: { content: problemContent, description: 'Not allowed for this tenant' },
      404: { content: problemContent, description: 'Not found' },
    },
  }),
  version: createRoute({
    method: 'get',
    path: '/tenants/{tenant}/definitions/{kind}/{id}/versions/{version}',
    summary: 'Get one published version',
    request: {
      params: z.object({
        tenant: tenantParam,
        kind: kindParam,
        id: idParam,
        version: z.coerce
          .number()
          .int()
          .positive()
          .openapi({ param: { name: 'version', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        content: { 'application/json': { schema: PublishedDefinition } },
        description: 'Found',
      },
      401: { content: problemContent, description: 'Not authenticated' },
      403: { content: problemContent, description: 'Not allowed for this tenant' },
      404: { content: problemContent, description: 'Not found' },
    },
  }),
  resolve: createRoute({
    method: 'get',
    path: '/services/by-name/{name}',
    summary: 'Resolve a public name or alias to a service variant',
    request: {
      params: z.object({ name: z.string().openapi({ param: { name: 'name', in: 'path' } }) }),
    },
    responses: {
      200: { content: { 'application/json': { schema: ResolvedName } }, description: 'Resolved' },
      401: { content: problemContent, description: 'Not authenticated' },
      404: { content: problemContent, description: 'No such name visible to the caller' },
    },
  }),
};

type Names = Map<string, string>;

const seededReason = 'local configuration';

const reasonOf = (v: PublishedVersion) =>
  v.reason === seededReason && /^(platform|worker):seed$/.test(v.publishedBy)
    ? t('services.seedReason')
    : v.reason;

const summary = (v: PublishedVersion, names: Names = new Map()) => {
  const name = names.get(v.publishedBy);
  return {
    version: v.version,
    publishedBy: v.publishedBy,
    ...(name ? { publishedByName: name } : {}),
    publishedAt: v.publishedAt,
    reason: reasonOf(v),
  };
};

const published = (v: PublishedVersion, names?: Names) => ({
  kind: v.definition.kind,
  tenant: v.definition.metadata.tenant,
  id: v.definition.metadata.id,
  ...summary(v, names),
  definition: v.definition as unknown as Record<string, unknown>,
  files: v.files,
});

const isYaml = (contentType: string | undefined) =>
  /^(application|text)\/(x-)?yaml\b/i.test(contentType ?? '');

type Read = { unreadable: string } | { validated: Validated; files: PromptFiles };

const fromText = (text: string, plugins: PluginSchemas, files: PromptFiles): Read => {
  const validated = validateYaml(text, plugins);
  if (!validated.ok && validated.errors[0]?.message.startsWith('not valid YAML'))
    return { unreadable: validated.errors[0].message };
  return { validated, files };
};

const isFiles = (v: unknown): v is PromptFiles =>
  typeof v === 'object' && v !== null && Object.values(v).every((x) => typeof x === 'string');

const draftRevisionOf = async (c: Context) => {
  if (isYaml(c.req.header('content-type'))) return undefined;
  const body = (await c.req.json().catch(() => undefined)) as
    { draftRevision?: unknown } | undefined;
  return typeof body?.draftRevision === 'number' ? body.draftRevision : undefined;
};

export const readDefinition = async (c: Context, plugins: PluginSchemas): Promise<Read> => {
  if (isYaml(c.req.header('content-type'))) return fromText(await c.req.text(), plugins, {});
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { unreadable: 'the body is not valid JSON' };
  }
  if (body && typeof body === 'object' && 'definition' in body && !('apiVersion' in body)) {
    const { definition, files = {} } = body as { definition: unknown; files?: unknown };
    if (!isFiles(files)) return { unreadable: 'files must map prompt paths to text' };
    if (typeof definition === 'string') return fromText(definition, plugins, files);
    return { validated: validateDefinition(definition, plugins), files };
  }
  return { validated: validateDefinition(body, plugins), files: {} };
};

const takenBy = / is used by (Service|StepFlow):([^/]+)\/\S+$/;

const redact = (errors: ValidationError[], tenant: string) =>
  errors.map((e) => {
    const match = takenBy.exec(e.message);
    return match && match[2] !== tenant
      ? { ...e, message: e.message.replace(takenBy, ' is already taken') }
      : e;
  });

export const registerDefinitionRoutes = (app: OpenAPIHono, options: DefinitionsApiOptions) => {
  const unregistered = async (principal: { kind: string }, tenant: string) =>
    principal.kind !== 'operator' &&
    options.registered !== undefined &&
    !(await options.registered(tenant));
  const { store, plugins, auth, admin, access } = options;
  const now = options.now ?? (() => new Date());
  const namesOf = async (versions: PublishedVersion[]): Promise<Names> =>
    (await options.names?.namesOf(versions.map((v) => v.publishedBy))) ?? new Map();

  app.openapi(routes.validate, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const read = await readDefinition(c, plugins);
    if ('unreadable' in read)
      return problem(c, 400, 'Unreadable definition', { detail: read.unreadable });
    const { validated } = read;
    const tenant = validated.ok ? validated.definition.metadata.tenant : undefined;
    if (tenant && !access(principal, tenant, c.req.raw))
      return problem(c, 403, 'Not allowed for this tenant');
    if (tenant && (await unregistered(principal, tenant))) return tenantNotRegistered(c, tenant);
    const lacking = tenant && refusedRight(c, principal, tenant, 'manage-services');
    if (lacking) return lacking;
    if (!validated.ok) return problem(c, 422, 'Invalid definition', { errors: validated.errors });
    const errors = admin.check(validated.definition, read.files);
    if (errors.length > 0) return problem(c, 422, 'Invalid definition', { errors });
    const warnings = definitionWarnings(validated.definition);
    return c.json({ valid: true as const, ...(warnings.length ? { warnings } : {}) }, 200);
  });

  app.openapi(routes.publish, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const read = await readDefinition(c, plugins);
    if ('unreadable' in read)
      return problem(c, 400, 'Unreadable definition', { detail: read.unreadable });
    const { validated } = read;
    if (!validated.ok) return problem(c, 422, 'Invalid definition', { errors: validated.errors });
    const tenant = validated.definition.metadata.tenant;
    const acting = access(principal, tenant, c.req.raw);
    if (!acting) return problem(c, 403, 'Not allowed for this tenant');
    if (await unregistered(principal, tenant)) return tenantNotRegistered(c, tenant);
    const lacking = refusedRight(c, acting, tenant, 'manage-services');
    if (lacking) return lacking;
    if (validated.definition.kind === 'Skill')
      return problem(c, 422, 'Invalid definition', {
        errors: [
          {
            path: 'kind',
            message: `skills are published through /tenants/${tenant}/skills/${validated.definition.metadata.id}/publish, which checks their test set`,
          },
        ],
      });
    const unconfirmed = riskConfirmationProblems(validated.definition);
    if (unconfirmed.length > 0)
      return problem(c, 422, 'Invalid definition', { errors: unconfirmed });

    const service = validated.definition.kind === 'Service' ? validated.definition.metadata.id : '';
    const fromDraft = service !== '' && (await draftRevisionOf(c)) !== undefined;
    const behind = fromDraft ? await options.drafts?.outdated(tenant, service) : undefined;
    if (behind)
      return c.json(
        {
          type: draftOutdatedType,
          title: draftOutdatedTitle,
          status: 409,
          detail: `Utkastet ble startet fra versjon ${behind.baseVersion}, men versjon ${behind.latestVersion} er publisert siden. Oppdater utkastet før du publiserer.`,
          baseVersion: behind.baseVersion,
          latestVersion: behind.latestVersion,
          errors: behind.paths.map((path) => ({
            path,
            message: 'endret i en nyere publisert versjon',
          })),
        },
        409,
        { 'content-type': 'application/problem+json' },
      );

    const reason = changeReasonOf(c) ?? '';
    const result = await admin.publish(acting, {
      definition: confirmedBy(validated.definition, acting, now()),
      files: read.files,
      reason,
    });
    c.header('genai-task', result.task);
    if (!result.ok)
      return problem(c, 422, 'Invalid definition', { errors: redact(result.errors, tenant) });
    if (service && !fromDraft)
      await options.drafts
        ?.followPublish(
          actorOf(acting.actor ?? acting),
          tenant,
          service,
          result.value,
          `Fulgte publisert versjon ${result.value.version}: ${reason}`,
        )
        .catch(() => undefined);
    const warnings = definitionWarnings(validated.definition);
    const body = {
      ...published(result.value, await namesOf([result.value])),
      ...(warnings.length ? { warnings } : {}),
    };
    c.header(
      'location',
      `/tenants/${body.tenant}/definitions/${segments[body.kind]}/${body.id}/versions/${body.version}`,
    );
    return c.json(body, 201);
  });

  app.openapi(routes.list, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant } = c.req.valid('param');
    if (!access(principal, tenant, c.req.raw)) return problem(c, 404, 'Not found');
    const entries = await store.list(tenant);
    const rows = await Promise.all(
      entries.map(async ({ kind, id }) => ({
        kind,
        id,
        latestVersion: (await store.get(kind, tenant, id))?.version ?? 0,
      })),
    );
    return c.json({ data: rows }, 200);
  });

  app.openapi(routes.get, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant, kind, id } = c.req.valid('param');
    if (!access(principal, tenant, c.req.raw)) return problem(c, 404, 'Not found');
    const history = await store.versions(kinds[kind], tenant, id);
    const latest = history.at(-1);
    if (!latest) return problem(c, 404, 'Not found');
    const names = await namesOf(history);
    return c.json(
      {
        kind: kinds[kind],
        tenant,
        id,
        latest: published(latest, names),
        versions: history.map((v) => summary(v, names)),
      },
      200,
    );
  });

  app.openapi(routes.version, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { tenant, kind, id, version } = c.req.valid('param');
    if (!access(principal, tenant, c.req.raw)) return problem(c, 404, 'Not found');
    const found = await store.get(kinds[kind], tenant, id, version);
    if (!found) return problem(c, 404, 'Not found');
    return c.json(published(found, await namesOf([found])), 200);
  });

  app.openapi(routes.resolve, async (c) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Not authenticated');
    const { name } = c.req.valid('param');
    const found = await store.resolve(name);
    if (!found || !access(principal, found.service.tenant, c.req.raw))
      return problem(c, 404, 'Not found');
    return c.json(
      {
        name,
        publicName: found.publicName,
        aliases: found.aliases,
        tenant: found.service.tenant,
        service: found.service.id,
        variant: found.variant,
        version: found.service.version,
      },
      200,
    );
  });
};
