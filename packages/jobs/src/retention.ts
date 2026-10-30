import type { CompiledCapability, SettingsRegistry } from '@genai/definitions';
import {
  type RetentionGroup,
  type RetentionPolicy,
  type RetentionStore,
  type ThreadRetentionStore,
} from '@genai/kernel';
import type { BlobStore } from '@genai/port-blob';
import { retentionFor } from './retention-policy.js';
import { purgeRunDocuments } from './run-documents.js';
import type { TraceDeliveryStore } from './trace-deliveries.js';
import { schedule, type Clock, type ScheduledJob } from './scheduler.js';

const dayMs = 86_400_000;

export interface RetentionDeps {
  store: RetentionStore;
  settings: SettingsRegistry;
  capabilities(): Promise<CompiledCapability[]>;
  threads?: ThreadRetentionStore;
  documents?: Pick<BlobStore, 'list' | 'delete'>;
  tenants?: () => Promise<string[]>;
  /** Traces sent to a sink are deleted there too once their task's content is purged. */
  deliveries?: Pick<TraceDeliveryStore, 'markPending'>;
  now?: () => Date;
}

export interface RetentionRun {
  at: string;
  groups: (RetentionGroup & RetentionPolicy & { payloads: number; envelopes: number })[];
  traceDeletes: number;
  payloads: number;
  envelopes: number;
  conversations: number;
  documents: number;
}

const serviceNamed = (capabilities: CompiledCapability[], tenant: string, agent: string) =>
  capabilities.find(
    (c) =>
      c.capability.descriptor.id === agent ||
      (c.service.tenant === tenant &&
        (c.service.id === agent || c.publicName === agent || c.aliases.includes(agent))),
  );

export const purgeExpired = async (deps: RetentionDeps): Promise<RetentionRun> => {
  const now = (deps.now ?? (() => new Date()))();
  const capabilities = await deps.capabilities();
  const byId = new Map(capabilities.map((c) => [c.capability.descriptor.id, c]));
  const groups: RetentionRun['groups'] = [];
  let traceDeletes = 0;
  for (const group of await deps.store.groups()) {
    const policy = retentionFor(deps.settings, group.tenant, byId.get(group.capability));
    const {
      tasks,
      traceDeletes: marked,
      ...purged
    } = await deps.store.purge({
      ...group,
      payloadBefore: new Date(now.getTime() - policy.payloadDays * dayMs),
      envelopeBefore: new Date(now.getTime() - policy.envelopeDays * dayMs),
    });
    if (marked !== undefined) traceDeletes += marked;
    else if (deps.deliveries && tasks.length > 0)
      traceDeletes += await deps.deliveries.markPending(group.tenant, { tasks }, now.toISOString());
    groups.push({ ...group, ...policy, ...purged });
  }
  let conversations = 0;
  const tenants = new Set([
    ...groups.map((g) => g.tenant),
    ...capabilities.map((c) => c.service.tenant),
    ...((await deps.tenants?.()) ?? []),
  ]);
  if (deps.threads) {
    for (const tenant of tenants)
      for (const agent of await deps.threads.agents(tenant)) {
        const policy = retentionFor(
          deps.settings,
          tenant,
          serviceNamed(capabilities, tenant, agent),
        );
        conversations += await deps.threads.purge({
          tenant,
          agent,
          before: new Date(now.getTime() - policy.payloadDays * dayMs),
        });
      }
  }
  const documents = deps.documents
    ? await purgeRunDocuments({
        blobs: deps.documents,
        settings: deps.settings,
        capabilities,
        tenants,
        now,
      })
    : 0;
  return {
    at: now.toISOString(),
    groups,
    payloads: groups.reduce((n, g) => n + g.payloads, 0),
    envelopes: groups.reduce((n, g) => n + g.envelopes, 0),
    conversations,
    documents,
    traceDeletes,
  };
};

export const scheduleRetention = (
  deps: RetentionDeps & {
    cron?: string;
    clock?: Clock;
    active?: () => Promise<boolean>;
    onRun?: (run: RetentionRun) => void;
    onError?: (error: unknown) => void;
  },
): ScheduledJob =>
  schedule(
    deps.cron ?? '17 3 * * *',
    async () => {
      if (deps.active && !(await deps.active())) return;
      deps.onRun?.(await purgeExpired(deps));
    },
    {
      timeZone: 'Europe/Oslo',
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.onError ? { onError: deps.onError } : {}),
    },
  );
