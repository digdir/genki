import type { ProviderObjectRecord, ProviderObjectStore } from '@genai/kernel';
import { schedule, type Clock, type ScheduledJob } from './scheduler.js';

export interface SweepDeps {
  store: ProviderObjectStore;
  /** Deletes one object at its provider; throws when it cannot. */
  remove(record: ProviderObjectRecord): Promise<void>;
  /** Called for an object that could not be deleted, so an operator can see it. */
  report(record: ProviderObjectRecord, reason: string): Promise<void> | void;
  now?: () => Date;
  limit?: number;
}

export interface SweepRun {
  at: string;
  deleted: number;
  incidents: number;
}

export const sweepProviderObjects = async (deps: SweepDeps): Promise<SweepRun> => {
  const now = (deps.now ?? (() => new Date()))();
  let deleted = 0;
  let incidents = 0;
  for (const record of await deps.store.due(now, deps.limit ?? 500)) {
    try {
      await deps.remove(record);
      await deps.store.deleted(record);
      deleted += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await deps.store.incident(record, reason, now);
      await deps.report(record, reason);
      incidents += 1;
    }
  }
  return { at: now.toISOString(), deleted, incidents };
};

export const scheduleProviderObjectSweep = (
  deps: SweepDeps & {
    cron?: string;
    clock?: Clock;
    active?: () => Promise<boolean>;
    onRun?: (run: SweepRun) => void;
    onError?: (error: unknown) => void;
  },
): ScheduledJob =>
  schedule(
    deps.cron ?? '43 3 * * *',
    async () => {
      if (deps.active && !(await deps.active())) return;
      deps.onRun?.(await sweepProviderObjects(deps));
    },
    {
      timeZone: 'Europe/Oslo',
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.onError ? { onError: deps.onError } : {}),
    },
  );
