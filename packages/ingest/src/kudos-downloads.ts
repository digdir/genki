import { retryAfterMs } from './kudos.js';
import { processKudosLimiter, type KudosRateLimiter } from './kudos-rate.js';
import { HttpStatusError } from './website.js';

/** KUDOS file downloads one worker runs at once (issue 931, ADR 0042). */
export const kudosDownloadsAtOnce = 2;

/** Waits one download may add up before its try fails. */
export const kudosDownloadWaitLimitMs = 30 * 60_000;

/** The first wait after a refusal, doubling with each refusal in a row up to the longest. */
export const kudosDownloadFirstWaitMs = 5_000;
export const kudosDownloadLongestWaitMs = 2 * 60_000;

/** One wait: the host and the cause's code or status, never the file's path or query. */
export interface KudosDownloadWait {
  host: string;
  cause: string;
  waitMs: number;
}

export interface KudosDownloadsOptions {
  atOnce?: number;
  waitLimitMs?: number;
  /** Every KUDOS request waits its turn here; by default the one limiter of this process. */
  limiter?: KudosRateLimiter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** From 0 to 1, for the jitter. */
  random?: () => number;
  /** Told of each wait, for the log. */
  onWait?: (wait: KudosDownloadWait) => void;
}

export interface KudosDownloads {
  /** Runs one download of `url` in its turn, waiting out refusals until the job's `signal` aborts. */
  run<T>(url: string, download: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** Codes undici gives a request that never got an answer: the connection was not taken. */
const notTakenCodes = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EPIPE',
]);

/** Why KUDOS did not take a download, when that is a reason to wait (ADR 0042); else undefined. */
export const kudosWaitCause = (error: unknown): string | undefined => {
  if ((error as { code?: unknown } | null)?.code === 'EAI_AGAIN') return 'EAI_AGAIN';
  if (error instanceof HttpStatusError)
    return error.status === 429 || error.status === 503 ? `HTTP ${error.status}` : undefined;
  if (!(error instanceof TypeError) || error.message !== 'fetch failed') return undefined;
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && notTakenCodes.has(code) ? code : undefined;
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sleeps, or rejects with the signal's reason once it is aborted; leaves no listener behind. */
const sleepUnless = async (
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal,
) => {
  signal.throwIfAborted();
  let stop: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', abort, { once: true });
    stop = () => signal.removeEventListener('abort', abort);
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    stop();
  }
};

/** Paces one process's KUDOS file downloads: a cap, and a shared hold with jittered backoff (ADR 0042). */
export const kudosDownloads = (options: KudosDownloadsOptions = {}): KudosDownloads => {
  const atOnce = options.atOnce ?? kudosDownloadsAtOnce;
  const waitLimit = options.waitLimitMs ?? kudosDownloadWaitLimitMs;
  const limiter = options.limiter ?? processKudosLimiter;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? pause;
  const random = options.random ?? Math.random;
  let running = 0;
  const queue: Array<() => void> = [];
  let heldUntil = 0;
  let refusedInARow = 0;

  const acquire = async () => {
    if (running < atOnce) {
      running += 1;
      return;
    }
    // The releasing download hands its turn over, so `running` stays as it is.
    await new Promise<void>((resolve) => queue.push(resolve));
  };
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else running -= 1;
  };
  /** Waits out the hold, and again if it grew meanwhile; returns the hold seen and the time slept. */
  const held = async (signal?: AbortSignal) => {
    let slept = 0;
    for (;;) {
      const until = heldUntil;
      const wait = until - now();
      if (wait > 0) {
        const from = now();
        await (signal ? sleepUnless(sleep, wait, signal) : sleep(wait));
        slept += now() - from;
      }
      if (heldUntil === until) return { seen: until, slept };
    }
  };

  return {
    async run(url, download, signal) {
      let waited = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { seen, slept } = await held(signal);
        waited += slept;
        await acquire();
        let cause: string | undefined;
        let error: unknown;
        try {
          // A hold set while this download waited for its turn holds it too.
          if (heldUntil !== seen) continue;
          await limiter.take();
          const result = await download();
          refusedInARow = 0;
          return result;
        } catch (failure) {
          cause = kudosWaitCause(failure);
          if (!cause) throw failure;
          error = failure;
        } finally {
          release();
        }
        refusedInARow += 1;
        const ceiling = Math.min(
          kudosDownloadLongestWaitMs,
          kudosDownloadFirstWaitMs * 2 ** Math.min(refusedInARow - 1, 30),
        );
        let wait = Math.round(random() * ceiling);
        if (error instanceof HttpStatusError && error.status === 429) {
          const asked = retryAfterMs(error.retryAfter ?? null, now());
          limiter.pause(asked);
          wait = Math.max(wait, asked);
        }
        const until = Math.max(heldUntil, now() + wait);
        if (waited + (until - now()) > waitLimit) throw error;
        heldUntil = until;
        options.onWait?.({ host: hostOf(url), cause, waitMs: until - now() });
      }
    },
  };
};

/** The pacing every KUDOS file download in this process goes through. */
export const processKudosDownloads = kudosDownloads();
