import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicNamesOf, serviceDefinition, type ServiceDefinition } from '@genai/definitions';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { compareCaptured } from './compare.js';
import { compare, inOldNames, record } from './runner.js';
import { allScenarios } from './scenarios/index.js';
import { agentId, capabilities, parityScope, toolName, type Role } from './scope.js';
import type { Captured } from './types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const seeded = [
  join(root, 'apps', 'api', 'config', 'local', 'services'),
  join(root, 'apps', 'parity', 'config', 'services'),
];

const definitions: ServiceDefinition[] = seeded.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parseYaml(readFileSync(join(dir, f), 'utf8')) as { kind?: string })
    .filter((d) => (d.kind ?? 'Service') === 'Service')
    .map((d) => serviceDefinition.parse(d)),
);

type Protocol = 'mcp' | 'openai' | 'rest';

const served = (protocol: Protocol) =>
  new Set(
    definitions
      .filter((d) => d.spec.exposure[protocol] === true)
      .flatMap((d) =>
        d.spec.variants.flatMap((v) => {
          const names = publicNamesOf(d, v);
          return [names.primary, ...names.aliases];
        }),
      ),
  );

const servedServiceIds = new Set(
  definitions.filter((d) => d.spec.exposure.rest === true).map((d) => d.metadata.id),
);

const targets = JSON.parse(
  readFileSync(join(root, 'apps', 'parity', 'testsets', 'targets.json'), 'utf8'),
) as { testSets: Record<string, { new: Record<string, unknown> }> };

const roles = Object.keys(capabilities) as Role[];

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe('parity names per side', () => {
  it.each(['mcp', 'openai'] as const)(
    'every new-side scope name is served over %s by the seeded platform config',
    (protocol) => {
      const names = served(protocol);
      for (const role of roles) expect(names, role).toContain(toolName(role, 'new'));
    },
  );

  it('the new-side conversation agentId is a seeded service exposed over REST', () => {
    expect(servedServiceIds).toContain(agentId('agent', 'new'));
  });

  it('every new-side tool in testsets/targets.json is served over MCP by the seeded platform config', () => {
    const names = served('mcp');
    for (const [id, set] of Object.entries(targets.testSets))
      for (const key of ['agent', 'probe', 'relaxedAgent'])
        if (typeof set.new[key] === 'string') expect(names, `${id}.${key}`).toContain(set.new[key]);
  });

  it('old-side names stay headless-rag names and are the comparison scope', () => {
    expect(toolName('agent', 'old')).toBe('builtin.agent-rag-agent__agent-rag-graph-bundled');
    expect(toolName('probe', 'old')).toBe('builtin.retrieve-only-agent__retrieve-only');
    expect(agentId('agent', 'old')).toBe('builtin/agent-rag-agent');
    expect([...parityScope].sort()).toEqual(roles.map((r) => toolName(r, 'old')).sort());
  });

  it('every scenario request names only old-side names on the old side and only new-side names on the new side', () => {
    const oldNames = roles.flatMap((r) => [toolName(r, 'old'), agentId(r, 'old')]);
    const newNames = roles.flatMap((r) => [toolName(r, 'new'), agentId(r, 'new')]);
    const fake = { request: { method: 'GET' as const, path: '/' }, response: fakeCreated };
    for (const scenario of allScenarios)
      for (const step of scenario.steps) {
        const previous = scenario.steps.map(() => fake);
        const strings = (side: 'old' | 'new') =>
          JSON.stringify(step.request(previous, side)).match(/"[^"]*"/g) ?? [];
        const quoted = (names: string[]) => names.map((n) => JSON.stringify(n));
        expect(
          strings('old').filter((s) => quoted(newNames).includes(s)),
          scenario.id,
        ).toEqual([]);
        expect(
          strings('new').filter((s) => quoted(oldNames).includes(s)),
          scenario.id,
        ).toEqual([]);
      }
  });

  it('a new-side response is compared in old-side names', () => {
    const listing = (names: string[]): Captured => ({
      status: 200,
      headers: {},
      body: { result: { tools: names.map((name) => ({ name })) } },
    });
    const old = listing(roles.map((r) => toolName(r, 'old')));
    const next = listing([...roles.map((r) => toolName(r, 'new')), 'simple-qa__default']);
    expect(compareCaptured(old, inOldNames(next, 'new'), 'exact', [], parityScope)).toEqual([]);
    expect(compareCaptured(old, next, 'exact', [], parityScope)).not.toEqual([]);
  });

  it('a recording of the old side compares equal to a new side that echoes its own names', async () => {
    const echo = async () => {
      const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString()));
        req.on('end', () => {
          const body = raw ? (JSON.parse(raw) as { params?: { name?: string } }) : {};
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { tool: body.params?.name ?? null } }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const scenario = allScenarios.filter((s) => s.id === 'mcp.invalid-overrides');
    const dir = await mkdtemp(join(tmpdir(), 'parity-names-'));
    await record({ name: 'old', baseUrl: await echo(), apiKey: 'k' }, scenario, dir);
    const recorded = JSON.parse(await readFile(join(dir, 'mcp.invalid-overrides.json'), 'utf8'));
    expect(recorded.steps[0].response.body.error.tool).toBe(toolName('probe', 'old'));
    const [report] = await compare(
      { name: 'new', baseUrl: await echo(), apiKey: 'k' },
      scenario,
      dir,
      {
        divergences: [],
      },
    );
    expect(report?.differences).toEqual([]);
    expect(report?.outcome).toBe('pass');
  });
});

const fakeCreated: Captured = {
  status: 200,
  headers: {},
  body: {
    id: 'c1',
    datasets: [{ tenant: 't', 'dataset-config-key': 'default' }],
    result: { _meta: { conversation_id: 'c1' } },
  },
};
