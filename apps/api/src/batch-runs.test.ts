import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import type { ModelCatalog } from '@genai/port-model';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { PLATFORM_RIGHTS, trustedEntraScope } from '@genai/identity';
import { createAdmin } from './admin.js';
import { restartMessage } from './background-lease.js';
import { batchRunsModule, createBatchRunsModule } from './batch-run-routes.js';
import {
  batchEstimateKind,
  batchItemKind,
  batchRunKind,
  notFoundOf,
  type Range,
} from './batch-runs.js';
import { resolveCatalog } from './catalogs.js';
import { localeMiddleware } from './i18n/index.js';
import { createPlatform, platformModules } from './composition.js';
import { appendVersion, InMemoryConfigEntryStore } from './config-store.js';
import { serviceLifecycleKind } from './service-lifecycle.js';
import type { ModelPrice } from './draft-runner.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) => parseYaml(readFileSync(join(config, file), 'utf8')) as unknown;
const tenant = '991825827';
const other = '889640782';
const modelId = 'foundry-openai/gpt-4o-2m-tps';
const priced: Record<string, ModelPrice> = {
  [modelId]: { inputPerThousand: 0.05, outputPerThousand: 0.15 },
};

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant,
    authorizedFor: [{ org: tenant }],
  },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant,
    authorizedFor: [{ org: tenant, actions: ['use-services'] }],
  },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  entra: {
    kind: 'operator',
    issuer: 'test',
    subject: 'entra',
    tenant,
    authorizedFor: [{ org: tenant, actions: [...PLATFORM_RIGHTS] }],
    scopes: [trustedEntraScope],
  },
};

const kudosDocs = [
  {
    doc_num: 'd1',
    title: 'Årsrapport 2024 Brønnøysund',
    type: 'Årsrapport',
    concerned_years: '2024',
    orgs_short: 'BRREG',
    total_chunks: 40,
  },
  {
    doc_num: 'd2',
    title: 'Årsrapport 2024 Digdir',
    type: 'Årsrapport',
    concerned_years: '2024',
    orgs_short: 'DIGDIR',
    total_chunks: 60,
  },
  {
    doc_num: 'd3',
    title: 'Årsrapport 2024 Feilrapport',
    type: 'Årsrapport',
    concerned_years: '2024',
    orgs_short: 'NAV',
    total_chunks: 80,
  },
  {
    doc_num: 'd4',
    title: 'Årsrapport 2024 Skatteetaten',
    type: 'Årsrapport',
    concerned_years: '2024',
    orgs_short: 'SKATT',
    total_chunks: 50,
  },
  {
    doc_num: 'd5',
    title: 'Årsrapport 2024 Statsbygg',
    type: 'Årsrapport',
    concerned_years: '2024',
    orgs_short: 'SB',
    total_chunks: 20,
  },
  {
    doc_num: 'd6',
    title: 'Evaluering av tilskudd',
    type: 'Evaluering',
    concerned_years: '2023',
    orgs_short: 'DIGDIR',
    total_chunks: 30,
  },
  {
    doc_num: '330296',
    title: 'Tildelingsbrev 2021',
    type: 'Tildelingsbrev',
    concerned_years: '2021',
    orgs_short: 'DFO',
    total_chunks: 10,
  },
];

const docsCollection = 'KUDOS_preprod_v4_documents_ab897fbdedfa';

const kudosChunks = kudosDocs.flatMap((d) =>
  [0, 1].map((position) => ({
    chunk_id: `${d.doc_num}-${position}`,
    doc_num: d.doc_num,
    chunk_index: position,
    content_markdown: `Fra ${d.title}: tekst ${position + 1} om digitalisering.`,
    search_phrase: `digitalisering i ${d.title}`,
    metadata: d.title,
    [docsCollection]: { title: d.title, url: `https://kudos.example.no/${d.doc_num}` },
  })),
);

const clauseHolds = (record: Record<string, unknown>, clause: string): boolean => {
  const joined = /^\$\w+\((.*)\)$/.exec(clause);
  if (joined) return (joined[1] ?? '').split(' && ').every((c) => clauseHolds(record, c));
  const m = /^(\w+):(>=|<=|=)?(.*)$/.exec(clause);
  if (!m) return true;
  const value = record[m[1] ?? ''];
  const raw = (m[3] ?? '').replace(/`/g, '');
  if (m[2] === '>=') return Number(value) >= Number(raw);
  if (m[2] === '<=') return Number(value) <= Number(raw);
  const list = raw.startsWith('[') ? raw.slice(1, -1).split(',') : [raw];
  return list.includes(String(value));
};

const matchesFilter = (record: Record<string, unknown>, filter: unknown) => {
  if (typeof filter !== 'string') return true;
  const joined = /^\$\w+\((.*)\)$/.exec(filter);
  const clauses = (joined ? (joined[1] ?? '') : filter).split(' && ');
  return clauses.every((c) => clauseHolds(record, c));
};

const typesenseSearch = (s: Record<string, unknown>) => {
  const onDocs = s.collection === docsCollection;
  const records: Record<string, unknown>[] = onDocs
    ? kudosDocs
    : kudosChunks.map((c) => ({ ...kudosDocs.find((d) => d.doc_num === c.doc_num), ...c }));
  const found = records.filter((r) => matchesFilter(r, s.filter_by));
  if (typeof s.facet_by === 'string')
    return {
      found: found.length,
      hits: [],
      facet_counts: s.facet_by.split(',').map((field) => {
        const counts = new Map<string, number>();
        for (const r of found)
          counts.set(String(r[field] ?? ''), (counts.get(String(r[field] ?? '')) ?? 0) + 1);
        return {
          field_name: field,
          counts: [...counts].map(([value, count]) => ({ value, count })),
        };
      }),
    };
  const perPage = Number(s.per_page ?? 10);
  const page = Number(s.page ?? 1);
  return {
    found: found.length,
    hits: found
      .slice((page - 1) * perPage, page * perPage)
      .map((document) => ({ document, text_match_info: { score: 1 } })),
  };
};

const reply = (content: string, stream: boolean, completion = 20, prompt = 100) =>
  stream
    ? {
        status: 200,
        sse: [
          {
            data: {
              id: 'c',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'gpt-test',
              choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
            },
          },
          {
            data: {
              id: 'c',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'gpt-test',
              choices: [],
              usage: {
                prompt_tokens: prompt,
                completion_tokens: completion,
                total_tokens: prompt + completion,
              },
            },
          },
          { data: '[DONE]' },
        ],
      }
    : {
        status: 200,
        json: {
          id: 'c1',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-test',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
          },
        },
      };

const service = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'oppsummering', name: 'Oppsummering' },
  spec: {
    purpose: 'Oppsummer årsrapporter',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Oppsummer kort.' } },
    model: { primary: modelId, residency: 'global' },
  },
};

interface BootOptions {
  prices?: Record<string, ModelPrice>;
  store?: InMemoryConfigEntryStore;
  lockdown?: boolean;
}

const boot = async (options: BootOptions = {}) => {
  const state = {
    broken: true,
    failAll: false,
    runaway: '',
    completion: (_call: number) => 20,
    prompt: (_call: number) => 100,
    answer: (_user: string): string | undefined => undefined,
    modelCalls: 0,
    searches: [] as Record<string, unknown>[],
    users: [] as string[],
    bodies: [] as Record<string, unknown>[],
  };
  const model = await fakeHttp((body: Record<string, unknown>) => {
    if (!body.messages)
      return {
        status: 200,
        json: { data: [{ id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' }] },
      };
    state.modelCalls += 1;
    state.bodies.push(body);
    const messages = body.messages as { content?: string }[];
    const user = messages.at(-1)?.content ?? '';
    state.users.push(messages.map((m) => m.content ?? '').join('\n'));
    if (state.failAll || (state.broken && user.includes('Feilrapport')))
      return { status: 400, json: { error: { message: 'ugyldig dokument' } } };
    const limit =
      state.runaway && user.includes(state.runaway)
        ? Infinity
        : Number(body.max_completion_tokens ?? body.max_tokens ?? Infinity);
    return reply(
      state.answer(user) ?? `Sammendrag av ${user.split('\n')[0] ?? ''}`,
      Boolean(body.stream),
      Math.min(state.completion(state.modelCalls - 1), limit),
      state.prompt(state.modelCalls - 1),
    );
  });
  const search = await fakeHttp((body: Record<string, unknown>) => {
    const searches = (body.searches ?? []) as Record<string, unknown>[];
    state.searches.push(...searches);
    return { status: 200, json: { results: searches.map(typesenseSearch) } };
  });
  servers.push(model, search);
  const env = {
    FOUNDRY_OPENAI_BASE_URL: `${model.url}/v1`,
    TYPESENSE_URL: search.url,
    COLBERT_API_URL: search.url,
  };
  const background: Promise<void>[] = [];
  const platform = await createPlatform({
    catalogs: {
      models: resolveCatalog(yaml('models.yaml'), 'models', env).catalog as ModelCatalog,
      knowledge: resolveCatalog(yaml('knowledge.yaml'), 'datasets', env).catalog,
      rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', env).catalog,
    },
    secrets: envSecrets({ FOUNDRY_OPENAI_KEY: 'm', TYPESENSE_KEY: 't', COLBERT_API_KEY: 'c' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    blobStore: new InMemoryBlobStore(),
    policy: { decide: async () => ({ allow: true }) },
    prices: options.prices ?? priced,
    ...(options.store ? { configurables: { store: options.store } } : {}),
    ...(options.lockdown ? { lockdown: { configuredKeys: new Set<string>() } } : {}),
    modules: [
      ...platformModules.filter((m) => m !== batchRunsModule),
      createBatchRunsModule({ onBackground: (w) => background.push(w) }),
    ],
    authenticate: async (request) => {
      const who = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';
      const principal = people[who];
      return principal ? { principal } : undefined;
    },
  });
  const app = new Hono();
  app.use('*', localeMiddleware);
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  platform.mount(app, admin);
  const published = await platform.definitions.publish(service, 'kari', 'første');
  if (!published.ok) throw new Error(JSON.stringify(published.errors));
  await platform.sync();
  const send = async (
    method: string,
    path: string,
    who = 'kari',
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'change-reason': 'Kjører dokumentene for testen' }),
        ...headers,
        authorization: `Bearer ${who}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const type = res.headers.get('content-type') ?? '';
    const parsed = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, body: parsed as Record<string, unknown>, headers: res.headers };
  };
  const settled = async () => {
    while (background.length > 0) await Promise.all(background.splice(0));
  };
  return { platform, admin, send, settled, state, search };
};

const base = `/tenants/${tenant}/services/oppsummering/batch-runs`;
const annualReports = {
  dataset: 'digdir/kudos',
  filters: { type: ['Årsrapport'], concerned_years: ['2024'] },
};

type Env = Awaited<ReturnType<typeof boot>>;

const estimateFor = async (env: Env, body: Record<string, unknown> = annualReports) => {
  const res = await env.send('POST', `${base}/estimate`, 'kari', { sample: false, ...body });
  expect(res.status).toBe(201);
  return res.body;
};

const runTo = async (env: Env, start: Record<string, unknown>) => {
  const started = await env.send('POST', base, 'kari', start);
  expect(started.status).toBe(202);
  await env.settled();
  return (await env.send('GET', `${base}/${String(started.body.id)}`)).body;
};

describe('batch runs in a locked environment', () => {
  const start = async (env: Env, who: string) => {
    const estimate = await env.send('POST', `${base}/estimate`, who, {
      sample: false,
      ...annualReports,
    });
    expect(estimate.status).toBe(201);
    const started = await env.send('POST', base, who, {
      estimate: estimate.body.id,
      maxCostNok: 5,
    });
    expect(started.status).toBe(202);
    await env.settled();
    return (await env.send('GET', `${base}/${String(started.body.id)}`, who)).body;
  };

  it('runs a batch an Entra user started in lockdown', async () => {
    const env = await boot({ lockdown: true });
    env.state.broken = false;

    const run = await start(env, 'entra');

    expect(env.state.modelCalls).toBe(5);
    expect((run.items as { status: string }[]).map((i) => i.status)).toEqual(
      Array(5).fill('succeeded'),
    );
  });

  it('still refuses a batch a TestID user started in lockdown', async () => {
    const env = await boot({ lockdown: true });
    env.state.broken = false;

    const run = await start(env, 'kari');

    expect(env.state.modelCalls).toBe(0);
    expect((run.items as { status: string }[]).map((i) => i.status)).toEqual(
      Array(5).fill('failed'),
    );
  });

  it('estimates a batch without running samples for someone who may not use models in lockdown', async () => {
    const env = await boot({ lockdown: true });
    env.state.broken = false;

    const res = await env.send('POST', `${base}/estimate`, 'kari', annualReports);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ basis: 'assumed', samples: [] });
    expect(env.state.modelCalls).toBe(0);
  });

  it('still samples a batch estimate for an Entra user in lockdown', async () => {
    const env = await boot({ lockdown: true });
    env.state.broken = false;

    const res = await env.send('POST', `${base}/estimate`, 'entra', annualReports);

    expect(res.body.basis).toBe('measured');
    expect(env.state.modelCalls).toBe(3);
  });
});

describe('batch runs over a document set', () => {
  it('offers the datasets with their filter values and estimates the cost of a selection', async () => {
    const env = await boot();

    const sources = await env.send('GET', `${base}/sources`);
    const estimate = await estimateFor(env);

    const kudos = (sources.body.data as { id: string; filters: { field: string }[] }[]).find(
      (d) => d.id === 'digdir/kudos',
    );
    expect(kudos?.filters.map((f) => f.field)).toEqual(
      expect.arrayContaining(['type', 'concerned_years', 'orgs_short']),
    );
    expect(estimate).toMatchObject({
      items: 5,
      priced: true,
      model: modelId,
      version: 1,
      dataset: 'digdir/kudos',
      basis: 'assumed',
      samples: [],
    });
    const cost = estimate.costMicroNok as { low: number; high: number };
    expect(cost.low).toBeGreaterThan(0);
    expect(cost.high).toBeGreaterThan(cost.low);
    expect((estimate.preview as { title: string }[]).map((d) => d.title)).toContain(
      'Årsrapport 2024 Digdir',
    );
    expect(env.state.modelCalls).toBe(0);
  });

  it('asks the search engine for up to 1000 values per filter so every Kudos organisation can be chosen', async () => {
    const env = await boot();

    await env.send('GET', `${base}/sources`);

    const faceted = env.state.searches.filter((s) => typeof s.facet_by === 'string');
    expect(faceted.length).toBeGreaterThan(0);
    expect(faceted.every((s) => s.max_facet_values === 1000)).toBe(true);
  });

  it('measures three documents spread by size unless the sample is skipped, and derives the range from them', async () => {
    const env = await boot();
    env.state.broken = false;

    const res = await env.send('POST', `${base}/estimate`, 'kari', annualReports);

    expect(res.status).toBe(201);
    expect(res.body.basis).toBe('measured');
    expect((res.body.samples as Record<string, unknown>[]).map((s) => s.document)).toEqual([
      'd5',
      'd4',
      'd3',
    ]);
    expect((res.body.samples as Record<string, unknown>[])[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      costMicroNok: 8000,
    });
    expect(res.body.perItem).toMatchObject({
      inputTokens: { low: 70, high: 150 },
      outputTokens: { low: 14, high: 1500 },
    });
    expect(res.body.maxOutputTokens).toBe(1500);
    expect(env.state.modelCalls).toBe(3);
  });

  it('does not sample a selection no larger than the sample, since running it costs the same', async () => {
    const env = await boot();

    const res = await env.send('POST', `${base}/estimate`, 'kari', {
      dataset: 'digdir/kudos',
      documents: ['d1', 'd2', 'd4'],
    });

    expect(res.body).toMatchObject({ items: 3, basis: 'assumed', samples: [] });
    expect((res.body.perItem as { outputTokens: Range }).outputTokens.high).toBe(4000);
    expect(env.state.modelCalls).toBe(0);
  });

  it('assumes a wide output range when the sample is skipped or every sample fails', async () => {
    const env = await boot();

    const skipped = await estimateFor(env, annualReports);
    env.state.failAll = true;
    const failed = await estimateFor(env, { ...annualReports, sample: true });

    expect(skipped).toMatchObject({ basis: 'assumed', samples: [] });
    expect((skipped.perItem as { outputTokens: Range }).outputTokens.high).toBe(4000);
    expect(failed.basis).toBe('assumed');
    expect(failed.samples).toHaveLength(3);
    expect(failed.perItem).toEqual(skipped.perItem);
  });

  it('reserves the largest input seen so far plus a full answer, so the run never passes the cap when inputs grow and every answer hits the limit', async () => {
    const env = await boot();
    env.state.broken = false;
    env.state.prompt = (call) => Math.round(100 * 1.3 ** call);
    const estimate = await estimateFor(env, { ...annualReports, sample: true });
    const high = (estimate.perItem as { costMicroNok: Range }).costMicroNok.high;
    env.state.completion = () => 5000;
    const cap = 0.75;

    const run = await runTo(env, { estimate: estimate.id, maxCostNok: cap, concurrency: 1 });

    const items = (run.items as { costMicroNok: number; truncated?: boolean }[]).filter(
      (i) => i.costMicroNok > 0,
    );
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.truncated)).toBe(true);
    expect(Math.max(...items.map((i) => i.costMicroNok))).toBeGreaterThan(high);
    expect(run.status).toBe('stopped');
    expect(run.costMicroNok as number).toBeLessThanOrEqual(cap * 1_000_000);
  });

  it('refuses to start without an estimate or a cost cap', async () => {
    const env = await boot();
    const estimate = await estimateFor(env);

    expect((await env.send('POST', base, 'kari', {})).status).toBe(400);
    expect(
      (await env.send('POST', base, 'kari', { estimate: 'ukjent', maxCostNok: 5 })).status,
    ).toBe(404);
    const uncapped = await env.send('POST', base, 'kari', { estimate: estimate.id });
    expect(uncapped.status).toBe(400);
    expect(uncapped.body.errors).toEqual([expect.objectContaining({ path: 'maxCostNok' })]);
  });

  it('runs each document, records output, sources, tokens and cost, and retries the failed one', async () => {
    const env = await boot();
    const estimate = await estimateFor(env);

    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 5 });

    expect(run).toMatchObject({
      status: 'succeeded',
      total: 5,
      counts: { succeeded: 4, failed: 1, queued: 0, running: 0, skipped: 0 },
      tokens: { input: 400, output: 80 },
      costMicroNok: 32_000,
    });
    const items = run.items as Record<string, unknown>[];
    expect(items[1]).toMatchObject({
      index: 1,
      document: { id: 'd2', title: 'Årsrapport 2024 Digdir' },
      status: 'succeeded',
      output: 'Sammendrag av Årsrapport 2024 Digdir',
      version: 1,
      models: [modelId],
      tokens: { input: 100, output: 20 },
      costMicroNok: 8000,
      task: expect.any(String),
    });
    expect(items[2]).toMatchObject({ status: 'failed', error: expect.any(String) });

    env.state.broken = false;
    const calls = env.state.modelCalls;
    const retried = await env.send('POST', `${base}/${String(run.id)}/retry`, 'kari', {
      maxCostNok: 5,
    });
    expect(retried.status).toBe(202);
    expect(retried.body.retried).toBe(1);
    await env.settled();
    const after = (await env.send('GET', `${base}/${String(run.id)}`)).body;

    expect(env.state.modelCalls - calls).toBe(1);
    expect(after).toMatchObject({
      status: 'succeeded',
      pass: 2,
      counts: { succeeded: 5, failed: 0 },
      costMicroNok: 40_000,
    });
    expect((after.items as Record<string, unknown>[])[2]).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      output: 'Sammendrag av Årsrapport 2024 Feilrapport',
    });
    const again = await env.send('POST', `${base}/${String(run.id)}/retry`, 'kari', {
      maxCostNok: 5,
    });
    expect(again.status).toBe(409);
  });

  it('reserves the estimate for each document before starting it, so in-flight work cannot pass the cap', async () => {
    const env = await boot();
    env.state.broken = false;
    const estimate = await estimateFor(env, { ...annualReports, sample: true });
    expect((estimate.perItem as { costMicroNok: unknown }).costMicroNok).toEqual({
      low: 5600,
      high: 232_500,
    });
    env.state.completion = () => 5000;

    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 0.5, concurrency: 4 });

    expect(run).toMatchObject({
      status: 'stopped',
      error: 'Stoppet fordi kostnaden nådde taket på 0,5 kr',
      counts: { succeeded: 2, skipped: 3 },
      costMicroNok: 460_000,
    });
    expect(env.state.modelCalls).toBe(5);
  });

  it('cuts an answer short at the output the estimate allows, so the item succeeds as truncated and the cap holds', async () => {
    const env = await boot();
    env.state.broken = false;
    const estimate = await estimateFor(env, { ...annualReports, sample: true });
    const sampled = env.state.bodies.length;
    env.state.completion = (call) => (call === sampled ? 5000 : 20);

    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 5, concurrency: 1 });

    const limitOf = (b: Record<string, unknown>) => b.max_completion_tokens ?? b.max_tokens;
    expect((estimate.perItem as { outputTokens: Range }).outputTokens.high).toBe(1500);
    expect(estimate.maxOutputTokens).toBe(1500);
    expect(env.state.bodies.slice(0, sampled).map(limitOf)).toEqual([4000, 4000, 4000]);
    expect(env.state.bodies.slice(sampled).map(limitOf)).toEqual([1500, 1500, 1500, 1500, 1500]);
    expect(run).toMatchObject({ status: 'succeeded', counts: { succeeded: 5 } });
    const items = run.items as Record<string, unknown>[];
    expect(items[0]).toMatchObject({ truncated: true, tokens: { input: 100, output: 1500 } });
    expect(items.filter((i) => i.truncated)).toHaveLength(1);

    const csv = await env.send('GET', `${base}/${String(run.id)}/export?format=csv`);
    const json = await env.send('GET', `${base}/${String(run.id)}/export?format=json`);
    const rows = String(csv.body).split('\r\n');
    expect(rows[1]).toContain(';Sammendrag av Årsrapport 2024 Brønnøysund;Ja;');
    expect((json.body.items as Record<string, unknown>[])[0]?.truncated).toBe(true);
  });

  it('counts and exports an item whose answer says it found nothing as not found, not completed', async () => {
    const env = await boot();
    env.state.broken = false;
    env.state.answer = (user) => (user.includes('Digdir') ? 'Ikke funnet.' : undefined);
    const estimate = await estimateFor(env);

    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 5 });

    expect(run.counts).toMatchObject({ succeeded: 4, notFound: 1, failed: 0 });
    const items = run.items as Record<string, unknown>[];
    expect(items.find((i) => i.status === 'notFound')).toMatchObject({
      document: { title: 'Årsrapport 2024 Digdir' },
    });
    const csv = String((await env.send('GET', `${base}/${String(run.id)}/export?format=csv`)).body);
    const json = await env.send('GET', `${base}/${String(run.id)}/export?format=json`);
    const digdir = csv.split('\r\n').find((r) => r.includes('Årsrapport 2024 Digdir')) ?? '';
    expect(digdir).toContain(';Ikke funnet;Ikke funnet.;');
    expect(csv).toContain(';Fullført;Sammendrag av');
    const exported = (json.body.items as Record<string, unknown>[]).find(
      (i) => i.status === 'notFound',
    );
    expect(exported).toMatchObject({ noAnswer: true });
  });

  it('treats a structured no-answer flag on the answer part as not found, whatever the wording', () => {
    const flagged = {
      noAnswer: false,
      answer: 'The annual report has no section on this, so there is nothing to summarise here.',
      parts: [
        { mime: 'text/plain', body: { kind: 'text' as const, text: '' }, meta: { noAnswer: true } },
      ],
    };

    expect(notFoundOf(flagged)).toBe(true);
    expect(notFoundOf({ ...flagged, parts: [] })).toBe(false);
    expect(notFoundOf({ noAnswer: true, answer: '', parts: [] })).toBe(true);
  });

  it('writes the CSV export in the language the caller asks for, status column included', async () => {
    const env = await boot();
    env.state.broken = false;
    env.state.answer = (user) =>
      user.includes('Digdir') ? 'I could not find it in the report.' : undefined;
    const estimate = await estimateFor(env);
    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 5 });

    const en = await env.send(
      'GET',
      `${base}/${String(run.id)}/export?format=csv`,
      'kari',
      undefined,
      {
        'accept-language': 'en',
      },
    );
    const nb = await env.send('GET', `${base}/${String(run.id)}/export?format=csv`);

    const [enHeader, ...enRows] = String(en.body).replace('\uFEFF', '').split('\r\n');
    expect(enHeader).toContain('No.;Document ID;Title;Link;Dataset;Status;Answer;Truncated');
    expect(enRows.join('\n')).toContain(';Completed;');
    expect(enRows.join('\n')).toContain(';Nothing found;I could not find it in the report.;No;');
    expect(String(nb.body)).toContain('Nr;Dokument-ID;Tittel;Lenke;Datasett;Status;Svar;Avkortet');
    expect(String(nb.body)).toContain(';Ikke funnet;I could not find it in the report.;Nei;');
  });

  it('keeps the item output limit between the floor and the platform default unless the service sets more', async () => {
    const env = await boot();
    env.state.broken = false;
    env.state.completion = () => 3000;
    const measured = await estimateFor(env, { ...annualReports, sample: true });
    const assumed = await estimateFor(env);

    expect((measured.perItem as { outputTokens: Range }).outputTokens.high).toBe(4000);
    expect(measured.maxOutputTokens).toBe(4000);
    expect(assumed.maxOutputTokens).toBe(4000);

    const raised = {
      ...service,
      spec: {
        ...service.spec,
        strategy: {
          ...service.spec.strategy,
          config: { instructions: 'Oppsummer.', maxTokens: 8000 },
        },
      },
    };
    const published = await env.platform.definitions.publish(raised, 'kari', 'mer');
    expect(published.ok).toBe(true);
    await env.platform.sync();
    const more = await estimateFor(env, { ...annualReports, sample: true });

    expect(more.maxOutputTokens).toBe(4500);
    expect((more.perItem as { outputTokens: Range }).outputTokens.high).toBe(4500);
  });

  it('refuses a cap below what one document can cost with a full answer', async () => {
    const env = await boot();
    const estimate = await estimateFor(env, { ...annualReports, sample: true });

    const refused = await env.send('POST', base, 'kari', {
      estimate: estimate.id,
      maxCostNok: 0.01,
    });

    expect(refused.status).toBe(400);
    expect(refused.body.title).toBe(
      'Taket er lavere enn det ett dokument kan koste med fullt svar (0,233 kr)',
    );
  });

  it('caps an unpriced model by tokens', async () => {
    const env = await boot({ prices: {} });
    env.state.broken = false;
    const estimate = await estimateFor(env, { ...annualReports, sample: true });
    expect(estimate).toMatchObject({ priced: false, costMicroNok: null });

    const refused = await env.send('POST', base, 'kari', { estimate: estimate.id, maxCostNok: 5 });
    expect(refused.status).toBe(400);
    const below = await env.send('POST', base, 'kari', { estimate: estimate.id, maxTokens: 1600 });
    expect(below.body.title).toBe(
      'Taket er lavere enn det ett dokument kan bruke med fullt svar (1\u00a0650 tokens)',
    );
    env.state.completion = () => 5000;
    const run = await runTo(env, { estimate: estimate.id, maxTokens: 3400, concurrency: 2 });

    expect(run).toMatchObject({
      status: 'stopped',
      counts: { succeeded: 2, skipped: 3 },
      tokens: { input: 200, output: 3000 },
      costMicroNok: null,
    });
  });

  it('exports the results with provenance as CSV and JSON', async () => {
    const env = await boot();
    const estimate = await estimateFor(env);
    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 5 });

    const csv = await env.send('GET', `${base}/${String(run.id)}/export?format=csv`);
    const json = await env.send('GET', `${base}/${String(run.id)}/export?format=json`);

    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('attachment');
    const lines = String(csv.body)
      .replace(/^\uFEFF/, '')
      .split('\r\n');
    expect(lines[0]).toBe(
      'Nr;Dokument-ID;Tittel;Lenke;Datasett;Status;Svar;Avkortet;Feil;Kilder;Tjeneste;Tjenesteversjon;Modell;Tokens inn;Tokens ut;Kostnad (kr);Oppgave',
    );
    expect(lines[2]).toContain(
      'd2;Årsrapport 2024 Digdir;;digdir/kudos;Fullført;Sammendrag av Årsrapport 2024 Digdir;Nei;',
    );
    expect((json.body.items as Record<string, unknown>[])[1]).toMatchObject({
      document: { id: 'd2', title: 'Årsrapport 2024 Digdir', dataset: 'digdir/kudos' },
      service: 'oppsummering',
      version: 1,
      models: [modelId],
      sources: [{ document: 'd2', title: 'Årsrapport 2024 Digdir' }],
      truncated: false,
    });
  });

  it('links a retired numeric Kudos document and its sources to a Kudos title search in the run and its exports', async () => {
    const env = await boot();
    const search = 'https://kudos.dfo.no/dokumenter?query=Tildelingsbrev%202021';
    const estimate = await estimateFor(env, { dataset: 'digdir/kudos', documents: ['330296'] });
    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 5 });

    const detail = await env.send('GET', `${base}/${String(run.id)}`);
    const csv = await env.send('GET', `${base}/${String(run.id)}/export?format=csv`);
    const json = await env.send('GET', `${base}/${String(run.id)}/export?format=json`);

    expect((detail.body.items as { document: unknown }[])[0]?.document).toMatchObject({
      id: '330296',
      url: search,
    });
    expect(String(csv.body)).toContain(`330296;Tildelingsbrev 2021;${search};digdir/kudos`);
    expect((json.body.items as { document: unknown }[])[0]?.document).toMatchObject({
      url: search,
    });
  });

  it('runs only the named documents when ids are given', async () => {
    const env = await boot();

    const estimate = await estimateFor(env, { dataset: 'digdir/kudos', documents: ['d2', 'd6'] });

    expect(estimate.items).toBe(2);
    expect((estimate.preview as { id: string }[]).map((d) => d.id)).toEqual(['d2', 'd6']);
  });

  it('cancels a run so the remaining documents are not processed', async () => {
    const env = await boot();
    env.state.broken = false;
    const estimate = await estimateFor(env);
    const started = await env.send('POST', base, 'kari', {
      estimate: estimate.id,
      maxCostNok: 5,
      concurrency: 1,
    });

    const cancelled = await env.send(
      'POST',
      `${base}/${String(started.body.id)}/cancel`,
      'kari',
      {},
    );
    await env.settled();
    const run = (await env.send('GET', `${base}/${String(started.body.id)}`)).body;

    expect(cancelled.status).toBe(202);
    expect(run.status).toBe('cancelled');
    expect((run.counts as Record<string, number>).succeeded).toBeLessThan(5);
    expect(
      (await env.send('POST', `${base}/${String(started.body.id)}/cancel`, 'kari', {})).status,
    ).toBe(409);
  });

  it('starting, retrying and cancelling a run are audited admin tasks with the change reason', async () => {
    const env = await boot();
    const estimate = await estimateFor(env);
    const started = await env.send(
      'POST',
      base,
      'kari',
      { estimate: estimate.id, maxCostNok: 5 },
      {
        'change-reason': 'Oppsummerer årsrapportene',
      },
    );
    await env.settled();
    const id = String(started.body.id);
    const retried = await env.send('POST', `${base}/${id}/retry`, 'kari', { maxCostNok: 5 });
    await env.send('POST', `${base}/${id}/cancel`, 'kari', {});

    const audit = await env.admin.audit(tenant);
    expect(started.headers.get('genai-task')).toBeTruthy();
    expect(retried.headers.get('genai-task')).toBeTruthy();
    expect(audit.map((a) => a.action)).toEqual([
      'platform.batch-run.start',
      'platform.batch-run.retry',
      'platform.batch-run.cancel',
    ]);
    expect(audit[0]).toMatchObject({ outcome: 'applied', reason: 'Oppsummerer årsrapportene' });
  });

  it('shows tokens and cost of a batch run only with view-usage or to the person who started it', async () => {
    const env = await boot();
    const estimate = await estimateFor(env);
    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 5 });

    const listed = (await env.send('GET', base, 'erik')).body.data as Record<string, unknown>[];
    const detail = (await env.send('GET', `${base}/${String(run.id)}`, 'erik')).body;
    const json = (await env.send('GET', `${base}/${String(run.id)}/export?format=json`, 'erik'))
      .body;
    const csv = String(
      (await env.send('GET', `${base}/${String(run.id)}/export?format=csv`, 'erik')).body,
    );
    const own = (await env.send('GET', `${base}/${String(run.id)}`, 'kari')).body;

    for (const field of ['tokens', 'costMicroNok', 'cap', 'perItem']) {
      expect(listed[0]).not.toHaveProperty(field);
      expect(detail).not.toHaveProperty(field);
    }
    for (const item of detail.items as Record<string, unknown>[]) {
      expect(item).not.toHaveProperty('tokens');
      expect(item).not.toHaveProperty('costMicroNok');
    }
    for (const item of json.items as Record<string, unknown>[])
      expect(item).not.toHaveProperty('costMicroNok');
    const row =
      csv
        .replace(/^\uFEFF/, '')
        .split('\r\n')[2]
        ?.split(';') ?? [];
    expect(row.slice(13, 16)).toEqual(['', '', '']);
    expect(own).toHaveProperty('costMicroNok');
    expect(own).toHaveProperty('tokens');
  });

  it('keeps runs to their tenant and needs the right to manage services to start one', async () => {
    const env = await boot();
    const estimate = await estimateFor(env);
    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 5 });

    expect((await env.send('GET', `${base}/${String(run.id)}`, 'ola')).status).toBe(404);
    expect(
      (
        await env.send(
          'GET',
          `/tenants/${other}/services/oppsummering/batch-runs/${String(run.id)}`,
          'ola',
        )
      ).status,
    ).toBe(404);
    expect((await env.send('POST', `${base}/estimate`, 'erik', annualReports)).status).toBe(403);
    expect(
      (await env.send('POST', base, 'erik', { estimate: estimate.id, maxCostNok: 5 })).status,
    ).toBe(403);
    expect((await env.send('GET', base, 'erik')).body.data).toHaveLength(1);
  });
});

const ragService = {
  ...service,
  metadata: { tenant, id: 'kilder', name: 'Kilder' },
  spec: {
    ...service.spec,
    strategy: {
      id: 'rag-single-shot',
      version: 1,
      config: { instructions: 'Svar med kilder.', generate: true },
    },
    knowledge: { datasets: [{ dataset: 'digdir/kudos' }] },
  },
};

const readingFlow = {
  apiVersion: 'genai/v1',
  kind: 'StepFlow',
  metadata: { tenant, id: 'les-dokumentet', name: 'Les dokumentet' },
  spec: {
    purpose: 'Les dokumentet batchen gir',
    steps: [
      { id: 'les', block: 'read-document@1', input: { document: '{{input.document}}' } },
      { id: 'sok', block: 'retrieve@1', input: { query: '{{input.query}}' } },
    ],
  },
};

const flowService = {
  ...service,
  metadata: { tenant, id: 'flyt', name: 'Flyt' },
  spec: {
    ...service.spec,
    strategy: { id: 'step-flow', version: 1, config: { flow: 'les-dokumentet@1' } },
    knowledge: { datasets: [{ dataset: 'digdir/kudos' }] },
  },
};

const threeDocuments = { dataset: 'digdir/kudos', documents: ['d1', 'd2', 'd4'] };
const titleOf = (id: string) => kudosDocs.find((d) => d.doc_num === id)?.title ?? '';

const runService = async (env: Env, id: string) => {
  const path = `/tenants/${tenant}/services/${id}/batch-runs`;
  const estimate = await env.send('POST', `${path}/estimate`, 'kari', {
    ...threeDocuments,
    sample: false,
  });
  expect(estimate.status).toBe(201);
  const started = await env.send('POST', path, 'kari', {
    estimate: estimate.body.id,
    maxCostNok: 5,
  });
  expect(started.status).toBe(202);
  await env.settled();
  return (await env.send('GET', `${path}/${String(started.body.id)}`)).body;
};

const chunkSearches = (env: Env) =>
  env.state.searches.filter(
    (s) =>
      s.collection !== docsCollection &&
      typeof s.facet_by !== 'string' &&
      !String(s.filter_by).startsWith('chunk_id:='),
  );

describe('documents in a batch run are the only knowledge each item sees', () => {
  it('scopes every search of a rag service to the item document, and cites only its chunks', async () => {
    const env = await boot();
    env.state.broken = false;
    const published = await env.platform.definitions.publish(ragService, 'kari', 'første');
    expect(published.ok).toBe(true);
    env.state.searches.length = 0;

    const run = await runService(env, 'kilder');

    expect(run).toMatchObject({ status: 'succeeded', counts: { succeeded: 3 } });
    for (const item of run.items as {
      document: { id: string };
      sources: { document?: string; url?: string }[];
    }[]) {
      expect(item.sources.length).toBeGreaterThan(0);
      expect(new Set(item.sources.map((s) => s.url))).toEqual(
        new Set([`https://kudos.example.no/${item.document.id}`]),
      );
    }
    const searched = chunkSearches(env);
    expect(searched.length).toBeGreaterThan(0);
    for (const s of searched)
      expect(String(s.filter_by)).toMatch(/doc_num:=\[`d[124]`\]|doc_num:=`d[124]`/);
  });

  it('gives a single-call service the text of its own document only', async () => {
    const env = await boot();
    env.state.broken = false;

    await runService(env, 'oppsummering');

    for (const id of ['d1', 'd2', 'd4']) {
      const prompt = env.state.users.find((u) => u.includes(`Fra ${titleOf(id)}: tekst 1`));
      expect(prompt, id).toBeDefined();
      expect(prompt).toContain(`Fra ${titleOf(id)}: tekst 2`);
      for (const other of ['d1', 'd2', 'd4'].filter((o) => o !== id))
        expect(prompt).not.toContain(`Fra ${titleOf(other)}`);
    }
  });

  it('lets a step flow read input.document and keeps its retrieve step on that document', async () => {
    const env = await boot();
    env.state.broken = false;
    expect((await env.platform.definitions.publish(readingFlow, 'kari', 'første')).ok).toBe(true);
    expect((await env.platform.definitions.publish(flowService, 'kari', 'første')).ok).toBe(true);
    env.state.searches.length = 0;

    const run = await runService(env, 'flyt');

    expect(run).toMatchObject({ status: 'succeeded', counts: { succeeded: 3 } });
    const ranges = chunkSearches(env).filter((s) => String(s.sort_by).startsWith('chunk_index'));
    expect(ranges.map((s) => /doc_num:=`(d\d)`/.exec(String(s.filter_by))?.[1]).sort()).toEqual([
      'd1',
      'd2',
      'd4',
    ]);
    for (const s of chunkSearches(env)) expect(String(s.filter_by)).toMatch(/d[124]/);
  });
});

describe('a batch run keeps the version it was estimated on', () => {
  it('runs every item and retry on that version after the service is republished', async () => {
    const env = await boot();
    const estimate = await estimateFor(env);
    const republished = await env.platform.definitions.publish(
      {
        ...service,
        spec: {
          ...service.spec,
          strategy: { ...service.spec.strategy, config: { instructions: 'Ny versjon.' } },
        },
      },
      'kari',
      'andre',
    );
    expect(republished.ok).toBe(true);

    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 5 });
    env.state.broken = false;
    await env.send('POST', `${base}/${String(run.id)}/retry`, 'kari', { maxCostNok: 5 });
    await env.settled();
    const after = (await env.send('GET', `${base}/${String(run.id)}`)).body;

    expect(after).toMatchObject({ version: 1, counts: { succeeded: 5 } });
    expect(new Set((after.items as { version: number }[]).map((i) => i.version))).toEqual(
      new Set([1]),
    );
    expect(env.state.users.some((u) => u.includes('Ny versjon.'))).toBe(false);
    expect(env.state.users.filter((u) => u.includes('Oppsummer kort.'))).toHaveLength(6);
  });
});

describe('batch runs of a paused or archived service', () => {
  const setState = (store: InMemoryConfigEntryStore, state: 'paused' | 'archived' | 'active') =>
    appendVersion(store, {
      kind: serviceLifecycleKind,
      scope: tenant,
      id: 'oppsummering',
      spec: { state },
      deleted: state === 'active',
      by: 'employee:test:kari',
      reason: 'Venter på ny modell',
    });

  it('refuses to start and to retry with the service problem code, and runs again once resumed', async () => {
    const store = new InMemoryConfigEntryStore();
    const env = await boot({ store });
    const estimate = await estimateFor(env);
    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 5 });

    await setState(store, 'paused');
    const second = await estimateFor(env);
    const start = await env.send('POST', base, 'kari', { estimate: second.id, maxCostNok: 5 });
    const retry = await env.send('POST', `${base}/${String(run.id)}/retry`, 'kari', {
      maxCostNok: 5,
    });
    await setState(store, 'archived');
    const archived = await env.send('POST', base, 'kari', { estimate: second.id, maxCostNok: 5 });
    await setState(store, 'active');
    const resumed = await env.send('POST', base, 'kari', { estimate: second.id, maxCostNok: 5 });

    for (const refused of [start, retry]) {
      expect(refused.status).toBe(503);
      expect(refused.body.errors).toEqual([
        expect.objectContaining({
          code: 'service_paused',
          message: 'Tjenesten er satt på pause. Begrunnelse: Venter på ny modell',
        }),
      ]);
    }
    expect(archived.status).toBe(503);
    expect(archived.body.errors).toEqual([expect.objectContaining({ code: 'service_archived' })]);
    expect(resumed.status).toBe(202);
    await env.settled();
  });
});

describe('batch runs after a restart', () => {
  it('marks a run left running as failed, fails its running item, and retries what was left', async () => {
    const store = new InMemoryConfigEntryStore();
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const put = (kind: string, id: string, spec: unknown) =>
      store.append({
        kind,
        scope: tenant,
        id,
        version: 1,
        spec: spec as Record<string, unknown>,
        deleted: false,
        by: 'employee:test:kari',
        reason: 'Kjører',
        at: minutesAgo(10),
      });
    const documents = kudosDocs.slice(0, 2).map((d) => ({ id: d.doc_num, title: d.title }));
    const perItem = {
      inputTokens: { low: 1, high: 2 },
      outputTokens: { low: 1, high: 2 },
      costMicroNok: { low: 1, high: 2 },
    };
    await put(batchEstimateKind, 'est', {
      id: 'est',
      service: 'oppsummering',
      version: 1,
      model: modelId,
      priced: true,
      dataset: 'digdir/kudos',
      filters: {},
      documents,
      items: 2,
      perItem,
      tokens: { low: 2, high: 4 },
      costMicroNok: { low: 2, high: 4 },
      createdAt: minutesAgo(12),
      expiresAt: minutesAgo(-1000),
    });
    await put(batchRunKind, 'gammel', {
      id: 'gammel',
      service: 'oppsummering',
      version: 1,
      model: modelId,
      priced: true,
      dataset: 'digdir/kudos',
      filters: {},
      estimate: 'est',
      status: 'running',
      total: 2,
      concurrency: 1,
      cap: { costMicroNok: 1_000_000 },
      perItem,
      pass: 1,
      startedAt: minutesAgo(12),
      endedAt: null,
      owner: 'old',
      heartbeatAt: minutesAgo(10),
    });
    await put(batchItemKind, 'gammel/00000', {
      run: 'gammel',
      index: 0,
      document: documents[0],
      status: 'running',
      attempts: 1,
      pass: 1,
      sources: [],
      models: [],
      tokens: { input: 0, output: 0 },
      costMicroNok: 0,
    });

    const env = await boot({ store });
    await env.settled();
    const run = (await env.send('GET', `${base}/gammel`)).body;

    expect(run).toMatchObject({
      status: 'failed',
      error: restartMessage,
      counts: { failed: 1, skipped: 1 },
    });
    expect((run.items as Record<string, unknown>[])[0]).toMatchObject({ error: restartMessage });

    const retried = await env.send('POST', `${base}/gammel/retry`, 'kari', { maxCostNok: 5 });
    expect(retried.body.retried).toBe(2);
    await env.settled();
    expect((await env.send('GET', `${base}/gammel`)).body).toMatchObject({
      status: 'succeeded',
      counts: { succeeded: 2 },
    });
  });
});

describe('approval above the per-job limit', () => {
  it('says the estimate needs approval when it is above the tenant limit, and refuses to start without a reason', async () => {
    const env = await boot();
    expect(env.platform.settings.setTenant(tenant, 'batch.approvalLimitNok', 0.5).ok).toBe(true);
    const estimate = await estimateFor(env);

    expect(estimate.approval).toEqual({ limitNok: 0.5, required: true });
    const refused = await env.send('POST', base, 'kari', { estimate: estimate.id, maxCostNok: 5 });
    expect(refused.status).toBe(409);
    expect(refused.body.errors).toEqual([expect.objectContaining({ path: 'approval' })]);

    const run = await runTo(env, {
      estimate: estimate.id,
      maxCostNok: 5,
      approval: 'Godkjent av leder for årsrapportarbeidet',
    });
    expect(run.costApproval).toMatchObject({
      by: expect.stringContaining('kari'),
      reason: 'Godkjent av leder for årsrapportarbeidet',
      limitNok: 0.5,
    });
    expect(run.startedBy).toEqual(expect.stringContaining('kari'));
  });

  it('needs no approval below the default limit of 150 kr', async () => {
    const env = await boot();
    const estimate = await estimateFor(env);

    expect(estimate.approval).toEqual({ limitNok: 150, required: false });
    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 5 });
    expect(run.costApproval).toBeUndefined();
  });
});

describe('input values for every document', () => {
  const withFields = {
    ...service,
    spec: {
      ...service.spec,
      input: {
        accepts: ['text/plain'],
        fields: [
          {
            id: 'fellesforing',
            label: 'Fellesføring',
            kind: 'choice',
            required: true,
            options: ['Inkluderingsdugnaden', 'Lærlinger'],
          },
        ],
      },
    },
  };

  it('checks the values against the service fields and sends them with each document', async () => {
    const env = await boot();
    env.state.broken = false;
    expect((await env.platform.definitions.publish(withFields, 'kari', 'felt')).ok).toBe(true);
    await env.platform.sync();

    const wrong = await env.send('POST', `${base}/estimate`, 'kari', {
      ...annualReports,
      sample: false,
      input: { fellesforing: 'Klima' },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors).toEqual([expect.objectContaining({ path: 'input.fellesforing' })]);

    const estimate = await estimateFor(env, {
      ...annualReports,
      input: { fellesforing: 'Lærlinger' },
    });
    expect(estimate.input).toEqual({ fellesforing: 'Lærlinger' });
    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 5 });
    expect(run.input).toEqual({ fellesforing: 'Lærlinger' });
    expect(env.state.users.every((u) => u.includes('Fellesføring: Lærlinger'))).toBe(true);
  });
});

describe('choosing the documents for a batch run', () => {
  const extra = [
    {
      doc_num: 'd7',
      title: 'Årsrapport for Miljødirektoratet for 2022 M-2513',
      type: 'Årsrapport',
      concerned_years: '2024',
      orgs_short: 'MDIR',
      total_chunks: 30,
    },
    {
      doc_num: 'd8',
      title: 'Årsrapport 2024 Statsbygg',
      type: 'Årsrapport',
      concerned_years: '2024',
      orgs_short: 'SB',
      total_chunks: 20,
      publish_date: '2025-04-01',
    },
  ];
  afterEach(() => {
    kudosDocs.splice(kudosDocs.length - extra.length, extra.length);
  });

  it('leaves out a report whose title names another year and older versions of the same report, and says how many it left out', async () => {
    kudosDocs.push(...extra);
    const env = await boot();

    const estimate = await estimateFor(env);

    expect(estimate).toMatchObject({
      found: 7,
      items: 5,
      excluded: {
        otherYear: [{ id: 'd7', title: 'Årsrapport for Miljødirektoratet for 2022 M-2513' }],
        duplicates: [{ document: { id: 'd5', title: 'Årsrapport 2024 Statsbygg' }, keptId: 'd8' }],
      },
    });
    expect((estimate.preview as { id: string }[]).map((d) => d.id).sort()).toEqual([
      'd1',
      'd2',
      'd3',
      'd4',
      'd8',
    ]);
  });

  it('keeps every document the person names by id, even an older version', async () => {
    kudosDocs.push(...extra);
    const env = await boot();

    const estimate = await estimateFor(env, {
      dataset: 'digdir/kudos',
      documents: ['d5', 'd7', 'd8'],
    });

    expect(estimate).toMatchObject({ found: 3, items: 3 });
    expect(estimate.excluded).toBeUndefined();
  });
});

describe('a run stored by an earlier version of the platform', () => {
  const legacy = async () => {
    const store = new InMemoryConfigEntryStore();
    const put = (kind: string, id: string, spec: unknown) =>
      store.append({
        kind,
        scope: tenant,
        id,
        version: 1,
        spec: spec as Record<string, unknown>,
        deleted: false,
        by: 'employee:test:kari',
        reason: 'Ferdig',
        at: new Date().toISOString(),
      });
    const documents = [
      { id: '330296', title: 'Tildelingsbrev 2021' },
      { id: 'd3', title: 'Årsrapport 2024 Feilrapport' },
    ];
    const perItem = {
      inputTokens: { low: 50, high: 150 },
      outputTokens: { low: 10, high: 30 },
      costMicroNok: { low: 3000, high: 12_000 },
    };
    await put(batchEstimateKind, 'est', {
      id: 'est',
      service: 'oppsummering',
      version: 1,
      model: modelId,
      priced: true,
      dataset: 'digdir/kudos',
      filters: {},
      documents,
      items: 2,
      perItem,
      tokens: { low: 120, high: 360 },
      costMicroNok: { low: 6000, high: 24_000 },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await put(batchRunKind, 'gammel', {
      id: 'gammel',
      service: 'oppsummering',
      version: 1,
      model: modelId,
      priced: true,
      dataset: 'digdir/kudos',
      filters: {},
      estimate: 'est',
      status: 'succeeded',
      total: 2,
      concurrency: 1,
      cap: { costMicroNok: 4_000_000 },
      perItem,
      pass: 1,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
    await put(batchItemKind, 'gammel/00000', {
      run: 'gammel',
      index: 0,
      document: documents[0],
      status: 'succeeded',
      attempts: 1,
      pass: 1,
      output: 'Mål og resultater',
      sources: Array.from({ length: 10 }, () => ({
        title: 'Tildelingsbrev 2021',
        document: '330296',
      })),
      models: [modelId],
      tokens: { input: 100, output: 20 },
      costMicroNok: 8000,
    });
    await put(batchItemKind, 'gammel/00001', {
      run: 'gammel',
      index: 1,
      document: documents[1],
      status: 'failed',
      attempts: 1,
      pass: 1,
      error: 'task emitted more than 10000 events',
      sources: [],
      models: [],
      tokens: { input: 0, output: 0 },
      costMicroNok: 0,
    });
    return boot({ store });
  };
  const search = 'https://kudos.dfo.no/dokumenter?query=Tildelingsbrev%202021';

  it('exports every row with its document link and each source once', async () => {
    const env = await legacy();

    const csv = String((await env.send('GET', `${base}/gammel/export?format=csv`)).body);

    const row = csv.split('\r\n').find((l) => l.startsWith('1;')) ?? '';
    expect(row).toContain(`330296;Tildelingsbrev 2021;${search};digdir/kudos;Fullført`);
    expect(row).toContain(`;Tildelingsbrev 2021 ${search};oppsummering;`);
    expect(row.split('Tildelingsbrev 2021').length - 1).toBe(2);
  });

  it('maps a failure text stored before error codes to its translated code when the job is read', async () => {
    const env = await legacy();

    const job = (await env.send('GET', `${base}/gammel`)).body;

    expect((job.items as Record<string, unknown>[])[1]).toMatchObject({
      status: 'failed',
      errorCode: 'limit_exceeded',
    });
  });

  it('retries a failed document under the output limit the estimate allows, so a runaway answer is cut short instead of failing again', async () => {
    const env = await legacy();
    env.state.broken = false;
    env.state.completion = () => 16_384;

    const retried = await env.send('POST', `${base}/gammel/retry`, 'kari', { maxCostNok: 5 });
    expect(retried.status).toBe(202);
    await env.settled();
    const after = (await env.send('GET', `${base}/gammel`)).body;

    expect(
      env.state.bodies.at(-1)?.max_completion_tokens ?? env.state.bodies.at(-1)?.max_tokens,
    ).toBe(1500);
    expect((after.items as Record<string, unknown>[])[1]).toMatchObject({
      status: 'succeeded',
      truncated: true,
      tokens: { input: 100, output: 1500 },
    });
  });

  it('names the person who started it when that person is the one looking', async () => {
    const env = await legacy();

    const own = await env.send('GET', `${base}/gammel`, 'kari', undefined, {
      'actor-name': encodeURIComponent('Kari Nordmann'),
    });
    const other = await env.send('GET', `${base}/gammel`, 'erik', undefined, {
      'actor-name': 'Erik',
    });

    expect(own.body).toMatchObject({
      startedBy: 'employee:test:kari',
      startedByName: 'Kari Nordmann',
    });
    expect(other.body.startedByName).toBeUndefined();
  });
});

describe('who started a batch run', () => {
  it('stores the name of the person who starts a run and shows it to everyone', async () => {
    const env = await boot();
    const estimate = await estimateFor(env);

    const started = await env.send(
      'POST',
      base,
      'kari',
      { estimate: estimate.id, maxCostNok: 5 },
      { 'actor-name': encodeURIComponent('Kari Nordmann') },
    );
    await env.settled();
    const listed = await env.send('GET', base, 'erik');

    expect(started.body.startedByName).toBe('Kari Nordmann');
    expect((listed.body.data as Record<string, unknown>[])[0]?.startedByName).toBe('Kari Nordmann');
  });
});

describe('a batch run within the monthly token quota', () => {
  it('records the tokens and cost a failed document spent, with the reason code', async () => {
    const env = await boot();
    env.state.broken = false;
    const estimate = await estimateFor(env, { ...annualReports, sample: true });
    env.state.runaway = 'Feilrapport';
    env.state.completion = () => 100_000;

    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 50 });

    const failed = (run.items as Record<string, unknown>[]).find((i) => i.status === 'failed');
    expect(failed).toMatchObject({
      errorCode: expect.any(String),
      tokens: { output: 100_000 },
      costMicroNok: expect.any(Number),
    });
    expect(failed?.costMicroNok as number).toBeGreaterThan(0);
  });

  it('refuses to start a run when the month is used up', async () => {
    const env = await boot();
    env.state.broken = false;
    const estimate = await estimateFor(env);
    await runTo(env, { estimate: estimate.id, maxCostNok: 5 });
    expect(env.platform.settings.setTenant(tenant, 'usage.monthlyTokens', 100).ok).toBe(true);

    const next = await estimateFor(env);
    const refused = await env.send('POST', base, 'kari', { estimate: next.id, maxCostNok: 5 });

    expect(refused.status).toBe(409);
    expect(refused.body.errors).toEqual([expect.objectContaining({ path: 'quota' })]);
  });

  it('stops before a document whose reservation would pass the monthly quota', async () => {
    const env = await boot();
    env.state.broken = false;
    const estimate = await estimateFor(env, { ...annualReports, sample: true });
    const perItem = estimate.perItem as { inputTokens: Range; outputTokens: Range };
    const reservation = perItem.inputTokens.high + perItem.outputTokens.high;
    const used = env.state.bodies.length * 120;
    expect(
      env.platform.settings.setTenant(tenant, 'usage.monthlyTokens', used + reservation + 60).ok,
    ).toBe(true);

    const run = await runTo(env, { estimate: estimate.id, maxCostNok: 50, concurrency: 1 });

    expect(run).toMatchObject({
      status: 'stopped',
      errorCode: 'quota_exhausted',
      counts: { succeeded: 1, skipped: 4 },
    });
  });
});
