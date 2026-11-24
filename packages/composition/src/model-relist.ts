import type { ModelDiscoverySettings } from './runtime.js';

export type { DiscoveryListing } from '@genai/port-model';

export interface ModelRelistOptions {
  relistIfDue: () => Promise<unknown>;
  everyMs: number;
  random?: () => number;
  schedule?: (run: () => void, ms: number) => { unref?: () => void };
  onError?: (error: unknown) => void;
}

/** Tries the re-list four times an interval, jittered. */
export const scheduleModelRelist = (options: ModelRelistOptions) => {
  const random = options.random ?? Math.random;
  const schedule =
    options.schedule ??
    ((run: () => void, ms: number) => setTimeout(run, ms) as { unref?: () => void });
  const checkMs = options.everyMs / 4;
  let stopped = false;
  const next = () => {
    if (stopped) return;
    schedule(
      () => {
        if (stopped) return;
        void options
          .relistIfDue()
          .catch((error: unknown) => options.onError?.(error))
          .finally(next);
      },
      Math.round(checkMs * (0.75 + random() * 0.5)),
    ).unref?.();
  };
  next();
  return {
    stop: () => {
      stopped = true;
    },
  };
};

const positive = (name: string, value: string | undefined, unitMs: number) => {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed * unitMs;
};

export const modelDiscoveryFromEnv = (
  env: Record<string, string | undefined>,
): ModelDiscoverySettings => {
  const relistMs = positive('MODEL_RELIST_MINUTES', env.MODEL_RELIST_MINUTES, 60_000);
  const graceMs = positive(
    'MODEL_DISCOVERY_GRACE_HOURS',
    env.MODEL_DISCOVERY_GRACE_HOURS,
    3_600_000,
  );
  return { ...(relistMs ? { relistMs } : {}), ...(graceMs ? { graceMs } : {}) };
};
