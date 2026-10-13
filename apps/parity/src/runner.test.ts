import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { noChunks } from './checks.js';
import { compare, record } from './runner.js';
import type { Scenario } from './types.js';

const servers: Server[] = [];

const serve = async (
  handler: (path: string, key: string | undefined) => { status: number; body: unknown },
) => {
  const server = createServer((req, res) => {
    const { status, body } = handler(
      req.url ?? '/',
      req.headers['x-api-key'] as string | undefined,
    );
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const scenarios: Scenario[] = [
  {
    id: 'demo.models',
    title: 'models',
    steps: [
      { name: 'models', mode: 'exact', request: () => ({ method: 'GET', path: '/v1/models' }) },
    ],
  },
  {
    id: 'mcp.ping',
    title: 'ping',
    steps: [{ name: 'ping', mode: 'exact', request: () => ({ method: 'GET', path: '/ping' }) }],
  },
];

describe('parity runner', () => {
  it('records without the API key, passes an identical server, and fails an agreed divergence left unimplemented', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parity-'));
    const handler = (path: string) => ({ status: 200, body: { path, data: ['a'] } });
    const old = await serve(handler);
    const next = await serve(handler);

    await record({ name: 'old', baseUrl: old, apiKey: 'rag_secret' }, scenarios, dir);
    const reports = await compare({ name: 'new', baseUrl: next, apiKey: 'other' }, scenarios, dir);

    expect(reports.map((r) => r.outcome)).toEqual(['pass', 'fail']);
    expect(reports[1]?.differences.map((d) => d.new)).toContain(
      'the new platform still behaves like headless-rag',
    );
    expect(await readFile(join(dir, 'demo.models.json'), 'utf8')).not.toContain('rag_secret');
  });

  it('fails a changed response, and reports an agreed divergence as such', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parity-'));
    const old = await serve((path) => ({ status: 200, body: { path, data: ['a'] } }));
    const next = await serve((path) =>
      path === '/ping'
        ? {
            status: 404,
            body: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } },
          }
        : { status: 200, body: { path, data: ['b'] } },
    );

    await record({ name: 'old', baseUrl: old, apiKey: 'k' }, scenarios, dir);
    const reports = await compare({ name: 'new', baseUrl: next, apiKey: 'k' }, scenarios, dir);

    expect(reports.map((r) => r.outcome)).toEqual(['fail', 'divergence']);
    expect(reports[1]?.divergence).toMatch(/ADR 0017/);
  });

  it('fails an agreed divergence that does not behave as the ADR says', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parity-'));
    const old = await serve((path) => ({ status: 200, body: { path } }));
    const unchanged = await serve((path) => ({ status: 200, body: { path } }));
    const wrong = await serve((path) => ({ status: path === '/ping' ? 500 : 200, body: { path } }));

    await record({ name: 'old', baseUrl: old, apiKey: 'k' }, scenarios, dir);
    const same = await compare({ name: 'new', baseUrl: unchanged, apiKey: 'k' }, scenarios, dir);
    const broken = await compare({ name: 'new', baseUrl: wrong, apiKey: 'k' }, scenarios, dir);

    expect(same[1]?.outcome).toBe('fail');
    expect(same[1]?.differences.map((d) => d.new)).toContain(
      'the new platform still behaves like headless-rag',
    );
    expect(broken[1]?.outcome).toBe('fail');
    expect(broken[1]?.differences.map((d) => d.new).join(' ')).toMatch(
      /status 500, expected one of 404/,
    );
  });

  it('skips a scenario the ADR says has no old reference, without calling the target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parity-'));
    const calls: string[] = [];
    const next = await serve((path) => {
      calls.push(path);
      return { status: 200, body: {} };
    });
    const settings: Scenario = {
      id: 'settings.top-k-on-mcp',
      title: 'top-k on MCP',
      steps: [{ name: 's', mode: 'exact', request: () => ({ method: 'GET', path: '/s' }) }],
    };

    const [report] = await compare({ name: 'new', baseUrl: next, apiKey: 'k' }, [settings], dir);

    expect(report).toMatchObject({ outcome: 'skipped' });
    expect(report?.divergence).toMatch(/ADR 0017: every setting works on every entry point/);
    expect(calls).toEqual([]);
  });

  it('compares LLM answers by shape unless replayed through the playback stub', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parity-'));
    const llm: Scenario = {
      id: 'v1.chat-demo',
      title: 'chat',
      needs: ['llm'],
      steps: [{ name: 'chat', mode: 'exact', request: () => ({ method: 'GET', path: '/chat' }) }],
    };
    const old = await serve(() => ({ status: 200, body: { answer: 'Svar A' } }));
    const next = await serve(() => ({ status: 200, body: { answer: 'Svar B' } }));

    await record({ name: 'old', baseUrl: old, apiKey: 'k' }, [llm], dir);
    const live = await compare({ name: 'new', baseUrl: next, apiKey: 'k' }, [llm], dir);
    const replayed = await compare({ name: 'new', baseUrl: next, apiKey: 'k' }, [llm], dir, {
      playback: true,
    });

    expect(live[0]?.outcome).toBe('pass');
    expect(replayed[0]?.outcome).toBe('fail');
  });

  it('reports a scenario with no recording as missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parity-'));
    const next = await serve(() => ({ status: 200, body: {} }));

    const reports = await compare({ name: 'new', baseUrl: next, apiKey: 'k' }, scenarios, dir);

    expect(reports.map((r) => r.outcome)).toEqual(['missing', 'missing']);
  });

  it("fails a scenario whose response matches headless-rag's shape but breaks a check of the new platform", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parity-'));
    const body = {
      result: { isError: false, structuredContent: { chunks: [{ chunk_id: 'c1' }] } },
    };
    const old = await serve(() => ({ status: 200, body }));
    const next = await serve(() => ({ status: 200, body }));
    const filtered: Scenario[] = [
      {
        id: 'mcp.call-probe-impossible-filter',
        title: 'impossible filter',
        steps: [
          {
            name: 'probe',
            mode: 'shape',
            request: () => ({ method: 'POST', path: '/api/mcp' }),
            check: noChunks,
          },
        ],
      },
    ];

    await record({ name: 'old', baseUrl: old, apiKey: 'k' }, filtered, dir);
    const [report] = await compare({ name: 'new', baseUrl: next, apiKey: 'k' }, filtered, dir);

    expect(report?.outcome).toBe('fail');
    expect(report?.differences.map((d) => d.new)).toEqual([
      'a filter that matches nothing returned 1 chunks',
    ]);
  });
});
