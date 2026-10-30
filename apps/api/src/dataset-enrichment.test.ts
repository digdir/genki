import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { memoryEnrichmentWriter, type QuestionProposal } from '@genai/ingest';
import { envSecrets, type PortContext } from '@genai/kernel';
import type { KnowledgePort } from '@genai/port-knowledge';
import type { ModelPort } from '@genai/port-model';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { createDatasetEnrichmentModule, enrichmentOutputTokens } from './dataset-enrichment.js';

const digdir = '991825827';
const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
};

const opened: PortContext[] = [];

const meteredModel = (ctx: PortContext): ModelPort => {
  opened.push(ctx);
  return {
    info: () => ({ id: 'fake', residency: 'norway', capabilities: [] }),
    chat: async () => {
      const usage = { inputTokens: 10, outputTokens: 5 };
      await ctx.meter(usage, { kind: 'model', id: 'fake' });
      return {
        content: '1. Hva er fristen?\n2. Hvem kan søke?',
        toolCalls: [],
        finishReason: 'stop',
        usage,
        servedModel: 'fake-served',
      };
    },
    chatStream: async function* () {
      yield* [];
    },
  };
};

const knowledge = (lists: Record<string, string[]>): KnowledgePort =>
  ({
    info: () => ({
      id: `${digdir}/kudos`,
      residency: 'norway',
      filters: {},
      profiles: ['content', 'questions'],
    }),
    search: async (request: { profile?: string }) => ({
      hits: (lists[request.profile ?? ''] ?? []).map((id, i) => ({
        id,
        score: 1 - i / 10,
        text: id === 'c1' ? 'Hva er fristen?' : 'annet',
        fields: {},
      })),
    }),
  }) as unknown as KnowledgePort;

const boot = async (
  withStore = true,
  options: { monthlyTokens?: number; tenantCallsPerMinute?: number } = {},
) => {
  const enrichment = memoryEnrichmentWriter();
  const settings = new SettingsRegistry(platformSettings);
  if (options.monthlyTokens)
    settings.setTenant(digdir, 'usage.monthlyTokens', options.monthlyTokens);
  if (options.tenantCallsPerMinute)
    settings.setTenant(digdir, 'usage.tenantCallsPerMinute', options.tenantCallsPerMinute);
  const platform = await createPlatform({
    settings,
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: 'https://modell.example.no/v1',
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({}),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    configurables: { scheduleIntervalMs: 0 },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
    modules: [
      createDatasetEnrichmentModule({
        writerFor: (_deps, dataset) => ({
          dataset: { id: dataset, filters: {}, options: { endpoint: 'sok', residency: 'norway' } },
          writer: withStore ? { enrichment } : {},
        }),
        knowledgeFor: () => knowledge({ content: ['x', 'y'], questions: ['c1'] }),
        modelFor: (_deps, _model, ctx) => meteredModel(ctx),
      }),
    ],
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (path: string, as: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        'change-reason': 'Testendring',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  await app.request(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer kari',
      'content-type': 'application/json',
      'change-reason': 'Testendring',
    },
    body: JSON.stringify({
      engine: 'typesense',
      baseURL: 'https://sok.testetaten.example.no',
      auth: { kind: 'bearer', secret: `secret://tenant/${digdir}/search-token` },
    }),
  });
  const created = await call(`/tenants/${digdir}/datasets`, 'kari', {
    id: 'kudos',
    name: 'Kudos',
    residency: 'norway',
    index: { endpoint: 'sok', collections: { docs: 'k_docs', chunks: 'k_chunks' } },
  });
  expect(created.status).toBe(201);
  return { call, admin, enrichment, platform };
};

const base = `/tenants/${digdir}/datasets/kudos/enrichment/hypothetical-questions`;
const json = async <T>(response: Response) => (await response.json()) as T;

describe('dataset enrichment with hypothetical questions', () => {
  it('proposes, applies, verifies and reverts questions for a chunk, auditing each write', async () => {
    const { call, admin, enrichment } = await boot();

    const proposed = await call(`${base}/proposals`, 'kari', {
      model: 'fake',
      chunks: [{ chunkId: 'c1', docNum: 'd1', content: 'Fristen er 1. mars.' }],
    });
    expect(proposed.status).toBe(200);
    const { proposals } = await json<{ proposals: QuestionProposal[] }>(proposed);
    expect(proposals[0]?.questions).toEqual(['Hva er fristen?', 'Hvem kan søke?']);
    expect(enrichment.rows(`${digdir}/kudos`)).toEqual([]);

    const applied = await call(`${base}/apply`, 'kari', { proposals });
    expect(await json(applied)).toEqual({ applied: 2, chunkIds: ['c1'] });
    expect(enrichment.rows(`${digdir}/kudos`).map((r) => r.model)).toEqual([
      'fake-served',
      'fake-served',
    ]);

    const verified = await call(`${base}/verify`, 'kari', {
      chunkId: 'c1',
      query: 'frist',
      evalGatePass: true,
    });
    expect(await json(verified)).toMatchObject({
      newlyFindable: true,
      matchedQuestion: 'Hva er fristen?',
      keep: true,
    });

    const reverted = await call(`${base}/revert`, 'kari', {
      chunkId: 'c1',
      promptHash: proposals[0]?.provenance?.promptHash,
    });
    expect(await json(reverted)).toEqual({ reverted: 2, chunkId: 'c1' });

    const actions = (await admin.audit(digdir)).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'platform.dataset.enrichment.apply',
        'platform.dataset.enrichment.revert',
      ]),
    );
  });

  it('applying and reverting questions are admin tasks named in the response', async () => {
    const { call, admin } = await boot();
    const proposals = [{ chunkId: 'c1', questions: ['Hva er fristen?'] }];

    const applied = await call(`${base}/apply`, 'kari', { proposals });
    const reverted = await call(`${base}/revert`, 'kari', { chunkId: 'c1' });

    const audit = (await admin.audit(digdir))
      .filter((a) => a.action.startsWith('platform.dataset.enrichment'))
      .map((a) => [a.action, a.outcome, a.task]);
    expect(audit).toEqual([
      ['platform.dataset.enrichment.apply', 'applied', applied.headers.get('genai-task')],
      ['platform.dataset.enrichment.revert', 'applied', reverted.headers.get('genai-task')],
    ]);
  });

  it('returns the rows of a dry run without writing them', async () => {
    const { call, enrichment } = await boot();
    const response = await call(`${base}/apply`, 'kari', {
      proposals: [{ chunkId: 'c1', questions: ['Hva?'] }],
      dryRun: true,
    });
    expect(await json(response)).toMatchObject({
      applied: 1,
      rows: [{ chunk_id: 'c1', model: 'agent-composed' }],
    });
    expect(enrichment.rows(`${digdir}/kudos`)).toEqual([]);
  });

  it('refuses to apply on an engine without an enrichment store', async () => {
    const { call } = await boot(false);
    const response = await call(`${base}/apply`, 'kari', {
      proposals: [{ chunkId: 'c1', questions: ['Hva?'] }],
    });
    expect(response.status).toBe(409);
  });

  it('refuses a verify against a profile the dataset does not have', async () => {
    const { call } = await boot();
    const response = await call(`${base}/verify`, 'kari', {
      chunkId: 'c1',
      query: 'frist',
      profile: 'triples',
    });
    expect(response.status).toBe(409);
  });

  it('lets only members who manage datasets change enrichment', async () => {
    const { call } = await boot();
    const response = await call(`${base}/revert`, 'erik', { chunkId: 'c1' });
    expect([403, 404]).toContain(response.status);
  });
});

describe('enrichment proposals and the monthly token quota', () => {
  const propose = { model: 'fake', chunks: [{ chunkId: 'c1', content: 'Fristen er 1. mars.' }] };

  it('counts the tokens of proposed questions against the monthly quota, in a task of their own', async () => {
    const { call, platform } = await boot();

    const proposed = await call(`${base}/proposals`, 'kari', propose);

    expect(proposed.status).toBe(200);
    expect(proposed.headers.get('genai-task')).toBeTruthy();
    expect((await platform.quota(digdir, { fresh: true })).usedTokens).toBe(15);
  });

  it('caps the answer length of each proposal call', async () => {
    const { call } = await boot();
    opened.length = 0;

    await call(`${base}/proposals`, 'kari', propose);

    expect(opened.at(-1)?.outputLimit?.()).toBe(enrichmentOutputTokens);
  });

  it('refuses to propose questions once the monthly token quota is used', async () => {
    const { call } = await boot(true, { monthlyTokens: 10 });
    expect((await call(`${base}/proposals`, 'kari', propose)).status).toBe(200);

    const refused = await call(`${base}/proposals`, 'kari', propose);

    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ type: 'urn:genai:problem:quota-exhausted' });
  });

  it('counts proposal calls against the tenant call limit', async () => {
    const { call } = await boot(true, { tenantCallsPerMinute: 1 });
    expect((await call(`${base}/proposals`, 'kari', propose)).status).toBe(200);

    const refused = await call(`${base}/proposals`, 'kari', propose);

    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ type: 'urn:genai:problem:rate-limited' });
  });

  it('refuses a model that is not released yet or belongs to another tenant', async () => {
    const { call, platform } = await boot();
    for (const [id, scope, spec] of [
      ['fake/candidate', 'platform', { release: 'candidate' }],
      ['fake/private', 'platform', { tenants: ['974760673'] }],
    ] as const) {
      const published = await platform.catalog.publish({
        kind: 'model',
        scope,
        id,
        spec: { endpoint: 'fake', deployment: 'x', residency: 'norway', ...spec },
        by: 'operator:test:drift',
        reason: 'ny modell',
      });
      expect(published).toMatchObject({ ok: true });
    }
    opened.length = 0;

    for (const model of ['fake/candidate', 'fake/private']) {
      const refused = await call(`${base}/proposals`, 'kari', { ...propose, model });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({ errors: [{ path: 'model' }] });
    }
    expect(opened).toEqual([]);
  });
});
