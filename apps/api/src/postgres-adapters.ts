import type { TaskStatus } from '@genai/contracts';
import { assistantCapabilityPrefix } from '@genai/jobs';
import type { DirectoryEntry, TaskIndex, TenantDirectoryStore, TrackedTask } from './extensions.js';

type TenantStatus = NonNullable<DirectoryEntry['status']>;

export interface TenantRows {
  list(): Promise<{ orgNumber: string; name?: string; status?: TenantStatus }[]>;
  ensure(
    orgNumber: string,
    input: { createdBy: string; name?: string; status?: TenantStatus },
  ): Promise<unknown>;
}

export interface TaskRows {
  list(query: { tenant?: string; status?: TaskStatus[]; limit: number }): Promise<TaskRow[]>;
  tokensUsed?(query: {
    tenant: string;
    since: string;
    excludeCapabilityPrefix?: string;
  }): Promise<number>;
}

interface TaskRow {
  id: string;
  tenant: string;
  status: string;
  createdAt: string;
  endedAt?: string;
}

export const postgresTenantDirectory = (tenants: TenantRows): TenantDirectoryStore => ({
  list: async () =>
    (await tenants.list()).map((t) => ({
      orgNumber: t.orgNumber,
      name: t.name ?? t.orgNumber,
      status: t.status ?? 'active',
    })),
  save: async (entry, by) => {
    await tenants.ensure(entry.orgNumber, {
      createdBy: by,
      name: entry.name,
      ...(entry.status ? { status: entry.status } : {}),
    });
  },
});

const tracked = (row: TaskRow): TrackedTask => ({
  task: row.id,
  tenant: row.tenant,
  status: row.status,
  at: row.endedAt ?? row.createdAt,
});

export const postgresTaskIndex = (tasks: TaskRows, limit = 1000): TaskIndex => ({
  all: async (tenant) => (await tasks.list({ ...(tenant ? { tenant } : {}), limit })).map(tracked),
  running: async () => (await tasks.list({ status: ['queued', 'running'], limit })).map(tracked),
  ...(tasks.tokensUsed
    ? {
        tokensUsed: (tenant: string, since: string) =>
          tasks.tokensUsed?.({
            tenant,
            since,
            excludeCapabilityPrefix: assistantCapabilityPrefix,
          }) ?? Promise.resolve(0),
      }
    : {}),
});
