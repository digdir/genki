import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { residencies, type Residency } from '@genai/port-model';
import {
  altinnPolicy,
  apiKeyDigest,
  createAuthenticator,
  createTokenVerifier,
  InMemoryClients,
  InMemoryIdentities,
  oidcAudienceOf,
  type IdentityTestDataInput,
} from '@genai/identity';
import {
  envSecrets,
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryTaskStore,
  type EventLog,
} from '@genai/kernel';
import { createTraceExporter, observedEventLog } from '@genai/providers-langfuse';
import {
  createPostgresStores,
  LocalKeyWrapper,
  PostgresDefinitionStore,
  postgresSourceFromEnv,
} from '@genai/providers-postgres';
import { parse as parseYaml } from 'yaml';
import { FileSystemBlobStore } from '@genai/port-blob';
import type { PolicyDecisionPoint } from '@genai/kernel';
import { documentConverterFrom, phraseArchiveFrom } from './document-converter.js';
import { createAdmin, platformActor } from './admin.js';
import { InMemoryTenantApiKeys, type TenantApiKeys } from './routes/portal-routes.js';
import type { ModelPrice } from './draft-runner.js';
import { postgresKeyPolicies, postgresTenantKeys } from './tenant-keys.js';
import { clientRegistry, notifyingClients, type ClientListener } from './frontends.js';
import { actorNames } from './actor-names.js';
import {
  defaultPlatformTenant,
  ownedByPlatformTenant,
  platformTenantFrom,
} from '@genai/composition';
import { createApp } from './app.js';
import { sharedLimiter } from './rate-limit.js';
import { kernelTaskReader } from './timeline.js';
import { bearerAuthenticator } from './auth.js';
import { followChanges } from './change-feed.js';
import { postgresTaskIndex, postgresTenantDirectory } from './postgres-adapters.js';
import { loadCatalog } from './catalogs.js';
import { callerFrom, createPlatform, platformModules, serviceRequirement } from './composition.js';
import {
  createDefinitionSourcesModule,
  readGitDefinitions,
  seedDefinitions,
  type DefinitionSource,
} from './definition-sources.js';
import { withoutUnknownVariantModels } from './seed-variants.js';
import { readTestSets, seedTestSets, testSetsOfServices } from './seed-test-sets.js';
import { operatorDirectory, splitOperators } from './operators.js';
import { altinnPdpFrom, withPdpActions } from './altinn-pdp.js';
import { bootProblems, devModeWarning, isDevMode } from './boot-guard.js';
import { loginIssuers } from './login-issuers.js';
import { documentMockRoutes } from './openapi/access.js';
import { unknownTestPerson } from './dev-login.js';
import { asPlatformResource } from './platform-resource.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { admitMaskinportenClients, maskinportenClientRegistry } from './maskinporten-clients.js';
import { isLockdown } from './lockdown.js';

const envFile = join(import.meta.dirname, '..', '..', '..', '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT ?? 8080);
const version = process.env.APP_VERSION ?? 'dev';
const audience = process.env.API_AUDIENCE ?? 'digdir:genai';
const configDir = process.env.CONFIG_DIR ?? join(import.meta.dirname, '..', 'config', 'local');
const resource = process.env.ALTINN_RESOURCE ?? 'urn:altinn:resource:digdir-genai-platform';
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ msg, ...extra }));

const refused = bootProblems(process.env);
if (refused.length > 0) {
  log('refusing to start', { problems: refused });
  process.exit(1);
}
if (isDevMode(process.env)) {
  console.warn(`\n*** DEV MODE ***\n${devModeWarning}\n`);
  log('dev mode', { warning: devModeWarning });
}
const platformTenant = platformTenantFrom(process.env);
log('platform tenant', { tenant: platformTenant });

const identityFile = (() => {
  const raw = (parseYaml(readFileSync(join(configDir, 'identity.yaml'), 'utf8')) ?? {}) as {
    devLogin?: { employee?: string; operator?: string };
    clients?: Record<string, unknown>[];
  } & Record<string, unknown>;
  const { devLogin = {}, ...withFlags } = raw;
  const { testData: rest, operatorPids } = splitOperators(withFlags);
  return {
    devLogin,
    operatorPids,
    testData: {
      ...rest,
      clients: (rest.clients ?? []).map((client) => ({ audience, ...client })),
    } as IdentityTestDataInput,
  };
})();
const testData = identityFile.testData;
const operators = operatorDirectory(
  identityFile.operatorPids,
  (process.env.OPERATOR_SUBJECTS ?? '').split(',').filter(Boolean),
);
const altinnPdp = altinnPdpFrom(process.env, testData);
log('altinn pdp', {
  kind: altinnPdp.kind,
  ...(altinnPdp.kind === 'altinn' ? { baseURL: altinnPdp.baseURL } : {}),
});

const databaseHosts = (...urls: (string | undefined)[]) =>
  urls.flatMap((url) => {
    try {
      return url ? [new URL(url).hostname.replace(/^\[|\]$/g, '')] : [];
    } catch {
      return [];
    }
  });

const databaseSource = postgresSourceFromEnv(process.env);
const db = databaseSource
  ? await createPostgresStores(
      databaseSource,
      LocalKeyWrapper.fromBase64(process.env.CONTENT_MASTER_KEY),
      {
        onError: (error) => log('postgres connection error', { error: String(error) }),
        ...(process.env.DATABASE_RUNTIME_URL
          ? { runtime: { connectionString: process.env.DATABASE_RUNTIME_URL } }
          : {}),
      },
    )
  : undefined;
log('storage', { kind: db ? 'postgres' : 'memory' });

let mockRegistration: ClientListener = {};
const clients = notifyingClients(db?.clients ?? new InMemoryClients(), {
  saved: (client, before) => mockRegistration.saved?.(client, before),
  removed: (client) => mockRegistration.removed?.(client),
});
const registeredClients = clientRegistry(clients);

const { trusted, mock } = await loginIssuers({
  env: process.env,
  port,
  audience,
  testData,
  registeredClients,
});
if (mock)
  mockRegistration = {
    saved: (client, before) => {
      const oidc = client.spec.oidc;
      if (before?.spec.oidc && before.spec.oidc.clientId !== oidc?.clientId)
        mock.clients.remove(before.spec.oidc.clientId);
      if (!oidc) return;
      mock.clients.register({
        clientId: oidc.clientId,
        redirectUris: oidc.redirectUris,
        postLogoutRedirectUris: oidc.postLogoutRedirectUris,
        audience: oidcAudienceOf(client) ?? oidc.clientId,
        audiences: [audience],
        tokenEndpointAuthMethod: 'none',
      });
    },
    removed: (client) => {
      if (client.spec.oidc) mock.clients.remove(client.spec.oidc.clientId);
    },
  };
const reservedClientIds = (testData.clients ?? []).map((c) => c.clientId);
const verifier = operators.watch(
  asPlatformResource(
    withPdpActions(createTokenVerifier({ issuers: trusted }), altinnPdp, resource, (error) =>
      log('altinn actions failed', { error: String(error) }),
    ),
    resource,
  ),
);
const secrets = envSecrets();

const memoryKeys = new InMemoryTenantApiKeys();
const configuredKeys = new Set<string>();
if (mock && process.env.DEV_API_KEY) {
  const devKey = {
    id: 'local-dev',
    name: 'Local development key',
    digest: apiKeyDigest(process.env.DEV_API_KEY),
    tenant: platformTenant,
    scopes: ['query' as const],
    datasets: ['*'],
    agents: ['*'],
  };
  configuredKeys.add(devKey.digest);
  if (db) await db.apiKeys.restore(devKey);
  else await memoryKeys.add(devKey);
  log('local dev key enabled', { tenant: platformTenant, storage: db ? 'postgres' : 'memory' });
}

if (mock && process.env.DEV_SERVICE_API_KEY) {
  const service = process.env.DEV_SERVICE_API_KEY_SERVICE || 'kunnskapsassistenten';
  const serviceKey = {
    id: 'local-dev-service',
    name: `Local development key bound to ${service}`,
    digest: apiKeyDigest(process.env.DEV_SERVICE_API_KEY),
    tenant: platformTenant,
    scopes: ['query' as const],
    datasets: [],
    agents: [],
    service,
  };
  configuredKeys.add(serviceKey.digest);
  if (db) await db.apiKeys.restore(serviceKey);
  else await memoryKeys.add(serviceKey);
}

const memoryIdentities = new InMemoryIdentities();
const identities = db?.identities ?? memoryIdentities;
const authenticator = createAuthenticator({
  verifier,
  apiKeys: db?.apiKeys ?? memoryKeys,
  onVerified: async (verified) => {
    if (db && verified.personId)
      await db.identities.remember(
        verified.principal.issuer,
        verified.principal.subject,
        verified.personId,
      );
    else memoryIdentities.remember(verified);
  },
});

const tasks = db?.tasks ?? new InMemoryTaskStore();
const baseLog: EventLog = db?.log ?? new InMemoryEventLog();
const traces = process.env.TRACES_ENDPOINT
  ? createTraceExporter(
      {
        endpoint: process.env.TRACES_ENDPOINT,
        auth: process.env.LANGFUSE_PUBLIC_KEY
          ? {
              kind: 'langfuse',
              publicKey: process.env.LANGFUSE_PUBLIC_KEY,
              secretKey: 'secret://env/langfuse-secret-key',
            }
          : { kind: 'none' },
        content: process.env.TRACES_CONTENT === 'true',
        ...(process.env.TRACES_ENVIRONMENT ? { environment: process.env.TRACES_ENVIRONMENT } : {}),
      },
      { secrets, tasks: async (id) => (await tasks.get(id))?.task, serviceName: 'genai-api' },
    )
  : undefined;
const traceResidency = residencies.includes(process.env.TRACES_RESIDENCY as Residency)
  ? (process.env.TRACES_RESIDENCY as Residency)
  : 'global';
log('traces', { enabled: Boolean(traces), content: process.env.TRACES_CONTENT === 'true' });

const catalogs = {
  models: loadCatalog(configDir, 'models.yaml', 'models'),
  knowledge: loadCatalog(configDir, 'knowledge.yaml', 'datasets'),
  rerank: loadCatalog(configDir, 'rerank.yaml', 'rerankers'),
  embeddings: existsSync(join(configDir, 'embeddings.yaml'))
    ? loadCatalog(configDir, 'embeddings.yaml', 'models')
    : { catalog: { endpoints: {}, models: [] }, skipped: [] },
};
const skipped = Object.values(catalogs).flatMap((c) => c.skipped);
if (skipped.length > 0) log('catalog entries skipped for missing settings', { skipped });

const dataDir = process.env.DATA_DIR ?? join(import.meta.dirname, '..', '.data');

const allowWorker = (inner: PolicyDecisionPoint): PolicyDecisionPoint => ({
  decide: async (principal, action, resource) =>
    action === 'invoke' &&
    principal.kind === 'agency-system' &&
    principal.scopes?.includes('genai:worker') &&
    principal.tenant !== undefined &&
    principal.tenant === resource.tenant
      ? { allow: true }
      : inner.decide(principal, action, resource),
});

const settings = new SettingsRegistry(platformSettings);
if (db) await settings.attach(db.settings);
const pricesFile = join(configDir, 'prices.yaml');
const prices = existsSync(pricesFile)
  ? ((parseYaml(readFileSync(pricesFile, 'utf8')) as { models?: Record<string, ModelPrice> })
      .models ?? {})
  : {};
const tenantKeys: TenantApiKeys = db ? postgresTenantKeys(db.apiKeys) : memoryKeys;

const seedList = (file: string) => {
  const path = join(configDir, file);
  if (!existsSync(path)) return [];
  const raw = (parseYaml(readFileSync(path, 'utf8')) ?? {}) as {
    items?: { id: string; mandatory?: boolean; spec: unknown }[];
  };
  return raw.items ?? [];
};

const documentConverter = documentConverterFrom(process.env, secrets);
const phraseArchive = phraseArchiveFrom(process.env, log);
log('document converter', { converter: process.env.DOCUMENT_CONVERTER ?? 'local' });

const configEntries = db?.configEntries ?? new InMemoryConfigEntryStore();
const admitClients = admitMaskinportenClients(
  maskinportenClientRegistry(configEntries),
  trusted.filter((t) => t.kind === 'maskinporten').map((t) => t.issuer),
);

const promptsDir = join(configDir, 'prompts');
const definitionSources: DefinitionSource[] = [
  { dir: join(configDir, 'flows'), promptsDir },
  { dir: join(configDir, 'services'), promptsDir },
  ...(process.env.SEED_PARITY_SERVICES === 'true'
    ? [
        {
          dir: join(import.meta.dirname, '..', '..', 'parity', 'config', 'services'),
          promptsDir,
        },
      ]
    : []),
];

const lockdown = isLockdown(process.env);
if (lockdown)
  log('lockdown: only API keys from configuration may use models', {
    configuredKeys: configuredKeys.size,
  });

const platform = await createPlatform({
  platformTenant,
  ...(lockdown ? { lockdown: { configuredKeys } } : {}),
  modules: [...platformModules, createDefinitionSourcesModule(definitionSources, platformTenant)],
  settings,
  verifyPluginsOnBoot: true,
  clients,
  reservedClientIds,
  ...(db ? { webhookDeliveries: db.webhookDeliveries } : {}),
  ...(db ? { triggerRuns: db.triggerRuns } : {}),
  webhookEgress: mock
    ? { testOverride: { allowHttp: true, allowLoopback: true } }
    : { platformHosts: ['localhost', '127.0.0.1', `localhost:${port}`] },
  endpoints: {
    ...Object.fromEntries(
      trusted.filter((t) => t.kind === 'ansattporten').map((t) => ['issuer', t.issuer]),
    ),
    audience,
    altinnResource: resource,
  },
  apiKeys: tenantKeys,
  ...(db ? { keyPolicies: postgresKeyPolicies(db.apiKeys) } : {}),
  prices,
  configurables: {
    store: configEntries,
    gateSeed: seedList('gates.yaml'),
    ruleSeed: seedList('guardrail-rules.yaml'),
  },
  traces: () =>
    traces && process.env.TRACES_ENDPOINT
      ? {
          endpoint: process.env.TRACES_ENDPOINT.split('?')[0] ?? '',
          content: process.env.TRACES_CONTENT === 'true',
          residency: traceResidency,
          stats: traces.stats(),
        }
      : undefined,
  catalogs: {
    models: catalogs.models.catalog,
    knowledge: catalogs.knowledge.catalog,
    rerank: catalogs.rerank.catalog,
    embeddings: catalogs.embeddings.catalog,
  },
  ...(db ? { knowledgePool: db.pool, changes: db.changes } : {}),
  ...(db
    ? {
        rateLimits: {
          limiter: sharedLimiter(db.rateLimits, (error) =>
            log('shared rate limit unavailable', { error: String(error) }),
          ),
        },
      }
    : {}),
  ...(db ? { databasePing: () => db.pool.query('select 1') } : {}),
  ...(process.env.ENHETSREGISTERET_URL
    ? { organizationRegistry: { url: process.env.ENHETSREGISTERET_URL } }
    : {}),
  searchOnlyClusters: [process.env.TYPESENSE_URL],
  ...(process.env.INGEST_FOLDER_ROOT ? { ingestFolderRoot: process.env.INGEST_FOLDER_ROOT } : {}),
  secrets,
  definitions: (plugins, sharedSkill, sharedFlow) =>
    db
      ? new PostgresDefinitionStore(
          db.runtimePool,
          { ...plugins, settings: settings.definitions() },
          undefined,
          sharedSkill,
          sharedFlow,
        )
      : new InMemoryDefinitionStore(
          { ...plugins, settings: settings.definitions() },
          undefined,
          sharedSkill,
          sharedFlow,
        ),
  log: baseLog,
  ...(traces ? { observe: (l: EventLog) => observedEventLog(l, traces) } : {}),
  tasks,
  blobStore: new FileSystemBlobStore(process.env.BLOB_DIR ?? join(dataDir, 'blobs')),
  egress: {
    platformHosts: [
      'localhost',
      '127.0.0.1',
      `localhost:${port}`,
      ...databaseHosts(process.env.DATABASE_URL, process.env.DATABASE_RUNTIME_URL),
      ...(process.env.PGHOST ? [process.env.PGHOST] : []),
    ],
  },
  catalogSkips: skipped,
  ...(db
    ? {
        tenantDirectory: postgresTenantDirectory(db.tenants),
        taskIndex: postgresTaskIndex(db.tasks),
        ingestionExecutions: db.ingestionExecutions,
      }
    : {}),
  state: db?.state ?? new InMemoryStateStore(),
  ...(db
    ? {
        conversations: db.conversations,
        modelClassifications: db.modelClassifications,
        tenantSecrets: db.tenantSecrets,
        connections: db.connections,
        evalStores: db.eval,
        labels: db.labels,
      }
    : {}),
  policy: allowWorker(
    altinnPolicy({
      altinn: altinnPdp.authorization,
      identities,
      requirementFor: () => serviceRequirement(resource),
    }),
  ),
  authenticate: async (request) => {
    const found = await authenticator.authenticate(request);
    if (!found) return undefined;
    return callerFrom(
      { ...found, principal: await admitClients(found.principal) },
      found.method === 'token' && operators.isOperator(found.principal),
    );
  },
  onWarning: (message) => log('warning', { message }),
  logger: log,
  logFailureMessages: process.env.LOG_FAILURE_MESSAGES === 'true',
  ...(documentConverter ? { documentConverter } : {}),
  ...(phraseArchive ? { phraseArchive } : {}),
});

const admin = createAdmin({
  platformTenant,
  store: platform.definitions,
  plugins: platform.plugins,
  settings,
  models: platform.models,
  extensions: platform.extensions,
  tenants: () => platform.directory.list(),
  ...(db ? { records: db.adminRecords } : {}),
});
const app = createApp(version, {
  platform: {
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    models: platform.models,
    admin,
    tasks: kernelTaskReader(platform.kernel, {
      kind: 'operator',
      issuer: 'platform',
      subject: 'task-reader',
    }),
    tenantDirectory: () => platform.directory.list(),
    organisationName: (orgNumber) =>
      (testData.organisations ?? []).find((o) => o.orgno === orgNumber)?.name,
    tenantQuota: platform.quota,
    tenantGate: platform.tenantGate,
    registered: platform.registered,
    caller: platform.caller,
    lifecycle: platform.lifecycle,
    auth: bearerAuthenticator(verifier, operators.isOperator),
    drafts: platform.serviceDrafts,
    names: actorNames(configEntries),
    lockdown,
  },
});
platform.mount(app, admin);

const localTestSets = readTestSets(
  [
    join(import.meta.dirname, '..', '..', '..', 'packages', 'eval', 'testsets'),
    join(import.meta.dirname, '..', '..', '..', 'packages', 'jobs', 'examples', 'testsets'),
  ],
  platformTenant,
);
for (const outcome of await seedTestSets(
  admin,
  platform.evalStores.testSets,
  testSetsOfServices(
    localTestSets.sets,
    readGitDefinitions(definitionSources, platformTenant).definitions,
  ),
))
  if (outcome.state !== 'present') log(`test set ${outcome.state}`, outcome);
for (const unreadable of localTestSets.unreadable) log('test set unreadable', { ...unreadable });

const seeded = withoutUnknownVariantModels(
  readGitDefinitions(definitionSources, platformTenant).definitions,
  (id) => platform.plugins.models.has(id),
);
for (const dropped of seeded.dropped)
  log('variant skipped: its model is not configured', { ...dropped });
if (
  await platform.directory.ensure(
    {
      orgNumber: platformTenant,
      name:
        (testData.organisations ?? []).find((o) => o.orgno === platformTenant)?.name ??
        (platformTenant === defaultPlatformTenant ? 'Digitaliseringsdirektoratet' : platformTenant),
      status: 'active',
    },
    'platform:seed',
  )
)
  log('platform tenant registered', { tenant: platformTenant });

for (const outcome of await seedDefinitions(admin, platform.definitions, seeded.definitions))
  if (outcome.state === 'published') log('definition published', outcome);
  else if (outcome.state === 'skipped') log('definition skipped', outcome);

const clientsDir = join(configDir, 'clients');
for (const file of existsSync(clientsDir)
  ? readdirSync(clientsDir).filter((f) => f.endsWith('.yaml'))
  : []) {
  const definition = ownedByPlatformTenant(
    parseYaml(readFileSync(join(clientsDir, file), 'utf8')) as {
      metadata: { tenant: string; id: string };
    },
    platformTenant,
  );
  const { tenant, id } = definition.metadata;
  if (await clients.get(tenant, id)) continue;
  const result = await admin.perform(platformActor('seed', tenant), 'platform.clients.save', {
    tenant,
    definition,
    reason: 'local configuration',
  });
  log(result.ok ? 'client registered' : 'client skipped', {
    file,
    task: result.task,
    ...(result.ok ? {} : { errors: result.errors }),
  });
}
await platform.toolConnections
  .reload()
  .catch((error: unknown) => log('tool connections not loaded at boot', { error: String(error) }));
if (db)
  followChanges(db.changes, {
    settings,
    supportSessions: db.adminRecords,
    catalog: platform.catalog,
    definitions: platform,
    models: platform.models,
    toolConnections: platform.toolConnections,
  });
if (mock) {
  documentMockRoutes(app);
  app.route('/mock/ansattporten', mock.app);
  if (altinnPdp.kind === 'mock') app.route('/mock/altinn', altinnPdp.app);
  app.post('/mock/dev-login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { as?: string; pid?: string };
    const operator = body.as === 'operator';
    const pid =
      body.pid ?? (operator ? identityFile.devLogin.operator : identityFile.devLogin.employee);
    const person = mock.testData.persons.find((p) => p.pid === pid);
    if (!person) return unknownTestPerson(c);
    const tokens = await mock.testTokens(person.pid, 'local-portal', [resource]);
    const verified = await verifier.verify(tokens.access_token);
    if (operator) operators.add(verified.principal.subject);
    const orgs = [...new Set((verified.principal.authorizedFor ?? []).map((a) => a.org))];
    return c.json({
      token: tokens.access_token,
      name: person.name,
      organisations: person.parties
        .filter((p) => orgs.includes(p.orgno))
        .map((p) => ({
          orgNumber: p.orgno,
          name: p.name,
          actions: [
            ...new Set(
              (verified.principal.authorizedFor ?? [])
                .filter((a) => a.org === p.orgno)
                .flatMap((a) => a.actions ?? []),
            ),
          ],
        })),
      roles: operator ? ['GenAI.Operator'] : [],
    });
  });
}

const logRequests = process.env.LOG_REQUESTS === 'true';
const fetchHandler: typeof app.fetch = logRequests
  ? async (request, ...rest) => {
      const response = await app.fetch(request, ...rest);
      log('request', {
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
      });
      return response;
    }
  : app.fetch;

serve({ fetch: fetchHandler, port }, (info) => {
  log('api listening', { port: info.port, version, mockLogin: Boolean(mock) });
});
