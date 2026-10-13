import { nextRun, parseCron } from './cron.js';

export interface Clock {
  now(): Date;
  setTimer(at: Date, run: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimer: (at, run) => {
    const timer = setTimeout(run, Math.max(0, at.getTime() - Date.now()));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface ScheduledJob {
  next(): Date | undefined;
  stop(): void;
}

export const schedule = (
  expression: string,
  fire: (at: Date) => Promise<void>,
  options: { clock?: Clock; timeZone?: string; onError?: (error: unknown) => void } = {},
): ScheduledJob => {
  const cron = parseCron(expression);
  const clock = options.clock ?? systemClock;
  let cancel: (() => void) | undefined;
  let upcoming: Date | undefined;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    upcoming = nextRun(cron, clock.now(), options.timeZone);
    const at = upcoming;
    cancel = clock.setTimer(at, () => {
      void fire(at)
        .catch((error: unknown) => options.onError?.(error))
        .finally(arm);
    });
  };
  arm();
  return {
    next: () => upcoming,
    stop: () => {
      stopped = true;
      cancel?.();
    },
  };
};
