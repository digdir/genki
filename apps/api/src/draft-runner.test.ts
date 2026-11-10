import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify } from 'yaml';
import type { Part, Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { resolveCatalog } from './catalogs.js';
import { adoptionKind, blockKey } from './building-blocks.js';
import { createPlatform } from './composition.js';
import { appendVersion } from './config-store.js';
import { assistantCapabilityPrefix } from '@genai/jobs';
import { kernelTaskReader } from './timeline.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) => parseYaml(readFileSync(join(config, file), 'utf8')) as unknown;
const tenant = '991825827';
const modelId = 'foundry-openai/gpt-4o-2m-tps';

const kari = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant,
  authorizedFor: [{ org: tenant }],
} as Principal;

const reply = (content: string, stream: boolean) =>
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
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      };

const modelReply = (body: Record<string, unknown>) => {
  if (!body.messages)
    return {
      status: 200,
      json: { data: [{ id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' }] },
    };
  const system = (body.messages as { content?: string }[])[0]?.content ?? '';
  const answer = system.includes('Svar ingenting')
    ? ''
    : system.includes('Svar på bokmål')
      ? 'Bokmålssvar.'
      : 'Nynorsksvar.';
  return reply(answer, Boolean(body.stream));
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

const boot = async (searchReply: Record<string, unknown> = {}) => {
  const model = await fakeHttp(modelReply);
  const search = await fakeHttp(() => ({ status: 200, json: searchReply }));
  servers.push(model, search);
  const env = {
    FOUNDRY_OPENAI_BASE_URL: `${model.url}/v1`,
    TYPESENSE_URL: search.url,
    COLBERT_API_URL: search.url,
  };
  const platform = await createPlatform({
    catalogs: {
      models: resolveCatalog(yaml('models.yaml'), 'models', env).catalog,
      knowledge: resolveCatalog(yaml('knowledge.yaml'), 'datasets', env).catalog,
      rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', env).catalog,
    },
    prices: { [modelId]: { inputPerThousand: 1, outputPerThousand: 2 } },
    secrets: envSecrets({ FOUNDRY_OPENAI_KEY: 'm', TYPESENSE_KEY: 't', COLBERT_API_KEY: 'c' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer kari' ? { principal: kari } : undefined,
  });
  const app = new Hono();
  platform.mount(
    app,
    createAdmin({
      store: platform.definitions,
      plugins: platform.plugins,
      settings: new SettingsRegistry([]),
      extensions: platform.extensions,
    }),
  );
  const get = async (path: string) =>
    (await app.request(path, { headers: { authorization: 'Bearer kari' } })).json() as Promise<
      Record<string, unknown>
    >;
  return { platform, app, get };
};

const withoutProvenance = (parts: Part[]) =>
  parts.filter((p) => p.mime !== 'application/vnd.genai.provenance+json');

const bokmal = service('utkast-bokmal', 'Svar på bokmål.');
const nynorsk = service('utkast-nynorsk', 'Svar på nynorsk.');

const facetCounts = [
  {
    field_name: 'orgs_short',
    counts: [
      { value: 'Udir', count: 3 },
      { value: 'Digdir', count: 2 },
    ],
  },
];

const withForm = {
  ...service('utkast-skjema', 'Svar på bokmål.'),
  spec: {
    ...service('utkast-skjema', 'Svar på bokmål.').spec,
    knowledge: { datasets: [{ dataset: 'digdir/kudos' }] },
    input: {
      accepts: ['text/plain'],
      fields: [
        {
          id: 'agency',
          label: 'Virksomhet',
          kind: 'choice',
          required: true,
          optionsFrom: { dataset: 'digdir/kudos', facet: 'orgs_short' },
        },
      ],
    },
  },
};

describe('a draft with options drawn from dataset facets', () => {
  const post = (app: Hono, path: string, body: unknown) =>
    app.request(`/tenants/${tenant}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer kari' },
      body: JSON.stringify(body),
    });

  it('lists the facet values as options, also when the draft is YAML text', async () => {
    const { app } = await boot({
      facet_counts: facetCounts,
      results: [{ facet_counts: facetCounts }],
    });

    for (const definition of [withForm, stringify(withForm)]) {
      const res = await post(app, '/definitions/input-fields', { definition });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        fields: [expect.objectContaining({ id: 'agency', options: ['Udir', 'Digdir'] })],
      });
    }
    expect((await post(app, '/definitions/input-fields', {})).status).toBe(400);
  });

  it('lists the facet values for published versions in the playground options', async () => {
    const { platform, get } = await boot({
      facet_counts: facetCounts,
      results: [{ facet_counts: facetCounts }],
    });
    await platform.definitions.publish(withForm, 'test', 'test', {});

    const options = (await get(`/tenants/${tenant}/playground/options`)) as {
      services: { id: string; versions: { inputFields?: { options?: string[] }[] }[] }[];
    };

    const published = options.services.find((s) => s.id === 'utkast-skjema');
    expect(published?.versions[0]?.inputFields?.[0]?.options).toEqual(['Udir', 'Digdir']);
  });

  it('refuses a value that is not one of the facet values in a test run', async () => {
    const { app } = await boot({
      facet_counts: facetCounts,
      results: [{ facet_counts: facetCounts }],
    });

    const wrong = await post(app, '/definitions/test-run', {
      definition: withForm,
      input: { agency: 'Skatteetaten' },
    });
    const right = await post(app, '/definitions/test-run', {
      definition: withForm,
      input: { agency: 'Udir' },
    });

    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { errors: { path: string }[] }).errors).toEqual([
      expect.objectContaining({ path: 'agency' }),
    ]);
    expect(right.status).toBe(200);
  });
});

describe('the draft runner', () => {
  it('the draft runner returns the same result as the old test-run route', async () => {
    const { platform, app } = await boot();

    const res = await app.request(`/tenants/${tenant}/definitions/test-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer kari' },
      body: JSON.stringify({ definition: bokmal, query: 'Hei' }),
    });
    const route = (await res.json()) as Record<string, unknown>;
    const direct = await platform.drafts.run({
      principal: kari,
      tenant,
      definition: bokmal,
      parts: [{ kind: 'text', text: 'Hei' }],
      origin: 'builder',
    });

    expect(res.status).toBe(200);
    expect(Object.keys(route).sort()).toEqual(['answer', 'ok', 'parts', 'task']);
    expect(direct).toMatchObject({
      ok: true,
      answer: route.answer,
      origin: 'builder',
      usage: { inputTokens: 10, outputTokens: 5 },
      costMicroNok: 20_000,
      costNok: 0.02,
      dataLocation: 'global',
    });
    expect(direct.ok && withoutProvenance(direct.parts)).toEqual(
      withoutProvenance(route.parts as Part[]),
    );
  });

  it('completes a draft the way publishing does before it runs', async () => {
    const { platform } = await boot();
    const draft = service('utkast-uferdig', 'Svar kort.') as { spec: Record<string, unknown> };
    const incomplete = {
      ...draft,
      spec: {
        ...draft.spec,
        model: { primary: modelId },
        input: { accepts: ['text/plain'], fields: [{ id: '', label: 'År', kind: 'text' }] },
      },
    };

    const run = await platform.drafts.run({
      principal: kari,
      tenant,
      definition: incomplete,
      parts: [{ kind: 'text', text: 'Hei' }],
      origin: 'builder',
    });

    expect(run).toMatchObject({ ok: true, dataLocation: 'global' });
  });

  it('a run whose model answers nothing is marked as no answer', async () => {
    const { platform } = await boot();
    const run = (definition: unknown) =>
      platform.drafts.run({
        principal: kari,
        tenant,
        definition,
        parts: [{ kind: 'text', text: 'Hei' }],
        origin: 'builder',
      });

    const empty = await run(service('utkast-tomt', 'Svar ingenting.'));
    const answered = await run(bokmal);

    expect(empty).toMatchObject({ ok: true, answer: '', noAnswer: true });
    expect(answered).toMatchObject({ ok: true, answer: 'Bokmålssvar.', noAnswer: false });
  });

  it('a model turned off for the tenant in Byggeklosser stops the run with the reason', async () => {
    const { platform } = await boot();
    await appendVersion(platform.configEntries, {
      kind: adoptionKind,
      scope: tenant,
      id: blockKey('model', modelId),
      spec: { status: 'in_use', settings: { enabled: false }, event: 'settings' },
      deleted: false,
      by: 'Kari',
      reason: 'Slått av mens vi tester',
      at: '2026-10-07T10:00:00Z',
    });

    const run = await platform.drafts.run({
      principal: kari,
      tenant,
      definition: bokmal,
      parts: [{ kind: 'text', text: 'Hei' }],
      origin: 'builder',
    });

    expect(run.ok).toBe(false);
    expect(JSON.stringify(run)).toContain('er slått av for virksomheten');
  });

  it("names an assistant run so the monthly quota's assistant prefix leaves it out", async () => {
    const { platform } = await boot();

    const run = await platform.drafts.run({
      principal: kari,
      tenant,
      definition: bokmal,
      parts: [{ kind: 'text', text: 'Hei' }],
      origin: 'assistant',
    });
    if (!run.ok) throw new Error('the assistant run failed');
    const task = await kernelTaskReader(platform.kernel, {
      kind: 'operator',
      issuer: 'platform',
      subject: 'task-reader',
    }).task(run.task);

    expect(task?.service.capability.id.startsWith(assistantCapabilityPrefix)).toBe(true);
  });

  it('counts test runs on their own usage line and in the total, never as a service', async () => {
    const { platform, get } = await boot();
    await platform.definitions.publish(nynorsk, 'test', 'test');
    const [published] = await platform.definitions.capabilities();
    if (!published) throw new Error('nothing published');
    const served = await platform.kernel.invoke(kari, published.capability.descriptor.id, {
      data: { query: 'Hei', history: [] },
    });
    await served.result;

    const draft = await platform.drafts.run({
      principal: kari,
      tenant,
      definition: bokmal,
      parts: [{ kind: 'text', text: 'Hei' }],
      origin: 'playground',
    });
    const usage = (await get(`/tenants/${tenant}/usage`)) as {
      totals: { inputTokens: number };
      byService: { service: string }[];
      testing: { usage: { inputTokens: number }; byOrigin: { origin: string }[] };
    };
    const tasks = (await get(`/tenants/${tenant}/tasks`)) as { data: { id: string }[] };
    const overview = (await get(`/tenants/${tenant}/overview`)) as {
      recentTasks: { id: string }[];
    };

    expect(draft.ok).toBe(true);
    expect(usage.totals.inputTokens).toBe(20);
    expect(usage.testing.usage.inputTokens).toBe(10);
    expect(usage.testing.byOrigin.map((o) => o.origin)).toEqual(['playground']);
    expect(usage.byService.map((s) => s.service)).toEqual(['utkast-nynorsk']);
    expect(tasks.data.map((t) => t.id)).toEqual([served.task]);
    expect(overview.recentTasks.map((t) => t.id)).toEqual([served.task]);
  });

  it('two draft runs in parallel do not share state', async () => {
    const { platform } = await boot();
    const run = (definition: unknown) =>
      platform.drafts.run({
        principal: kari,
        tenant,
        definition,
        parts: [{ kind: 'text', text: 'Hei' }],
        origin: 'playground',
      });

    const [a, b] = await Promise.all([run(bokmal), run(nynorsk)]);

    expect(a).toMatchObject({ ok: true, answer: 'Bokmålssvar.', usage: { inputTokens: 10 } });
    expect(b).toMatchObject({ ok: true, answer: 'Nynorsksvar.', usage: { inputTokens: 10 } });
    expect(a.ok && b.ok && a.task !== b.task).toBe(true);
    expect(platform.registry.all().some((c) => c.descriptor.id.startsWith('platform/draft/'))).toBe(
      false,
    );
  });

  it('refuses a file part that is not in the blob store', async () => {
    const { platform } = await boot();

    const result = await platform.drafts.run({
      principal: kari,
      tenant,
      definition: bokmal,
      parts: [{ kind: 'file', blob: 'opplasting/mangler.txt' }],
      origin: 'playground',
    });

    expect(result).toMatchObject({ ok: false, status: 422, errors: [{ path: 'parts[0].blob' }] });
  });
});

describe('a run that fails in a step before any model call', () => {
  const brokenFlow = {
    apiVersion: 'genai/v1',
    kind: 'StepFlow',
    metadata: { tenant, id: 'brutt-flyt', name: 'Brutt flyt' },
    spec: {
      purpose: 'Feiler i første steg',
      steps: [{ id: 'skriv', block: 'template@1', input: { text: '{{input.mangler}}' } }],
    },
  };
  const flowService = {
    ...service('brutt-tjeneste', 'Svar kort.'),
    spec: {
      ...service('brutt-tjeneste', 'Svar kort.').spec,
      strategy: { id: 'step-flow', version: 1, config: { flow: 'brutt-flyt@1' } },
    },
  };
  const post = (app: Hono, path: string, body: unknown) =>
    app.request(`/tenants/${tenant}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer kari' },
      body: JSON.stringify(body),
    });

  it('says which step failed in the playground and the test run, not that the model did not answer', async () => {
    const { platform, app } = await boot();
    expect((await platform.definitions.publish(brokenFlow, 'kari', 'Test', {})).ok).toBe(true);

    const played = await post(app, '/playground/runs', {
      setup: {
        service: { id: 'brutt-tjeneste', version: 'draft', definition: flowService },
        output: 'text',
      },
      input: { text: 'Hei' },
    });
    const tested = await post(app, '/definitions/test-run', {
      definition: flowService,
      query: 'Hei',
    });

    expect(played.status).toBe(502);
    const playedBody = (await played.json()) as Record<string, string>;
    expect(playedBody).toMatchObject({ code: 'strategy_error', step: 'skriv' });
    expect(playedBody.title).toMatch(/^Steget «skriv» feilet\. Tjenesten feilet underveis\./);
    expect(playedBody.title).not.toContain('modellen');
    expect(playedBody.detail).toContain('step skriv failed');
    expect(tested.status).toBe(502);
    expect(await tested.json()).toMatchObject({
      title: 'Steget «skriv» feilet. Tjenesten feilet underveis.',
      code: 'strategy_error',
      runId: tested.headers.get('genai-task'),
      errors: [{ message: expect.stringContaining('step skriv failed') }],
    });
  });

  it("lists the user's own failed runs with a reason and no error text", async () => {
    const { platform, get } = await boot();
    await platform.definitions.publish(brokenFlow, 'kari', 'Test', {});
    await platform.definitions.publish(flowService, 'kari', 'Test', {});
    const [compiled] = (await platform.definitions.capabilities()).filter(
      (c) => c.service.id === 'brutt-tjeneste',
    );
    await platform.drafts.invoke({
      principal: kari,
      tenant,
      capability: compiled?.capability.descriptor.id ?? '',
      data: {},
      parts: [{ kind: 'text', text: 'Hei' }],
    });

    const mine = (await get(`/tenants/${tenant}/tasks/mine?status=failed`)) as {
      data: Record<string, unknown>[];
    };

    expect(mine.data).toEqual([
      expect.objectContaining({
        status: 'failed',
        service: 'brutt-tjeneste',
        failure: {
          code: 'strategy_error',
          step: 'skriv',
          reason: 'Steget «skriv» feilet. Tjenesten feilet underveis.',
        },
      }),
    ]);
    expect(JSON.stringify(mine)).not.toContain('step skriv failed');
  });
});
