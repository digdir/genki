import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';

export interface RequestTiming {
  method: string;
  route: string;
  status: number;
  ms: number;
}

export interface RequestTimingOptions {
  write(entry: RequestTiming): void;
  slowMs?: number;
  everyRequest?: boolean;
  now?: () => number;
}

export const defaultSlowRequestMs = 500;

const routePatternOf = (c: Context) =>
  matchedRoutes(c)
    .filter((r) => r.method === c.req.method)
    .at(-1)?.path ?? 'unmatched';

export const requestTiming = (options: RequestTimingOptions): MiddlewareHandler => {
  const now = options.now ?? (() => performance.now());
  const slowMs = options.slowMs ?? defaultSlowRequestMs;
  return async (c, next) => {
    const started = now();
    try {
      await next();
    } finally {
      const ms = Math.round(now() - started);
      if (options.everyRequest || ms >= slowMs)
        options.write({
          method: c.req.method,
          route: routePatternOf(c),
          status: c.res.status,
          ms,
        });
    }
  };
};
