import {
  actingClient,
  createBff,
  InMemoryBffSessions,
  organisationsOf,
  platformAppActing,
} from './bff/index.js';
import { remoteFileOriginsFrom } from '@genai/adapter-rest';
import { platformLoginFrom } from './platform-login.js';
import { binderTrustFrom } from './binder-token.js';
import { hostnameSetupFrom } from './hostname-claims.js';
import {
  assistantHostnameFrom,
  hostedHostnamesFrom,
  hostView,
  reservedDomainsFrom,
} from './hosts.js';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { attachSessionUpgrade } from './session-upgrade.js';
import { mockClientSync } from './mock-clients.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { residencies, type DiscoveryListing, type Residency } from '@genai/port-model';
import {
  altinnPolicy,
  apiKeyDigest,
  createAuthenticator,
  createTokenVerifier,
  InMemoryClients,
  InMemoryIdentities,
  serviceAccessPolicy,
  type IdentityTestDataInput,
} from '@genai/identity';
import {
  envSecrets,
  InMemoryEventLog,
  InMemoryHostnameClaims,
  InMemoryStateStore,
  InMemoryTaskStore,
  type EventLog,
} from '@genai/kernel';
import { createTraceExporter, observedEventLog } from '@genai/providers-langfuse';
import {
  createPostgresStores,
  ingestSender,
  knowledgeReadSourceFromEnv,
  knowledgeSourceFromEnv,
  LocalKeyWrapper,
  managedIdentityTokenSource,
  PostgresDefinitionStore,
  PostgresDiscoveredModels,
  PostgresJobRuns,
  postgresSourceFromEnv,
} from '@genai/providers-postgres';
import { knowledgeDropQueue, knowledgeFieldsQueue, knowledgeKeys } from '@genai/jobs';
import { PgBossJobQueue } from '@genai/providers-pgboss';
import { parse as parseYaml } from 'yaml';
import { FileSystemBlobStore } from '@genai/port-blob';
import type { PolicyDecisionPoint } from '@genai/kernel';
import { documentConverterFrom, phraseArchiveFrom } from './document-converter.js';
import { evalSlotLimitsFromEnv, shutdownGraceFromEnv } from './eval-slots.js';
import { drainBeforeExit } from './shutdown.js';
import { blockOriginFrom, blockPortFrom, frameAncestorsFrom } from './block-origin.js';
import { createBlockFrames } from './block-frames.js';
import { createAdmin, platformActor, type AuditEntry } from './admin.js';
import { createAccessPeopleModule, peopleSourceFrom, selectedPeople } from './access-people.js';
import { draftServices } from './access-draft-services.js';
import { InMemoryTenantApiKeys, type TenantApiKeys } from './routes/portal-routes.js';
import type { PriceSpec, Principal } from '@genai/contracts';
import { postgresKeyPolicies, postgresTenantKeys } from './tenant-keys.js';
import {
  forgetsTestIdEraRevocation,
  forgetTestIdEraRevocation,
  revokeTestIdEra,
  revokesTestIdEra,
} from './testid-era.js';
import { clientRegistry, notifyingClients, type ClientListener } from './frontends.js';
import { actorNames } from './actor-names.js';
import {
  databaseHosts,
  knowledgeServerEndpoints,
  savedKnowledgeCatalog,
  defaultPlatformTenant,
  environmentTierOf,
  openKnowledgePools,
  processorRecordCheckOf,
  ownedByPlatformTenant,
  platformTenantFrom,
  keepRunningOnRejection,
  modelDiscoveryFromEnv,
  scheduleModelRelist,
  tenantSampleRate,
  envFlagsIn,
} from '@genai/composition';
import { buildTimeOf, createApp } from './app.js';
import { defaultSlowRequestMs } from './request-timing.js';
import { sharedLimiter } from './rate-limit.js';
import { kernelTaskReader } from './timeline.js';
import { followChanges, refreshEverywhere } from './change-feed.js';
import { postgresTaskIndex, postgresTenantDirectory } from './postgres-adapters.js';
import { loadCatalog } from './catalogs.js';
import {
  createPlatform,
  platformCaller,
  platformModules,
  serviceRequirement,
} from './composition.js';
import {
  createDefinitionSourcesModule,
  localDefinitionSources,
  readGitDefinitions,
  seedDefinitions,
  type DefinitionSource,
} from './definition-sources.js';
import { withoutUnknownVariantModels } from './seed-variants.js';
import { readTestSets, seedTestSets, testSetsOfServices } from './seed-test-sets.js';
import { readPipelineSeeds, seedPipelines } from './pipeline-seeds.js';
import { readDemoSeeds, seedDemos } from './demos.js';
import { operatorDirectory, operatorSubjectsFrom, splitOperators } from './operators.js';
import { testRunnerKeysAllowed } from './test-runner.js';
import { altinnPdpFrom, withPdpActions } from './altinn-pdp.js';
import { federatedAppTokens, gatewayUsageConfigFromEnv } from '@genai/providers-ai-gateway';
import {
  bootProblems,
  devModeWarning,
  isDevMode,
  knowledgeServerProblems,
  tracesContent,
} from './boot-guard.js';
import { loginIssuers } from './login-issuers.js';
import { environmentsOf } from './service-environments.js';
import { documentMockRoutes } from './openapi/access.js';
import { unknownTestPerson } from './dev-login.js';
import { asPlatformResource } from './platform-resource.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { admitMaskinportenClients, maskinportenClientRegistry } from './maskinporten-clients.js';
import { employeeClientIds, isLockdown, operatorClientIds, trustedEntraFrom } from './lockdown.js';

/**
 * Runs that run as knowledge jobs (ADR 0042) send their jobs only to the platform server, as
 * genai_runtime; pg-boss starts for sending on the first send, since the worker installs it.
 */
const knowledgeJobRuns = (runtimePool: Parameters<typeof PgBossJobQueue.start>[0]) => {
  let queue: Promise<PgBossJobQueue> | undefined;
  const started = () =>
    (queue ??= PgBossJobQueue.start(runtimePool, { works: false }).catch((error: unknown) => {
      queue = undefined;
      throw error;
    }));
  return {
    runs: new PostgresJobRuns(runtimePool, {
      send: async (run, transaction) => ingestSender(await started()).send(run, transaction),
    }),
    // A generation an engine switch left on the knowledge server is dropped by the worker (ADR 0025).
    drop: async (input: { tenant: string; dataset: string; generation: string }) => {
      await (
        await started()
      ).send(knowledgeDropQueue, input, { key: knowledgeKeys.drop(input.dataset) });
    },
    // New fields on a dataset's stored documents, written by the worker (ADR 0042).
    refreshFields: async (input: { tenant: string; dataset: string; fill: string }) => {
      const data = knowledgeFieldsQueue.payload.parse(input);
      await (
        await started()
      ).send(knowledgeFieldsQueue, data, { key: knowledgeKeys.fields(input.dataset) });
    },
  };
};

const envFile = join(import.meta.dirname, '..', '..', '..', '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT ?? 8080);
const version = process.env.APP_VERSION ?? 'dev';
const audience = process.env.API_AUDIENCE ?? 'digdir:genai';
const configDir = process.env.CONFIG_DIR ?? join(import.meta.dirname, '..', 'config', 'local');
const resource = process.env.ALTINN_RESOURCE ?? 'urn:altinn:resource:digdir-genai-platform';
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ msg, ...extra }));
keepRunningOnRejection(log);

const gatewayUsage = gatewayUsageConfigFromEnv(process.env);
const refused = [...bootProblems(process.env), ...gatewayUsage.problems];
if (refused.length > 0) {
  log('refusing to start', { problems: refused });
  process.exit(1);
}
if (isDevMode(process.env)) {
  console.warn(`\n*** DEV MODE ***\n${devModeWarning}\n`);
  log('dev mode', { warning: devModeWarning });
}
const platformTenant = platformTenantFrom(process.env);
const enhetsregisteret =
  process.env.ENHETSREGISTERET_URL ?? 'https://data.brreg.no/enhetsregisteret/api/enheter';
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
const altinnPdp = altinnPdpFrom(process.env, testData);
log('altinn pdp', {
  kind: altinnPdp.kind,
  ...(altinnPdp.kind === 'altinn' ? { baseURL: altinnPdp.baseURL } : {}),
});
if (altinnPdp.kind === 'altinn')
  void altinnPdp
    .warm()
    .catch((error: unknown) => log('altinn token not fetched at boot', { error: String(error) }));

const databaseSource = postgresSourceFromEnv(process.env);
const db = databaseSource
  ? await createPostgresStores(databaseSource, LocalKeyWrapper.fromEnv(process.env), {
      onError: (error) => log('postgres connection error', { error: String(error) }),
      ...(process.env.DATABASE_RUNTIME_URL
        ? { runtime: { connectionString: process.env.DATABASE_RUNTIME_URL } }
        : {}),
    })
  : undefined;
log('storage', { kind: db ? 'postgres' : 'memory' });

let mockRegistration: ClientListener = {};
const clients = notifyingClients(db?.clients ?? new InMemoryClients(), {
  saved: (client, before) => mockRegistration.saved?.(client, before),
  removed: (client) => mockRegistration.removed?.(client),
});
const platformLogin = platformLoginFrom(process.env, audience);
if (platformLogin)
  log('platform login for hosted assistants', {
    hostname: platformLogin.hostname,
    secret: platformLogin.secret !== undefined,
    subjectsKept: platformLogin.subjectKeyKept,
    apps: platformLogin.apps.map((a) => a.app),
  });
const registeredClients = clientRegistry(
  clients,
  platformLogin && { ...platformLogin, current: actingClient },
);

const trustedEntra = trustedEntraFrom(process.env, platformTenant, resource);
const entraOnly = altinnPdp.kind === 'none';
if (trustedEntra)
  log('Entra logins in the configured groups get rights in the platform organisation', {
    entraOnly,
    groups: trustedEntra.groups.length,
    userGroups: trustedEntra.userGroups?.length ?? 0,
    serviceGroups: trustedEntra.serviceGroups?.length ?? 0,
    serviceClients: trustedEntra.serviceClientIds?.length ?? 0,
    clients: trustedEntra.clientIds.length,
    emailDomain: trustedEntra.emailDomain ?? null,
  });
const { trusted, mock, mockIssuer } = await loginIssuers({
  env: process.env,
  port,
  audience,
  testData,
  registeredClients,
  platformLoginClients: platformLogin ? [platformLogin.clientId] : [],
  ...(platformLogin ? { platformLoginKey: platformLogin.subjectKey } : {}),
  platformAppSession: () => platformAppActing() !== undefined,
  ...(trustedEntra ? { trustedEntra } : {}),
  entraOnly,
  onKeysNotFetched: (fields) => log('login keys not fetched', fields),
});
let clientSecretOf: (tenant: string, name: string) => Promise<string | undefined> = async () =>
  undefined;
if (mock) mockRegistration = mockClientSync(mock.clients, audience, (t, n) => clientSecretOf(t, n));
if (mock && platformLogin?.secret)
  mock.clients.register({
    clientId: platformLogin.clientId,
    redirectUris: [`${platformLogin.origin}/auth/callback`],
    postLogoutRedirectUris: [`${platformLogin.origin}/auth/logged-out`],
    audience,
    tokenEndpointAuthMethod: 'client_secret_basic',
    clientSecret: platformLogin.secret,
  });
const operatorSubjects = operatorSubjectsFrom(process.env);
const operators = operatorDirectory({
  pids: identityFile.operatorPids,
  subjects: operatorSubjects,
  clientIds: [
    ...operatorClientIds(process.env),
    ...(platformLogin && platformLogin.apps.length > 0 ? [platformLogin.clientId] : []),
  ],
  ...(mockIssuer ? { mockIssuer } : {}),
});
if (!mock && identityFile.operatorPids.length > 0)
  log('ignoring operator: true in identity.yaml; it applies only to the dev-mode mock login', {
    persons: identityFile.operatorPids.length,
  });
const bareSubjects = operatorSubjects.filter((s) => !s.includes('|')).length;
if (!mock && bareSubjects > 0)
  log('ignoring OPERATOR_SUBJECTS entries without an issuer; they apply only to the mock login', {
    entries: bareSubjects,
  });
const reservedClientIds = [
  ...(testData.clients ?? []).map((c) => c.clientId),
  ...operatorClientIds(process.env),
  ...employeeClientIds(process.env),
  ...(platformLogin ? [platformLogin.clientId] : []),
];
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
        content: tracesContent(process.env),
        ...(process.env.TRACES_ENVIRONMENT ? { environment: process.env.TRACES_ENVIRONMENT } : {}),
      },
      {
        secrets,
        tasks: async (id) => (await tasks.get(id))?.task,
        serviceName: 'genai-api',
        sampleRateFor: (tenant) => tenantSampleRate(settings)(tenant),
      },
    )
  : undefined;
const traceResidency = residencies.includes(process.env.TRACES_RESIDENCY as Residency)
  ? (process.env.TRACES_RESIDENCY as Residency)
  : 'global';
log('traces', { enabled: Boolean(traces), content: tracesContent(process.env) });

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

const savedKnowledge = savedKnowledgeCatalog(
  db ? await db.configEntries.latest({ kind: 'knowledge-endpoint' }) : [],
);
const knowledgeRefused = [
  ...knowledgeServerProblems(process.env, catalogs.knowledge.catalog),
  ...knowledgeServerProblems(process.env, savedKnowledge),
];
if (
  !process.env.KNOWLEDGE_DATABASE_URL &&
  !process.env.KNOWLEDGE_PGHOST &&
  knowledgeServerEndpoints(savedKnowledge).length > 0
)
  log('warning', {
    message: `saved knowledge endpoints skipped, no knowledge server is configured: ${knowledgeServerEndpoints(savedKnowledge).join(', ')}`,
  });
if (knowledgeRefused.length > 0) {
  log('refusing to start', { problems: knowledgeRefused });
  process.exit(1);
}
const knowledgeSource = knowledgeSourceFromEnv(process.env, 'api');
const knowledgeReadSource = knowledgeReadSourceFromEnv(process.env);
const knowledgeServer = knowledgeSource
  ? openKnowledgePools(knowledgeSource, 'api', knowledgeReadSource)
  : undefined;
log('knowledge server', {
  configured: Boolean(knowledgeServer),
  readHost: knowledgeReadSource?.host ?? 'primary',
});

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
  ? ((parseYaml(readFileSync(pricesFile, 'utf8')) as { models?: Record<string, PriceSpec> })
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

const documentConverter = documentConverterFrom(process.env, secrets, log);
const phraseArchive = phraseArchiveFrom(process.env, log);
log('document converter', { converter: process.env.DOCUMENT_CONVERTER ?? 'local' });

const configEntries = db?.configEntries ?? new InMemoryConfigEntryStore();
const accessPeople = peopleSourceFrom(process.env, testData, resource);
log('altinn people', { kind: accessPeople.kind });
const admitClients = admitMaskinportenClients(
  maskinportenClientRegistry(configEntries),
  trusted.filter((t) => t.kind === 'maskinporten').map((t) => t.issuer),
);

const definitionSources: DefinitionSource[] = [
  ...localDefinitionSources(configDir, process.env),
  ...(process.env.SEED_PARITY_SERVICES === 'true'
    ? [
        {
          dir: join(import.meta.dirname, '..', '..', 'parity', 'config', 'services'),
          promptsDir: join(configDir, 'prompts'),
        },
      ]
    : []),
];

const lockdown = isLockdown(process.env);
if (lockdown)
  log('lockdown: only configured keys, trusted Entra logins and their keys may use models', {
    configuredKeys: configuredKeys.size,
  });

const environmentTier = environmentTierOf(process.env);
if (environmentTier === 'test')
  log('GENAI_ENV=test: operators may try descriptors in review on synthetic data');

const testRunnerKeys = testRunnerKeysAllowed(process.env);
if (testRunnerKeys)
  log('GENAI_TEST_RUNNER_KEYS=true: operators may give test-runner keys for the smoke test');

const processorRecords = processorRecordCheckOf(process.env);

const hostedHostnames = hostedHostnamesFrom(process.env);
if (platformLogin)
  for (const name of [platformLogin.hostname, ...platformLogin.apps.map((a) => a.hostname)])
    hostedHostnames.delete(name);
const hostnameClaims = db?.hostnameClaims ?? new InMemoryHostnameClaims();
const hosting = {
  hostnames: hostedHostnames,
  reservedDomains: reservedDomainsFrom(process.env),
  assistantHostname: assistantHostnameFrom(process.env),
  claims: hostnameClaims,
};
const blockOrigin = blockOriginFrom(process.env);
const hostnames = hostnameSetupFrom(process.env, hostnameClaims, hosting);
const binder = binderTrustFrom(process.env);
log('hostname claims', {
  zone: hostnames.zone ?? null,
  target: Object.keys(hostnames.target),
  binder: binder !== undefined,
});
const platform = await createPlatform({
  envFlags: envFlagsIn(process.env),
  platformTenant,
  blockOrigin,
  federatedTokens: federatedAppTokens({
    assertion: managedIdentityTokenSource(process.env.AZURE_CLIENT_ID),
  }),
  appVersion: version,
  ...(process.env.DEMO_RECORDER_KEY_SHA256
    ? { demoRecorderKeyDigest: process.env.DEMO_RECORDER_KEY_SHA256 }
    : {}),
  ...(process.env.GENAI_DEMO_RECORDER === 'scheduled'
    ? { demoRecorder: 'scheduled' as const }
    : {}),
  tracing: {
    ...(process.env.LANGFUSE_BASE_URL ? { instance: process.env.LANGFUSE_BASE_URL } : {}),
    instanceReceivesContent: process.env.LANGFUSE_INSTANCE_RECEIVES_CONTENT === 'true',
    devMode: isDevMode(process.env),
  },
  ...(lockdown ? { lockdown: { configuredKeys } } : {}),
  environmentTier,
  testRunnerKeys,
  isOperator: operators.isOperator,
  processorRecords,
  modules: [
    ...platformModules,
    createDefinitionSourcesModule(definitionSources, platformTenant),
    createAccessPeopleModule(accessPeople),
  ],
  settings,
  verifyPluginsOnBoot: true,
  clients,
  reservedClientIds,
  hosting,
  hostnames,
  ...(binder ? { binder } : {}),
  documentFileOrigins: remoteFileOriginsFrom(process.env.GENAI_DOCUMENT_FILE_ORIGINS),
  ...(platformLogin
    ? { platformLogin: { clientId: platformLogin.clientId, audience: platformLogin.audience } }
    : {}),
  ...(db ? { webhookDeliveries: db.webhookDeliveries } : {}),
  ...(db ? { traceDeliveries: db.traceDeliveries } : {}),
  ...(db ? { triggerRuns: db.triggerRuns } : {}),
  ...(db && gatewayUsage.config ? { gatewayUsage: db.usageBuckets } : {}),
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
    // The platform adds every dataset on `connection: knowledge` (createPlatform).
    ...(db ? { jobRuns: { runsAsJobs: () => false, ...knowledgeJobRuns(db.runtimePool) } } : {}),
  },
  traces: () =>
    traces && process.env.TRACES_ENDPOINT
      ? {
          endpoint: process.env.TRACES_ENDPOINT.split('?')[0] ?? '',
          content: tracesContent(process.env),
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
  ...(db ? { changes: db.changes } : {}),
  ...(knowledgeServer ? { knowledgeServer: knowledgeServer.pools } : {}),
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
  ...(enhetsregisteret ? { organizationRegistry: { url: enhetsregisteret } } : {}),
  ...(process.env.INGEST_FOLDER_ROOT ? { ingestFolderRoot: process.env.INGEST_FOLDER_ROOT } : {}),
  ...(process.env.INGEST_WORKING_DIRECTORY
    ? { ingestWorkingDirectory: process.env.INGEST_WORKING_DIRECTORY }
    : {}),
  ...(process.env.INGEST_PARQUET_MAX_BYTES
    ? { ingestParquetMaxBytes: Number(process.env.INGEST_PARQUET_MAX_BYTES) }
    : {}),
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
    platformHosts: ['localhost', '127.0.0.1', `localhost:${port}`, ...databaseHosts(process.env)],
  },
  catalogSkips: skipped,
  ...(db
    ? {
        tenantDirectory: postgresTenantDirectory(db.tenants),
        taskIndex: postgresTaskIndex(db.tasks, { events: db.log }),
        ingestionExecutions: db.ingestionExecutions,
      }
    : {}),
  state: db?.state ?? new InMemoryStateStore(),
  ...(db
    ? {
        conversations: db.conversations,
        threadErasure: db.threadErasure,
        modelClassifications: db.modelClassifications,
        discoveredModels: new PostgresDiscoveredModels<DiscoveryListing>(db.runtimePool),
        providerObjects: db.providerObjects,
        tenantSecrets: db.tenantSecrets,
        connections: db.connections,
        evalStores: db.eval,
        labels: db.labels,
        sinkLabels: db.sinkLabels,
      }
    : {}),
  policy: allowWorker(
    serviceAccessPolicy(
      altinnPolicy({
        altinn: altinnPdp.authorization,
        identities,
        requirementFor: () => serviceRequirement(resource),
      }),
      {
        selectedFor: selectedPeople(configEntries),
        identities,
        key: accessPeople.key,
        draftServiceOf: draftServices.of,
      },
    ),
  ),
  authenticate: platformCaller(authenticator, {
    isOperator: operators.isOperator,
    admit: admitClients,
  }),
  onWarning: (message) => log('warning', { message }),
  logger: log,
  logFailureMessages: process.env.LOG_FAILURE_MESSAGES === 'true',
  evalSlots: evalSlotLimitsFromEnv(process.env),
  modelDiscovery: modelDiscoveryFromEnv(process.env),
  ...(documentConverter ? { documentConverter } : {}),
  ...(phraseArchive ? { phraseArchive } : {}),
});
if (db) {
  const switchDeps = {
    platformTenant,
    config: configEntries,
    audit: (entry: AuditEntry) => db.adminRecords.appendAudit(entry),
    now: () => new Date(),
    newId: () => randomUUID(),
  };
  if (revokesTestIdEra(process.env, entraOnly)) {
    const revoked = await revokeTestIdEra({
      ...switchDeps,
      apiKeys: {
        unadmitted: () => db.apiKeys.unadmitted(),
        revoke: tenantKeys.revoke.bind(tenantKeys),
      },
      configuredKeys,
      definitions: platform.definitions,
      audited: (tenant) => db.adminRecords.audit(tenant),
    });
    if (revoked)
      log('TestID-era credentials revoked at the production login switch', { ...revoked });
  } else if (
    forgetsTestIdEraRevocation(process.env) &&
    (await forgetTestIdEraRevocation(switchDeps))
  )
    log('back on test Ansattporten: the next production login switch revokes again');
}

const learnAndAnnounce = async (actor?: Principal) => {
  const result = await platform.learnModelCapabilities(actor);
  if (result.checked.length > 0)
    await db?.changes.announce('model-classifications').catch((error: unknown) =>
      log('learned model capabilities not announced to other replicas', {
        error: String(error),
      }),
    );
  return result;
};
void learnAndAnnounce().catch((error: unknown) =>
  log('checking what discovered models can do failed', { error: String(error) }),
);
const admin = createAdmin({
  platformTenant,
  blockOrigin: platform.blockOrigin,
  flags: platform.flags,
  store: platform.definitions,
  lifecycle: platform.lifecycle,
  plugins: platform.plugins,
  settings,
  models: {
    describe: () => platform.models.describe(),
    refresh: () =>
      refreshEverywhere(platform.modelDiscovery, db?.changes, (error) =>
        log('model refresh not announced to other replicas', { error: String(error) }),
      ),
    learnCapabilities: learnAndAnnounce,
    classify: platform.models.classify.bind(platform.models),
  },
  extensions: platform.extensions,
  tenants: () => platform.directory.list(),
  names: actorNames(configEntries),
  ...(db ? { records: db.adminRecords } : {}),
});
const relist = scheduleModelRelist({
  relistIfDue: platform.modelDiscovery.relistIfDue,
  everyMs: platform.modelDiscovery.relistMs,
  onError: (error) => log('scheduled model listing failed', { error: String(error) }),
});
const builtAt = buildTimeOf(process.env.APP_BUILT_AT);
const app = createApp(version, {
  ...(builtAt ? { builtAt } : {}),
  ...(process.env.GENAI_ENV ? { environment: process.env.GENAI_ENV } : {}),
  modelDiscovery: platform.modelDiscovery.state,
  discoveryConnections: platform.modelDiscovery.connections,
  catalogSkipped: () => platform.catalog.skipped(),
  requestTiming: {
    write: (entry) => log('request', { ...entry }),
    slowMs: Number(process.env.SLOW_REQUEST_MS) || defaultSlowRequestMs,
    everyRequest: process.env.LOG_REQUESTS === 'true',
  },
  platform: {
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    models: platform.models,
    admin,
    tasks: kernelTaskReader(
      platform.kernel,
      { kind: 'operator', issuer: 'platform', subject: 'task-reader' },
      tasks,
    ),
    tenantDirectory: () => platform.directory.list(),
    organisationName: (orgNumber) =>
      (testData.organisations ?? []).find((o) => o.orgno === orgNumber)?.name,
    registeredName: async (orgNumber) => (await platform.organization(orgNumber))?.name,
    tenantQuota: platform.quota,
    tenantGate: platform.tenantGate,
    registered: platform.registered,
    caller: platform.caller,
    lifecycle: platform.lifecycle,
    drafts: platform.serviceDrafts,
    environments: (tenant, service) => environmentsOf(configEntries, tenant, service),
    unmaskedInput: platform.unmaskedInput,
    names: actorNames(configEntries),
    lockdown,
    loginRefusal: async (request) => {
      const checked = await authenticator.check(request);
      return checked.ok ? undefined : checked.code;
    },
    platformClientIds: [...operatorClientIds(process.env), ...employeeClientIds(process.env)],
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

const pipelineSeeds = readPipelineSeeds(join(configDir, 'pipelines'));
for (const unreadable of pipelineSeeds.unreadable) log('pipeline seed unreadable', unreadable);
for (const outcome of await seedPipelines(platform.ingestion, pipelineSeeds.seeds))
  if (outcome.state !== 'present') log(`pipeline ${outcome.state}`, outcome);

const demoSeeds = readDemoSeeds(join(import.meta.dirname, '..', '..', '..', 'demos'));
for (const unreadable of demoSeeds.unreadable) log('demo seed unreadable', unreadable);
for (const outcome of await seedDemos(configEntries, demoSeeds.seeds))
  if (outcome.state !== 'present') log(`demo ${outcome.state}`, outcome);

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
    contentReasons: db.adminRecords,
    catalog: platform.catalog,
    descriptors: platform.descriptors,
    definitions: platform,
    models: platform.modelDiscovery,
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
    if (operator) operators.add(verified.principal);
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

clientSecretOf = (tenant, name) =>
  platform.vault
    .resolver({
      resolve: () => Promise.reject(new Error('the client secret is not set')),
    })
    .resolve(`secret://tenant/${tenant}/${name}`)
    .catch(() => undefined);
const proxyKey = process.env.GENAI_PROXY_KEY;
if (proxyKey !== undefined && proxyKey.length < 32)
  log('GENAI_PROXY_KEY is shorter than 32 characters; the BFF trusts no host', {});
const ansattportenIssuer = trusted.find((t) => t.kind === 'ansattporten')?.issuer;
const bff = createBff({
  proxyKey: proxyKey && proxyKey.length >= 32 ? proxyKey : undefined,
  sessions: db?.bffSessions ?? new InMemoryBffSessions(),
  clients,
  rules: hosting,
  hostActive: async (hostname) =>
    (await hostView(
      {
        clients,
        definitions: platform.definitions,
        configEntries: platform.configEntries,
        rules: hosting,
        issuer: ansattportenIssuer,
        platformLogin,
      },
      hostname,
    )) !== undefined,
  issuer: ansattportenIssuer,
  platformLogin,
  platformTenant,
  isOperator: async (accessToken) =>
    operators.isOperator((await verifier.verify(accessToken)).principal),
  altinnResource: entraOnly ? undefined : resource,
  acrValues: entraOnly ? 'entraid' : undefined,
  secrets: {
    value: clientSecretOf,
    hosts: (tenant, name) => platform.vault.hosts(tenant, name),
  },
  organisations: async (accessToken) => {
    const verified = await verifier.verify(accessToken);
    return organisationsOf(verified.principal);
  },
  log,
});

const server = serve(
  { fetch: (request, env) => bff.handle(request, (r) => app.fetch(r, env)), port },
  (info) => {
    log('api listening', { port: info.port, version, mockLogin: Boolean(mock) });
  },
);
attachSessionUpgrade(server as unknown as Server, app, platform.liveSessions);
const blockServer =
  blockOrigin &&
  serve(
    {
      fetch: createBlockFrames({
        origin: blockOrigin,
        store: platform.definitions,
        frameAncestors: frameAncestorsFrom(process.env, hosting),
      }).fetch,
      port: blockPortFrom(process.env),
    },
    (info) => log('block origin listening', { port: info.port, origin: blockOrigin }),
  );

// A deploy stops this instance: start no new test-set case, let the ones running finish, then go.
const shutdownGraceMs = shutdownGraceFromEnv(process.env);
let stopping = false;
const stop = (signal: string) => {
  if (stopping) process.exit(1);
  stopping = true;
  relist.stop();
  log('api stopping', {
    signal,
    casesInFlight: platform.evalSlots.inFlight(),
    runsInFlight: platform.kernel.running(),
    shutdownGraceMs,
  });
  void drainBeforeExit(platform.kernel, platform.evalSlots, shutdownGraceMs).finally(() => {
    log('api stopped', {
      casesInFlight: platform.evalSlots.inFlight(),
      runsInFlight: platform.kernel.running(),
    });
    server.close();
    if (blockServer) blockServer.close();
    process.exit(0);
  });
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
