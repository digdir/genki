import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeContract } from '@genai/plugins/testing';
import type { SecretResolver } from '@genai/kernel';
import { memoryUsageSource, UsageGatewayError, usageGroupBy } from '@genai/port-usage';
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
const realAnswer = readFileSync(join(import.meta.dirname, 'fixtures', 'usage-answer.json'), 'utf8');
const egress = new EgressGuard({ testOverride: { allowLoopback: true, allowHttp: true } });

const configFor = (server: UsageServer) => ({
  id: 'gateway',
  baseUrl: server.url,
  credential: 'secret://env/gateway-usage-key',
  genkiClients: [],
  since: new Date('2026-10-01T00:00:00Z'),
  timeoutMs: 5_000,
  maxResponseBytes: 1024 * 1024,
});

const servers: UsageServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

describeContract('ai gateway over HTTP, with the fake behind it', usageContract, async () => {
  const fake = memoryUsageSource();
  const server = await serveUsageGateway(fake, { token: clientKey });
  return {
    subject: {
      gateway: httpUsageGateway(configFor(server), { secrets, egress }),
      arrange: fake,
    },
    close: () => server.close(),
  };
});

describe('the ai gateway usage source', () => {
  const day = Date.parse('2026-10-12T00:00:00Z');
  const hourMs = 3_600_000;
  const window = {
    from: new Date(day),
    to: new Date(day + hourMs),
    bucket: 'hour' as const,
  };
  const request = {
    timeRange: { from: '2026-10-12T00:00:00Z', to: '2026-10-12T01:00:00Z' },
    bucketSeconds: 3600,
  };
  const serve = async () => {
    const fake = memoryUsageSource();
    const server = await serveUsageGateway(fake, { token: clientKey });
    servers.push(server);
    return { fake, server };
  };

  it('posts the usage request as JSON to {base}/usage with the client key resolved from its secret:// reference', async () => {
    const { server } = await serve();
    const source = aiGatewayUsageSource(configFor(server), { secrets, egress });
    await source.usage(window);

    const [seen] = server.requests;
    expect(seen?.method).toBe('POST');
    expect(seen?.path).toBe('/usage');
    expect(seen?.headers.authorization).toBe(`Bearer ${clientKey}`);
    expect(JSON.stringify(seen)).not.toContain('secret://');
    expect(JSON.parse(seen?.body ?? '')).toEqual({
      timeRange: { from: '2026-10-12T00:00:00Z', to: '2026-10-12T01:00:00Z' },
      bucketSeconds: 3600,
      groupBy: [
        { field: 'requestModel' },
        { field: 'attributes', key: 'usage.org' },
        { field: 'attributes', key: 'usage.client' },
      ],
      filters: { httpStatus: [200] },
    });
  });

  it('asks for whole hours when the window starts or ends inside an hour', async () => {
    const { server } = await serve();
    const source = aiGatewayUsageSource(configFor(server), { secrets, egress });
    await source.usage({
      from: new Date(day + 20 * 60_000),
      to: new Date(day + hourMs + 10 * 60_000),
      bucket: 'hour',
    });

    expect(JSON.parse(server.requests[0]?.body ?? '').timeRange).toEqual({
      from: '2026-10-12T00:00:00Z',
      to: '2026-10-12T02:00:00Z',
    });
  });

  it('splits a range longer than 31 days into requests of at most 31 days', async () => {
    const { server } = await serve();
    const source = aiGatewayUsageSource(configFor(server), { secrets, egress });
    await source.usage({
      from: new Date(day),
      to: new Date(day + 40 * 24 * hourMs),
      bucket: 'hour',
    });

    const ranges = server.requests.map((r) => {
      const body = JSON.parse(r.body) as typeof request;
      return (Date.parse(body.timeRange.to) - Date.parse(body.timeRange.from)) / (24 * hourMs);
    });
    expect(ranges).toEqual([31, 9]);
  });

  it("maps buckets to rows per hour, model and organisation, marks genki's own app as genki, and closes a bucket once settled", async () => {
    const { fake, server } = await serve();
    const genkiApp = '334f8fa1-437e-4b84-bceb-f320fb60f3ed';
    const at = (minutes: number) => new Date(day + minutes * 60_000);
    const call = { model: 'gpt-oss', inputTokens: 100, outputTokens: 10, costMicros: 1500 };
    fake.record({ ...call, client: 'portal', org: '991825827', at: at(1) });
    fake.record({ ...call, client: 'other-app', org: '991825827', at: at(2) });
    fake.record({ ...call, client: genkiApp, org: '991825827', at: at(3) });
    fake.record({ ...call, client: 'portal', at: at(4) });
    fake.record({ ...call, client: 'portal', org: '991825827', at: at(61) });
    const source = aiGatewayUsageSource(
      { ...configFor(server), genkiClients: [genkiApp] },
      { secrets, egress, now: () => new Date(day + 90 * 60_000) },
    );
    const { rows } = await source.usage({ ...window, to: new Date(day + 2 * hourMs) });

    expect(
      rows.map((r) => [r.start.slice(11, 16), r.closed, r.subject, r.requests, r.cost]),
    ).toEqual([
      ['00:00', true, undefined, 1, { currency: 'USD', micros: 1500 }],
      [
        '00:00',
        true,
        { kind: 'genki', id: '991825827', org: '991825827' },
        1,
        { currency: 'USD', micros: 1500 },
      ],
      ['00:00', true, { kind: 'org', id: '991825827' }, 2, { currency: 'USD', micros: 3000 }],
      ['01:00', false, { kind: 'org', id: '991825827' }, 1, { currency: 'USD', micros: 1500 }],
    ]);
  });

  it("reads the gateway's real answer, with the group nested, totalTokens as sent and the fields genki does not use left out", async () => {
    const { server } = await serve();
    server.answerWith(realAnswer);
    const answer = await httpUsageGateway(configFor(server), { secrets, egress }).query(request);

    const figures = {
      group: { requestModel: 'aivar:borealis', 'usage.client': 'genki', 'usage.org': '991825827' },
      requests: 1,
      inputTokens: 16,
      outputTokens: 3,
      totalTokens: 19,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.0000042,
    };
    expect(answer).toEqual({
      timeRange: { from: '2026-11-17T10:00:00Z', to: '2026-11-17T12:00:00Z' },
      bucketSeconds: 3600,
      buckets: [{ start: '2026-11-17T11:00:00Z', ...figures }],
      groups: [figures],
    });
  });

  it("turns the real answer into one row per hour, model and organisation, with genki's client marked as genki", async () => {
    const { server } = await serve();
    server.answerWith(realAnswer);
    const source = aiGatewayUsageSource(
      { ...configFor(server), genkiClients: ['genki'] },
      { secrets, egress, now: () => new Date('2026-11-17T13:00:00Z') },
    );
    const { rows } = await source.usage({
      from: new Date('2026-11-17T10:00:00Z'),
      to: new Date('2026-11-17T12:00:00Z'),
      bucket: 'hour',
    });

    expect(rows).toEqual([
      {
        source: 'gateway',
        start: '2026-11-17T11:00:00.000Z',
        closed: true,
        model: 'aivar:borealis',
        subject: { kind: 'genki', id: '991825827', org: '991825827' },
        inputTokens: 16,
        outputTokens: 3,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        requests: 1,
        unpricedRequests: 0,
        cost: { currency: 'USD', micros: 4 },
      },
    ]);
  });

  it('treats a null attribute in the group as absent, so the row has no organisation', async () => {
    const { server } = await serve();
    const lacking = JSON.parse(realAnswer) as {
      buckets: { group: Record<string, string | null> }[];
    };
    for (const bucket of lacking.buckets) bucket.group['usage.org'] = null;
    server.answerWith(JSON.stringify(lacking));
    const source = aiGatewayUsageSource(configFor(server), { secrets, egress });
    const { rows } = await source.usage({
      from: new Date('2026-11-17T10:00:00Z'),
      to: new Date('2026-11-17T12:00:00Z'),
      bucket: 'hour',
    });

    expect(rows.map((r) => [r.model, r.subject, r.requests])).toEqual([
      ['aivar:borealis', undefined, 1],
    ]);
  });

  it('counts cache tokens from the gateway as part of the input tokens, not on top of them', async () => {
    const { fake, server } = await serve();
    fake.record({
      client: 'portal',
      org: '991825827',
      model: 'gpt-oss',
      at: new Date(day + 60_000),
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 60,
      cacheWriteTokens: 20,
    });
    const source = aiGatewayUsageSource(configFor(server), { secrets, egress });
    const { rows } = await source.usage(window);

    expect(
      rows.map((r) => [r.inputTokens, r.cachedInputTokens, r.cacheWriteTokens, r.outputTokens]),
    ).toEqual([[100, 60, 20, 10]]);
  });

  it('answers 502 when the answer lacks a figure genki reads', async () => {
    const { server } = await serve();
    const broken = JSON.parse(realAnswer) as { groups: Record<string, unknown>[] };
    for (const group of broken.groups) delete group.cost;
    server.answerWith(JSON.stringify(broken));
    const error = await httpUsageGateway(configFor(server), { secrets, egress })
      .query(request)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UsageGatewayError);
    expect((error as UsageGatewayError).status).toBe(502);
  });

  it('has the fake answer the same call as the real gateway did, but for the cost in whole micros', async () => {
    const { server } = await serve();
    server.answerWith(realAnswer);
    const real = await httpUsageGateway(configFor(server), { secrets, egress }).query(request);
    const fake = memoryUsageSource();
    fake.record({
      client: 'genki',
      org: '991825827',
      model: 'aivar:borealis',
      at: '2026-11-17T11:05:00Z',
      inputTokens: 16,
      outputTokens: 3,
      costMicros: 4,
    });
    const answer = await fake.query({
      timeRange: real.timeRange,
      bucketSeconds: 3600,
      groupBy: usageGroupBy,
      filters: { httpStatus: [200] },
    });

    expect(answer).toEqual({
      ...real,
      buckets: real.buckets.map((b) => ({ ...b, cost: 0.000004 })),
      groups: real.groups.map((g) => ({ ...g, cost: 0.000004 })),
    });
  });

  it('signs in with the federated app token when the source is set up as an app', async () => {
    const { server } = await serve();
    const app = {
      clientId: '334f8fa1-437e-4b84-bceb-f320fb60f3ed',
      tenant: '11111111-2222-3333-4444-555555555555',
      scope: 'api://gateway/.default',
    };
    const asked: unknown[] = [];
    const source = aiGatewayUsageSource(
      {
        id: 'gateway',
        baseUrl: server.url,
        federatedApp: app,
        genkiClients: [app.clientId],
        since: new Date('2026-10-01T00:00:00Z'),
        timeoutMs: 5_000,
        maxResponseBytes: 1024 * 1024,
      },
      {
        secrets,
        egress,
        federatedTokens: (given) => {
          asked.push(given);
          return async () => clientKey;
        },
      },
    );
    await source.usage(window);

    expect(asked).toEqual([app]);
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${clientKey}`);
  });

  it('turns a refusal into an error with the status genki acts on, and the wait after a 429', async () => {
    const { server } = await serve();
    const gateway = httpUsageGateway(configFor(server), { secrets, egress });
    const statusOf = async () => {
      const error = await gateway.query(request).catch((e: unknown) => e);
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

  it('explains a 401 and a 403 in its own words, without the token or what the gateway sent back', async () => {
    const { server } = await serve();
    const gateway = httpUsageGateway(configFor(server), { secrets, egress });
    const messages = [];
    for (const status of [401, 403]) {
      server.failWith(
        status,
        {},
        JSON.stringify({ title: 'Denied', detail: `token ${clientKey}` }),
      );
      const error = (await gateway.query(request).catch((e: unknown) => e)) as UsageGatewayError;
      messages.push(error.message);
    }

    expect(messages).toEqual([
      "the gateway refused genki's sign-in: the token is not from the gateway's tenant or has the wrong audience",
      'the gateway refused the usage request: a role is missing or the request breaks its rules',
    ]);
    expect(messages.join(' ')).not.toContain(clientKey);
  });

  it('answers 502 when the gateway cannot be reached', async () => {
    const gateway = httpUsageGateway(
      { ...configFor({ url: 'http://127.0.0.1:9' } as UsageServer), timeoutMs: 200 },
      { secrets, egress },
    );
    const error = await gateway.query(request).catch((e: unknown) => e);

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

  it('signs in as an app when the app client id, tenant and scope are set instead of a key', () => {
    const { config, problems } = gatewayUsageConfigFromEnv({
      GATEWAY_USAGE_URL: 'https://gateway-api.example.no/v1',
      GATEWAY_USAGE_APP_CLIENT_ID: '334f8fa1-437e-4b84-bceb-f320fb60f3ed',
      GATEWAY_USAGE_APP_TENANT: '11111111-2222-3333-4444-555555555555',
      GATEWAY_USAGE_APP_SCOPE: 'api://gateway/.default',
    });

    expect(problems).toEqual([]);
    expect(config?.credential).toBeUndefined();
    expect(config?.genkiClients).toEqual(['334f8fa1-437e-4b84-bceb-f320fb60f3ed']);
    expect(config?.federatedApp).toEqual({
      clientId: '334f8fa1-437e-4b84-bceb-f320fb60f3ed',
      tenant: '11111111-2222-3333-4444-555555555555',
      scope: 'api://gateway/.default',
    });
  });

  it('refuses both a client key and an app, and an app without a tenant', () => {
    const app = {
      GATEWAY_USAGE_URL: 'https://gateway-api.example.no/v1',
      GATEWAY_USAGE_APP_CLIENT_ID: '334f8fa1-437e-4b84-bceb-f320fb60f3ed',
      GATEWAY_USAGE_APP_SCOPE: 'api://gateway/.default',
    };

    expect(
      gatewayUsageConfigFromEnv({
        ...app,
        GATEWAY_USAGE_APP_TENANT: '11111111-2222-3333-4444-555555555555',
        GATEWAY_USAGE_CREDENTIAL: 'secret://env/gateway-usage-key',
      }).problems,
    ).toEqual(['set GATEWAY_USAGE_CREDENTIAL or GATEWAY_USAGE_APP_*, not both']);
    expect(gatewayUsageConfigFromEnv(app).problems).toEqual([
      'GATEWAY_USAGE_APP_TENANT must be the GUID of the gateway tenant',
    ]);
  });

  it('strips any number of trailing slashes from the base URL in linear time', () => {
    const url = `https://gateway-api.example.no/v1${'/'.repeat(100_000)}`;
    const started = performance.now();
    const { config } = gatewayUsageConfigFromEnv({
      GATEWAY_USAGE_URL: url,
      GATEWAY_USAGE_CREDENTIAL: 'secret://env/gateway-usage-key',
    });

    expect(config?.baseUrl).toBe('https://gateway-api.example.no/v1');
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('turns the gateway on with a base URL and a credential reference', () => {
    const { config } = gatewayUsageConfigFromEnv({
      GATEWAY_USAGE_URL: 'https://api.aivar.no/',
      GATEWAY_USAGE_CREDENTIAL: 'secret://env/gateway-usage-key',
      GATEWAY_USAGE_GENKI_CLIENT: 'genki-test',
      GATEWAY_USAGE_SINCE: '2026-10-01',
    });

    expect(config).toMatchObject({
      id: 'gateway',
      baseUrl: 'https://api.aivar.no',
      genkiClients: ['genki-test'],
      since: new Date('2026-10-01T00:00:00Z'),
    });
  });
});
