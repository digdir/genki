import {
  federatedScopePattern,
  guidPattern,
  secretRefPattern,
  type FederatedApp,
  type FederatedTokens,
  type SecretResolver,
} from '@genai/kernel';
import {
  gatewayUsageSource,
  UsageGatewayError,
  type GatewayUsageAnswer,
  type GatewayUsageRequest,
  type UsageGateway,
  type UsageSource,
} from '@genai/port-usage';
import { EgressError, type EgressGuard } from '@genai/providers-mcp-client';
import { z } from 'zod';

export interface GatewayUsageConfig {
  id: string;
  baseUrl: string;
  /** A `secret://` reference to the client key, resolved per request. */
  credential?: string;
  federatedApp?: FederatedApp;
  genkiClients: string[];
  since: Date;
  timeoutMs: number;
  maxResponseBytes: number;
}

export const defaultGatewayTimeoutMs = 60_000;

const count = z.number().int().nonnegative();
const label = z.string().nullable().optional();
const time = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'a time');

const group = z.object({
  group: z.object({
    provider: label,
    requestModel: label,
    responseModel: label,
    'usage.org': label,
    'usage.client': label,
  }),
  requests: count,
  inputTokens: count,
  outputTokens: count,
  totalTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  cost: z.number().nonnegative(),
});

const answer = z.object({
  timeRange: z.object({ from: time, to: time }),
  bucketSeconds: count,
  buckets: z.array(group.extend({ start: time })),
  groups: z.array(group),
});

const problem = z.object({
  title: z.string().optional(),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

const refusals: Record<number, string> = {
  401: "the gateway refused genki's sign-in: the token is not from the gateway's tenant or has the wrong audience",
  403: 'the gateway refused the usage request: a role is missing or the request breaks its rules',
};

const withoutTrailingSlashes = (url: string) => {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
};

const federatedAppFromEnv = (env: NodeJS.ProcessEnv, problems: string[]) => {
  const clientId = env.GATEWAY_USAGE_APP_CLIENT_ID?.trim();
  const tenant = env.GATEWAY_USAGE_APP_TENANT?.trim();
  const scope = env.GATEWAY_USAGE_APP_SCOPE?.trim();
  if (!clientId && !tenant && !scope) return undefined;
  if (!clientId || !guidPattern.test(clientId))
    problems.push('GATEWAY_USAGE_APP_CLIENT_ID must be the GUID of the app');
  if (!tenant || !guidPattern.test(tenant))
    problems.push('GATEWAY_USAGE_APP_TENANT must be the GUID of the gateway tenant');
  if (!scope || !federatedScopePattern.test(scope))
    problems.push('GATEWAY_USAGE_APP_SCOPE must be a scope ending in /.default');
  return { clientId: clientId ?? '', tenant: tenant ?? '', scope: scope ?? '' };
};

export const gatewayUsageConfigFromEnv = (
  env: NodeJS.ProcessEnv,
): { config?: GatewayUsageConfig; problems: string[] } => {
  const baseUrl = env.GATEWAY_USAGE_URL?.trim();
  const credential = env.GATEWAY_USAGE_CREDENTIAL?.trim();
  const problems: string[] = [];
  const federatedApp = federatedAppFromEnv(env, problems);
  if (!baseUrl && !credential && !federatedApp) return { problems: [] };
  if (!baseUrl || !URL.canParse(baseUrl)) problems.push('GATEWAY_USAGE_URL must be a URL');
  if (credential && federatedApp)
    problems.push('set GATEWAY_USAGE_CREDENTIAL or GATEWAY_USAGE_APP_*, not both');
  else if (!federatedApp && (!credential || !secretRefPattern.test(credential)))
    problems.push('GATEWAY_USAGE_CREDENTIAL must be a secret:// reference');
  const since = new Date(env.GATEWAY_USAGE_SINCE ?? '2026-11-01T00:00:00Z');
  if (Number.isNaN(since.getTime())) problems.push('GATEWAY_USAGE_SINCE must be a date');
  const genkiClient = env.GATEWAY_USAGE_GENKI_CLIENT?.trim() || federatedApp?.clientId;
  const timeoutMs = Number(env.GATEWAY_USAGE_TIMEOUT_MS ?? defaultGatewayTimeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    problems.push('GATEWAY_USAGE_TIMEOUT_MS must be a whole number of milliseconds');
  if (problems.length > 0) return { problems };
  return {
    config: {
      id: 'gateway',
      baseUrl: withoutTrailingSlashes(baseUrl as string),
      ...(federatedApp ? { federatedApp } : { credential: credential as string }),
      genkiClients: genkiClient ? [genkiClient] : [],
      since,
      timeoutMs,
      maxResponseBytes: 32 * 1024 * 1024,
    },
    problems,
  };
};

export interface GatewayUsageDeps {
  secrets: SecretResolver;
  egress: EgressGuard;
  federatedTokens?: FederatedTokens;
}

const clientToken = (config: GatewayUsageConfig, deps: GatewayUsageDeps) => {
  if (config.federatedApp) {
    if (!deps.federatedTokens)
      throw new Error('the gateway usage source signs in as an app, but no app sign-in is set up');
    return deps.federatedTokens(config.federatedApp);
  }
  const ref = config.credential;
  if (!ref) throw new Error('the gateway usage source has no credential');
  return () => deps.secrets.resolve(ref);
};

export const httpUsageGateway = (
  config: GatewayUsageConfig,
  deps: GatewayUsageDeps,
): UsageGateway => {
  const token = clientToken(config, deps);
  const base = new URL(config.baseUrl);
  const allow = [
    {
      host: base.hostname.replace(/^\[|\]$/g, ''),
      port: base.port ? Number(base.port) : base.protocol === 'https:' ? 443 : 80,
    },
  ];
  return {
    async query(request: GatewayUsageRequest): Promise<GatewayUsageAnswer> {
      const key = await token();
      let response;
      try {
        response = await deps.egress.request(allow, `${config.baseUrl}/usage`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify(request),
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
        const refused = refusals[response.status];
        if (refused) throw new UsageGatewayError(response.status, refused);
        const found = problem.safeParse(body);
        const retryAfter = Number(response.headers['retry-after']);
        throw new UsageGatewayError(
          response.status,
          found.data?.detail ?? found.data?.title ?? `the gateway answered ${response.status}`,
          found.data?.errors ?? [],
          Number.isFinite(retryAfter) ? retryAfter : undefined,
        );
      }
      const parsed = answer.safeParse(body);
      if (!parsed.success)
        throw new UsageGatewayError(
          502,
          `the gateway's answer breaks the contract: ${parsed.error.message}`,
        );
      return parsed.data as GatewayUsageAnswer;
    },
  };
};

export const aiGatewayUsageSource = (
  config: GatewayUsageConfig,
  deps: GatewayUsageDeps & { now?: () => Date },
): UsageSource =>
  gatewayUsageSource(config.id, httpUsageGateway(config, deps), {
    genkiClients: config.genkiClients,
    ...(deps.now ? { now: deps.now } : {}),
  });
