import pg, { type Pool } from 'pg';
import { createPool, withClientErrorListener, type PostgresPoolOptions } from './pool.js';
import { PostgresConversationStore } from './conversations.js';
import type { KeyWrapper } from './crypto.js';
import { PostgresEventLog } from './event-log.js';
import { PostgresIdentities } from './identities.js';
import { ContentKeys } from './keys.js';
import { migrate, runtimeRole } from './schema.js';
import { PostgresStateStore, PostgresTaskStore } from './stores.js';
import { PostgresTenants } from './tenancy.js';
import { PostgresApiKeys } from './api-keys.js';
import { PostgresModelClassifications } from './models.js';
import { PostgresAdminRecords } from './admin-records.js';
import { PostgresClients } from './clients.js';
import { PostgresWebhookDeliveries } from './webhook-deliveries.js';
import { PostgresTriggerRuns } from './trigger-runs.js';
import { PostgresConfigEntries } from './config-entries.js';
import { PostgresConnections } from './connections.js';
import {
  PostgresCandidateStore,
  PostgresEvalRunStore,
  PostgresFeedbackStore,
  PostgresLabelStore,
  PostgresTestSetStore,
} from './eval.js';
import { PostgresTenantSecrets } from './secrets.js';
import { PostgresSettingsStore } from './settings.js';
import { PostgresChangeFeed } from './change-feed.js';
import { PostgresIngestionExecutions } from './executions.js';
import { PostgresRateLimiter } from './rate-limits.js';
import { PostgresRetentionStore, PostgresThreadRetention } from './retention.js';

export {
  createPool,
  entraPostgresScope,
  type PasswordProvider,
  type PostgresPoolOptions,
} from './pool.js';
export {
  cachedEntraPassword,
  managedIdentityTokenSource,
  postgresSourceFromEnv,
  usesEntraPostgres,
  type AccessToken,
  type TokenSource,
} from './entra.js';
export {
  PostgresAdminRecords,
  type PostgresAuditEntry,
  type PostgresSupportSession,
} from './admin-records.js';
export { PostgresClients } from './clients.js';
export { PostgresWebhookDeliveries } from './webhook-deliveries.js';
export { PostgresTriggerRuns } from './trigger-runs.js';
export { PostgresLeaderLease } from './leader-lease.js';
export { PostgresRateLimiter, type PostgresRateDecision } from './rate-limits.js';
export { PostgresRetentionStore, PostgresThreadRetention } from './retention.js';
export { PostgresConfigEntries, type PostgresConfigEntry } from './config-entries.js';
export { PostgresConnections } from './connections.js';
export {
  PostgresCandidateStore,
  PostgresEvalRunStore,
  PostgresFeedbackStore,
  PostgresLabelStore,
  PostgresTestSetStore,
} from './eval.js';
export { PostgresTenantSecrets } from './secrets.js';
export { PostgresSettingsStore } from './settings.js';
export {
  PostgresApiKeys,
  type NewApiKey,
  type NewKeyPolicy,
  type PostgresApiKey,
  type PostgresKeyPolicy,
  type RestoredApiKey,
  type StoredKeyPolicy,
} from './api-keys.js';
export { PostgresConversationStore, threadScope } from './conversations.js';
export { LocalKeyWrapper, type KeyWrapper } from './crypto.js';
export { PostgresDefinitionStore } from './definitions.js';
export { erased, PostgresEventLog } from './event-log.js';
export { PostgresIdentities } from './identities.js';
export { PostgresModelClassifications } from './models.js';
export { ContentKeys } from './keys.js';
export { grantRuntimeRole, migrate, runtimeRole } from './schema.js';
export {
  PostgresStateStore,
  PostgresTaskStore,
  type TaskQuery,
  type TaskSummary,
} from './stores.js';
export {
  PostgresTenants,
  withPlatformAccess,
  withTenant,
  type TenantRecord,
  type TenantStatus,
} from './tenancy.js';
export {
  PostgresChangeFeed,
  type ChangeTopic,
  type PostgresChangeFeedOptions,
} from './change-feed.js';
export {
  executionScope,
  PostgresIngestionExecutions,
  type IngestionExecution,
  type IngestionExecutionReport,
  type IngestionExecutionStatus,
} from './executions.js';

const runtimePoolFor = (owner: Pool) =>
  withClientErrorListener(
    new pg.Pool({
      ...owner.options,
      password: owner.options.password,
      allowExitOnIdle: true,
      options: [owner.options.options, `-c role=${runtimeRole}`].filter(Boolean).join(' '),
    }),
  );

export const createPostgresStores = async (
  source: Pool | PostgresPoolOptions,
  wrapper: KeyWrapper,
  options: {
    pollMs?: number;
    changePollMs?: number;
    onError?: (error: unknown) => void;
    runtime?: Pool | PostgresPoolOptions;
  } = {},
) => {
  const owner = 'query' in source ? withClientErrorListener(source) : createPool(source);
  const onError =
    options.onError ??
    ((error: unknown) => process.emitWarning(`postgres connection error: ${String(error)}`));
  if (owner.listenerCount('error') === 0) owner.on('error', onError);
  await migrate(owner);
  const pool =
    options.runtime === undefined
      ? runtimePoolFor(owner)
      : 'query' in options.runtime
        ? withClientErrorListener(options.runtime)
        : createPool(options.runtime);
  if (pool.listenerCount('error') === 0) pool.on('error', onError);
  const keys = new ContentKeys(pool, wrapper);
  const log = new PostgresEventLog(pool, keys, options.pollMs, onError);
  await log.start();
  const changes = new PostgresChangeFeed(pool, {
    onError,
    ...(options.changePollMs === undefined ? {} : { pollMs: options.changePollMs }),
  });
  await changes.start();
  return {
    log,
    changes,
    tasks: new PostgresTaskStore(pool, keys),
    state: new PostgresStateStore(pool, keys),
    conversations: new PostgresConversationStore(pool, keys),
    identities: new PostgresIdentities(pool, keys),
    tenants: new PostgresTenants(pool),
    apiKeys: new PostgresApiKeys(pool),
    modelClassifications: new PostgresModelClassifications(pool),
    settings: new PostgresSettingsStore(pool, keys),
    adminRecords: await PostgresAdminRecords.open(pool),
    tenantSecrets: new PostgresTenantSecrets(pool, keys),
    connections: new PostgresConnections(pool),
    eval: {
      testSets: new PostgresTestSetStore(pool),
      runs: new PostgresEvalRunStore(pool),
      feedback: new PostgresFeedbackStore(pool, keys),
      candidates: new PostgresCandidateStore(pool, keys),
    },
    labels: new PostgresLabelStore(pool),
    clients: new PostgresClients(pool),
    webhookDeliveries: new PostgresWebhookDeliveries(pool),
    triggerRuns: new PostgresTriggerRuns(pool),
    configEntries: new PostgresConfigEntries(pool),
    ingestionExecutions: new PostgresIngestionExecutions(pool),
    rateLimits: new PostgresRateLimiter(pool),
    retention: new PostgresRetentionStore(pool),
    threadRetention: new PostgresThreadRetention(pool, keys),
    erase: (tenant: string, scope: string) => keys.erase(tenant, scope),
    pool: owner,
    runtimePool: pool,
    close: async () => {
      await changes.close();
      await log.close();
    },
  };
};
