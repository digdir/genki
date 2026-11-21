import { retryAfterMs } from './kudos.js';
import { processKudosLimiter, type KudosRateLimiter } from './kudos-rate.js';
import { HttpStatusError } from './website.js';

/**
 * KUDOS file downloads one worker runs at once (issue 931). From the worker, 7 of 8 new
 * connections opened at once to `kudos.dfo.no` went unanswered for 10 s, while a kept one answered.
 */
export const kudosDownloadsAtOnce = 2;

/** How long one download may wait in all for KUDOS to take it before its try fails. */
export const kudosDownloadWaitLimitMs = 30 * 60_000;

/** The first wait after a refusal; it doubles with each refusal in a row, up to the longest. */
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
  /** Runs one download of `url` when a turn is free; waits out refusals without failing. */
  run<T>(url: string, download: () => Promise<T>): Promise<T>;
}

/** Codes undici gives a request that never got an answer: the connection was not taken. */
const notTakenCodes = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EPIPE',
]);

/**
 * Why KUDOS did not take a download, when it is a reason to wait: no connection or no answer at
 * all (undici's `fetch failed`, unlike `terminated` for a body cut off after the answer), 429 or
 * 503. Anything else is the try's to fail.
 */
export const kudosWaitCause = (error: unknown): string | undefined => {
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

/**
 * Paces one process's KUDOS file downloads (issue 931): at most `atOnce` at a time, and a refusal
 * holds back every download for a wait that doubles with refusals in a row, with full jitter, so a
 * minute when KUDOS takes no connections uses no try. A download that has waited `waitLimitMs` in
 * all fails with its last error.
 */
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
  /** Waits out the hold, again only when a refusal made it longer meanwhile; returns the hold seen. */
  const held = async () => {
    for (;;) {
      const until = heldUntil;
      const wait = until - now();
      if (wait > 0) await sleep(wait);
      if (heldUntil === until) return until;
    }
  };

  return {
    async run(url, download) {
      const started = now();
      for (;;) {
        const seen = await held();
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
        if (until - started > waitLimit) throw error;
        heldUntil = until;
        options.onWait?.({ host: hostOf(url), cause, waitMs: until - now() });
      }
    },
  };
};

/** The pacing every KUDOS file download in this process goes through. */
export const processKudosDownloads = kudosDownloads();
