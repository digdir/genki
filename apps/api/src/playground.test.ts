import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { parseTestSet } from '@genai/eval';
import { envSecrets } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { outsideEuRule } from './building-blocks.js';
import { resolveCatalog } from './catalogs.js';
import { createPlatform } from './composition.js';
import { platformScope } from './config-store.js';
import { localeMiddleware } from './i18n/index.js';
import type { PlaygroundOptions, PlaygroundRunResponse } from './playground.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) => parseYaml(readFileSync(join(config, file), 'utf8')) as unknown;
const tenant = '991825827';
const modelId = 'foundry-openai/gpt-4o-2m-tps';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant,
    authorizedFor: [{ org: tenant }],
  } as Principal,
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant,
    authorizedFor: [{ org: tenant, actions: ['use-services'] }],
  } as Principal,
};

const completion = (content: string, tokens: [number, number]) => ({
  status: 200,
  json: {
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-test',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: tokens[0], completion_tokens: tokens[1], total_tokens: 0 },
  },
});

const streamed = (content: string, tokens: [number, number]) => ({
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
        usage: { prompt_tokens: tokens[0], completion_tokens: tokens[1], total_tokens: 0 },
      },
    },
    { data: '[DONE]' },
  ],
});

const modelReply = (body: Record<string, unknown>) => {
  if (!body.messages)
    return {
      status: 200,
      json: { data: [{ id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' }] },
    };
  const system = (body.messages as { content?: string }[])[0]?.content ?? '';
  if (system.includes('Feil')) return { status: 400, json: { error: { message: 'nede' } } };
  const [answer, tokens]: [string, [number, number]] = system.includes('nynorsk')
    ? ['Nynorsksvar.', [20, 10]]
    : ['Bokmålssvar.', [10, 5]];
  return body.stream ? streamed(answer, tokens) : completion(answer, tokens);
};

const service = (id: string, instructions: string) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id, name: id },
  spec: {
    purpose: 'Svar kort på spørsmål',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions } },
    model: { primary: modelId, residency: 'global' },
  },
});

const openPolicy = {
  kind: 'block-policy',
  scope: platformScope,
  id: 'platform',
  version: 1,
  spec: { rules: [] },
  deleted: false,
  by: 'drift',
  at: new Date().toISOString(),
  reason: 'Alle modeller er tillatt i testene',
};

const boot = async ({ residencyRule = false } = {}) => {
  const model = await fakeHttp(modelReply);
  const search = await fakeHttp(() => ({ status: 200, json: {} }));
  servers.push(model, search);
  const env = {
    FOUNDRY_OPENAI_BASE_URL: `${model.url}/v1`,
    TYPESENSE_URL: search.url,
    COLBERT_API_URL: search.url,
  };
  const settings = new SettingsRegistry(platformSettings);
  const blobs = new InMemoryBlobStore();
  const platform = await createPlatform({
    blobStore: blobs,
    catalogs: {
      models: resolveCatalog(yaml('models.yaml'), 'models', env).catalog,
      knowledge: resolveCatalog(yaml('knowledge.yaml'), 'datasets', env).catalog,
      rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', env).catalog,
    },
    prices: { [modelId]: { inputPerThousand: 1, outputPerThousand: 2 } },
    secrets: envSecrets({ FOUNDRY_OPENAI_KEY: 'm', TYPESENSE_KEY: 't', COLBERT_API_KEY: 'c' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    settings,
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = people[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
  });
  await platform.configEntries.append(
    residencyRule ? { ...openPolicy, spec: { rules: [outsideEuRule] } } : openPolicy,
  );
  const app = new Hono();
  app.use('*', localeMiddleware);
  platform.mount(
    app,
    createAdmin({
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      extensions: platform.extensions,
    }),
  );
  const call = async (path: string, body?: unknown, who = 'kari') => {
    const res = await app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${who}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const run = (body: unknown, who?: string) =>
    call(`/tenants/${tenant}/playground/runs`, body, who);
  return { platform, settings, model, blobs, call, run, app };
};

const testSet = (id: string, forService: string) =>
  parseTestSet({
    apiVersion: 'genai/v1',
    kind: 'TestSet',
    metadata: { tenant, id, name: `Spørsmål til ${forService}`, version: 1 },
    spec: {
      service: forService,
      cases: [
        { id: 'c1', split: 'validation', input: 'Hei', expected: { referenceAnswer: 'Hei' } },
      ],
    },
  });

const own = (instructions: string) => ({
  model: modelId,
  instructions,
  output: 'text',
});

describe('the playground', () => {
  it('a playground run with a not-allowed model is refused with the rule and owner', async () => {
    const { call, run } = await boot({ residencyRule: true });

    const refused = await run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } });
    const options = (await call(`/tenants/${tenant}/playground/options`))
      .body as unknown as PlaygroundOptions;

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      setup: 'setup',
      policy: {
        block: modelId,
        ownedBy: 'Digdir',
        link: '#/settings',
        rule: expect.stringContaining('utenfor EU/EØS'),
      },
    });
    expect(options.models.find((m) => m.id === modelId)).toMatchObject({
      dataLocation: 'global',
      status: 'not_allowed',
      policy: { ownedBy: 'Digdir' },
    });
  });

  it('compare returns two results with their own cost', async () => {
    const { run } = await boot();

    const res = await run({
      setup: own('Svar på bokmål.'),
      compareWith: own('Svar på nynorsk.'),
      input: { text: 'Hei' },
    });
    const body = res.body as unknown as PlaygroundRunResponse;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      text: 'Bokmålssvar.',
      tokensIn: 10,
      tokensOut: 5,
      costNok: 0.02,
      dataLocation: 'global',
      sources: [],
      searchNotes: [],
      quota: { usedPercent: expect.any(Number), monthlyTokens: 50_000_000 },
    });
    expect(body.compare).toMatchObject({
      text: 'Nynorsksvar.',
      tokensIn: 20,
      tokensOut: 10,
      costNok: 0.04,
    });
    expect(body.runId).not.toBe(body.compare?.runId);
    expect(typeof body.timeMs).toBe('number');
  });

  it('a failed model call answers a 502 problem, stores nothing and is not counted', async () => {
    const { platform, call, run } = await boot();

    const res = await run({ setup: own('Feil med vilje.'), input: { text: 'Hei' } });
    const options = (await call(`/tenants/${tenant}/playground/options`))
      .body as unknown as PlaygroundOptions;

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      type: 'urn:genai:problem:playground-unavailable',
      status: 502,
      setup: 'setup',
    });
    expect(options.quota.usedPercent).toBe(0);
    expect(await platform.evalStores.candidates.list(tenant)).toEqual([]);
    expect(await platform.definitions.list(tenant)).toEqual([]);
  });

  it('playground runs are excluded from service statistics', async () => {
    const { call, run } = await boot();

    const res = await run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } });
    const usage = (await call(`/tenants/${tenant}/usage`)).body as {
      totals: { inputTokens: number };
      byService: unknown[];
    };
    const tasks = (await call(`/tenants/${tenant}/tasks`)).body as { data: unknown[] };

    expect(res.status).toBe(200);
    expect(usage.totals.inputTokens).toBe(0);
    expect(usage.byService).toEqual([]);
    expect(tasks.data).toEqual([]);
  });

  it('a run on a service draft uses the draft, not the published version', async () => {
    const { platform, run } = await boot();
    await platform.definitions.publish(service('svar', 'Svar på nynorsk.'), 'test', 'første');

    const draft = await run({
      setup: {
        service: { id: 'svar', version: 'draft', definition: service('svar', 'Svar på bokmål.') },
        output: 'text',
      },
      compareWith: { service: { id: 'svar', version: 1 }, output: 'text' },
      input: { text: 'Hei' },
    });

    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({
      text: 'Bokmålssvar.',
      compare: { text: 'Nynorsksvar.' },
    });
  });

  it('the playground is refused when the setting turns it off', async () => {
    const { settings, call, run } = await boot();
    expect(settings.setTenant(tenant, 'playground.enabled', false)).toMatchObject({ ok: true });

    const res = await run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } });
    const options = await call(`/tenants/${tenant}/playground/options`);

    expect(res.status).toBe(409);
    expect(res.body.title).toMatch(/Prøveområdet er slått av/);
    expect(options.status).toBe(409);
  });

  it('a user without manage rights cannot run the playground', async () => {
    const { run, model } = await boot();
    const before = model.seen.length;

    const res = await run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } }, 'erik');

    expect(res.status).toBe(403);
    expect(res.body.title).toMatch(/Administrere tjenester/);
    expect(model.seen.length).toBe(before);
  });

  it('lists services exposed for chat first, with the sample questions from their definition', async () => {
    const { platform, call } = await boot();
    const plain = service('aaa-benchmark', 'Svar kort.');
    const chat = service('zzz-chat', 'Svar kort.');
    Object.assign(chat.spec, {
      exposure: { chat: true },
      exampleQuestions: ['Hva er fristen?'],
    });
    await platform.definitions.publish(plain, 'test', 'første');
    await platform.definitions.publish(chat, 'test', 'første');

    const options = (await call(`/tenants/${tenant}/playground/options`))
      .body as unknown as PlaygroundOptions;

    expect(options.services.map((s) => [s.id, s.chat, s.exampleQuestions])).toEqual([
      ['zzz-chat', true, ['Hva er fristen?']],
      ['aaa-benchmark', false, []],
    ]);
  });

  it('gives each sample question in the language the caller reads, and keeps a plain question as written', async () => {
    const { platform, app } = await boot();
    const chat = service('zzz-chat', 'Svar kort.');
    Object.assign(chat.spec, {
      exposure: { chat: true },
      exampleQuestions: [{ nb: 'Hva er fristen?', en: 'What is the deadline?' }, 'Hei'],
    });
    const published = await platform.definitions.publish(chat, 'test', 'første');
    expect(published.ok ? [] : published.errors).toEqual([]);
    const questions = async (language: string) => {
      const res = await app.request(`/tenants/${tenant}/playground/options`, {
        headers: { authorization: 'Bearer kari', 'accept-language': language },
      });
      const options = (await res.json()) as PlaygroundOptions;
      return options.services.find((s) => s.id === 'zzz-chat')?.exampleQuestions;
    };

    expect(await questions('nb')).toEqual(['Hva er fristen?', 'Hei']);
    expect(await questions('en')).toEqual(['What is the deadline?', 'Hei']);
  });

  it('the options carry service versions, named blocks, test sets and the monthly quota', async () => {
    const { platform, call } = await boot();
    await platform.definitions.publish(service('svar', 'Svar på nynorsk.'), 'test', 'første');
    await platform.definitions.publish(service('svar', 'Svar på bokmål.'), 'test', 'andre');
    await platform.evalStores.testSets.put(testSet('svar-sporsmal', 'svar'));

    const options = (await call(`/tenants/${tenant}/playground/options`))
      .body as unknown as PlaygroundOptions;

    expect(options.services).toEqual([
      {
        id: 'svar',
        name: 'svar',
        chat: false,
        exampleQuestions: [],
        latestVersion: 2,
        versions: [
          {
            version: 2,
            draft: false,
            inUse: true,
            setup: expect.objectContaining({ model: modelId }),
          },
          {
            version: 1,
            draft: false,
            inUse: false,
            setup: expect.objectContaining({ output: 'text' }),
          },
        ],
      },
    ]);
    expect(options.testSets).toEqual([
      { id: 'svar-sporsmal', name: 'Spørsmål til svar', cases: 1, service: 'svar' },
    ]);
    expect(options.blocks.every((b) => typeof b.name === 'string')).toBe(true);
    expect(options.quota).toEqual({ usedPercent: 0, monthlyTokens: 50_000_000 });
  });

  it('an uploaded file is stored in the tenant blob store and read by the run', async () => {
    const { blobs, model, run } = await boot();
    const data = Buffer.from('Søker: Eksempel IL\nBeløp: 120 000 kr').toString('base64');

    const res = await run({
      setup: own('Svar på bokmål.'),
      input: { file: { name: 'søknad 7.txt', mediaType: 'text/plain', data } },
    });

    expect(res.status).toBe(200);
    expect(res.body.text).toBe('Bokmålssvar.');
    const files = await blobs.list(tenant, 'playground/');
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toMatch(/^playground\/[^/]+\/søknad_7\.txt$/);
    expect(JSON.stringify(model.seen.at(-1))).toContain('Eksempel IL');
  });

  it('the bundled sample file can be run without uploading anything', async () => {
    const { blobs, model, run } = await boot();

    const res = await run({
      setup: own('Svar på bokmål.'),
      input: { file: { name: 'Søknad_2025_007.pdf', sample: true } },
    });

    expect(res.status).toBe(200);
    expect((await blobs.list(tenant, 'playground/'))[0]?.path).toMatch(/Søknad_2025_007\.txt$/);
    expect(JSON.stringify(model.seen.at(-1))).toContain('Nytt øvingslokale');
  });

  it('an uploaded file is removed again when the model does not answer', async () => {
    const { blobs, run } = await boot();

    const res = await run({ setup: own('Feil med vilje.'), input: { file: { sample: true } } });

    expect(res.status).toBe(502);
    expect(await blobs.list(tenant, 'playground/')).toEqual([]);
  });

  it('a run is refused with 429 once the monthly tokens are used up', async () => {
    const { settings, blobs, model, call, run } = await boot();
    expect((await run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } })).status).toBe(200);
    expect(settings.setTenant(tenant, 'usage.monthlyTokens', 10)).toMatchObject({ ok: true });
    const before = model.seen.length;

    const res = await run({ setup: own('Svar på bokmål.'), input: { file: { sample: true } } });
    const options = (await call(`/tenants/${tenant}/playground/options`))
      .body as unknown as PlaygroundOptions;

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      status: 429,
      title: expect.stringMatching(/^Kvoten for måneden er brukt opp\./),
      quota: { monthlyTokens: 10 },
    });
    expect(model.seen.length).toBe(before);
    expect(await blobs.list(tenant, 'playground/')).toEqual([]);
    expect(options.quota.usedPercent).toBeGreaterThanOrEqual(100);
  });

  it('a playground answer saved as a test case keeps the chosen test set and origin', async () => {
    const { platform, call, run } = await boot();
    await platform.evalStores.testSets.put(testSet('svar-sporsmal', 'svar'));
    const answer = (await run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } }))
      .body as unknown as PlaygroundRunResponse;

    const saved = await call(`/tenants/${tenant}/testcase-candidates`, {
      task: answer.runId,
      question: 'Hei',
      answer: 'Bokmålssvar.',
      testSet: 'svar-sporsmal',
      service: 'svar',
      origin: 'playground',
    });
    const plain = await call(`/tenants/${tenant}/testcase-candidates`, {
      task: answer.runId,
      question: 'Hei igjen',
    });

    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({
      status: 'pending-review',
      targetTestSet: 'svar-sporsmal',
      origin: 'playground',
    });
    expect(await platform.evalStores.candidates.get(saved.body.id as string)).toMatchObject({
      targetTestSet: 'svar-sporsmal',
      origin: 'playground',
      service: 'svar',
    });
    expect(plain.status).toBe(201);
    expect(plain.body).not.toHaveProperty('origin');
    expect(plain.body).not.toHaveProperty('targetTestSet');
  });
});

interface StreamFrame {
  event: string;
  data: Record<string, unknown>;
}

const frames = (text: string): StreamFrame[] =>
  text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? '';
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6) ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });

describe('the playground run stream', () => {
  const stream = async (
    app: Awaited<ReturnType<typeof boot>>,
    body: unknown,
  ): Promise<{ status: number; type: string; frames: StreamFrame[]; json?: unknown }> => {
    const res = await app.app.request(`/tenants/${tenant}/playground/runs/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer kari' },
      body: JSON.stringify(body),
    });
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('text/event-stream'))
      return { status: res.status, type, frames: [], json: await res.json() };
    return { status: res.status, type, frames: frames(await res.text()) };
  };

  it('streams status, steps, the answer, usage stats, the result and the quota', async () => {
    const app = await boot();

    const res = await stream(app, { setup: own('Svar på bokmål.'), input: { text: 'Hei' } });
    const names = res.frames.map((f) => f.event);
    const result = res.frames.find((f) => f.event === 'result')?.data.result as Record<
      string,
      unknown
    >;

    expect(res.status).toBe(200);
    expect(names[0]).toBe('started');
    expect(names.at(-1)).toBe('done');
    expect(names.indexOf('result')).toBeGreaterThan(names.indexOf('delta'));
    expect(
      res.frames
        .filter((f) => f.event === 'delta')
        .map((f) => f.data.text)
        .join(''),
    ).toBe('Bokmålssvar.');
    expect(res.frames.find((f) => f.event === 'delta')?.data).toMatchObject({
      setup: 'setup',
      channel: 'answer',
    });
    expect(
      res.frames
        .filter((f) => f.event === 'step')
        .map((f) => (f.data.step as { type: string }).type),
    ).toEqual(expect.arrayContaining(['trigger', 'model', 'result']));
    expect(result).toMatchObject({
      text: 'Bokmålssvar.',
      tokensIn: 10,
      byModel: [{ model: expect.any(String), inputTokens: 10, outputTokens: 5 }],
      stats: { inputTokens: 10, outputTokens: 5 },
    });
    expect((result.steps as { type: string }[]).map((s) => s.type)).toEqual([
      'trigger',
      'model',
      'result',
    ]);
    expect(res.frames.at(-1)?.data).toMatchObject({ quota: { monthlyTokens: 50_000_000 } });
  });

  it('streams both runs of a comparison on one response', async () => {
    const app = await boot();

    const res = await stream(app, {
      setup: own('Svar på bokmål.'),
      compareWith: own('Svar på nynorsk.'),
      input: { text: 'Hei' },
    });
    const results = res.frames.filter((f) => f.event === 'result');

    expect(results.map((f) => f.data.setup).sort()).toEqual(['compareWith', 'setup']);
    expect(
      results.map((f) => [f.data.setup, (f.data.result as { text: string }).text]).sort(),
    ).toEqual([
      ['compareWith', 'Nynorsksvar.'],
      ['setup', 'Bokmålssvar.'],
    ]);
    expect(res.frames.filter((f) => f.event === 'started')).toHaveLength(2);
  });

  it('answers a refused setup with a problem before any stream starts', async () => {
    const app = await boot({ residencyRule: true });

    const res = await stream(app, { setup: own('Svar på bokmål.'), input: { text: 'Hei' } });

    expect(res.status).toBe(403);
    expect(res.type).toContain('application/problem+json');
    expect(res.json).toMatchObject({ setup: 'setup', policy: { block: modelId } });
  });

  it('reports a failed model call in the stream and still closes with the quota', async () => {
    const app = await boot();

    const res = await stream(app, { setup: own('Feil med vilje.'), input: { text: 'Hei' } });

    expect(res.frames.find((f) => f.event === 'failed')?.data).toMatchObject({
      setup: 'setup',
      problem: { type: 'urn:genai:problem:playground-unavailable', status: 502, setup: 'setup' },
    });
    expect(res.frames.at(-1)?.event).toBe('done');
  });

  it('sends earlier turns to the model as history', async () => {
    const app = await boot();

    const res = await app.run({
      setup: own('Svar på bokmål.'),
      input: { text: 'Og i fjor?' },
      history: [
        { role: 'user', text: 'Hvor mange søkte i år?' },
        { role: 'assistant', text: 'Tolv.' },
      ],
    });
    const sent = app.model.seen.find((r) => Array.isArray(r.body.messages))?.body.messages as {
      role: string;
      content: string;
    }[];

    expect(res.status).toBe(200);
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent.slice(1, 3).map((m) => m.content)).toEqual(['Hvor mange søkte i år?', 'Tolv.']);
    expect(sent.at(-1)?.content).not.toContain('Tolv.');
  });
});
