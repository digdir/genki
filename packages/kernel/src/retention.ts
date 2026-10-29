import type { RiskClass } from '@genai/contracts';
import type { InMemoryEventLog, InMemoryTaskStore } from './memory.js';

export const retentionClasses = ['transient', 'standard', 'case'] as const;

export type RetentionClass = (typeof retentionClasses)[number];

export const retentionClassDays: Readonly<Record<RetentionClass, number>> = {
  transient: 7,
  standard: 90,
  case: 365,
};

export const minimumRetentionDays: Readonly<Record<RiskClass, number>> = {
  minimal: 0,
  limited: 30,
  high: 183,
};

export interface RetentionPolicy {
  retentionClass: RetentionClass;
  riskClass: RiskClass;
  payloadDays: number;
  envelopeDays: number;
}

export const retentionPolicy = (input: {
  retentionClass: RetentionClass;
  riskClass: RiskClass;
  auditDays: number;
}): RetentionPolicy => {
  const payloadDays = Math.max(
    retentionClassDays[input.retentionClass],
    minimumRetentionDays[input.riskClass],
  );
  return {
    retentionClass: input.retentionClass,
    riskClass: input.riskClass,
    payloadDays,
    envelopeDays: Math.max(input.auditDays, payloadDays),
  };
};

export interface RetentionGroup {
  tenant: string;
  capability: string;
}

export interface RetentionCutoff extends RetentionGroup {
  payloadBefore: Date;
  envelopeBefore: Date;
}

export interface PurgeCount {
  payloads: number;
  envelopes: number;
  /** The tasks whose content or envelope this purge removed. */
  tasks: string[];
}

export interface RetentionStore {
  groups(): Promise<RetentionGroup[]>;
  purge(cutoff: RetentionCutoff): Promise<PurgeCount>;
}

export interface ThreadCutoff {
  tenant: string;
  agent: string;
  before: Date;
}

export interface ThreadRetentionStore {
  agents(tenant: string): Promise<string[]>;
  purge(cutoff: ThreadCutoff): Promise<number>;
}

export interface ThreadErasure {
  erase(tenant: string, thread: string): Promise<number>;
}

export class InMemoryThreadErasure implements ThreadErasure {
  constructor(
    private readonly log: InMemoryEventLog,
    private readonly tasks: InMemoryTaskStore,
  ) {}

  async erase(tenant: string, thread: string): Promise<number> {
    let count = 0;
    for (const { task } of this.tasks.all()) {
      if (task.tenant !== tenant || task.thread !== thread) continue;
      this.log.dropPayloads(task.id);
      this.tasks.dropContent(task.id);
      count += 1;
    }
    return count;
  }
}

export class InMemoryRetentionStore implements RetentionStore {
  readonly #purged = new Set<string>();

  constructor(
    private readonly log: InMemoryEventLog,
    private readonly tasks: InMemoryTaskStore,
  ) {}

  async groups(): Promise<RetentionGroup[]> {
    const seen = new Map<string, RetentionGroup>();
    for (const { task } of this.tasks.all()) {
      if (!task.endedAt) continue;
      const group = { tenant: task.tenant, capability: task.service.capability.id };
      seen.set(JSON.stringify(group), group);
    }
    return [...seen.values()];
  }

  async purge(cutoff: RetentionCutoff): Promise<PurgeCount> {
    const count: PurgeCount = { payloads: 0, envelopes: 0, tasks: [] };
    for (const { task } of this.tasks.all()) {
      if (
        !task.endedAt ||
        task.tenant !== cutoff.tenant ||
        task.service.capability.id !== cutoff.capability
      )
        continue;
      const ended = new Date(task.endedAt).getTime();
      if (ended < cutoff.envelopeBefore.getTime()) {
        this.log.drop(task.id);
        this.tasks.delete(task.id);
        this.#purged.delete(task.id);
        count.envelopes += 1;
        count.tasks.push(task.id);
      } else if (ended < cutoff.payloadBefore.getTime() && !this.#purged.has(task.id)) {
        this.log.dropPayloads(task.id);
        this.tasks.dropContent(task.id);
        this.#purged.add(task.id);
        count.payloads += 1;
        count.tasks.push(task.id);
      }
    }
    return count;
  }
}
