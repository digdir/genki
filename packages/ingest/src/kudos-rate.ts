export interface KudosRateLimiter {
  /** Waits until one more request keeps under the limits, and counts it. */
  take(): Promise<void>;
  /** Holds every request back for this long, as KUDOS's `Retry-After` asks. */
  pause(ms: number): void;
}

export interface KudosRateLimiterOptions {
  perMinute?: number;
  perHour?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** KUDOS's limits per IP (issue 29): 180 requests a minute and 5,000 an hour. */
export const kudosLimits = { perMinute: 180, perHour: 5000 };

const minute = 60_000;
const hour = 3_600_000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Keeps one process under KUDOS's limits. Each request is given the earliest time both windows
 * allow and waits until then; the times are counted as given, not as read after the wait, so a
 * clock that only moves when the limiter sleeps cannot make it spin.
 */
export const kudosRateLimiter = (options: KudosRateLimiterOptions = {}): KudosRateLimiter => {
  const perMinute = options.perMinute ?? kudosLimits.perMinute;
  const perHour = options.perHour ?? kudosLimits.perHour;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? pause;
  const sent: number[] = [];
  let heldUntil = 0;
  let queue = Promise.resolve();

  const slot = () => {
    const start = now();
    let at = Math.max(start, heldUntil);
    while (sent.length > 0 && (sent[0] as number) <= at - hour) sent.shift();
    if (sent.length >= perHour) at = Math.max(at, (sent[sent.length - perHour] as number) + hour);
    if (sent.length >= perMinute)
      at = Math.max(at, (sent[sent.length - perMinute] as number) + minute);
    sent.push(at);
    return at - start;
  };

  return {
    take() {
      const turn = queue.then(async () => {
        const wait = slot();
        if (wait > 0) await sleep(wait);
      });
      queue = turn.catch(() => undefined);
      return turn;
    },
    pause(ms) {
      heldUntil = Math.max(heldUntil, now() + ms);
    },
  };
};

/** The limiter every KUDOS request in this process goes through, listings and downloads alike. */
export const processKudosLimiter = kudosRateLimiter();
