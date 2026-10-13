import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createClient } from '@genai/client';
import { frontendContract } from '@genai/client/contract';
import { runContract } from '@genai/plugins';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { defaultMessages } from '@genai/guardrails';
import { systemPrincipal } from '@genai/jobs';
import { apiKeyDigest } from '@genai/identity';
import { envSecrets, type PortContext } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { resolveCatalog } from './catalogs.js';
import { createPlatform, definitionSubject } from './composition.js';

const tenant = '991825827';
const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) =>
  parseYaml(readFileSync(join(config, file), 'utf8')) as Record<string, unknown>;
const prompt = (file: string) => ({
  [`prompts/${file}`]: readFileSync(join(config, 'prompts', file), 'utf8'),
});

const fakes: FakeServer[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((s) => s.close()));
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((resolve) => {
          s.closeAllConnections();
          s.close(resolve);
        }),
    ),
  );
});

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
};
const sample = (schema: Schema): unknown => {
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sample(v)]),
    );
  if (schema.type === 'array') return [sample(schema.items ?? { type: 'string' })];
  if (schema.type === 'number' || schema.type === 'integer') return 1;
  if (schema.type === 'boolean') return true;
  return 'tildelingsbrev';
};

const completion = (content: string) => ({
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-test',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const chunk = (id: string, index: number) => ({
  id,
  chunk_id: id,
  doc_num: 'd1',
  chunk_index: index,
  content_markdown: `Tildelingsbrevet for 2025 sier ${id}.`,
  content_length: 40,
  metadata: '{"Header 1" "Tildelingsbrev 2025"}',
  KUDOS_preprod_v4_documents_ab897fbdedfa: {
    title: 'Tildelingsbrev 2025',
    url: 'https://kudos.dfo.no/dokument/d1',
    total_chunks: 2,
  },
});

const boot = async () => {
  const state = { answer: 'Svar uten kilde.', delayMs: 0 };
  const model = await fakeHttp((body) => {
    if (!body.messages)
      return {
        status: 200,
        json: { data: [{ id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' }] },
      };
    const format = body.response_format as { json_schema?: { schema: Schema } } | undefined;
    if (body.stream)
      return {
        status: 200,
        delayMs: state.delayMs,
        sse: [
          {
            data: {
              id: 'c1',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'gpt-test',
              choices: [{ index: 0, delta: { role: 'assistant', content: state.answer } }],
            },
          },
          {
            data: {
              id: 'c1',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'gpt-test',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            },
          },
          { data: '[DONE]' },
        ],
      };
    return {
      status: 200,
      delayMs: state.delayMs,
      json: completion(
        format?.json_schema ? JSON.stringify(sample(format.json_schema.schema)) : state.answer,
      ),
    };
  });
  const search = await fakeHttp((body) => ({
    status: 200,
    json: {
      results: (body.searches as Record<string, unknown>[]).map((s) =>
        s.facet_by
          ? { facet_counts: [], hits: [] }
          : String(s.collection).includes('phrases')
            ? {
                hits: ['c1', 'c2'].map((id) => ({
                  document: { chunk_id: id, search_phrase: id, doc_num: 'd1' },
                  hybrid_search_info: { rank_fusion_score: 0.8 },
                })),
              }
            : {
                hits: ['c1', 'c2'].map((id, i) => ({
                  document: chunk(id, i),
                  text_match_info: { score: '10' },
                })),
              },
      ),
    },
  }));
  const colbert = await fakeHttp((body) => ({
    status: 200,
    json: (body.documents as unknown[]).map((_, i) => ({
      index: i,
      score: 1 - i * 0.1,
      rank: i + 1,
    })),
  }));
  fakes.push(model, search, colbert);
  const env = {
    FOUNDRY_OPENAI_BASE_URL: `${model.url}/v1`,
    TYPESENSE_URL: search.url,
    COLBERT_API_URL: colbert.url,
  };
  const blobs = new InMemoryBlobStore();
  const people: Record<string, Principal> = {
    kari: {
      kind: 'employee',
      issuer: 'test',
      subject: 'kari',
      tenant,
      authorizedFor: [{ org: tenant }],
    } as Principal,
    ops: { kind: 'operator', issuer: 'test', subject: 'ops' },
  };
  const platform = await createPlatform({
    catalogs: {
      models: resolveCatalog(yaml('models.yaml'), 'models', env).catalog,
      knowledge: resolveCatalog(yaml('knowledge.yaml'), 'datasets', env).catalog,
      rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', env).catalog,
    },
    secrets: envSecrets({ FOUNDRY_OPENAI_KEY: 'm', TYPESENSE_KEY: 't', COLBERT_API_KEY: 'c' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const who = /^Bearer (\w+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      const principal = who ? people[who] : undefined;
      return principal ? { principal } : undefined;
    },
    blobStore: blobs,
    egress: { testOverride: { allowLoopback: true, allowHttp: true }, timeoutMs: 2000 },
    gates: new Map([
      [
        'pattern-no-regression',
        {
          id: 'pattern-no-regression',
          metric: 'answer-pattern',
          kind: 'no-regression',
          maxRegression: 0,
          perTag: false,
          split: 'validation',
        },
      ],
    ]),
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  return { platform, app, model, blobs, state, admin };
};

const as = (who: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${who}`,
  'content-type': 'application/json',
  ...extra,
});

const singleCall = (id: string, spec: Record<string, unknown> = {}) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id, name: id },
  spec: {
    purpose: 'Svar kort',
    audience: ['employees'],
    riskClass: 'limited',
    variants: [{ id: 'default' }],
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort på norsk.' } },
    model: { primary: 'foundry-openai/gpt-4o-2m-tps', residency: 'global' },
    exposure: { openai: true, mcp: true },
    ...spec,
  },
});

const chat = async (app: Hono, model: string, content: string) => {
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: as('kari'),
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
  });
  return ((await res.json()) as { choices?: { message: { content: string } }[] }).choices?.[0]
    ?.message.content;
};

describe('the integrated platform', () => {
  it('runs a step-flow service over MCP under its public tool name', async () => {
    const { platform, app } = await boot();
    expect(
      (await platform.definitions.publish(yaml('flows/fact-checker.yaml'), 'test', 'test')).ok,
    ).toBe(true);
    expect(
      (await platform.definitions.publish(yaml('services/fact-checker.yaml'), 'test', 'test')).ok,
    ).toBe(true);

    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: as('kari', {
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'fact-checker__default',
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'fact-checker__default',
          arguments: { query: 'Digdir fikk nye mål i 2025' },
        },
      }),
    });
    const body = (await res.json()) as {
      result: { isError: boolean; content: { type: string }[] };
    };

    expect(body.result.isError).toBe(false);
    expect(body.result.content.length).toBeGreaterThan(0);
  });

  it('refuses a question with a national identity number before the model sees it', async () => {
    const { platform, app, model } = await boot();
    await platform.definitions.publish(
      singleCall('guarded', {
        guardrails: { 'pii-before-model': { categories: ['national-id'], action: 'refuse' } },
      }),
      'test',
      'test',
    );
    const before = model.seen.length;

    const answer = await chat(app, 'guarded__default', 'Hva er status for 15838510075?');

    expect(answer).toBe(defaultMessages.pii);
    expect(
      model.seen.slice(before).some((r) => JSON.stringify(r.body).includes('15838510075')),
    ).toBe(false);
  });

  it('replaces an answer without sources when the service requires them', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(
      singleCall('sourced', { guardrails: { 'require-sources': true } }),
      'test',
      'test',
    );

    expect(await chat(app, 'sourced__default', 'Hva sier tildelingsbrevet?')).toBe(
      defaultMessages.sources,
    );
  });

  it('rewrites a folder of letters as a batch job and writes a result file', async () => {
    const { platform, blobs } = await boot();
    const published = await platform.definitions.publish(
      yaml('services/klarsprak.yaml'),
      'test',
      'test',
      prompt('klarsprak.nb.md'),
    );
    expect(published.ok).toBe(true);
    for (const name of ['a.txt', 'b.txt'])
      await blobs.put(
        { tenant, path: `klarsprak/innboks/${name}` },
        new TextEncoder().encode('Vi viser til Deres henvendelse.'),
        'text/plain',
      );
    const batch = platform.registry.all().find((c) => c.descriptor.id.endsWith('.batch'));
    expect(batch).toBeDefined();

    const run = await platform.kernel.invoke(
      systemPrincipal()(tenant),
      batch?.descriptor.id ?? '',
      {
        data: { batchId: 'b1', folder: 'innboks' },
      },
    );
    await run.result;

    const results = await blobs.list(tenant, 'klarsprak/results/');
    expect(results.map((r) => r.path)).toEqual(
      expect.arrayContaining([expect.stringContaining('b1')]),
    );
  });

  it('refuses a private host at registration and calls an agency tool through the egress guard with its tenant secret', async () => {
    const { platform, app } = await boot();
    const seen: Record<string, unknown>[] = [];
    const headers: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        seen.push(body);
        headers.push(req.headers.authorization);
        const reply = (result: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        };
        if (body.method === 'initialize')
          return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
        if (body.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }
        if (body.method === 'tools/list')
          return reply({
            tools: [
              { name: 'search_cases', description: 'Søk i saker', inputSchema: { type: 'object' } },
            ],
          });
        if (body.method === 'tools/call')
          return reply({ content: [{ type: 'text', text: 'Fant 2 saker.' }] });
        res.writeHead(400);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const privateHost = await app.request(`/tenants/${tenant}/tool-connections`, {
      method: 'POST',
      headers: as('kari', { 'change-reason': 'test av endringen' }),
      body: JSON.stringify({
        id: 'internt',
        name: 'Internt',
        endpoint: 'https://169.254.169.254/mcp',
        version: '1',
        allow: [{ host: '169.254.169.254' }],
        auth: { kind: 'bearer', secret: `secret://tenant/${tenant}/case-api` },
      }),
    });
    const secret = await app.request(`/tenants/${tenant}/secrets/case-api`, {
      method: 'PUT',
      headers: as('kari', { 'change-reason': 'test av endringen' }),
      body: JSON.stringify({ value: 'tool-token' }),
    });
    await platform.connections.save({
      connection: {
        id: 'saker',
        tenant,
        name: 'Saksarkiv',
        endpoint: `http://127.0.0.1:${port}/mcp`,
        version: '1',
        allow: [{ host: '127.0.0.1', port }],
        auth: { kind: 'bearer', secret: `secret://tenant/${tenant}/case-api` },
      },
      tools: [],
      pending: [],
    } as Parameters<typeof platform.connections.save>[0]);
    const sync = await app.request(`/tenants/${tenant}/tool-connections/saker/sync`, {
      method: 'POST',
      headers: as('kari', { 'change-reason': 'test av endringen' }),
    });
    const ctx: PortContext = {
      tenant,
      principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant },
      task: 't1',
      signal: new AbortController().signal,
      meter: async () => undefined,
    };
    const tool = platform.mcp.resolve('saker.search_cases', '1', ctx, tenant);
    const result = await tool?.call({ q: 'tilskudd' });

    expect(privateHost.status).toBe(400);
    expect(secret.status).toBe(200);
    expect(JSON.stringify(await secret.json())).not.toContain('tool-token');
    expect(sync.status).toBe(200);
    expect(platform.plugins.tools.has('saker.search_cases@1')).toBe(true);
    expect(JSON.stringify(result?.parts)).toContain('Fant 2 saker.');
    expect(headers.at(-1)).toBe('Bearer tool-token');
  });

  it('records feedback on an answer through the KA-compatible route', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(singleCall('enkel'), 'test', 'test');
    const capability = platform.registry
      .all()
      .find((c) => c.descriptor.id === `${tenant}/enkel/default`);
    const run = await platform.kernel.invoke(
      { kind: 'employee', issuer: 'test', subject: 'kari', tenant },
      capability?.descriptor.id ?? '',
      { data: { query: 'hei' } },
    );
    await run.result;

    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: as('kari'),
      body: JSON.stringify({
        conversation_id: 'c1',
        rating: 'up',
        task: run.task,
        comment: 'Bra svar',
      }),
    });
    const listed = await app.request(`/tenants/${tenant}/feedback?service=enkel`, {
      headers: as('kari'),
    });

    expect(res.status).toBe(201);
    expect(((await listed.json()) as { data: unknown[] }).data).toEqual([
      { rating: 'up', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown },
    ]);
  });

  it('passes the frontend contract suite for a browser client with a token, feedback included', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(singleCall('enkel'), 'test', 'test');
    const client = createClient({
      baseUrl: 'http://platform.test',
      token: 'kari',
      fetch: ((url, init) => app.request(String(url), init)) as typeof fetch,
    });

    const result = await runContract(
      frontendContract,
      async () => ({
        subject: { client, service: 'enkel__default', question: 'hei', feedback: true },
      }),
      { timeoutMs: 30_000 },
    );

    expect(result.results.filter((r) => r.status === 'failed')).toEqual([]);
  });

  it('runs an evaluation and refuses to publish a version that scores worse', async () => {
    const { platform, app, state } = await boot();
    const evaluation = { testSets: ['mini'], gates: ['pattern-no-regression'] };
    const v1 = singleCall('gated', { evaluation });
    const v2 = singleCall('gated', {
      evaluation,
      strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar svært kort.' } },
    });
    const first = await platform.definitions.publish(v1, 'test', 'test');
    expect(first.ok).toBe(true);
    await platform.evalStores.testSets.put({
      apiVersion: 'genai/v1',
      kind: 'TestSet',
      metadata: { tenant, id: 'mini', name: 'Mini', version: 1 },
      spec: {
        service: 'gated',
        cases: [
          {
            id: 'a',
            split: 'validation',
            input: 'status',
            expected: { answerPattern: '(?i)publisert' },
          },
          {
            id: 'b',
            split: 'validation',
            input: 'abonnement',
            expected: { answerPattern: '(?i)publisert' },
          },
        ],
      },
    } as Parameters<typeof platform.evalStores.testSets.put>[0]);
    const evaluate = async (subject: string) => {
      const started = await app.request(`/tenants/${tenant}/eval-runs`, {
        method: 'POST',
        headers: as('kari'),
        body: JSON.stringify({
          capability: `${tenant}/gated/default`,
          testSet: { id: 'mini' },
          evaluators: ['contract'],
          provenance: { commit: 'test', data: 'test' },
          service: 'gated',
          subject,
        }),
      });
      const { task } = (await started.json()) as { task: string };
      for (let i = 0; i < 200; i += 1) {
        const status = (await (
          await app.request(`/eval-tasks/${task}`, { headers: as('kari') })
        ).json()) as { state: string };
        if (status.state !== 'running') return status;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('eval did not finish');
    };

    const current = await platform.definitions.get('Service', tenant, 'gated');
    state.answer = 'Den er publisert.';
    expect((await evaluate(definitionSubject(current?.definition.spec))).state).toBe('completed');
    const unevaluated = await platform.definitions.publish(v2, 'test', 'test');
    const candidate =
      /subject (spec:[0-9a-f]+)/.exec(
        unevaluated.ok ? '' : (unevaluated.errors[0]?.message ?? ''),
      )?.[1] ?? '';
    expect(candidate).toMatch(/^spec:/);
    state.answer = 'Vet ikke.';
    await evaluate(candidate);
    const worse = await platform.definitions.publish(v2, 'test', 'test');
    state.answer = 'Den er publisert.';
    await evaluate(candidate);
    const better = await platform.definitions.publish(v2, 'test', 'test');

    expect(unevaluated.ok).toBe(false);
    expect(worse).toMatchObject({ ok: false, errors: [{ path: 'spec.evaluation' }] });
    expect(better.ok).toBe(true);
  });

  it('serves the portal pages: overview, usage and an API key stored by digest until revoked', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(singleCall('pages'), 'test', 'test');
    await chat(app, 'pages__default', 'Hei');

    const overview = await app.request(`/tenants/${tenant}/overview`, { headers: as('kari') });
    const usage = await (
      await app.request(`/tenants/${tenant}/usage`, { headers: as('kari') })
    ).text();
    const created = await app.request(`/tenants/${tenant}/api-keys`, {
      method: 'POST',
      headers: as('kari', { 'change-reason': 'integrasjon for test' }),
      body: JSON.stringify({ name: 'Testnøkkel' }),
    });
    const { key, apiKey } = (await created.json()) as { key: string; apiKey: { id: string } };
    const stored = (await platform.apiKeys.list(tenant)).find((k) => k.id === apiKey.id);
    const revoked = await app.request(`/tenants/${tenant}/api-keys/${apiKey.id}/revoke`, {
      method: 'POST',
      headers: as('kari', { 'change-reason': 'ikke i bruk' }),
    });
    const keys = await platform.apiKeys.list(tenant);

    expect(overview.status).toBe(200);
    expect(usage).toContain('"requests"');
    expect(created.status).toBe(201);
    expect(stored?.digest).toBe(apiKeyDigest(key));
    expect(revoked.status).toBe(200);
    expect(keys.find((k) => k.id === apiKey.id)?.revokedAt).toBeDefined();
    expect(JSON.stringify(keys)).not.toContain(key);
  });

  it('serves the console pages: sharing a service, ending a support session and cancelling a running task', async () => {
    const { platform, app, admin, state } = await boot();
    await platform.definitions.publish(singleCall('shared'), 'test', 'test');
    await chat(app, 'shared__default', 'Hei');
    const ops: Principal = { kind: 'operator', issuer: 'test', subject: 'ops' };

    const shared = await app.request(`/operator/shared-services/${tenant}/shared`, {
      method: 'PUT',
      headers: as('ops', { 'change-reason': 'tilby alle virksomheter' }),
      body: JSON.stringify({ availableTo: '*' }),
    });
    const opened = await admin.openSupportSession(ops, tenant, 'feilsøking', 30);
    const session = opened.ok ? (opened.value as { id: string }).id : '';
    const ended = await app.request(`/operator/support-sessions/${session}/end`, {
      method: 'POST',
      headers: as('ops', { 'change-reason': 'ferdig med saken' }),
    });
    const finished = (await (
      await app.request(`/tenants/${tenant}/tasks`, { headers: as('kari') })
    ).json()) as { data: { id: string }[] };
    const cancelFinished = await app.request(`/operator/tasks/${finished.data[0]?.id}/cancel`, {
      method: 'POST',
      headers: as('ops', { 'change-reason': 'test av endringen' }),
    });
    state.delayMs = 1500;
    const slow = chat(app, 'shared__default', 'Ta deg tid').catch(() => undefined);
    let running: { task: string }[] = [];
    for (let i = 0; i < 40 && running.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      running = (
        (await (await app.request('/operator/running-tasks', { headers: as('ops') })).json()) as {
          data: { task: string }[];
        }
      ).data;
    }
    const cancelled = await app.request(`/operator/tasks/${running[0]?.task}/cancel`, {
      method: 'POST',
      headers: as('ops', { 'change-reason': 'avbryter test' }),
    });
    await slow;
    const refused = await app.request(`/operator/shared-services/${tenant}/shared`, {
      method: 'PUT',
      headers: as('kari', { 'change-reason': 'prøver på nytt nå' }),
      body: JSON.stringify({ availableTo: null }),
    });

    expect(shared.status).toBe(200);
    expect((await platform.definitions.get('Service', tenant, 'shared'))?.version).toBe(2);
    expect(ended.status).toBe(200);
    expect(admin.supportSession(session, ops, tenant)).toBeUndefined();
    expect(cancelFinished.status).toBe(404);
    expect(running.length).toBe(1);
    expect(cancelled.status).toBe(200);
    expect(refused.status).toBe(403);
  });
});
