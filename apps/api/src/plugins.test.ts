import type { Principal } from '@genai/contracts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { envSecrets } from '@genai/kernel';
import { manifest, runContract } from '@genai/plugins';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { toolSourceContract } from '@genai/port-tools/contract';
import { openAiChatFixture } from '@genai/providers-openai/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { externalTarget } from './external-plugins.js';
import { bootPlatform, digdir, readJson as json } from './testkit.js';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

interface PluginView {
  kind: string;
  id: string;
  version: string;
  contract: string;
  verifiable: boolean;
  contractTests: {
    passed: boolean;
    trigger: string;
    results: { name: string; status: string }[];
  } | null;
}

describe('plug-in registry', () => {
  it('lists the manifests of every built-in plug-in kind, with no results before a run', async () => {
    const { send } = await bootPlatform({ people });
    const { data } = await json<{ data: PluginView[] }>(await send('/operator/plugins', 'drift'));
    const kinds = new Set(data.map((p) => p.kind));
    for (const kind of [
      'model',
      'embedding',
      'rerank',
      'knowledge',
      'tool-source',
      'blob',
      'step-block',
      'hook',
    ])
      expect(kinds, kind).toContain(kind);
    expect(data.find((p) => p.id === 'model.openai-chat')).toMatchObject({
      contract: 'model@1',
      verifiable: true,
      contractTests: null,
    });
    expect(data.find((p) => p.id === 'step-block.model')).toMatchObject({ version: '1' });
    expect(data.find((p) => p.id === 'knowledge.typesense')).toMatchObject({ verifiable: true });
  });

  it('runs the real suite from the building-blocks route and records the result per version', async () => {
    const { send } = await bootPlatform({ people });
    const ran = await send(
      '/operator/building-blocks/model.anthropic-messages/contract-tests',
      'drift',
      {
        method: 'POST',
        reason: 'Kjører kontrakttestene',
      },
    );
    expect(ran.status).toBe(200);
    const run = await json<{ passed: boolean; version: string; results: { status: string }[] }>(
      ran,
    );
    expect(run.passed).toBe(true);
    expect(run.results.length).toBeGreaterThan(4);
    const detail = await json<PluginView & { runs: unknown[] }>(
      await send('/operator/plugins/model.anthropic-messages', 'drift'),
    );
    expect(detail.contractTests).toMatchObject({ passed: true, trigger: 'operator' });
    expect(detail.runs).toHaveLength(1);
    const hooks = await send('/operator/plugins/hook.webhook/contract-tests', 'drift', {
      method: 'POST',
      reason: 'Kjører kontrakttestene',
    });
    expect(await json(hooks)).toMatchObject({ passed: true });
  });

  it('refuses runs for unknown plug-ins, CI-only plug-ins and people who are not operators', async () => {
    const { send } = await bootPlatform({ people });
    const post = (id: string, as = 'drift') =>
      send(`/operator/plugins/${id}/contract-tests`, as, {
        method: 'POST',
        reason: 'Kjører kontrakttestene',
      });
    expect((await post('finnes-ikke')).status).toBe(404);
    expect((await post('knowledge.typesense')).status).toBe(200);
    expect((await post('model.openai-chat', 'kari')).status).toBe(403);
    expect((await send('/operator/plugins', 'kari')).status).toBe(403);
  });

  it('shows tenants the manifests and whether the contract passed, without the details', async () => {
    const { send } = await bootPlatform({ people });
    await send('/operator/plugins/blob.memory/contract-tests', 'drift', {
      method: 'POST',
      reason: 'Kjører kontrakttestene',
    });
    const { data } = await json<{ data: (PluginView & { results?: unknown })[] }>(
      await send(`/tenants/${digdir}/plugins?kind=blob`, 'kari'),
    );
    expect(data.map((p) => p.id)).toEqual(['blob.filesystem', 'blob.memory']);
    expect(data[1]?.contractTests).toMatchObject({ passed: true });
    expect(JSON.stringify(data)).not.toContain('results');
  });

  it('checks an external manifest before it is registered', async () => {
    const { send } = await bootPlatform({ people });
    const good = await send('/operator/plugins/manifest-check', 'drift', {
      body: {
        kind: 'tool-source',
        id: 'tool-source.sak',
        version: '1.2',
        contract: 'tool-source@1',
        title: 'Saker',
      },
    });
    expect(await json(good)).toMatchObject({ origin: 'builtin', secrets: [] });
    const bad = await send('/operator/plugins/manifest-check', 'drift', {
      body: {
        kind: 'tool-source',
        id: 'tool-source.sak',
        version: '1',
        contract: 'model@1',
        title: 'x',
      },
    });
    expect(bad.status).toBe(400);
  });
});

describe('external plug-ins', () => {
  const fakes: FakeServer[] = [];
  afterEach(async () => {
    await Promise.all(fakes.splice(0).map((f) => f.close()));
  });

  const modelEndpoint = async () => {
    const fake = await fakeHttp((body) =>
      openAiChatFixture.reply({ kind: 'text', text: 'Hei fra ekstern modell' }, body, ''),
    );
    fakes.push(fake);
    return fake.url;
  };

  const external = (url: string) => ({
    manifest: {
      kind: 'model',
      id: 'model.ekstern',
      version: '1',
      contract: 'model@1',
      title: 'Ekstern modell',
      capabilities: ['stream'],
      dataLocation: 'norway',
      hosts: ['127.0.0.1', 'modell.example.no'],
      secrets: ['secret://env/fake-key'],
    },
    endpoint: {
      baseURL: `${url}/v1`,
      protocol: 'openai-chat',
      deployment: 'ekstern',
      auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
    },
  });

  it('registers a model endpoint only with a reason of at least ten characters, lists it as external and runs the suite against it', async () => {
    const { send } = await bootPlatform({ people });
    const url = await modelEndpoint();
    expect(
      (await send('/operator/plugins', 'drift', { body: external(url) })).status,
      'a reason is required',
    ).toBe(400);
    expect(
      (await send('/operator/plugins', 'drift', { body: external(url), reason: 'kort' })).status,
      'a reason of at least ten characters is required',
    ).toBe(400);
    const saved = await send('/operator/plugins', 'drift', {
      body: external(url),
      reason: 'Ny modell fra en leverandør i Norge',
    });
    expect(saved.status).toBe(201);
    expect(saved.headers.get('genai-task')).toBeTruthy();
    const { data } = await json<{ data: (PluginView & { origin: string })[] }>(
      await send('/operator/plugins?kind=model', 'drift'),
    );
    expect(data.find((p) => p.id === 'model.ekstern')).toMatchObject({
      origin: 'external',
      verifiable: true,
    });
    const run = await json<{ passed: boolean; results: { name: string; status: string }[] }>(
      await send('/operator/plugins/model.ekstern/contract-tests', 'drift', {
        method: 'POST',
        reason: 'Kjører kontrakttestene',
      }),
    );
    expect(run.results.filter((r) => r.status === 'failed')).toEqual([]);
    expect(run.passed).toBe(true);
    expect(run.results.filter((r) => r.status === 'passed').length).toBeGreaterThan(2);

    const removed = await send('/operator/plugins/model.ekstern', 'drift', {
      method: 'DELETE',
      reason: 'Avtalen er sagt opp',
    });
    expect(removed.status).toBe(200);
    const after = await json<{ data: PluginView[] }>(await send('/operator/plugins', 'drift'));
    expect(after.data.some((p) => p.id === 'model.ekstern')).toBe(false);
  });

  it('refuses kinds that need code with 422, bad manifests with 400 and built-in ids with 409', async () => {
    const { send } = await bootPlatform({ people });
    const post = (body: unknown) =>
      send('/operator/plugins', 'drift', { body, reason: 'Prøver en ny byggekloss' });
    const block = await post({
      manifest: {
        kind: 'step-block',
        id: 'step-block.ny',
        version: '1',
        contract: 'step-block@1',
        title: 'Nytt steg',
      },
    });
    expect(block.status).toBe(422);
    expect(JSON.stringify(await block.json())).toContain('tool@1');
    const strategy = await post({ manifest: { kind: 'strategy', id: 'x', version: '1' } });
    expect(strategy.status).toBe(422);
    expect(JSON.stringify(await strategy.json())).toContain('remote-agent');
    expect(
      (
        await post({
          manifest: {
            kind: 'model',
            id: 'model.x',
            version: '1',
            contract: 'rerank@1',
            title: 'x',
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          ...external('https://modell.example.no'),
          endpoint: { baseURL: 'https://modell.example.no/v1', protocol: 'grpc-magi' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          ...external('https://modell.example.no'),
          manifest: { ...external('x').manifest, id: 'model.openai-chat' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await send('/operator/plugins', 'kari', {
          body: external('https://x.example.no'),
          reason: 'Registrerer som virksomhet',
        })
      ).status,
    ).toBe(403);
  });

  it('stores a manifest without an endpoint, which cannot be run from the API', async () => {
    const { send } = await bootPlatform({ people });
    await send('/operator/plugins', 'drift', {
      body: { manifest: { ...external('x').manifest, id: 'model.bare-manifest' } },
      reason: 'Bare manifestet foreløpig',
    });
    expect(
      (
        await send('/operator/plugins/model.bare-manifest/contract-tests', 'drift', {
          method: 'POST',
          reason: 'Kjører kontrakttestene',
        })
      ).status,
    ).toBe(409);
  });
});

describe('external tool sources', () => {
  it('run the tool-source suite against an MCP endpoint through the connection sources', async () => {
    let calls = 0;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { id?: unknown; method?: string };
        const reply = (result: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        };
        if (body.method === 'initialize')
          return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
        if (body.method === 'tools/list')
          return reply({
            tools: [
              { name: 'Finn sak', description: 'Finner en sak', inputSchema: { type: 'object' } },
            ],
          });
        if (body.method === 'tools/call') {
          calls += 1;
          return reply({ content: [{ type: 'text', text: 'Fant 1 sak.' }] });
        }
        res.writeHead(202);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const setup = externalTarget({
      models: [],
      rerank: [],
      secrets: envSecrets({}),
      tenant: digdir,
      egress: { testOverride: { allowLoopback: true, allowHttp: true }, timeoutMs: 2000 },
    })({
      manifest: manifest({
        kind: 'tool-source',
        id: 'tool-source.saksarkiv',
        version: '1',
        contract: 'tool-source@1',
        title: 'Saksarkiv',
        origin: 'external',
        hosts: ['127.0.0.1'],
      }),
      endpoint: {
        baseURL: `http://127.0.0.1:${port}/mcp`,
        protocol: 'mcp',
        example: { tool: 'finn-sak', input: { q: 'tilskudd' } },
      },
    });
    if (!setup) throw new Error('no target');
    const run = await runContract(toolSourceContract, setup as never);
    server.closeAllConnections();
    server.close();
    expect(run.results.filter((r) => r.status === 'failed')).toEqual([]);
    expect(calls).toBeGreaterThan(0);
  });
});
