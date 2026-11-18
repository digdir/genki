export interface DiscoveryFailure {
  endpoint: string;
  error: string;
}

export interface DiscoveryState {
  state: 'ok' | 'retrying';
  attempts: number;
  lastError?: string;
  since?: string;
}

export interface DiscoveryRetryOptions {
  refresh: () => Promise<{ failed: DiscoveryFailure[] }>;
  onWarning?: (message: string) => void;
  delaysMs?: number[];
  schedule?: (run: () => void, ms: number) => { unref?: () => void };
  now?: () => Date;
}

const defaultDelays = [5_000, 10_000, 30_000, 60_000, 120_000, 300_000];

/** Runs model discovery once, then again in the background until no endpoint fails. */
export const discoverWithRetry = async (options: DiscoveryRetryOptions) => {
  const delays = options.delaysMs ?? defaultDelays;
  const schedule =
    options.schedule ??
    ((run: () => void, ms: number) => setTimeout(run, ms) as { unref?: () => void });
  const now = options.now ?? (() => new Date());
  let current: DiscoveryState = { state: 'ok', attempts: 0 };
  let stopped = false;

  const attempt = async (): Promise<void> => {
    const attempts = current.attempts + 1;
    let failed: DiscoveryFailure[];
    try {
      ({ failed } = await options.refresh());
    } catch (error) {
      failed = [{ endpoint: '*', error: error instanceof Error ? error.message : String(error) }];
    }
    for (const f of failed)
      options.onWarning?.(`model discovery failed for ${f.endpoint}: ${f.error}`);
    if (failed.length === 0) {
      current = { state: 'ok', attempts };
      return;
    }
    current = {
      state: 'retrying',
      attempts,
      lastError: failed.map((f) => `${f.endpoint}: ${f.error}`).join('; '),
      since: current.since ?? now().toISOString(),
    };
    if (stopped) return;
    const delay = delays[Math.min(attempts - 1, delays.length - 1)] ?? 300_000;
    schedule(() => void attempt(), delay).unref?.();
  };

  await attempt();
  return {
    state: (): DiscoveryState => current,
    stop: () => {
      stopped = true;
    },
  };
};
