import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';

export interface RequestTiming {
  method: string;
  route: string;
  status: number;
  ms: number;
  steps?: Record<string, number>;
}

export interface RequestTimingOptions {
  write(entry: RequestTiming): void;
  slowMs?: number;
  everyRequest?: boolean;
  now?: () => number;
}

export const defaultSlowRequestMs = 500;

const stepScope = new AsyncLocalStorage<{ now: () => number; steps: Record<string, number> }>();

export const timedStep = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
  const scope = stepScope.getStore();
  if (!scope) return work();
  const started = scope.now();
  try {
    return await work();
  } finally {
    const ms = Math.round(scope.now() - started);
    scope.steps[name] = Math.max(scope.steps[name] ?? 0, ms);
  }
};

const routePatternOf = (c: Context) =>
  matchedRoutes(c)
    .filter((r) => r.method === c.req.method)
    .at(-1)?.path ?? 'unmatched';

export const requestTiming = (options: RequestTimingOptions): MiddlewareHandler => {
  const now = options.now ?? (() => performance.now());
  const slowMs = options.slowMs ?? defaultSlowRequestMs;
  return async (c, next) => {
    const started = now();
    const steps: Record<string, number> = {};
    try {
      await stepScope.run({ now, steps }, next);
    } finally {
      const ms = Math.round(now() - started);
      if (options.everyRequest || ms >= slowMs)
        options.write({
          method: c.req.method,
          route: routePatternOf(c),
          status: c.res.status,
          ms,
          ...(Object.keys(steps).length > 0 ? { steps } : {}),
        });
    }
  };
};
