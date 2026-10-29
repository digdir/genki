import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachRuntimeBlocks,
  type BlockTexts,
  createRuntime,
  followChanges,
  isLockdown,
  loadCatalog,
  mayUseModels,
  ownedByPlatformTenant,
  platformTenantFrom,
  runtimeBlocksOf,
  TenantSecretVault,
  withBlockSettings,
} from '@genai/composition';
import {
  InMemoryDefinitionStore,
  platformSettings,
  SettingsRegistry,
  type ServiceDefinition,
} from '@genai/definitions';
import {
  assistantCapabilityPrefix,
  costOf,
  InMemoryTriggerRuns,
  monthlyQuotaGate,
  recordTriggerRuns,
  scheduleRetention,
  triggerId,
  lifecycleBlock,
  triggerPauseKind,
  type TokenPrice,
  type TriggerBinding,
  InMemoryJobQueue,
  platformQueues,
} from '@genai/jobs';
import {
  envSecrets,
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryTaskStore,
  type EventLog,
} from '@genai/kernel';
import { FileSystemBlobStore } from '@genai/port-blob';
import { createTraceExporter, observedEventLog } from '@genai/providers-langfuse';
import { openJobQueue } from '@genai/providers-pgboss';
import {
  createPostgresStores,
  LocalKeyWrapper,
  PostgresDefinitionStore,
  PostgresLeaderLease,
  postgresSourceFromEnv,
  runtimeRole,
} from '@genai/providers-postgres';
import { parse as parseYaml } from 'yaml';
import { isDevMode, workerBootProblems, workerDevModeWarning } from './boot-guard.js';
import { followPublished } from './follow.js';
import { createWorker, ownTenantOnly } from './worker.js';

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ msg, ...extra }));

const root = join(import.meta.dirname, '..', '..', '..');
const envFile = join(root, '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const refused = workerBootProblems(process.env);
if (refused.length > 0) {
  log('refusing to start', { problems: refused });
  process.exit(1);
}
if (isDevMode(process.env)) {
  console.warn(`\n*** DEV MODE ***\n${workerDevModeWarning}\n`);
  log('dev mode', { warning: workerDevModeWarning });
}

const servicesDir = process.env.WORKER_SERVICES_DIR ?? join(root, 'packages', 'jobs', 'examples');
const configDir = process.env.CONFIG_DIR ?? join(root, 'apps', 'api', 'config', 'local');
const blobDir = process.env.BLOB_DIR ?? join(root, '.data', 'blobs');
const platformTenant = platformTenantFrom(process.env);

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

const jobs = db
  ? await openJobQueue({ owner: db.pool, runtime: db.runtimePool }, platformQueues, {
      grantTo: runtimeRole,
      works: true,
      onError: (error) =>
        log('job queue error', {
          error: error instanceof Error ? error.message : JSON.stringify(error),
        }),
    })
  : new InMemoryJobQueue();
log('jobs', { kind: db ? 'pg-boss' : 'memory', queues: platformQueues.length });

const secrets = envSecrets();
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

const settings = new SettingsRegistry(platformSettings);
if (db) await settings.attach(db.settings);
const pricesFile = join(configDir, 'prices.yaml');
const prices = existsSync(pricesFile)
  ? ((parseYaml(readFileSync(pricesFile, 'utf8')) as { models?: Record<string, TokenPrice> })
      .models ?? {})
  : {};

const tasks = db?.tasks ?? new InMemoryTaskStore();
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
      { secrets, tasks: async (id) => (await tasks.get(id))?.task, serviceName: 'genai-worker' },
    )
  : undefined;
log('traces', { enabled: Boolean(traces) });

const blockTexts: BlockTexts = {
  disabled: (name) =>
    `Byggeklossen «${name}» er slått av for virksomheten. Slå den på igjen under Byggeklosser, eller fjern den fra tjenesten.`,
  toolTimedOut: (seconds) => `Verktøyet svarte ikke innen ${seconds} sekunder.`,
};
const knowledgeDatasets =
  (
    catalogs.knowledge.catalog as {
      datasets?: { id: string; aliases?: string[]; endpoint?: string }[];
    }
  ).datasets ?? [];
const datasetOf = (id: string) =>
  knowledgeDatasets.find((d) => d.id === id || d.aliases?.includes(id));

const lockdown = isLockdown(process.env);
if (lockdown) log('lockdown: the worker runs no triggers and refuses every model call');

const blob = new FileSystemBlobStore(blobDir);
const eventLog = db?.log ?? new InMemoryEventLog();
const runtime = await createRuntime({
  platformTenant,
  catalogs: {
    models: catalogs.models.catalog,
    knowledge: catalogs.knowledge.catalog,
    rerank: catalogs.rerank.catalog,
    embeddings: catalogs.embeddings.catalog,
  },
  secrets,
  vault: new TenantSecretVault(db?.tenantSecrets),
  settings,
  ...(db ? { configEntries: db.configEntries } : {}),
  definitions: (plugins, sharedSkill) =>
    db
      ? new PostgresDefinitionStore(
          db.runtimePool,
          { ...plugins, settings: settings.definitions() },
          undefined,
          sharedSkill,
        )
      : new InMemoryDefinitionStore(
          { ...plugins, settings: settings.definitions() },
          undefined,
          sharedSkill,
        ),
  policy: ownTenantOnly(),
  ...(lockdown ? { admitsModelUse: mayUseModels } : {}),
  log: eventLog,
  tasks,
  prices,
  ...(db
    ? {
        wrapStrategy: (strategy) => withBlockSettings(db.configEntries, strategy, blockTexts),
        decorateAfter: (store) => async (capability, context) => {
          const definition = context.definition as ServiceDefinition | undefined;
          if (definition?.kind !== 'Service') return capability;
          const blocks = await runtimeBlocksOf(definition, {
            flowSteps: async (tenant, flow) =>
              (
                (await store.get('StepFlow', tenant, flow.id, flow.version))?.definition as
                  { spec?: { steps?: unknown[] } } | undefined
              )?.spec?.steps ?? [],
            resolveDataset: (id) => datasetOf(id)?.id ?? id,
            datasetEndpoint: (id) => datasetOf(id)?.endpoint,
            sharedTools: async () => new Map(),
          });
          return attachRuntimeBlocks(capability, definition.metadata.tenant, blocks);
        },
      }
    : {}),
  state: db?.state ?? new InMemoryStateStore(),
  blobStore: blob,
  egress: {
    platformHosts: [
      'localhost',
      '127.0.0.1',
      ...databaseHosts(process.env.DATABASE_URL, process.env.DATABASE_RUNTIME_URL),
      ...(process.env.PGHOST ? [process.env.PGHOST] : []),
    ],
  },
  ...(traces ? { observe: (l: EventLog) => observedEventLog(l, traces) } : {}),
  ...(db
    ? {
        knowledgePool: db.pool,
        connections: db.connections,
        modelClassifications: db.modelClassifications,
      }
    : {}),
  searchOnlyClusters: [process.env.TYPESENSE_URL],
  onWarning: (message) => log('warning', { message }),
  logger: log,
  logFailureMessages: process.env.LOG_FAILURE_MESSAGES === 'true',
});

if (!db) {
  const promptsDir = join(servicesDir, 'prompts');
  const prompts = existsSync(promptsDir)
    ? Object.fromEntries(
        readdirSync(promptsDir).map((f) => [
          `prompts/${f}`,
          readFileSync(join(promptsDir, f), 'utf8'),
        ]),
      )
    : {};
  for (const file of readdirSync(servicesDir).filter((f) => f.endsWith('.yaml'))) {
    const text = readFileSync(join(servicesDir, file), 'utf8');
    const used = Object.fromEntries(
      Object.entries(prompts).filter(([path]) => text.includes(path)),
    );
    const result = await runtime.store.publish(
      ownedByPlatformTenant(parseYaml(text) as { metadata?: { tenant?: unknown } }, platformTenant),
      'worker:seed',
      'local configuration',
      used,
    );
    log(result.ok ? 'service published' : 'service refused', {
      file,
      ...(result.ok ? {} : { errors: result.errors }),
    });
  }
}

const loadToolConnections = async () => {
  const tenants = new Set([
    platformTenant,
    ...(await runtime.store.capabilities()).map((c) => c.service.tenant),
  ]);
  for (const tenant of tenants) {
    await runtime.mcp.load(tenant);
    await runtime.refreshTools(tenant);
  }
};
await loadToolConnections().catch((error: unknown) =>
  log('tool connections not loaded at boot', { error: String(error) }),
);

const triggerRuns = db?.triggerRuns ?? new InMemoryTriggerRuns();
const recordRun = recordTriggerRuns(triggerRuns, {
  onError: (error) => log('trigger run not recorded', { error: String(error) }),
});
const paused = async (binding: TriggerBinding) => {
  const id = triggerId(binding.service, binding.trigger);
  const latest = (await db?.configEntries.history(triggerPauseKind, binding.tenant, id))?.at(-1);
  return Boolean(latest && !latest.deleted);
};

const monthlyTokens = (tenant: string) => {
  const value = settings.effective(tenant)['usage.monthlyTokens']?.value;
  return typeof value === 'number' && value > 0 ? value : 50_000_000;
};
const usedTokens = async (tenant: string, since: string) =>
  db
    ? db.tasks.tokensUsed({ tenant, since, excludeCapabilityPrefix: assistantCapabilityPrefix })
    : 0;
const pricedModels = runtime.prices as Record<string, TokenPrice | undefined>;

const lease = db ? new PostgresLeaderLease(db.pool, 'genai-worker-triggers') : undefined;
const reportError = (error: unknown) => log('worker sync failed', { error: String(error) });
const worker = createWorker({
  runtime,
  onRun: (run) => {
    log('trigger ran', {
      service: run.binding.service,
      outcome: run.outcome,
      task: run.task,
      ...(run.usage ? { usage: run.usage } : {}),
      ...(run.costMicroNok === undefined ? {} : { costMicroNok: run.costMicroNok }),
    });
    recordRun(run);
  },
  paused,
  blocked: async (binding) =>
    db ? lifecycleBlock((k, s, i) => db.configEntries.history(k, s, i), binding) : undefined,
  admit: monthlyQuotaGate({ monthlyTokens, usedTokens }),
  meter: (task) =>
    costOf(
      eventLog.read(task, 0, () => false),
      pricedModels,
    ),
  ...(lease ? { active: () => lease.tryAcquire() } : {}),
  locked: lockdown,
});
log('worker started', { blobDir, ...(await worker.sync()) });
const following = followPublished({
  sync: async () => {
    const synced = await worker.sync();
    log('triggers synced', synced);
    return synced;
  },
  ...(lease ? { leadership: lease } : {}),
  onError: reportError,
});
const stopFollowingChanges = db
  ? followChanges(db.changes, {
      settings,
      supportSessions: { reload: async () => undefined },
      catalog: {
        refresh: async () => {
          await runtime.catalog.refresh();
          await following.run();
        },
      },
      definitions: { sync: following.run },
      models: runtime.models,
      toolConnections: { reload: loadToolConnections },
    })
  : undefined;

const retentionLease = db ? new PostgresLeaderLease(db.pool, 'genai-worker-retention') : undefined;
const retention = db
  ? scheduleRetention({
      store: db.retention,
      settings,
      capabilities: () => runtime.store.capabilities(),
      threads: db.threadRetention,
      documents: blob,
      tenants: async () => (await db.tenants.list()).map((t) => t.orgNumber),
      ...(retentionLease ? { active: () => retentionLease.tryAcquire() } : {}),
      onRun: (run) =>
        log('retention purged', {
          payloads: run.payloads,
          envelopes: run.envelopes,
          conversations: run.conversations,
          documents: run.documents,
          groups: run.groups.length,
        }),
      onError: (error) => log('retention purge failed', { error: String(error) }),
    })
  : undefined;
log('retention', { scheduled: retention?.next()?.toISOString() ?? null });

const stop = () => {
  retention?.stop();
  stopFollowingChanges?.();
  following.stop();
  worker.stop();
  void (async () => {
    await jobs.stop();
    await db?.close();
    await lease?.release();
    await retentionLease?.release();
    await db?.runtimePool.end();
    await db?.pool.end();
  })().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
