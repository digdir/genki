import type { Context } from 'hono';

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RateLimiter {
  take(bucket: string, perMinute: number): Promise<RateDecision>;
}

export const defaultKeyCallsPerMinute = 120;
export const defaultTenantCallsPerMinute = 600;
export const publicCardsPerMinute = 30;

export const clientAddress = (c: Context) => {
  const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  return forwarded || socket || 'unknown';
};

export const windowMs = 60_000;

export class SlidingWindowLimiter implements RateLimiter {
  readonly #calls = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  async take(bucket: string, perMinute: number): Promise<RateDecision> {
    const at = this.now();
    const recent = (this.#calls.get(bucket) ?? []).filter((t) => t > at - windowMs);
    if (recent.length >= perMinute) {
      this.#calls.set(bucket, recent);
      const oldest = recent[recent.length - perMinute] ?? at;
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - at) / 1000)),
      };
    }
    recent.push(at);
    this.#calls.set(bucket, recent);
    if (this.#calls.size > 10_000) this.#prune(at);
    return { ok: true };
  }

  #prune(at: number) {
    for (const [bucket, calls] of this.#calls)
      if (!calls.some((t) => t > at - windowMs)) this.#calls.delete(bucket);
  }
}

export const tooManyRequests = (
  c: Context,
  retryAfterSeconds: number,
  type: string,
  title: string,
  detail: string,
) =>
  c.json({ type, title, status: 429, detail }, 429, {
    'content-type': 'application/problem+json',
    'retry-after': String(retryAfterSeconds),
  });

export const quotaExhaustedType = 'urn:genai:problem:quota-exhausted';
export const quotaExhaustedTitle = 'The monthly token quota is used up';

export const quotaExhaustedDetail = (monthlyTokens: number) =>
  `The organisation has used its ${monthlyTokens} tokens for this month.`;

export const secondsToNextMonth = (now = new Date()) =>
  Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / 1000);

export const quotaExhausted = (c: Context, monthlyTokens: number) =>
  tooManyRequests(
    c,
    secondsToNextMonth(),
    quotaExhaustedType,
    quotaExhaustedTitle,
    quotaExhaustedDetail(monthlyTokens),
  );

export const rateLimitedBody = (limit: number) => ({
  error: { code: 'rate_limited', message: 'Too many requests', limit, window_ms: windowMs },
});

export const keyRateLimited = (c: Context, retryAfterSeconds: number, limit: number) =>
  c.json(rateLimitedBody(limit), 429, { 'retry-after': String(retryAfterSeconds) });

export const sharedLimiter = (
  shared: RateLimiter,
  onError: (error: unknown) => void = () => undefined,
  local: RateLimiter = new SlidingWindowLimiter(),
): RateLimiter => ({
  take: async (bucket, perMinute) => {
    try {
      return await shared.take(bucket, perMinute);
    } catch (error) {
      onError(error);
      return local.take(bucket, perMinute);
    }
  },
});
