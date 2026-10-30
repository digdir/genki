import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { Principal } from '@genai/contracts';
import type { DefinitionStore, PluginSchemas, SettingsRegistry } from '@genai/definitions';
import { isApiKeyPrincipal } from '@genai/identity';
import { tenantAccess, type Access } from './access.js';
import { requireChangeReason } from './change-reason.js';
import { rememberActorNames, type ActorNames } from './actor-names.js';
import { createAdmin, type Admin, type ModelAdmin } from './admin.js';
import { acceptDecodedIds } from './decoded-ids.js';
import { registerDefinitionRoutes } from './definitions.js';
import {
  apiNotFoundBody,
  gzipResponses,
  isHeadlessRagApiPath,
  securityHeaders,
} from './hardening.js';
import { localeMiddleware, t } from './i18n/index.js';
import { refuseLockedRoutes, refuseUntrustedEntra } from './lockdown.js';
import { keepsOwnErrorShape, problemResponses } from './problem-responses.js';
import { problem, type Authenticator } from './http.js';
import { withChangeReasons, withTags, withUndocumentedRoutes } from './openapi-routes.js';
import { registerPlatformRoutes, type PlatformApiOptions } from './platform.js';
import { registerReference } from './reference/index.js';
import type { ServiceDrafts } from './service-drafts.js';
import { kernelTaskReader, type TaskReader } from './timeline.js';

const Health = z
  .object({ status: z.literal('ok'), version: z.string(), lockdown: z.boolean() })
  .openapi('Health');

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  responses: {
    200: { content: { 'application/json': { schema: Health } }, description: 'Service is up' },
  },
});

type Caller = (request: Request) => Promise<Principal | undefined>;

type Authentication = { auth: Authenticator; caller?: never } | { caller: Caller; auth?: never };

export type PlatformOptions = Authentication & {
  store: DefinitionStore;
  plugins: PluginSchemas;
  settings: SettingsRegistry;
  admin?: Admin;
  access?: Access;
  tasks?: TaskReader;
  tenantDirectory?: PlatformApiOptions['tenantDirectory'];
  organisationName?: PlatformApiOptions['organisationName'];
  tenantQuota?: PlatformApiOptions['tenantQuota'];
  tenantGate?: MiddlewareHandler;
  registered?: (tenant: string) => Promise<boolean>;
  lifecycle?: PlatformApiOptions['lifecycle'];
  models?: ModelAdmin;
  drafts?: Pick<ServiceDrafts, 'outdated' | 'followPublish'>;
  names?: ActorNames;
  now?: () => Date;
  lockdown?: boolean;
  loginRefusal?: (request: Request) => Promise<string | undefined>;
};

const withoutApiKeys = (caller: Caller): Authenticator => ({
  authenticate: async (request) => {
    const principal = await caller(request);
    return principal && !isApiKeyPrincipal(principal) ? principal : undefined;
  },
});

export interface AppOptions {
  platform?: PlatformOptions;
}

export const createApp = (version: string, options: AppOptions = {}) => {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (result.success) return;
      return problem(c, 400, 'Invalid request', {
        errors: result.error.issues.map((i) => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        })),
      });
    },
  });
  acceptDecodedIds(app);

  app.use('*', securityHeaders);
  app.use('*', gzipResponses());
  app.use('*', localeMiddleware);
  app.use('*', problemResponses);
  const lockdown = options.platform?.lockdown ?? false;
  app.openapi(healthRoute, (c) => c.json({ status: 'ok' as const, version, lockdown }, 200));
  app.get('/up', (c) => c.text('ok'));
  app.notFound((c) => {
    if (!isHeadlessRagApiPath(c.req.path)) return problem(c, 404, 'Not found');
    if (keepsOwnErrorShape(c.req.path)) return c.json(apiNotFoundBody, 404);
    return c.json(
      { type: 'about:blank', title: t('problems.status404'), status: 404, ...apiNotFoundBody },
      404,
      { 'content-type': 'application/problem+json' },
    );
  });
  if (options.platform?.tenantGate) {
    app.use('/tenants/:tenant', options.platform.tenantGate);
    app.use('/tenants/:tenant/*', options.platform.tenantGate);
  }

  const given = options.platform;
  const authentication = !given
    ? undefined
    : given.caller
      ? { caller: given.caller, auth: withoutApiKeys(given.caller) }
      : { caller: (r: Request) => given.auth.authenticate(r), auth: given.auth };

  if (options.platform?.names && authentication)
    app.use('*', rememberActorNames(authentication.auth, options.platform.names));

  if (options.platform && authentication) {
    const { store, plugins, settings } = options.platform;
    const { caller, auth } = authentication;
    if (options.platform.loginRefusal)
      app.use('*', refuseUntrustedEntra(options.platform.loginRefusal));
    if (lockdown) app.use('*', refuseLockedRoutes(caller));
    app.use('*', requireChangeReason(caller));
    const admin =
      options.platform.admin ??
      createAdmin({
        store,
        plugins,
        settings,
        ...(options.platform.models ? { models: options.platform.models } : {}),
        ...(options.platform.now ? { now: options.platform.now } : {}),
        ...(options.platform.names ? { names: options.platform.names } : {}),
      });
    const access = options.platform.access ?? tenantAccess(admin);
    const tasks =
      options.platform.tasks ??
      kernelTaskReader(admin.kernel, {
        kind: 'operator',
        issuer: 'platform',
        subject: 'task-reader',
      });
    registerDefinitionRoutes(app, {
      store,
      plugins,
      auth,
      admin,
      access,
      ...(options.platform.drafts ? { drafts: options.platform.drafts } : {}),
      ...(options.platform.names ? { names: options.platform.names } : {}),
      ...(options.platform.registered ? { registered: options.platform.registered } : {}),
    });
    registerPlatformRoutes(app, {
      store,
      settings,
      auth,
      admin,
      access,
      tasks,
      ...(options.platform.models ? { models: options.platform.models } : {}),
      ...(options.platform.tenantDirectory
        ? { tenantDirectory: options.platform.tenantDirectory }
        : {}),
      ...(options.platform.tenantQuota ? { tenantQuota: options.platform.tenantQuota } : {}),
      ...(options.platform.organisationName
        ? { organisationName: options.platform.organisationName }
        : {}),
      ...(options.platform.lifecycle ? { lifecycle: options.platform.lifecycle } : {}),
      ...(options.platform.names ? { names: options.platform.names } : {}),
      ...(options.platform.now ? { now: options.platform.now } : {}),
    });
  }

  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/openapi.json',
    summary: 'This OpenAPI 3.1 document. Open to everyone.',
    responses: {
      200: {
        description: 'The OpenAPI document for every route of the platform',
        content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
      },
    },
  });

  registerReference(app);

  app.get('/openapi.json', (c) =>
    c.json(
      withTags(
        withChangeReasons(
          withUndocumentedRoutes(
            app.getOpenAPI31Document({
              openapi: '3.1.0',
              info: { title: 'GenAI platform API', version },
            }),
            app.routes,
          ),
          app.routes,
        ),
      ),
    ),
  );

  return app;
};
