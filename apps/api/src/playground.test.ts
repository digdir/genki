import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import {
  InMemoryDefinitionStore,
  platformSettings,
  SettingsRegistry,
  type DefinitionStore,
  type PluginSchemas,
} from '@genai/definitions';
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
import type { TaskIndex } from './extensions.js';
import type { PlaygroundOptions, PlaygroundRunResponse } from './playground.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) => parseYaml(readFileSync(join(config, file), 'utf8')) as unknown;
const tenant = '991825827';
const modelId = 'foundry-openai/gpt-4o-2m-tps';
const euModel = 'foundry-openai/gpt-6-luna';

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

const knowledgeWith = (
  datasets: (list: Record<string, unknown>[]) => Record<string, unknown>[],
) => {
  const catalog = yaml('knowledge.yaml') as { datasets: Record<string, unknown>[] };
  return { ...catalog, datasets: datasets(catalog.datasets) };
};

const otherTenant = '123456789';

const withOthersDataset = (list: Record<string, unknown>[]) => {
  const publicDocs = list.find((d) => d.id === 'digdir/public-docs') ?? {};
  return [
    ...list,
    { ...publicDocs, id: 'annen/hemmelig', name: 'Hemmelig', aliases: [], tenants: [otherTenant] },
  ];
};

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

const boot = async ({
  residencyRule = false,
  taskIndex,
  store = (plugins) => new InMemoryDefinitionStore(plugins),
  datasets = (list) => list,
}: {
  residencyRule?: boolean;
  datasets?: (list: Record<string, unknown>[]) => Record<string, unknown>[];
  taskIndex?: TaskIndex;
  store?: (plugins: PluginSchemas) => DefinitionStore;
} = {}) => {
  const model = await fakeHttp(modelReply);
  const search = await fakeHttp((body) => ({
    status: 200,
    json: Array.isArray(body.searches)
      ? { results: body.searches.map(() => ({ found: 0, hits: [] })) }
      : {},
  }));
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
      knowledge: resolveCatalog(knowledgeWith(datasets), 'datasets', env).catalog,
      rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', env).catalog,
    },
    prices: { [modelId]: { inputPerThousand: 1, outputPerThousand: 2 } },
    secrets: envSecrets({ FOUNDRY_OPENAI_KEY: 'm', TYPESENSE_KEY: 't', COLBERT_API_KEY: 'c' }),
    definitions: store,
    settings,
    ...(taskIndex ? { taskIndex } : {}),
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
  return { platform, settings, model, search, blobs, call, run, app };
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

  it('refuses a draft whose variant uses a not-allowed model, even when the service model is allowed', async () => {
    const { run } = await boot({ residencyRule: true });
    const draft = service('svar', 'Svar på bokmål.');
    draft.spec.model.primary = 'local/echo';
    const definition = {
      ...draft,
      spec: { ...draft.spec, variants: [{ id: 'default', model: modelId }] },
    };

    const refused = await run({
      setup: { service: { id: 'svar', version: 'draft', definition }, output: 'text' },
      input: { text: 'Hei' },
    });

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ policy: { block: modelId } });
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

  it('playground runs count as testing in usage, never as a service run', async () => {
    const { call, run } = await boot();

    const res = await run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } });
    const usage = (await call(`/tenants/${tenant}/usage`)).body as {
      totals: { inputTokens: number };
      byService: unknown[];
      testing: { usage: { inputTokens: number }; byOrigin: { origin: string }[] };
    };
    const tasks = (await call(`/tenants/${tenant}/tasks`)).body as { data: unknown[] };

    expect(res.status).toBe(200);
    expect(usage.totals.inputTokens).toBe(usage.testing.usage.inputTokens);
    expect(usage.testing.usage.inputTokens).toBeGreaterThan(0);
    expect(usage.testing.byOrigin.map((o) => o.origin)).toEqual(['playground']);
    expect(usage.byService).toEqual([]);
    expect(tasks.data).toEqual([]);
  });

  it('counts playground runs as testing on the day they ran', async () => {
    const { call, run } = await boot();

    await run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } });
    const usage = (await call(`/tenants/${tenant}/usage?days=1`)).body as {
      testing: { usage: { inputTokens: number } };
      daily: { testing: { inputTokens: number }; ingestion: { inputTokens: number } }[];
    };

    expect(usage.daily.map((d) => d.testing.inputTokens)).toEqual([
      usage.testing.usage.inputTokens,
    ]);
    expect(usage.daily.map((d) => d.ingestion.inputTokens)).toEqual([0]);
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

  it('counts the trial runs of the last 7 days on each service draft, for that draft only', async () => {
    const { platform, run, app, call } = await boot();
    await platform.definitions.publish(service('svar', 'Svar på nynorsk.'), 'test', 'første');
    for (const id of ['svar', 'annen'])
      await app.request(`/tenants/${tenant}/services/${id}/draft`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer kari',
          'change-reason': 'Prøver et utkast',
        },
        body: JSON.stringify({ definition: service(id, 'Svar på bokmål.'), files: {} }),
      });

    for (let i = 0; i < 2; i += 1)
      await run({
        setup: {
          service: { id: 'svar', version: 'draft', definition: service('svar', 'Svar på bokmål.') },
          output: 'text',
        },
        input: { text: 'Hei' },
      });
    const drafts = (await call(`/tenants/${tenant}/service-drafts`)).body.data as {
      id: string;
      trialRuns7d: number;
    }[];

    expect(drafts.map((d) => [d.id, d.trialRuns7d]).sort()).toEqual([
      ['annen', 0],
      ['svar', 2],
    ]);
  });

  it('The portal playground runs a published service whose declared residency is global with an EU model and a global dataset', async () => {
    const { platform, run } = await boot();
    const published = service('kudos-svar', 'Svar på bokmål.');
    await platform.definitions.publish(
      {
        ...published,
        spec: {
          ...published.spec,
          strategy: { id: 'rag-single-shot', version: 1, config: { instructions: 'Svar kort.' } },
          knowledge: { datasets: [{ dataset: 'digdir/kudos' }] },
        },
      },
      'test',
      'første',
    );

    const res = await run({
      setup: { service: { id: 'kudos-svar', version: 1 }, model: euModel, output: 'text' },
      input: { text: 'Hei' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text: 'Bokmålssvar.' });
  });

  it("tries the chosen model in place of the service's primary, its fallback and the roles that used the primary", async () => {
    const { platform, run } = await boot({ residencyRule: true });
    const published = service('med-reserve', 'Svar på bokmål.');
    await platform.definitions.publish(
      {
        ...published,
        spec: {
          ...published.spec,
          model: {
            primary: modelId,
            fallback: modelId,
            roles: { planner: modelId },
            residency: 'global',
          },
        },
      },
      'test',
      'første',
    );

    const res = await run({
      setup: { service: { id: 'med-reserve', version: 1 }, model: euModel, output: 'text' },
      input: { text: 'Hei' },
    });

    expect(res.status).toBe(200);
  });

  it('refuses a playground model that runs wider than the residency the service declares', async () => {
    const { platform, run } = await boot();
    const published = service('eu-svar', 'Svar på bokmål.');
    await platform.definitions.publish(
      { ...published, spec: { ...published.spec, model: { primary: euModel, residency: 'eu' } } },
      'test',
      'første',
    );

    const res = await run({
      setup: { service: { id: 'eu-svar', version: 1 }, model: modelId, output: 'text' },
      input: { text: 'Hei' },
    });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      errors: [{ message: expect.stringContaining('outside eu') }],
    });
  });

  it("refuses the caller's own model choice as a validation error, not as an outdated version", async () => {
    const { platform, run } = await boot();
    const published = service('eu-svar', 'Svar på bokmål.');
    await platform.definitions.publish(
      { ...published, spec: { ...published.spec, model: { primary: euModel, residency: 'eu' } } },
      'test',
      'første',
    );

    const res = await run({
      setup: { service: { id: 'eu-svar', version: 1 }, model: modelId, output: 'text' },
      input: { text: 'Hei' },
    });

    expect(res.status).toBe(422);
    expect(res.body.type).not.toBe('urn:genai:problem:definition-outdated');
    expect(res.body).toMatchObject({
      errors: [
        {
          path: expect.stringContaining('spec.model'),
          message: expect.stringContaining('outside eu'),
        },
      ],
    });
  });

  it('a service draft with broken YAML is refused with 422 naming the definition', async () => {
    const { run } = await boot();

    const res = await run({
      setup: {
        service: { id: 'svar', version: 'draft', definition: 'kind: Service\nspec: [unclosed' },
        output: 'text',
      },
      input: { text: 'Hei' },
    });

    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([
      { path: 'setup.service.definition', message: expect.stringMatching(/line \d+/) },
    ]);
  });

  it('a published version that no longer fits the platform is refused naming the problem and the newest version', async () => {
    class FirstVersionOutdated extends InMemoryDefinitionStore {
      override async get(...args: Parameters<InMemoryDefinitionStore['get']>) {
        const found = await super.get(...args);
        if (found?.version !== 1) return found;
        const definition = found.definition as unknown as { spec: Record<string, unknown> };
        return {
          ...found,
          definition: {
            ...definition,
            spec: { ...definition.spec, strategy: { id: 'single-call', version: 99, config: {} } },
          },
        } as unknown as typeof found;
      }
    }
    const { platform, run } = await boot({ store: (p) => new FirstVersionOutdated(p) });
    await platform.definitions.publish(service('svar', 'Svar på nynorsk.'), 'test', 'første');
    await platform.definitions.publish(service('svar', 'Svar på bokmål.'), 'test', 'andre');

    const res = await run({
      setup: { service: { id: 'svar', version: 1 }, output: 'text' },
      input: { text: 'Hei' },
    });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      type: 'urn:genai:problem:definition-outdated',
      service: 'svar',
      version: 1,
      latestVersion: 2,
    });
    expect(res.body.title).toMatch(
      /^Versjon 1 av svar passer ikke lenger med plattformen: spec\.strategy/,
    );
    expect(res.body.title).toContain('Bruk den nyeste versjonen, 2.');
  });

  it('the outdated version refusal is in English for an English reader', async () => {
    class OnlyVersionOutdated extends InMemoryDefinitionStore {
      override async get(...args: Parameters<InMemoryDefinitionStore['get']>) {
        const found = await super.get(...args);
        if (!found) return found;
        const definition = found.definition as unknown as { spec: Record<string, unknown> };
        return {
          ...found,
          definition: {
            ...definition,
            spec: { ...definition.spec, strategy: { id: 'single-call', version: 99, config: {} } },
          },
        } as unknown as typeof found;
      }
    }
    const { platform, app } = await boot({ store: (p) => new OnlyVersionOutdated(p) });
    await platform.definitions.publish(service('svar', 'Svar på nynorsk.'), 'test', 'første');

    const res = await app.request(`/tenants/${tenant}/playground/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer kari',
        'accept-language': 'en',
      },
      body: JSON.stringify({
        setup: { service: { id: 'svar', version: 1 }, output: 'text' },
        input: { text: 'Hei' },
      }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { title: string };
    expect(body.title).toMatch(/^Version 1 of svar no longer fits the platform: spec\.strategy/);
    expect(body.title).toContain('It is the newest version');
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

  it('lists the variants of a version with their title and model, and none for a single variant', async () => {
    const { platform, call } = await boot();
    const plain = service('aaa-plain', 'Svar kort.');
    const varied = service('bbb-varied', 'Svar kort.');
    Object.assign(varied.spec, {
      variants: [
        'default',
        { id: 'rask', title: { nb: 'Rask', en: 'Fast' }, model: modelId },
        { id: 'kort', chat: false },
      ],
    });
    await platform.definitions.publish(plain, 'test', 'første');
    const published = await platform.definitions.publish(varied, 'test', 'første');
    expect(published.ok ? [] : published.errors).toEqual([]);

    const options = (await call(`/tenants/${tenant}/playground/options`))
      .body as unknown as PlaygroundOptions;
    const versionsOf = (id: string) => options.services.find((s) => s.id === id)?.versions;

    expect(versionsOf('bbb-varied')?.[0]?.variants).toEqual([
      { id: 'default' },
      { id: 'rask', title: 'Rask', model: modelId },
      { id: 'kort' },
    ]);
    expect(versionsOf('aaa-plain')?.[0]).not.toHaveProperty('variants');
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
            environments: ['prod'],
            setup: expect.objectContaining({ model: modelId }),
            strategy: expect.objectContaining({ id: 'single-call' }),
          },
          {
            version: 1,
            draft: false,
            inUse: false,
            setup: expect.objectContaining({ output: 'text' }),
            strategy: expect.objectContaining({ id: 'single-call' }),
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

  it('marks the version prod runs as in use and names the environments of each version', async () => {
    const { platform, app, call } = await boot();
    await platform.definitions.publish(service('svar', 'Svar på nynorsk.'), 'test', 'første');
    const added = await app.request(`/tenants/${tenant}/services/svar/environments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer kari',
        'change-reason': 'Prøver bokmål på testerne',
      },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(added.status).toBe(201);
    await platform.definitions.publish(service('svar', 'Svar på bokmål.'), 'test', 'andre');

    const options = (await call(`/tenants/${tenant}/playground/options`))
      .body as unknown as PlaygroundOptions;
    const versions = options.services.find((s) => s.id === 'svar')?.versions ?? [];

    expect(versions.map((v) => [v.version, v.inUse, v.environments])).toEqual([
      [2, false, ['test']],
      [1, true, ['prod']],
    ]);
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

  it('an exhausted quota refuses a playground run with 429 from the kernel', async () => {
    const { settings, blobs, model, call, run } = await boot();
    expect((await run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } })).status).toBe(200);
    expect(settings.setTenant(tenant, 'usage.monthlyTokens', 10, 'operator')).toMatchObject({
      ok: true,
    });
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

  it('a playground run refused at the quota answers the quota-exhausted problem with Retry-After', async () => {
    const { settings, app, run } = await boot();
    expect((await run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } })).status).toBe(200);
    settings.setTenant(tenant, 'usage.monthlyTokens', 10, 'operator');

    const res = await app.request(`/tenants/${tenant}/playground/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer kari' },
      body: JSON.stringify({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } }),
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ type: 'urn:genai:problem:quota-exhausted' });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('a builder test run refused at the quota answers the quota-exhausted problem with Retry-After', async () => {
    const { settings, app, run } = await boot();
    expect((await run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } })).status).toBe(200);
    settings.setTenant(tenant, 'usage.monthlyTokens', 10, 'operator');

    const res = await app.request(`/tenants/${tenant}/definitions/test-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer kari' },
      body: JSON.stringify({
        definition: service('utkast-kvote', 'Svar på bokmål.'),
        query: 'Hei',
      }),
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      type: 'urn:genai:problem:quota-exhausted',
      title: 'The monthly token quota is used up',
      status: 429,
    });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('options and runs read the monthly quota from one usage query, never task by task', async () => {
    const sums: string[] = [];
    const { call, run } = await boot({
      taskIndex: {
        all: async () => {
          throw new Error('the playground must not read every task to find the quota');
        },
        running: async () => [],
        tokensUsed: async (owner) => {
          sums.push(owner);
          return 25_000_000;
        },
      },
    });

    const options = (await call(`/tenants/${tenant}/playground/options`))
      .body as unknown as PlaygroundOptions;
    const answer = await run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } });

    expect(options.quota).toEqual({ usedPercent: 50, monthlyTokens: 50_000_000 });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ quota: { usedPercent: 50 } });
    expect(sums).toEqual([tenant, tenant]);
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

  it('an exhausted quota refuses a streamed run with 429 from the kernel before the stream opens', async () => {
    const app = await boot();
    expect((await app.run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } })).status).toBe(
      200,
    );
    app.settings.setTenant(tenant, 'usage.monthlyTokens', 10, 'operator');
    const before = app.model.seen.length;

    const res = await stream(app, { setup: own('Svar på bokmål.'), input: { text: 'Hei' } });

    expect(res.status).toBe(429);
    expect(res.type).toContain('application/problem+json');
    expect(res.json).toMatchObject({ status: 429, quota: { monthlyTokens: 10 } });
    expect(app.model.seen.length).toBe(before);
  });

  it('a streamed run refused at the quota answers the quota-exhausted problem with Retry-After', async () => {
    const app = await boot();
    expect((await app.run({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } })).status).toBe(
      200,
    );
    app.settings.setTenant(tenant, 'usage.monthlyTokens', 10, 'operator');

    const res = await app.app.request(`/tenants/${tenant}/playground/runs/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer kari' },
      body: JSON.stringify({ setup: own('Svar på bokmål.'), input: { text: 'Hei' } }),
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ type: 'urn:genai:problem:quota-exhausted' });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
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

describe('playground changes on top of a service version', () => {
  const ragService = (id: string) => {
    const base = service(id, 'Svar på bokmål.');
    return {
      ...base,
      spec: {
        ...base.spec,
        strategy: { id: 'rag-single-shot', version: 1, config: { instructions: 'Svar kort.' } },
        knowledge: { datasets: [{ dataset: 'digdir/kudos' }] },
      },
    };
  };

  const readingFlow = {
    apiVersion: 'genai/v1',
    kind: 'StepFlow',
    metadata: { tenant, id: 'les-dokumentet', name: 'Les dokumentet' },
    spec: {
      purpose: 'Les dokumentet',
      steps: [{ id: 'les', block: 'read-document@1', input: { document: '{{input.document}}' } }],
    },
  };

  const flowService = () => {
    const base = service('flyt', 'Svar på bokmål.');
    return {
      ...base,
      spec: {
        ...base.spec,
        strategy: { id: 'step-flow', version: 1, config: { flow: 'les-dokumentet@1' } },
        knowledge: { datasets: [{ dataset: 'digdir/kudos' }] },
      },
    };
  };

  it('instructions sent with a service version replace its instructions for that run only', async () => {
    const { platform, run } = await boot();
    await platform.definitions.publish(service('svar', 'Svar på bokmål.'), 'test', 'første');

    const res = await run({
      setup: {
        service: { id: 'svar', version: 1 },
        instructions: 'Svar på nynorsk.',
        output: 'text',
      },
      compareWith: { service: { id: 'svar', version: 1 }, output: 'text' },
      input: { text: 'Hei' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text: 'Nynorsksvar.', compare: { text: 'Bokmålssvar.' } });
  });

  it('a playground change never writes the service, its versions or a draft', async () => {
    const { platform, run, call } = await boot();
    await platform.definitions.publish(ragService('svar'), 'test', 'første');

    const res = await run({
      setup: {
        service: { id: 'svar', version: 1 },
        instructions: 'Svar på nynorsk.',
        datasets: ['digdir/public-docs'],
        output: 'text',
      },
      input: { text: 'Hei' },
    });
    const versions = await platform.definitions.versions('Service', tenant, 'svar');
    const drafts = (await call(`/tenants/${tenant}/service-drafts`)).body.data as unknown[];

    expect(res.status).toBe(200);
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(versions[0]?.definition).toMatchObject({
      spec: {
        strategy: { config: { instructions: 'Svar kort.' } },
        knowledge: { datasets: [{ dataset: 'digdir/kudos' }] },
      },
    });
    expect(drafts).toEqual([]);
  });

  it('instructions replace those of the chosen variant when it has its own strategy', async () => {
    const { platform, run } = await boot();
    const varied = service('svar', 'Svar på bokmål.');
    Object.assign(varied.spec, {
      variants: [
        'default',
        {
          id: 'egen',
          strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar på bokmål.' } },
        },
      ],
    });
    await platform.definitions.publish(varied, 'test', 'første');

    const res = await run({
      setup: {
        service: { id: 'svar', version: 1, variant: 'egen' },
        instructions: 'Svar på nynorsk.',
        output: 'text',
      },
      input: { text: 'Hei' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text: 'Nynorsksvar.' });
  });

  it('refuses instructions for a step flow, which has no single instructions field, without calling a model', async () => {
    const { platform, run, model } = await boot();
    await platform.definitions.publish(readingFlow, 'test', 'første');
    await platform.definitions.publish(flowService(), 'test', 'første');
    const before = model.seen.length;

    const res = await run({
      setup: { service: { id: 'flyt', version: 1 }, instructions: 'Svar kort.', output: 'text' },
      input: { text: 'Hei' },
    });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      errors: [{ path: 'setup.instructions', message: expect.stringContaining('Fast stegflyt') }],
    });
    expect(model.seen.length).toBe(before);
  });

  it('datasets sent with a service version replace the datasets it searches for that run', async () => {
    const { platform, run, search } = await boot();
    await platform.definitions.publish(ragService('svar'), 'test', 'første');

    const res = await run({
      setup: {
        service: { id: 'svar', version: 1 },
        datasets: ['digdir/public-docs'],
        output: 'text',
      },
      input: { text: 'Hei' },
    });
    const searched = JSON.stringify(search.seen);

    expect(res.status).toBe(200);
    expect(searched).toContain('website_');
    expect(searched).not.toContain('KUDOS_');
  });

  it('refuses a dataset another tenant owns on top of a service version, before any search or model call', async () => {
    const { platform, run, search, model } = await boot({ datasets: withOthersDataset });
    await platform.definitions.publish(ragService('svar'), 'test', 'første');
    const before = { search: search.seen.length, model: model.seen.length };

    const res = await run({
      setup: {
        service: { id: 'svar', version: 1 },
        datasets: ['digdir/kudos', 'annen/hemmelig'],
        output: 'text',
      },
      input: { text: 'Hei' },
    });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      errors: [{ path: 'setup.datasets[1]', message: expect.stringContaining('annen/hemmelig') }],
    });
    expect({ search: search.seen.length, model: model.seen.length }).toEqual(before);
  });

  it('answers a dataset another tenant owns and an unknown dataset alike, also without a service', async () => {
    const { run } = await boot({ datasets: withOthersDataset });

    const refused = await Promise.all(
      ['annen/hemmelig', 'finnes/ikke'].map((dataset) =>
        run({
          setup: { model: modelId, datasets: [dataset], output: 'text' },
          input: { text: 'Hei' },
        }),
      ),
    );

    expect(refused.map((r) => r.status)).toEqual([422, 422]);
    expect(refused.map((r) => r.body.errors)).toEqual([
      [{ path: 'setup.datasets[0]', message: expect.stringContaining('annen/hemmelig') }],
      [{ path: 'setup.datasets[0]', message: expect.stringContaining('finnes/ikke') }],
    ]);
    expect(
      new Set(
        refused.map((r) =>
          (r.body.errors as { message: string }[])[0]?.message.replace(
            /annen\/hemmelig|finnes\/ikke/,
            '',
          ),
        ),
      ).size,
    ).toBe(1);
  });

  it('the options name the strategy of each version and the step flow it runs, in bokmål and English', async () => {
    const { platform, call } = await boot();
    await platform.definitions.publish(readingFlow, 'test', 'første');
    await platform.definitions.publish(flowService(), 'test', 'første');
    await platform.definitions.publish(service('svar', 'Svar kort.'), 'test', 'første');

    const options = (await call(`/tenants/${tenant}/playground/options`))
      .body as unknown as PlaygroundOptions;
    const strategyOf = (id: string) =>
      options.services.find((s) => s.id === id)?.versions[0]?.strategy;

    expect(strategyOf('flyt')).toEqual({
      id: 'step-flow',
      version: 1,
      title: { nb: 'Fast stegflyt', en: 'Fixed step flow' },
      takesInstructions: false,
      flow: {
        ref: 'les-dokumentet@1',
        id: 'les-dokumentet',
        version: 1,
        title: { nb: 'Les dokumentet', en: 'Les dokumentet' },
      },
    });
    expect(strategyOf('svar')).toEqual({
      id: 'single-call',
      version: 1,
      title: { nb: 'Ett steg', en: 'One step' },
      takesInstructions: true,
    });
  });

  it('the options give each model the same price GET /models gives, or null without one', async () => {
    const { call } = await boot();

    const options = (await call(`/tenants/${tenant}/playground/options`))
      .body as unknown as PlaygroundOptions;
    const models = (await call('/models?all=true')).body.data as {
      id: string;
      price: unknown;
    }[];

    expect(options.models.find((m) => m.id === modelId)?.price).toEqual({
      inputPerThousand: 1,
      outputPerThousand: 2,
    });
    for (const m of options.models)
      expect(m.price).toEqual(models.find((x) => x.id === m.id)?.price ?? null);
  });
});
