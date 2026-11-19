import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screenFile, sessionFor } from './browser.ts';
import { estimateOf, playgroundVersionOf, priceOf } from './extra.ts';
import { loadPlan } from './client.ts';
import { finalOutcome, main, portalClientIdOf, reviewDecision } from './run.ts';

const asked = { asked: true, prs: 2, healthy: true, runsToday: 1, maxPerDay: 3 };

describe('the model review', () => {
  it('runs when asked, with merged pull requests, on a healthy deploy, under the daily cap', () => {
    expect(reviewDecision(asked)).toEqual({ review: true });
  });

  it('is skipped when no pull request was merged since the last green run', () => {
    expect(reviewDecision({ ...asked, prs: 0 }).review).toBe(false);
  });

  it('still runs on the run that reaches the daily cap', () => {
    expect(reviewDecision({ ...asked, runsToday: 3 }).review).toBe(true);
  });

  it('is skipped over the daily cap, or when the count is unknown', () => {
    expect(reviewDecision({ ...asked, runsToday: 4 }).review).toBe(false);
    expect(reviewDecision({ ...asked, runsToday: undefined }).review).toBe(false);
  });

  it('is skipped when genki-test runs another version, or when not asked', () => {
    expect(reviewDecision({ ...asked, healthy: false }).review).toBe(false);
    expect(reviewDecision({ ...asked, asked: false }).review).toBe(false);
  });
});

describe('the outcome', () => {
  it('is partial when genki-test went down during a run that passed', () => {
    expect(finalOutcome('pass', true, false)).toBe('partial');
  });

  it('keeps a failure, and a pass when genki-test stayed up', () => {
    expect(finalOutcome('fail', true, false)).toBe('fail');
    expect(finalOutcome('pass', true, true)).toBe('pass');
  });
});

describe('the browser', () => {
  it('reads the portal’s client id from its runtime config', () => {
    expect(
      portalClientIdOf('globalThis.__GENKI_CONFIG__ = {"OIDC_CLIENT_ID":"genki-portal"};'),
    ).toBe('genki-portal');
    expect(portalClientIdOf('globalThis.__GENKI_CONFIG__ = {};')).toBe('local-portal');
  });

  it('gives the portal a session in the platform organisation that has not expired', () => {
    expect(sessionFor('portal', 't', '312521172', 1000)).toEqual({
      name: 'Smoke test',
      organisations: [{ orgNumber: '312521172', name: 'Smoke test' }],
      token: 't',
      expiresAt: 3_601_000,
    });
  });

  it('gives the console an operator session', () => {
    expect(sessionFor('console', 't', '1', 0)).toEqual({
      name: 'Smoke test',
      roles: ['GenAI.Operator'],
      token: 't',
    });
  });

  it('names screenshots after the screen', () => {
    expect(screenFile('portal', '#/services/smoke/test')).toBe('portal-services-smoke-test');
    expect(screenFile('console', '#/')).toBe('console-home');
  });
});

describe('extra checks', () => {
  const plan = loadPlan();

  it('find no playground version when the options response is not JSON', () => {
    expect(playgroundVersionOf('network error', plan.service)).toBeUndefined();
    expect(playgroundVersionOf('<html>Bad gateway</html>', plan.service)).toBeUndefined();
  });

  it('find the latest playground version of the smoke service', () => {
    const options = JSON.stringify({ services: [{ id: plan.service, latestVersion: 4 }] });
    expect(playgroundVersionOf(options, plan.service)).toBe(4);
  });

  it('are estimated by what they do, and reads are free', () => {
    expect(
      estimateOf({ action: 'ask', variant: 'retrieve-only', question: 'q', stream: false }, plan),
    ).toBe(0.02);
    expect(
      estimateOf({ action: 'ask', variant: 'default', question: 'q', stream: true }, plan),
    ).toBe(0.2);
    expect(estimateOf({ action: 'operator-read', path: '/operator/tenants' }, plan)).toBe(0);
  });

  it('are estimated at the model’s playground price in the playground', () => {
    const model = plan.models[0];
    expect(
      model && estimateOf({ action: 'playground', model: model.model, question: 'q' }, plan),
    ).toBe(model?.playgroundKr);
  });

  it('are priced at the model they run on', () => {
    const haiku = plan.models.find((m) => m.model.includes('haiku'));
    expect(haiku).toBeDefined();
    if (!haiku) return;
    expect(priceOf({ action: 'playground', model: haiku.model, question: 'q' }, plan)).toBe(
      plan.prices[haiku.model],
    );
    expect(
      priceOf({ action: 'ask', variant: haiku.variant, question: 'q', stream: false }, plan),
    ).toBe(plan.prices[haiku.model]);
    expect(priceOf({ action: 'operator-read', path: '/operator/tenants' }, plan)).toBeUndefined();
  });
});

interface FakeRun {
  most: number;
  order: string[];
  ids: string[];
  rows: ReturnType<typeof main> extends Promise<infer R> ? R['checks'] : never;
}

// A fake genki-test whose model runs take a moment and are refused, so no check retries.
type Handler = (req: IncomingMessage, res: ServerResponse) => boolean;

const runAgainstFake = async (
  env: Record<string, string>,
  handle: Handler = () => false,
): Promise<FakeRun> => {
  const plan = loadPlan();
  let running = 0;
  let most = 0;
  const order: string[] = [];
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (handle(req, res)) return;
    if (url === '/health') return send(res, 200, { status: 'ok', version: 'a'.repeat(40) });
    if (url.endsWith('/playground/options'))
      return send(res, 200, { services: [{ id: plan.service, latestVersion: 1 }] });
    const modelRun =
      req.method === 'POST' &&
      ((url === '/v1/chat/completions' && req.headers['x-api-key']) ||
        url.endsWith('/playground/runs'));
    if (!modelRun) return send(res, 404, {});
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const asked = JSON.parse(body) as { model?: string; stream?: boolean };
      order.push(
        url.endsWith('/playground/runs') ? 'playground' : `${asked.model}:${asked.stream === true}`,
      );
      running++;
      most = Math.max(most, running);
      setTimeout(() => {
        running--;
        send(res, 400, { error: { message: 'refused by the fake' } });
      }, 30);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const out = mkdtempSync(join(tmpdir(), 'smoke-'));
  for (const [name, value] of Object.entries({
    SMOKE_API_URL: url,
    SMOKE_PORTAL_URL: url,
    SMOKE_CONSOLE_URL: url,
    SMOKE_API_KEY: 'smoke-key',
    SMOKE_EXPECT_SHA: '',
    SMOKE_CAPPED: 'false',
    SMOKE_FULL: 'all',
    SMOKE_TIERS: 'all',
    SMOKE_LANES: '3',
    SMOKE_OUT: out,
    PLAYWRIGHT_BROWSERS_PATH: join(out, 'no-browsers'),
    GITHUB_TOKEN: '',
    GITHUB_STEP_SUMMARY: '',
    GITHUB_OUTPUT: '',
    ...env,
  }))
    vi.stubEnv(name, value);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const report = await main();
    return { most, order, ids: report.checks.map((c) => c.id), rows: report.checks };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

describe('the model checks of a run', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('./browser.ts');
  });

  it('run as many at once as SMOKE_LANES says', async () => {
    expect((await runAgainstFake({ SMOKE_LANES: '3' })).most).toBe(3);
  }, 30_000);

  it('are reported in the plan’s order', async () => {
    const plan = loadPlan();
    const { ids } = await runAgainstFake({});
    expect(ids.filter((id) => /^(model|question|playground):/.test(id))).toEqual([
      ...plan.models.flatMap((m) => [`model:${m.model}`, `model:${m.model}:stream`]),
      ...plan.questions.map((q) => `question:${q.id}`),
      'playground:options',
      ...plan.models.map((m) => `playground:${m.model}`),
    ]);
  }, 30_000);

  it('start with the agent questions, which take longest', async () => {
    const plan = loadPlan();
    const agents = plan.questions.filter((q) => q.stream);
    const { order } = await runAgainstFake({ SMOKE_LANES: '1' });
    expect(order.slice(0, agents.length)).toEqual(
      agents.map((q) => `${plan.service}__${q.variant}:true`),
    );
  }, 30_000);
});

describe('the portal playground run in a browser', () => {
  const fakeBrowser = () =>
    vi.doMock('./browser.ts', () => ({
      openBrowser: async () => ({
        visit: async (app: 'portal' | 'console', path: string) => ({
          app,
          path,
          status: 200,
          api: [{ path: '/tenants/t/playground/runs', status: 200 }],
          pageErrors: [],
          alerts: [],
          heading: true,
          text: '',
        }),
        runPlayground: () => async () => undefined,
        close: async () => undefined,
      }),
    }));

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('./browser.ts');
  });

  it('is recorded in the report when it runs', async () => {
    fakeBrowser();
    const { ids } = await runAgainstFake({});
    expect(ids).toContain('screen:portal/playground-run');
  }, 30_000);

  it('is recorded as not run when the core tier is off', async () => {
    fakeBrowser();
    const { rows } = await runAgainstFake({ SMOKE_TIERS: 'cheap' });
    expect(rows.find((c) => c.id === 'screen:portal/playground-run')).toMatchObject({
      outcome: 'skip',
      skipReason: 'tier',
    });
  }, 30_000);
});

describe('the throwaway service of a run', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const archivedAfterEarlierRun = (publishFails = false) => {
    const state = new Map<string, string>([[loadPlan().throwaway, 'archived']]);
    const handle: Handler = (req, res) => {
      const reply = (status: number) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{}');
        return true;
      };
      const id = /\/services\/([^/]+)\/lifecycle$/.exec(req.url ?? '')?.[1];
      if (id && req.method === 'PUT') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          if (!state.has(id)) return reply(404);
          state.set(id, (JSON.parse(body) as { state: string }).state);
          reply(200);
        });
        return true;
      }
      if (id && req.method === 'GET') return reply(state.has(id) ? 200 : 404);
      if (req.url === '/definitions' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          const id = loadPlan().throwaway;
          if (!body.includes(id)) return reply(201);
          if (publishFails && state.get(id) !== 'archived') return reply(500);
          if (state.get(id) === 'archived') return reply(409);
          state.set(id, 'active');
          reply(201);
        });
        return true;
      }
      return false;
    };
    return { state, handle };
  };

  it('publishes the throwaway again after an earlier run archived it', async () => {
    const { state, handle } = archivedAfterEarlierRun();
    const { rows } = await runAgainstFake({}, handle);
    expect(rows.find((c) => c.id === 'lifecycle:throwaway')).toMatchObject({ outcome: 'pass' });
    expect(state.get(loadPlan().throwaway)).toBe('archived');
  }, 30_000);

  it('archives the throwaway again when it was restored but the publish failed', async () => {
    const { state, handle } = archivedAfterEarlierRun(true);
    await runAgainstFake({}, handle);
    expect(state.get(loadPlan().throwaway)).toBe('archived');
  }, 30_000);
});
