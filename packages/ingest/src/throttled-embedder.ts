import { EmbeddingError, type EmbeddingPort } from '@genai/port-embedding';

/**
 * When each embedding model may be called again, shared by every job on one worker: a 429 one job
 * gets holds back the others' calls to that model too, so they wait instead of adding to the storm.
 */
export class EmbeddingPauses {
  readonly #until = new Map<string, number>();

  until(model: string): number {
    return this.#until.get(model) ?? 0;
  }

  pause(model: string, until: number): void {
    if (until > this.until(model)) this.#until.set(model, until);
  }
}

export interface ThrottleOptions {
  pauses: EmbeddingPauses;
  /** The job's signal: a cancelled run stops the wait. */
  signal?: AbortSignal;
  /** The most one try of a job waits for the quota in all; then a 429 fails it as other errors do. */
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export const maxThrottleWaitMs = 20 * 60_000;
const firstBackoffMs = 1000;
const maxBackoffMs = 60_000;
/** What the OpenAI SDK did for an unavailable embedder before its retries were left to this. */
const unavailableRetries = 3;
const firstUnavailableMs = 500;

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const aborted = () => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });

const codeOf = (error: unknown) => (error instanceof EmbeddingError ? error.code : undefined);

/**
 * An embedder for a knowledge job that waits out the provider's quota instead of failing (#400).
 * A 429 waits as long as the provider asked, or 1 s doubling to 60 s when it did not say, for at
 * most `maxWaitMs` in all, and pauses every job's calls to the model on this worker meanwhile.
 * Opened without the SDK's own retries, so it also retries an unavailable embedder as the SDK did.
 * Every other error passes straight through.
 */
export const throttledEmbedder = (port: EmbeddingPort, options: ThrottleOptions): EmbeddingPort => {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const maxWaitMs = options.maxWaitMs ?? maxThrottleWaitMs;
  const model = port.info().id;
  let waited = 0;

  const waitForPause = async () => {
    const paused = options.pauses.until(model) - now();
    if (paused <= 0) return;
    if (waited + paused > maxWaitMs)
      throw new EmbeddingError(
        'rate_limited',
        `the embedder is rate limited; waited ${Math.round(waited / 1000)} s`,
      );
    await sleep(paused, options.signal);
    waited += paused;
  };

  return {
    info: () => port.info(),
    embed: async (texts) => {
      let throttled = 0;
      let unavailable = 0;
      for (;;) {
        await waitForPause();
        try {
          return await port.embed(texts);
        } catch (error) {
          const code = codeOf(error);
          if (code === 'unavailable' && unavailable < unavailableRetries) {
            await sleep(firstUnavailableMs * 2 ** unavailable++, options.signal);
            continue;
          }
          if (code !== 'rate_limited') throw error;
          const backoff = Math.min(maxBackoffMs, firstBackoffMs * 2 ** throttled++);
          const asked = (error as EmbeddingError).retryAfterMs;
          const ms = asked ?? Math.round(backoff * (0.8 + 0.4 * random()));
          if (waited + ms > maxWaitMs) throw error;
          options.pauses.pause(model, now() + ms);
        }
      }
    },
  };
};
