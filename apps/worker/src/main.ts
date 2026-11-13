import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachRuntimeBlocks,
  type BlockTexts,
  boundPlatformId,
  createRuntime,
  databaseHosts,
  knowledgeServerEndpoints,
  savedKnowledgeCatalog,
  followChanges,
  isLockdown,
  knowledgeRecordsOf,
  loadCatalog,
  mayUseModels,
  openKnowledgePools,
  ownedByPlatformTenant,
  platformTenantFrom,
  runtimeBlocksOf,
  TenantSecretVault,
  tracesContent,
  withBlockSettings,
} from '@genai/composition';
import {
  defaultHeavyThreshold,
  defaultNightWindow,
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
  scheduleProviderObjectSweep,
  scheduleRetention,
  triggerId,
  lifecycleBlock,
  triggerPauseKind,
  type TokenPrice,
  type TriggerBinding,
  defaultMarkerTimeoutMs,
  InMemoryJobQueue,
  workQueues,
  type RunJobs,
} from '@genai/jobs';
import {
  envSecrets,
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryTaskStore,
  type EventLog,
} from '@genai/kernel';
import { copyListing, copyOwner, knowledgeListingOf, type CopyIds } from '@genai/ingest';
import { FileSystemBlobStore } from '@genai/port-blob';
import { aiGatewayUsageSource, gatewayUsageConfigFromEnv } from '@genai/providers-ai-gateway';
import { EgressGuard } from '@genai/providers-mcp-client';
import { nativeOutputStoreFromEnv } from '@genai/providers-azure-blob';
import { createLocalConverter } from '@genai/providers-documents';
import { createTraceExporter, observedEventLog } from '@genai/providers-langfuse';
import type { DatasetConfig } from '@genai/port-knowledge';
import { openJobQueue, PgBossRunJobs } from '@genai/providers-pgboss';
import {
  knowledgeConversionsOf,
  knowledgeHeavyWork,
  prepareGeneration,
} from '@genai/providers-pgvector';
import {
  createPostgresStores,
  executionScope,
  ingestSender,
  knowledgeSourceFromEnv,
  LocalKeyWrapper,
  platformId,
  PostgresDefinitionStore,
  PostgresJobRunRecords,
  PostgresLeaderLease,
  postgresSourceFromEnv,
  workerRole,
} from '@genai/providers-postgres';
import { parse as parseYaml } from 'yaml';
import {
  isDevMode,
  knowledgeServerProblems,
  workerBootProblems,
  workerDevModeWarning,
} from './boot-guard.js';
import { followPublished } from './follow.js';
import {
  knowledgeRuntimeInput,
  startHealthServer,
  watchKnowledgeBinding,
} from './knowledge-binding.js';
import { buildWork, checkWork, finishRun, heavyWindow, type HeavyDeps } from './heavy-work.js';
import { dropWork } from './knowledge-drop.js';
import { indexConcurrencyOf, knowledgePoolSizeOf, knowledgeWork } from './knowledge-handlers.js';
import { conversionRunJobs, openWorkerJobs } from './knowledge-jobs.js';
import { platformWork } from './platform-work.js';
import { reconcileKnowledgeRuns } from './reconciler.js';
import { runProgress } from './run-progress.js';
import { scheduleUsagePolls, usagePollWork, type PolledSource } from './usage-poll.js';
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
// The API's default, so locally the worker reads the uploads the API wrote.
const blobDir =
  process.env.BLOB_DIR ?? join(process.env.DATA_DIR ?? join(root, 'apps', 'api', '.data'), 'blobs');
const platformTenant = platformTenantFrom(process.env);

const databaseSource = postgresSourceFromEnv(process.env);
const db = databaseSource
  ? await createPostgresStores(
      databaseSource,
      LocalKeyWrapper.fromBase64(process.env.CONTENT_MASTER_KEY),
      {
        onError: (error) => log('postgres connection error', { error: String(error) }),
        role: workerRole,
        ...(process.env.DATABASE_RUNTIME_URL
          ? { runtime: { connectionString: process.env.DATABASE_RUNTIME_URL } }
          : {}),
      },
    )
  : undefined;
log('storage', { kind: db ? 'postgres' : 'memory' });

const knowledgeSource = db ? knowledgeSourceFromEnv(process.env, 'worker') : undefined;
// Read at start, so a bad value stops the worker before it takes a job.
const indexConcurrency = indexConcurrencyOf(process.env);
const knowledgeServer = knowledgeSource
  ? openKnowledgePools({ ...knowledgeSource, max: knowledgePoolSizeOf(indexConcurrency) }, 'worker')
  : undefined;
const knowledgeWriter = knowledgeServer?.pools.writer;
// Set once the runtime exists: filter indexes skipped while unbound are followed when the binding is fixed.
let followKnowledge = () => {};
const knowledgeBinding = watchKnowledgeBinding({
  platformId: () => (db ? platformId(db.pool) : Promise.resolve('')),
  ...(knowledgeWriter ? { boundTo: () => boundPlatformId(knowledgeWriter) } : {}),
  log,
  onBound: () => followKnowledge(),
});
await knowledgeBinding.start();
const health = await startHealthServer({
  port: Number(process.env.WORKER_HEALTH_PORT ?? 8081),
  ready: () => knowledgeBinding.ready(),
});
log('health', { url: health.url, knowledgeServer: Boolean(knowledgeServer) });

const secrets = envSecrets();
const catalogs = {
  models: loadCatalog(configDir, 'models.yaml', 'models'),
  knowledge: loadCatalog(configDir, 'knowledge.yaml', 'datasets'),
  rerank: loadCatalog(configDir, 'rerank.yaml', 'rerankers'),
  embeddings: existsSync(join(configDir, 'embeddings.yaml'))
    ? loadCatalog(configDir, 'embeddings.yaml', 'models')
    : { catalog: { endpoints: {}, models: [] }, skipped: [] },
};
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
const gatewayUsage = gatewayUsageConfigFromEnv(process.env);
if (gatewayUsage.problems.length > 0) {
  log('refusing to start', { problems: gatewayUsage.problems });
  process.exit(1);
}
const egressOptions = { platformHosts: ['localhost', '127.0.0.1', ...databaseHosts(process.env)] };
const polledSources: PolledSource[] =
  gatewayUsage.config && db
    ? [
        {
          source: aiGatewayUsageSource(gatewayUsage.config, {
            secrets: envSecrets(),
            egress: new EgressGuard(egressOptions),
          }),
          since: gatewayUsage.config.since,
        },
      ]
    : [];
if (gatewayUsage.config && !db) log('gateway usage is off: it needs a database');
const work = [
  ...platformWork,
  ...(db && polledSources.length > 0
    ? [usagePollWork({ sources: polledSources, store: db.usageBuckets, log })]
    : []),
];
// The queues are worked only once the worker has passed every refusal above.
const jobError = (error: unknown) =>
  log('job queue error', {
    error: error instanceof Error ? error.message : JSON.stringify(error),
  });
// Filled once the runtime and the job queues exist; the knowledge handlers read them when a job runs.
const late: {
  runtime?: Awaited<ReturnType<typeof createRuntime>>;
  jobs?: Awaited<ReturnType<typeof openWorkerJobs>>;
} = {};
const runtimeFor = (what: string) => {
  if (!late.runtime) throw new Error(`the worker is still starting, so it cannot ${what} yet`);
  return late.runtime;
};
const openedJobs = () => {
  if (!late.jobs) throw new Error('the job queues are not open yet');
  return late.jobs;
};
const settings = new SettingsRegistry(platformSettings);
if (db) await settings.attach(db.settings);
const platformSetting = <T>(key: string, fallback: T) =>
  (settings.effective(platformTenant)[key]?.value as T | undefined) ?? fallback;
// Heavy knowledge work waits for the night window (ADR 0042, "Heavy work"); both are read per job.
const heavySettings = {
  window: () => platformSetting('knowledge.nightWindow', defaultNightWindow),
  threshold: () => platformSetting('knowledge.heavyThreshold', defaultHeavyThreshold),
};
const knowledgeVcores = process.env.KNOWLEDGE_VCORES
  ? Number(process.env.KNOWLEDGE_VCORES)
  : undefined;
if (knowledgeServer && knowledgeVcores === undefined)
  log(
    "KNOWLEDGE_VCORES is not set: index builds use PostgreSQL's max_parallel_maintenance_workers",
  );
const openedKnowledge = () => {
  const knowledge = openedJobs().knowledge;
  if (!knowledge) throw new Error('no knowledge server is configured');
  return knowledge;
};
/** The catalog's datasets on the knowledge server, each with its active generation. */
const knowledgeServerDatasets = (): DatasetConfig[] => {
  const runtime = late.runtime;
  if (!runtime) return [];
  return runtime.writers
    .datasetIds((endpoint) => endpoint.options?.connection === 'knowledge')
    .flatMap((id) => {
      try {
        const { dataset } = runtime.writers.open(id, { signal: new AbortController().signal });
        return dataset.generation ? [dataset] : [];
      } catch {
        return [];
      }
    });
};
/** An engine switch's spec, as far as the worker reads it (apps/api/src/engine-switches.ts). */
interface SwitchSpec {
  dataset: string;
  to: string;
  state: string;
  generation: string;
  embedding?: DatasetConfig['embedding'];
  options?: Record<string, unknown>;
  /** A copy's naming and named documents, decided at its start (#366). */
  copy?: { ids?: CopyIds; documents?: string[] };
}
const openSwitchStates = ['running', 'failed', 'comparing', 'ready', 'activating'];
/** The dataset at a switch's endpoint, filling the switch's generation (ADR 0025). */
const switchedDataset = (spec: SwitchSpec, signal: AbortSignal): DatasetConfig | undefined => {
  try {
    const { dataset } = runtimeFor('read the catalog').writers.openAt(
      spec.dataset,
      spec.to,
      { signal },
      {
        ...(spec.embedding ? { embedding: spec.embedding } : {}),
        ...(spec.options ? { datasetOptions: spec.options } : {}),
      },
    );
    return { ...dataset, generation: spec.generation };
  } catch {
    return undefined;
  }
};
const switchOfRun = async (run: { dataset: string; engineSwitch?: string }) => {
  if (!db || !run.engineSwitch) return undefined;
  const entry = (
    await db.configEntries.history('engine-switch', executionScope(run.dataset), run.engineSwitch)
  ).at(-1);
  return entry && !entry.deleted ? (entry.spec as SwitchSpec) : undefined;
};
const switchOfGeneration = async (generation: string) => {
  if (!db) return undefined;
  const entry = (await db.configEntries.latest({ kind: 'engine-switch' })).find(
    (e) =>
      !e.deleted &&
      (e.spec as SwitchSpec).generation === generation &&
      openSwitchStates.includes((e.spec as SwitchSpec).state),
  );
  return entry?.spec as SwitchSpec | undefined;
};
const heavyDeps: HeavyDeps | undefined = knowledgeServer?.pools.owner
  ? {
      server: knowledgeHeavyWork(knowledgeServer.pools.owner),
      queue: {
        send: (queue, data, options) => openedKnowledge().send(queue, data, options),
        work: (queue, handler, options) => openedKnowledge().work(queue, handler, options),
        retime: (queues, startAfter) => openedKnowledge().retime(queues, startAfter),
        schedule: (queue, cron, data, options) =>
          openedKnowledge().schedule(queue, cron, data, options),
      },
      ...heavySettings,
      datasets: knowledgeServerDatasets,
      datasetOfGeneration: async (generation) => {
        const spec = await switchOfGeneration(generation);
        return spec && switchedDataset(spec, AbortSignal.timeout(10_000));
      },
      ...(knowledgeVcores === undefined ? {} : { vcores: knowledgeVcores }),
      log,
    }
  : undefined;
// Runs of datasets on the knowledge database, as jobs (ADR 0042): text layer only until #141.
const knowledgeRunRecords = db
  ? new PostgresJobRunRecords(
      db.runtimePool,
      ingestSender({
        send: (queue, data, options) => openedJobs().platform.send(queue, data, options),
      }),
    )
  : undefined;
const knowledgeProgress = runProgress(log);
// Converters' native output, in the Blob container CONVERSIONS_BLOB_URL names, or a folder locally (ADR 0042).
const nativeOutputs = knowledgeWriter
  ? (
      await nativeOutputStoreFromEnv(
        process.env,
        process.env.DATA_DIR ?? join(root, 'apps', 'api', '.data'),
      )
    ).store
  : undefined;
const knowledgeHandlers =
  db && knowledgeRunRecords && knowledgeWriter
    ? knowledgeWork({
        indexConcurrency,
        log,
        progress: knowledgeProgress,
        records: knowledgeRecordsOf(knowledgeWriter),
        knowledge: {
          send: (queue, data, options) => openedKnowledge().send(queue, data, options),
          sendAgain: (queue, job, options) => openedKnowledge().sendAgain(queue, job, options),
          serveAlso: (queue, key, tenant, options) =>
            openedKnowledge().serveAlso?.(queue, key, tenant, options) ?? Promise.resolve(),
        },
        // Stored conversions with the text layer, while no Docling host is configured (ADR 0042).
        conversions: knowledgeConversionsOf(knowledgeWriter),
        converter: createLocalConverter(),
        ...(nativeOutputs ? { nativeOutputs } : {}),
        heavy: heavySettings,
        runs: knowledgeRunRecords,
        pipeline: async (run) =>
          (
            await db.configEntries.history(
              'ingestion-pipeline',
              executionScope(run.dataset),
              `${run.dataset}#${run.pipeline}`,
            )
          ).find((entry) => entry.version === run.pipelineVersion && !entry.deleted)?.spec,
        dataset: (id, signal) => {
          try {
            return runtimeFor('read the catalog').writers.open(id, { signal }).dataset;
          } catch {
            return undefined;
          }
        },
        switchDataset: async (run, signal) => {
          const spec = await switchOfRun(run);
          return spec && spec.dataset === run.dataset ? switchedDataset(spec, signal) : undefined;
        },
        generationExists: async (generation: string) =>
          Boolean(
            (
              await knowledgeWriter.query(`select 1 from kn_generations where generation = $1`, [
                generation,
              ])
            ).rowCount,
          ),
        ...(knowledgeServer?.pools.owner
          ? {
              prepare: (dataset: DatasetConfig, generation: string) =>
                prepareGeneration(
                  knowledgeServer.pools.owner as Parameters<typeof prepareGeneration>[0],
                  dataset,
                  generation,
                ),
            }
          : {}),
        listingOf: (spec, scope, signal, converter) =>
          knowledgeListingOf(
            spec,
            {
              uploads: new FileSystemBlobStore(blobDir),
              converter: converter ?? createLocalConverter(),
              ...(process.env.INGEST_FOLDER_ROOT
                ? { folderRoot: process.env.INGEST_FOLDER_ROOT }
                : {}),
            },
            scope,
            signal,
          ),
        copyListingOf: async (run, signal) => {
          const spec = await switchOfRun(run);
          if (!spec || spec.dataset !== run.dataset)
            throw new Error(
              `the engine switch ${run.engineSwitch} of dataset ${run.dataset} is gone`,
            );
          const scope = executionScope(run.dataset);
          const tenant = scope === 'platform' ? platformTenant : scope;
          // The catalog still names the engine the dataset is copied from, until the switch publishes.
          const exported = runtimeFor('read the catalog').knowledge.open(
            { kind: 'dataset', id: run.dataset, tenant },
            {
              tenant,
              principal: {
                kind: 'agency-system',
                issuer: 'platform',
                subject: 'engine-switch',
                tenant,
              },
              task: `ingestion:${run.id}`,
              signal,
              meter: async () => undefined,
            },
          ).export;
          const { list, document } = exported ?? {};
          if (!list || !document)
            throw new Error(`the engine of dataset ${run.dataset} cannot hand over its documents`);
          return copyListing({
            source: { list, document },
            ...(spec.copy?.ids ? { ids: spec.copy.ids } : {}),
            ...(spec.copy?.documents ? { documents: spec.copy.documents } : {}),
          });
        },
        embedder: (dataset, ctx, request) => {
          const runtime = runtimeFor('embed');
          const residency = runtime.residencyOf(dataset.id);
          return dataset.embedding
            ? runtime.embedders.open({ kind: 'embedder', id: dataset.embedding.model }, ctx, {
                ...request,
                ...(residency ? { maxResidency: residency } : {}),
              })
            : undefined;
        },
        bound: () => knowledgeBinding.knowledgeBound(),
        admission: {
          records: knowledgeRunRecords,
          platformTenant,
          lockdown: isLockdown(process.env),
          onRefused: (message) => log('knowledge job refused', { message }),
        },
      })
    : undefined;
const workerJobs = db
  ? await openWorkerJobs({
      platform: { owner: db.pool, worker: db.runtimePool },
      ...(knowledgeServer?.pools.owner && knowledgeServer.pools.writer
        ? {
            knowledge: { owner: knowledgeServer.pools.owner, writer: knowledgeServer.pools.writer },
          }
        : {}),
      markerTimeoutMs: Number(process.env.MARKER_TIMEOUT_MS ?? defaultMarkerTimeoutMs),
      work: [
        ...work,
        ...(knowledgeHandlers?.platform ?? []),
        ...(knowledgeServer?.pools.owner
          ? [
              dropWork({
                datasets: knowledgeServerDatasets,
                server: knowledgeHeavyWork(knowledgeServer.pools.owner),
                bound: () => knowledgeBinding.knowledgeBound(),
                log,
              }),
            ]
          : []),
      ],
      ...(knowledgeHandlers
        ? {
            knowledgeWork: [
              ...knowledgeHandlers.knowledge,
              ...(heavyDeps ? [checkWork(heavyDeps)] : []),
            ],
          }
        : {}),
      open: openJobQueue,
      runJobs: (pool, queue, queues) => new PgBossRunJobs(pool, queue, queues),
      ...(knowledgeWriter
        ? {
            knowledgeRunJobs: (jobs: RunJobs) =>
              conversionRunJobs(jobs, knowledgeConversionsOf(knowledgeWriter)),
          }
        : {}),
      onError: jobError,
    })
  : undefined;
if (workerJobs) late.jobs = workerJobs;
// knowledge.build and knowledge.fill are worked only inside the night window (ADR 0042, "Jobs").
const fillWork = knowledgeHandlers?.heavy[0];
const nightWindow =
  heavyDeps && workerJobs?.knowledge && fillWork
    ? heavyWindow(heavyDeps, { build: buildWork(heavyDeps), fill: fillWork })
    : undefined;
const tickNightWindow = async () => {
  await settings.reload();
  await nightWindow?.tick();
};
if (nightWindow) await tickNightWindow();
const nightWindowTimer = nightWindow
  ? setInterval(
      () =>
        void tickNightWindow().catch((error: unknown) =>
          log('knowledge night window failed', { error: String(error) }),
        ),
      30_000,
    )
  : undefined;
const jobs = workerJobs?.platform ?? new InMemoryJobQueue();
if (!workerJobs) await workQueues(jobs, work);
await scheduleUsagePolls(jobs, polledSources);
log('jobs', {
  kind: db ? 'pg-boss' : 'memory',
  queues: work.length,
  usageSources: polledSources.map((s) => s.source.id),
  knowledgeServer: Boolean(workerJobs?.knowledge),
});
const skipped = Object.values(catalogs).flatMap((c) => c.skipped);
if (skipped.length > 0) log('catalog entries skipped for missing settings', { skipped });

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
        content: tracesContent(process.env),
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
  egress: egressOptions,
  ...(traces ? { observe: (l: EventLog) => observedEventLog(l, traces) } : {}),
  ...(db
    ? {
        knowledgePool: db.pool,
        ...knowledgeRuntimeInput(knowledgeServer, knowledgeBinding),
        connections: db.connections,
        modelClassifications: db.modelClassifications,
      }
    : {}),
  searchOnlyClusters: [process.env.TYPESENSE_URL],
  onWarning: (message) => log('warning', { message }),
  logger: log,
  logFailureMessages: process.env.LOG_FAILURE_MESSAGES === 'true',
});
followKnowledge = runtime.followKnowledge;
late.runtime = runtime;

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
log('worker started', {
  version: process.env.APP_VERSION ?? 'dev',
  blobDir,
  knowledgeIndexConcurrency: indexConcurrency,
  ...(knowledgeServer ? { knowledgePoolSize: knowledgePoolSizeOf(indexConcurrency) } : {}),
  ...(await worker.sync()),
});
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
      descriptors: runtime.descriptors,
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
      outsideRun: db.outsideRunRetention,
      documents: blob,
      tenants: async () => (await db.tenants.list()).map((t) => t.orgNumber),
      ...(retentionLease ? { active: () => retentionLease.tryAcquire() } : {}),
      onRun: (run) =>
        log('retention purged', {
          payloads: run.payloads,
          envelopes: run.envelopes,
          conversations: run.conversations,
          documents: run.documents,
          outsideRunDays: run.outsideRunDays,
          groups: run.groups.length,
        }),
      onError: (error) => log('retention purge failed', { error: String(error) }),
    })
  : undefined;
log('retention', { scheduled: retention?.next()?.toISOString() ?? null });

const sweepLease = db
  ? new PostgresLeaderLease(db.pool, 'genai-worker-provider-objects')
  : undefined;
const providerObjectSweep = db
  ? scheduleProviderObjectSweep({
      store: db.providerObjects,
      remove: (record) => runtime.models.removeProviderObject(record),
      report: (record, reason) =>
        db.adminRecords.appendAudit({
          task: record.run,
          tenant: record.tenant,
          action: 'platform.provider-object.incident',
          actor: 'platform',
          at: new Date().toISOString(),
          outcome: 'rejected',
          target: `${record.connection}/${record.objectId}`,
          reason: `${record.descriptor} left ${record.objectId} at ${record.connection} and it could not be deleted: ${reason}`,
        }),
      ...(sweepLease ? { active: () => sweepLease.tryAcquire() } : {}),
      onRun: (run) => log('provider objects swept', { ...run }),
      onError: (error) => log('provider object sweep failed', { error: String(error) }),
    })
  : undefined;

// Ends runs whose jobs have ended, starts queued runs and applies send-backs (ADR 0042, "Jobs").
const knowledgeRunsLease = db
  ? new PostgresLeaderLease(db.pool, 'genai-worker-knowledge-runs')
  : undefined;
let reconciling = false;
const reconcileKnowledge = async () => {
  // A pass may wait minutes for a VACUUM's lock; the next tick does not start a second one.
  if (reconciling) return;
  if (!knowledgeRunRecords || !workerJobs || !(await knowledgeRunsLease?.tryAcquire())) return;
  reconciling = true;
  try {
    await reconcilePass(knowledgeRunRecords, workerJobs);
  } finally {
    reconciling = false;
  }
};
const reconcilePass = async (
  records: NonNullable<typeof knowledgeRunRecords>,
  opened: NonNullable<typeof workerJobs>,
) => {
  const pass = await reconcileKnowledgeRuns({
    records,
    servers: opened.runJobs,
    lockdown,
    ...(heavyDeps
      ? { finishing: finishRun(heavyDeps, (id, counts, mode) => records.report(id, counts, mode)) }
      : {}),
    failureBudget: async (run) => {
      const spec = (
        await db?.configEntries.history(
          'ingestion-pipeline',
          executionScope(run.dataset),
          `${run.dataset}#${run.pipeline}`,
        )
      )?.find((entry) => entry.version === run.pipelineVersion)?.spec as
        { maxDocumentFailures?: number } | undefined;
      // A copy has no pipeline: it stops after 1 % of Kudos's documents have failed.
      if (run.pipeline === copyOwner) return 100;
      return spec?.maxDocumentFailures ?? 10;
    },
  });
  if (pass.sentBack + pass.ended.length + pass.started.length + pass.dropped > 0)
    log('knowledge runs reconciled', {
      sentBack: pass.sentBack,
      ended: pass.ended.map((run) => run.id),
      started: pass.started.map((run) => run.id),
      dropped: pass.dropped,
    });
};
const knowledgeReconciler = knowledgeRunRecords
  ? setInterval(
      () =>
        void reconcileKnowledge().catch((error: unknown) =>
          log('knowledge reconciler failed', { error: String(error) }),
        ),
      60_000,
    )
  : undefined;

const stop = () => {
  knowledgeProgress.stop();
  retention?.stop();
  providerObjectSweep?.stop();
  if (knowledgeReconciler) clearInterval(knowledgeReconciler);
  if (nightWindowTimer) clearInterval(nightWindowTimer);
  stopFollowingChanges?.();
  following.stop();
  worker.stop();
  void (async () => {
    await jobs.stop();
    await nightWindow?.stop();
    await workerJobs?.knowledge?.stop();
    knowledgeBinding.stop();
    await health.close();
    await knowledgeServer?.close();
    await db?.close();
    await lease?.release();
    await retentionLease?.release();
    await sweepLease?.release();
    await knowledgeRunsLease?.release();
    await db?.runtimePool.end();
    await db?.pool.end();
  })().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
