export interface DiscoveryFailure {
  endpoint: string;
  error: string;
}

export interface DiscoveryState {
  state: 'ok' | 'retrying' | 'failed';
  attempts: number;
  lastError?: string;
  since?: string;
}

export interface DiscoveryRetryOptions<R extends { failed: DiscoveryFailure[] }> {
  refresh: () => Promise<R>;
  first?: () => Promise<R>;
  onWarning?: (message: string) => void;
  delaysMs?: number[];
  maxAttempts?: number;
  random?: () => number;
  schedule?: (run: () => void, ms: number) => { unref?: () => void };
  now?: () => Date;
}

const defaultDelays = [5_000, 10_000, 30_000, 60_000, 120_000, 300_000];
const defaultMaxAttempts = 12;

export const discoverWithRetry = async <R extends { failed: DiscoveryFailure[] }>(
  options: DiscoveryRetryOptions<R>,
) => {
  const delays = options.delaysMs ?? defaultDelays;
  const maxAttempts = options.maxAttempts ?? defaultMaxAttempts;
  const random = options.random ?? Math.random;
  const schedule =
    options.schedule ??
    ((run: () => void, ms: number) => setTimeout(run, ms) as { unref?: () => void });
  const now = options.now ?? (() => new Date());
  let current: DiscoveryState = { state: 'ok', attempts: 0 };
  let stopped = false;
  let scheduled = false;
  let inFlight: Promise<R> | undefined;
  let failures = 0;

  const record = (failed: DiscoveryFailure[]) => {
    for (const f of failed)
      options.onWarning?.(`model discovery failed for ${f.endpoint}: ${f.error}`);
    const attempts = current.attempts + 1;
    if (failed.length === 0) {
      failures = 0;
      current = { state: 'ok', attempts };
      return;
    }
    failures += 1;
    const gaveUp = failures >= maxAttempts;
    current = {
      state: gaveUp ? 'failed' : 'retrying',
      attempts,
      lastError: failed.map((f) => `${f.endpoint}: ${f.error}`).join('; '),
      since: current.since ?? now().toISOString(),
    };
    if (gaveUp) {
      options.onWarning?.(`model discovery gave up after ${failures} attempts`);
      return;
    }
    if (stopped || scheduled) return;
    const base = delays[Math.min(failures - 1, delays.length - 1)] ?? 300_000;
    scheduled = true;
    schedule(
      () => {
        scheduled = false;
        if (current.state === 'retrying' && !stopped) void attempt().catch(() => undefined);
      },
      Math.round(base / 2 + (random() * base) / 2),
    ).unref?.();
  };

  const run = async (refresh = options.refresh): Promise<R> => {
    try {
      const result = await refresh();
      record(result.failed);
      return result;
    } catch (error) {
      record([{ endpoint: '*', error: error instanceof Error ? error.message : String(error) }]);
      throw error;
    }
  };

  const attempt = (): Promise<R> => {
    inFlight ??= run().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  inFlight = run(options.first).finally(() => {
    inFlight = undefined;
  });
  await inFlight.catch(() => undefined);
  return {
    state: (): DiscoveryState => current,
    refresh: attempt,
    stop: () => {
      stopped = true;
    },
  };
};
