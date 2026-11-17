export const maxPollDelayMs = 30_000;

export const backoffDelay = (base: number, failures: number) =>
  Math.min(base * 2 ** failures, maxPollDelayMs);
