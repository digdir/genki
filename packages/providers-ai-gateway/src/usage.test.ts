import { afterAll, describe, expect, it } from 'vitest';
import { describeContract } from '@genai/plugins/testing';
import type { SecretResolver } from '@genai/kernel';
import { memoryUsageSource, UsageGatewayError } from '@genai/port-usage';
import { usageContract } from '@genai/port-usage/contract';
import { serveUsageGateway, type UsageServer } from '@genai/port-usage/testing';
import { EgressGuard } from '@genai/providers-mcp-client';
import { aiGatewayUsageSource, gatewayUsageConfigFromEnv, httpUsageGateway } from './usage.js';

const clientKey = 'ck-test-not-a-real-key';
const secrets: SecretResolver = {
  resolve: async (ref) => {
    if (ref !== 'secret://env/gateway-usage-key') throw new Error(`unknown ${ref}`);
    return clientKey;
  },
};
const egress = new EgressGuard({ testOverride: { allowLoopback: true, allowHttp: true } });

const configFor = (server: UsageServer) => ({
  id: 'gateway',
  baseUrl: server.url,
  credential: 'secret://env/gateway-usage-key',
  since: new Date('2026-10-01T00:00:00Z'),
  timeoutMs: 5_000,
  maxResponseBytes: 1024 * 1024,
});

const servers: UsageServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

describeContract('ai gateway over HTTP, with the fake behind it', usageContract, async () => {
  let now = new Date('2026-10-12T00:00:00Z');
  const fake = memoryUsageSource({ now: () => now, pageSize: 2 });
  const server = await serveUsageGateway(fake, { clientKey });
  return {
    subject: {
      gateway: httpUsageGateway(configFor(server), { secrets, egress }),
      arrange: fake,
      clock: { now: () => now, set: (at: Date) => (now = at) },
    },
    close: () => server.close(),
  };
});

describe('the ai gateway usage source', () => {
  const day = Date.parse('2026-10-12T00:00:00Z');
  const window = {
    from: new Date(day),
    to: new Date(day + 3_600_000),
    bucket: 'hour' as const,
  };

  it('sends the client key resolved from its secret:// reference, never the reference', async () => {
    const fake = memoryUsageSource({ now: () => new Date(day + 600_000) });
    const server = await serveUsageGateway(fake, { clientKey });
    servers.push(server);
    const source = aiGatewayUsageSource(configFor(server), { secrets, egress });
    await source.usage(window);

    const [seen] = server.requests;
    expect(seen?.headers.authorization).toBe(`Bearer ${clientKey}`);
    expect(JSON.stringify(seen)).not.toContain('secret://');
    expect(seen?.path).toBe(
      '/v1/usage?from=2026-10-12T00%3A00%3A00Z&to=2026-10-12T01%3A00%3A00Z&bucket=hour&groupBy=model%2Csubject',
    );
  });

  it('turns a refusal into an error with the status genki acts on, and the wait after a 429', async () => {
    const fake = memoryUsageSource();
    const server = await serveUsageGateway(fake, { clientKey });
    servers.push(server);
    const gateway = httpUsageGateway(configFor(server), { secrets, egress });
    const statusOf = async () => {
      const error = await gateway.query(window).catch((e: unknown) => e);
      return error instanceof UsageGatewayError
        ? [error.status, error.retryAfterSeconds]
        : [String(error)];
    };
    const outcomes = [];
    for (const status of [401, 403, 502]) {
      server.failWith(status);
      outcomes.push(await statusOf());
    }
    server.failWith(429, { 'retry-after': '120' });
    outcomes.push(await statusOf());

    expect(outcomes).toEqual([
      [401, undefined],
      [403, undefined],
      [502, undefined],
      [429, 120],
    ]);
  });

  it('answers 502 when the gateway cannot be reached', async () => {
    const gateway = httpUsageGateway(
      { ...configFor({ url: 'http://127.0.0.1:9/v1' } as UsageServer), timeoutMs: 200 },
      { secrets, egress },
    );
    const error = await gateway.query(window).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UsageGatewayError);
    expect((error as UsageGatewayError).status).toBe(502);
  });
});

describe('gateway settings', () => {
  it('leaves the gateway off when nothing is configured', () => {
    expect(gatewayUsageConfigFromEnv({})).toEqual({ problems: [] });
  });

  it('refuses a credential that is not a secret:// reference', () => {
    const { config, problems } = gatewayUsageConfigFromEnv({
      GATEWAY_USAGE_URL: 'https://gateway-api.example.no/v1',
      GATEWAY_USAGE_CREDENTIAL: 'sk-plain-key',
    });

    expect(config).toBeUndefined();
    expect(problems).toEqual(['GATEWAY_USAGE_CREDENTIAL must be a secret:// reference']);
  });

  it('turns the gateway on with a base URL and a credential reference', () => {
    const { config } = gatewayUsageConfigFromEnv({
      GATEWAY_USAGE_URL: 'https://gateway-api.example.no/v1/',
      GATEWAY_USAGE_CREDENTIAL: 'secret://env/gateway-usage-key',
      GATEWAY_USAGE_SINCE: '2026-10-01',
    });

    expect(config).toMatchObject({
      id: 'gateway',
      baseUrl: 'https://gateway-api.example.no/v1',
      since: new Date('2026-10-01T00:00:00Z'),
    });
  });
});
