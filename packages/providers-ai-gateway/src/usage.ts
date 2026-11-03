import { secretRefPattern, type SecretResolver } from '@genai/kernel';
import {
  gatewayUsageSource,
  UsageGatewayError,
  type GatewayUsagePage,
  type GatewayUsageQuery,
  type UsageGateway,
  type UsageSource,
} from '@genai/port-usage';
import { EgressError, type EgressGuard } from '@genai/providers-mcp-client';
import { z } from 'zod';

export interface GatewayUsageConfig {
  id: string;
  baseUrl: string;
  /** A `secret://` reference to the client key, resolved per request. */
  credential: string;
  since: Date;
  timeoutMs: number;
  maxResponseBytes: number;
}

export const defaultGatewayTimeoutMs = 60_000;

const count = z.number().int().nonnegative();
const subject = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  org: z.string().optional(),
});

const page = z.object({
  from: z.string(),
  to: z.string(),
  bucket: z.enum(['hour', 'day']),
  data: z.array(
    z.object({
      start: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'a time'),
      closed: z.boolean(),
      model: z.string().optional(),
      provider: z.string().optional(),
      subject: subject.optional(),
      inputTokens: count,
      outputTokens: count,
      cachedInputTokens: count,
      cacheWriteTokens: count,
      requests: count,
      unpricedRequests: count,
      cost: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), micros: count }),
    }),
  ),
  next: z.string().nullable(),
});

const problem = z.object({
  title: z.string().optional(),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

const rfc3339 = (at: Date) => at.toISOString().replace('.000Z', 'Z');

const withoutUndefined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };

/** Reads gateway settings from the environment; nothing configured leaves the gateway off. */
export const gatewayUsageConfigFromEnv = (
  env: NodeJS.ProcessEnv,
): { config?: GatewayUsageConfig; problems: string[] } => {
  const baseUrl = env.GATEWAY_USAGE_URL?.trim();
  const credential = env.GATEWAY_USAGE_CREDENTIAL?.trim();
  if (!baseUrl && !credential) return { problems: [] };
  const problems: string[] = [];
  if (!baseUrl || !URL.canParse(baseUrl)) problems.push('GATEWAY_USAGE_URL must be a URL');
  if (!credential || !secretRefPattern.test(credential))
    problems.push('GATEWAY_USAGE_CREDENTIAL must be a secret:// reference');
  const since = new Date(env.GATEWAY_USAGE_SINCE ?? '2026-11-01T00:00:00Z');
  if (Number.isNaN(since.getTime())) problems.push('GATEWAY_USAGE_SINCE must be a date');
  const timeoutMs = Number(env.GATEWAY_USAGE_TIMEOUT_MS ?? defaultGatewayTimeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    problems.push('GATEWAY_USAGE_TIMEOUT_MS must be a whole number of milliseconds');
  if (problems.length > 0) return { problems };
  return {
    config: {
      id: 'gateway',
      baseUrl: (baseUrl as string).replace(/\/+$/, ''),
      credential: credential as string,
      since,
      timeoutMs,
      maxResponseBytes: 32 * 1024 * 1024,
    },
    problems,
  };
};

/** The gateway's usage route over HTTP, through the egress guard, with the client key from a secret. */
export const httpUsageGateway = (
  config: GatewayUsageConfig,
  deps: { secrets: SecretResolver; egress: EgressGuard },
): UsageGateway => {
  const base = new URL(config.baseUrl);
  const allow = [
    {
      host: base.hostname.replace(/^\[|\]$/g, ''),
      port: base.port ? Number(base.port) : base.protocol === 'https:' ? 443 : 80,
    },
  ];
  return {
    async query(query: GatewayUsageQuery): Promise<GatewayUsagePage> {
      const params = new URLSearchParams(
        withoutUndefined({
          from: rfc3339(query.from),
          to: rfc3339(query.to),
          bucket: query.bucket,
          groupBy: query.groupBy?.join(','),
          subject: query.subject,
          org: query.org,
          cursor: query.cursor,
        }),
      );
      const key = await deps.secrets.resolve(config.credential);
      let response;
      try {
        response = await deps.egress.request(allow, `${config.baseUrl}/usage?${params}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
          timeoutMs: config.timeoutMs,
          maxResponseBytes: config.maxResponseBytes,
        });
      } catch (error) {
        if (error instanceof EgressError)
          throw new UsageGatewayError(502, `the gateway did not answer: ${error.message}`);
        throw error;
      }
      const body = (() => {
        try {
          return JSON.parse(response.body) as unknown;
        } catch {
          return undefined;
        }
      })();
      if (response.status !== 200) {
        const found = problem.safeParse(body);
        const retryAfter = Number(response.headers['retry-after']);
        throw new UsageGatewayError(
          response.status,
          found.data?.detail ?? found.data?.title ?? `the gateway answered ${response.status}`,
          found.data?.errors ?? [],
          Number.isFinite(retryAfter) ? retryAfter : undefined,
        );
      }
      const parsed = page.safeParse(body);
      if (!parsed.success)
        throw new UsageGatewayError(
          502,
          `the gateway's answer breaks the contract: ${parsed.error.message}`,
        );
      return {
        ...parsed.data,
        data: parsed.data.data.map((row) =>
          withoutUndefined({ ...row, subject: row.subject && withoutUndefined(row.subject) }),
        ),
      } as GatewayUsagePage;
    },
  };
};

export const aiGatewayUsageSource = (
  config: GatewayUsageConfig,
  deps: { secrets: SecretResolver; egress: EgressGuard },
): UsageSource => gatewayUsageSource(config.id, httpUsageGateway(config, deps));
