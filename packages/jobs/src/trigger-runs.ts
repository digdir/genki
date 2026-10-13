import { createHash, randomUUID } from 'node:crypto';
import type { Trigger, TriggerRun } from './triggers.js';

export const triggerPauseKind = 'trigger-pause';

export const triggerTarget = (trigger: Trigger) =>
  trigger.kind === 'schedule'
    ? trigger.cron
    : trigger.kind === 'queue-message'
      ? trigger.queue
      : trigger.folder;

export const triggerId = (service: string, trigger: Trigger) =>
  `${service}-${createHash('sha256')
    .update(`${trigger.kind}\n${triggerTarget(trigger)}`)
    .digest('hex')
    .slice(0, 10)}`;

export interface TriggerRunRecord {
  id: string;
  tenant: string;
  service: string;
  trigger: string;
  kind: Trigger['kind'];
  target: string;
  task?: string;
  outcome: TriggerRun['outcome'];
  error?: string;
  code?: string;
  usage?: { inputTokens: number; outputTokens: number };
  costMicroNok?: number;
  at: string;
}

export interface TriggerRunTally {
  trigger: string;
  runs: number;
  failed: number;
  last?: TriggerRunRecord;
}

export interface TriggerRunStore {
  record(run: TriggerRunRecord): Promise<void>;
  recent(tenant: string, trigger: string, limit: number): Promise<TriggerRunRecord[]>;
  tally(tenant: string, since: string): Promise<TriggerRunTally[]>;
}

const newest = (a: TriggerRunRecord, b: TriggerRunRecord) =>
  b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

export class InMemoryTriggerRuns implements TriggerRunStore {
  readonly #runs: TriggerRunRecord[] = [];

  async record(run: TriggerRunRecord) {
    this.#runs.push(structuredClone(run));
  }

  async recent(tenant: string, trigger: string, limit: number) {
    return this.#runs
      .filter((r) => r.tenant === tenant && r.trigger === trigger)
      .sort(newest)
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async tally(tenant: string, since: string) {
    const byTrigger = new Map<string, TriggerRunTally>();
    for (const run of this.#runs.filter((r) => r.tenant === tenant).sort(newest)) {
      const tally = byTrigger.get(run.trigger) ?? {
        trigger: run.trigger,
        runs: 0,
        failed: 0,
        last: structuredClone(run),
      };
      if (run.at >= since) {
        tally.runs += 1;
        if (run.outcome === 'failed') tally.failed += 1;
      }
      byTrigger.set(run.trigger, tally);
    }
    return [...byTrigger.values()];
  }
}

const maxError = 500;

export const runRecord = (run: TriggerRun, at: Date, id = randomUUID()): TriggerRunRecord => ({
  id,
  tenant: run.binding.tenant,
  service: run.binding.service,
  trigger: triggerId(run.binding.service, run.binding.trigger),
  kind: run.binding.trigger.kind,
  target: triggerTarget(run.binding.trigger),
  ...(run.task ? { task: run.task } : {}),
  outcome: run.outcome,
  ...(run.error ? { error: run.error.slice(0, maxError) } : {}),
  ...(run.code ? { code: run.code } : {}),
  ...(run.usage ? { usage: run.usage } : {}),
  ...(run.costMicroNok === undefined ? {} : { costMicroNok: run.costMicroNok }),
  at: at.toISOString(),
});

export const recordTriggerRuns =
  (
    store: TriggerRunStore,
    options: { now?: () => Date; onError?: (error: unknown) => void } = {},
  ) =>
  (run: TriggerRun) => {
    void store
      .record(runRecord(run, options.now?.() ?? new Date()))
      .catch((error: unknown) => options.onError?.(error));
  };
