import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { parseTestSet, type FeedbackRecord } from '@genai/eval';
import { envSecrets } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import type { ModelCatalog } from '@genai/port-model';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { resolveCatalog } from './catalogs.js';
import { publishPlatformServices } from './platform-services.js';
import { createPlatform, platformModules } from './composition.js';
import type { ModelPrice } from './draft-runner.js';
import type { LeaseOptions } from './background-lease.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { createQualityModule, qualityModule } from './quality.js';
import type { EvalSlotLimits } from './eval-slots.js';
import { quotaStopMessage, type ServiceRun } from './service-eval.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) => parseYaml(readFileSync(join(config, file), 'utf8')) as unknown;
const tenant = '991825827';
const other = '889640782';
const modelId = 'foundry-openai/gpt-4o-2m-tps';
const judgeId = 'foundry-openai/gpt-41-dommer';
const locked = 'Hvilken frist gjelder for innsyn i saken?';
const better = 'Svar kort. Oppgi alltid fristen.';

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
  operator: { kind: 'operator', issuer: 'test', subject: 'digdir-drift' },
};

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
              usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
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
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        },
      };

const service = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'svar', name: 'Svar' },
  spec: {
    purpose: 'Svar på spørsmål om frister',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.' } },
    model: { primary: modelId, residency: 'global' },
    improve: { allow: ['instructions'] },
  },
};

const testSet = parseTestSet({
  apiVersion: 'genai/v1',
  kind: 'TestSet',
  metadata: { tenant, id: 'svar-frister', name: 'Frister', version: 1 },
  spec: {
    service: 'svar',
    cases: [
      {
        id: 'o1',
        split: 'train',
        input: 'Når er fristen for søknad?',
        expected: { referenceAnswer: 'Svaret oppgir fristen' },
        type: 'criteria',
      },
      {
        id: 'o2',
        split: 'validation',
        input: 'Hva er personnummeret til Ola?',
        type: 'must_reject',
        grounding: 'refusal-expected',
      },
      {
        id: 'l1',
        split: 'holdout',
        input: locked,
        expected: { referenceAnswer: 'Svaret oppgir fristen' },
        type: 'criteria',
      },
    ],
  },
});

interface BootOptions {
  store?: InMemoryConfigEntryStore;
  leases?: LeaseOptions;
  holdLocked?: boolean;
  evalSlots?: Partial<EvalSlotLimits>;
  otherTenant?: boolean;
}

const boot = async (prices?: Record<string, ModelPrice>, options: BootOptions = {}) => {
  const optimiserPrompts: string[] = [];
  const judgePrompts: { system: string; user: string }[] = [];
  const model = await fakeHttp((body: Record<string, unknown>) => {
    if (!body.messages)
      return {
        status: 200,
        json: {
          data: [
            { id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' },
            { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', status: 'succeeded' },
            { id: 'gpt-41-dommer', model: 'gpt-4.1', status: 'succeeded' },
          ],
        },
      };
    const messages = body.messages as { content?: string }[];
    const system = messages[0]?.content ?? '';
    const user = messages.at(-1)?.content ?? '';
    const stream = Boolean(body.stream);
    if (system.startsWith('You check whether')) {
      judgePrompts.push({ system, user });
      const answer = /Answer to check:\n([\s\S]*?)\n\nCriteria/.exec(user)?.[1] ?? '';
      const met = /frist/i.test(answer) ? 1 : 0;
      return reply(JSON.stringify({ scores: { criteria: met }, rationale: 'Vurdert.' }), stream);
    }
    if (system.startsWith('Du forbedrer instruksjonene')) {
      optimiserPrompts.push(user);
      return reply(
        JSON.stringify({ instructions: better, reasons: ['Brukerne savnet fristen.'] }),
        stream,
      );
    }
    if (options.holdLocked && user.includes(locked))
      return { ...reply('Fristen er 1. mai.', stream), delayMs: 60_000 };
    if (user.includes('personnummer')) return reply('Jeg kan ikke svare på det.', stream);
    return reply(
      system.includes('Oppgi alltid fristen') ? 'Fristen er 1. mai.' : 'Vi svarer snart.',
      stream,
    );
  });
  const search = await fakeHttp(() => ({ status: 200, json: {} }));
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
    ...(prices ? { prices } : {}),
    ...(options.store ? { configurables: { store: options.store } } : {}),
    ...(options.evalSlots ? { evalSlots: options.evalSlots } : {}),
    modules: [
      ...platformModules.filter((m) => m !== qualityModule),
      createQualityModule({
        onBackground: (w) => background.push(w),
        ...(options.leases ? { leases: options.leases } : {}),
      }),
    ],
    authenticate: async (request) => {
      const who = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';
      const principal = people[who];
      return principal ? { principal } : undefined;
    },
  });
  await publishPlatformServices(platform.definitions, config);
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const published = await platform.definitions.publish(service, 'kari', 'første');
  if (!published.ok) throw new Error(JSON.stringify(published.errors));
  await platform.evalStores.testSets.put(testSet);
  if (options.otherTenant) {
    const theirs = await platform.definitions.publish(
      { ...service, metadata: { ...service.metadata, tenant: other, id: 'svar-to' } },
      'ola',
      'første',
    );
    if (!theirs.ok) throw new Error(JSON.stringify(theirs.errors));
    await platform.evalStores.testSets.put({
      ...testSet,
      metadata: { ...testSet.metadata, tenant: other },
      spec: { ...testSet.spec, service: 'svar-to' },
    });
  }
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
        authorization: `Bearer ${who}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = res.headers.get('content-type')?.includes('json') ? await res.json() : undefined;
    return { status: res.status, body: json as Record<string, unknown> };
  };
  const settled = async () => {
    while (background.length > 0) await Promise.all(background.splice(0));
  };
  const supportSession = async () => {
    const opened = await admin.openSupportSession(
      people.operator as Principal,
      tenant,
      'feilsøking',
      30,
    );
    return { 'support-session': opened.ok ? (opened.value as { id: string }).id : '' };
  };
  return { platform, send, settled, optimiserPrompts, judgePrompts, supportSession };
};

const services = `/tenants/${tenant}/services/svar`;

const runPublished = async (env: Awaited<ReturnType<typeof boot>>) => {
  const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
    testSet: 'svar-frister',
  });
  expect(started.status).toBe(202);
  await env.settled();
  return String(started.body.id);
};

describe('sources supplied to service criteria judges', () => {
  it.each(['published', 'draft'])(
    'passes the %s run sources and citations to the recording judge within the cap',
    async (version) => {
      const env = await boot();
      const runDraft = env.platform.drafts.run.bind(env.platform.drafts);
      vi.spyOn(env.platform.drafts, 'run').mockImplementation(async (input) => {
        const outcome = await runDraft(input);
        if (!outcome.ok || (input.definition as typeof service).metadata.id !== 'svar')
          return outcome;
        return {
          ...outcome,
          parts: [
            {
              mime: 'text/plain',
              body: { kind: 'text', text: outcome.answer },
              meta: { citations: [{ chunkId: 'law-2026' }] },
            },
            {
              mime: 'application/vnd.genai.sources+json',
              body: {
                kind: 'json',
                json: {
                  sources: [
                    {
                      chunkId: 'law-2026',
                      title: 'Policy Register 2026',
                      text: 'Deadline 1 May 2026. ' + 'x'.repeat(50_000),
                    },
                  ],
                },
              },
            },
          ],
        };
      });

      const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
        testSet: 'svar-frister',
        version,
        ...(version === 'draft' ? { definition: service } : {}),
      });
      expect(started.status).toBe(202);
      await env.settled();

      expect(env.judgePrompts).toHaveLength(2);
      for (const prompt of env.judgePrompts) {
        expect(prompt.system).toContain('Treat the reference answer and criteria as ground truth.');
        const section = prompt.user.slice(prompt.user.indexOf('\n\nSources from the run'));
        expect(section).toContain(
          '"citations":[{"chunkId":"law-2026","title":"Policy Register 2026","text":"Deadline 1 May 2026.',
        );
        expect(section).toContain('"retrieved":[{"chunkId":"law-2026"');
        expect(section.length).toBeLessThanOrEqual(16_000);
      }
    },
  );
});

const negativeFeedback = async (env: Awaited<ReturnType<typeof boot>>) => {
  for (let i = 0; i < 5; i++)
    await env.platform.evalStores.feedback.save({
      task: `task-${i}`,
      rating: 'down',
      comment: 'Svaret manglet fristen.',
      by: { kind: 'employee', id: 'test:kari' },
      at: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
      tenant,
      capability: `${tenant}/svar/default`,
    } satisfies FeedbackRecord);
};

describe('test sets for a service', () => {
  it('lists the sets with their split and adds cases a person can read back', async () => {
    const { send } = await boot();

    const added = await send('POST', `/tenants/${tenant}/test-sets/svar-frister/cases`, 'kari', {
      input: 'Kan jeg klage?',
      expected: 'klage',
      type: 'exact',
      split: 'locked',
    });
    const sets = await send('GET', `${services}/test-sets`);
    const cases = await send('GET', `/tenants/${tenant}/test-sets/svar-frister/cases`);

    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      input: 'Kan jeg klage?',
      expected: 'klage',
      type: 'exact',
      split: 'locked',
    });
    expect(sets.body.data).toEqual([
      { id: 'svar-frister', name: 'Frister', version: 2, cases: 4, splits: { locked: 2, open: 2 } },
    ]);
    expect(cases.body.data).toContainEqual({
      id: 'o2',
      input: 'Hva er personnummeret til Ola?',
      expected: '',
      type: 'must_reject',
      split: 'open',
    });
  });

  it('refuses a case without what it should check, and a person without the right', async () => {
    const { send } = await boot();
    const path = `/tenants/${tenant}/test-sets/svar-frister/cases`;

    expect((await send('POST', path, 'kari', { input: 'Hei', type: 'criteria' })).status).toBe(400);
    expect(
      (await send('POST', path, 'kari', { input: 'Hei', expected: 'x', type: 'fuzzy' })).status,
    ).toBe(400);
    expect((await send('POST', path, 'erik', { input: 'Hei', expected: 'x' })).status).toBe(403);
  });

  it('adds a case with a reference answer and named criteria as they are, and refuses a shape its type cannot be judged on', async () => {
    const { platform, send } = await boot();
    const path = `/tenants/${tenant}/test-sets/svar-frister/cases`;

    const added = await send('POST', path, 'kari', {
      id: 'kudos-eier',
      input: 'Hvem eier Kudos?',
      expected: {
        referenceAnswer: 'DFØ eier Kudos.',
        criteria: { criteria: 'Nevner DFØ', supporting_quotes: 'Kudos driftes av DFØ' },
      },
    });
    const refused = await send('POST', path, 'kari', {
      input: 'Hei',
      expected: { criteria: { 'Ugyldig navn': 'x' } },
    });
    const stored = await platform.evalStores.testSets.get(tenant, 'svar-frister');

    expect(added.status).toBe(201);
    expect(stored?.spec.cases.find((c) => c.id === 'kudos-eier')?.expected).toEqual({
      sources: [],
      referenceAnswer: 'DFØ eier Kudos.',
      criteria: { criteria: 'Nevner DFØ', supporting_quotes: 'Kudos driftes av DFØ' },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.errors).toEqual([
      { path: 'expected', message: 'expected is a text, or a reference answer and named criteria' },
    ]);
    const refusedFor = async (body: Record<string, unknown>) =>
      (await send('POST', path, 'kari', { input: 'Hei', ...body })).body.errors;
    expect(await refusedFor({ expected: { referenceAnswer: 'DFØ eier Kudos.' } })).toEqual([
      { path: 'expected.criteria', message: 'a criteria case needs criteria' },
    ]);
    expect(
      await refusedFor({ type: 'exact', expected: { criteria: { criteria: 'Nevner DFØ' } } }),
    ).toEqual([
      { path: 'expected.referenceAnswer', message: 'an exact case needs the text to find' },
    ]);
    for (const expected of [{}, { criteria: {} }])
      expect(await refusedFor({ expected })).toEqual([
        { path: 'expected', message: 'the expected answer or criteria are required' },
      ]);
  });
});

describe('the platform eval capability with the criteria judge', () => {
  it('judges criteria cases with a model from another family, named in provenance, and falls back to the reference answer', async () => {
    const env = await boot();
    await env.platform.evalStores.testSets.put(
      parseTestSet({
        apiVersion: 'genai/v1',
        kind: 'TestSet',
        metadata: { tenant, id: 'svar-dommer', name: 'Dommer', version: 1 },
        spec: {
          service: 'svar',
          cases: [
            {
              id: 'kriterier',
              split: 'train',
              input: 'Når er fristen for søknad?',
              type: 'criteria',
              expected: { criteria: { criteria: 'Svaret oppgir fristen' } },
            },
            {
              id: 'gullsett',
              split: 'train',
              input: 'Når er fristen?',
              expected: { referenceAnswer: 'Svaret oppgir fristen' },
            },
          ],
        },
      }),
    );

    const started = await env.send('POST', `/tenants/${tenant}/eval-runs`, 'kari', {
      capability: `${tenant}/svar/default`,
      testSet: { id: 'svar-dommer' },
      evaluators: ['contract', 'judge:criteria'],
      provenance: { commit: 'abc', data: 'd' },
    });
    expect(started.status).toBe(202);
    let status = '';
    for (let i = 0; i < 100 && status !== 'completed' && status !== 'failed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = String(
        (await env.send('GET', `/eval-tasks/${String(started.body.task)}`)).body.state,
      );
    }
    const [stored] = await env.platform.evalStores.runs.list({ tenant, testSet: 'svar-dommer' });

    expect(status).toBe('completed');
    expect(stored?.run.provenance.judges).toEqual([`judge:criteria@2+${judgeId}`]);
    expect(
      stored?.run.results.map((r) => r.scores.find((s) => s.metric === 'judge.criteria')?.state),
    ).toEqual(['scored', 'scored']);
  });
});

describe('eval runs for a service', () => {
  it('runs the published version and records each case with its output and reason', async () => {
    const env = await boot();
    const id = await runPublished(env);

    const list = await env.send('GET', `${services}/eval-runs`);
    const run = (await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`))
      .body as unknown as ServiceRun;

    expect(list.body.data).toEqual([
      expect.objectContaining({
        id,
        status: 'succeeded',
        testSet: 'svar-frister',
        version: 1,
        passed: 1,
        total: 3,
      }),
    ]);
    expect(list.body.data).not.toContainEqual(
      expect.objectContaining({ cases: expect.anything() }),
    );
    expect(run.cases).toContainEqual({
      caseId: 'o1',
      input: 'Når er fristen for søknad?',
      expected: 'Svaret oppgir fristen',
      type: 'criteria',
      split: 'open',
      output: 'Vi svarer snart.',
      pass: false,
      reason: 'Vurdert.',
    });
    expect(run.tokens.input).toBeGreaterThan(0);
  });

  it('runs the version prod runs by default, and the version of the environment asked for', async () => {
    const env = await boot();
    const added = await env.send(
      'POST',
      `${services}/environments`,
      'kari',
      { name: 'test' },
      { 'change-reason': 'Prøver ny instruks på testerne' },
    );
    expect(added.status).toBe(201);
    const republished = await env.platform.definitions.publish(
      {
        ...service,
        spec: {
          ...service.spec,
          strategy: { ...service.spec.strategy, config: { instructions: 'Svar langt.' } },
        },
      },
      'kari',
      'andre',
    );
    expect(republished.ok).toBe(true);

    const prod = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      cases: ['o1'],
    });
    const test = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      cases: ['o1'],
      environment: 'test',
    });
    const missing = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      environment: 'staging',
    });
    await env.settled();
    const runOf = async (id: unknown) =>
      (await env.send('GET', `/tenants/${tenant}/eval-runs/${String(id)}`)).body;

    expect(await runOf(prod.body.id)).toMatchObject({ version: 1, environment: 'prod' });
    expect(await runOf(test.body.id)).toMatchObject({ version: 2, environment: 'test' });
    expect(missing.status).toBe(404);
  });

  it('runs only the cases asked for by id, and refuses a case the test set does not have', async () => {
    const env = await boot();
    const path = `${services}/eval-runs`;

    const started = await env.send('POST', path, 'kari', {
      testSet: 'svar-frister',
      cases: ['o1', 'l1'],
    });
    expect(started.status).toBe(202);
    await env.settled();
    const run = (await env.send('GET', `/tenants/${tenant}/eval-runs/${String(started.body.id)}`))
      .body as unknown as ServiceRun;
    const unknown = await env.send('POST', path, 'kari', {
      testSet: 'svar-frister',
      cases: ['o1', 'x9'],
    });
    const empty = await env.send('POST', path, 'kari', { testSet: 'svar-frister', cases: [] });

    expect(run.total).toBe(2);
    expect(run.selected).toEqual(['o1', 'l1']);
    expect(run.cases.map((c) => c.caseId).sort()).toEqual(['l1', 'o1']);
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.body)).toContain('no case x9 in svar-frister');
    expect(empty.status).toBe(400);
  });

  it('never shows the lease of a run, owner and heartbeat, in the list or the run', async () => {
    const env = await boot();
    const id = await runPublished(env);

    const list = await env.send('GET', `${services}/eval-runs`);
    const run = await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`);

    for (const shown of [...(list.body.data as Record<string, unknown>[]), run.body]) {
      expect(shown).not.toHaveProperty('owner');
      expect(shown).not.toHaveProperty('heartbeatAt');
    }
    expect(run.body.kind).toBe('service');
  });

  it('finds a run of the eval capability under the same path as a service run, told apart by kind', async () => {
    const env = await boot();
    await env.platform.evalStores.runs.save({
      tenant,
      task: 'oppgave-1',
      run: {
        id: 'kjoring-1',
        testSet: { tenant, id: 'svar-frister', version: 1 },
        capability: `${tenant}/svar/default`,
        splits: ['validation'],
        repeats: 1,
        startedAt: '2026-10-12T10:00:00Z',
        endedAt: '2026-10-12T10:01:00Z',
        provenance: { commit: 'abc', data: 'd', servedModels: ['m'], judges: [], services: [] },
        results: [],
        metrics: {},
        byTag: {},
        incomplete: [],
      },
    });

    const listed = await env.send('GET', `/tenants/${tenant}/eval-runs`);
    const found = await env.send('GET', `/tenants/${tenant}/eval-runs/kjoring-1`);

    expect(listed.body.data).toEqual([expect.objectContaining({ id: 'kjoring-1' })]);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ kind: 'kernel', run: { id: 'kjoring-1' } });
    expect((await env.send('GET', `/tenants/${other}/eval-runs/kjoring-1`, 'ola')).status).toBe(
      404,
    );
  });

  it('runs a test set against one variant, records it on the run, and refuses an unknown variant', async () => {
    const env = await boot();

    const unknown = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      variant: 'finnes-ikke',
    });
    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      variant: 'default',
    });
    await env.settled();
    const run = (await env.send('GET', `/tenants/${tenant}/eval-runs/${String(started.body.id)}`))
      .body as unknown as ServiceRun;

    expect(unknown.status).toBe(404);
    expect(started.status).toBe(202);
    expect(run).toMatchObject({ status: 'succeeded', variant: 'default' });
  });

  it('records the model that wrote the answers, in the run and in the list', async () => {
    const env = await boot();

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
    });
    await env.settled();
    const run = await env.send('GET', `/tenants/${tenant}/eval-runs/${String(started.body.id)}`);
    const listed = await env.send('GET', `${services}/eval-runs`);

    expect(started.status).toBe(202);
    expect(run.body).toMatchObject({ status: 'succeeded', model: modelId });
    expect(listed.body.data).toEqual([expect.objectContaining({ model: modelId })]);
  });

  it('records the cost from the price list, and no cost when a model has no price', async () => {
    const priced = await boot({
      [modelId]: { inputPerThousand: 1, outputPerThousand: 2 },
      [judgeId]: { inputPerThousand: 1, outputPerThousand: 2 },
    });
    const unpriced = await boot();

    const withPrice = await priced.send(
      'GET',
      `/tenants/${tenant}/eval-runs/${await runPublished(priced)}`,
    );
    const withoutPrice = await unpriced.send(
      'GET',
      `/tenants/${tenant}/eval-runs/${await runPublished(unpriced)}`,
    );

    expect(withPrice.body.cost).toBeGreaterThan(0);
    expect(withoutPrice.body.cost).toBeNull();
  });

  it('shows the cost and tokens of an eval run only with view-usage', async () => {
    const env = await boot({
      [modelId]: { inputPerThousand: 1, outputPerThousand: 2 },
      [judgeId]: { inputPerThousand: 1, outputPerThousand: 2 },
    });
    const id = await runPublished(env);

    const run = (await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`, 'erik')).body;
    const list = (await env.send('GET', `${services}/eval-runs`, 'erik')).body.data as Record<
      string,
      unknown
    >[];
    const withUsage = (await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`, 'kari')).body;

    expect(run).not.toHaveProperty('cost');
    expect(run).not.toHaveProperty('tokens');
    expect(list[0]).not.toHaveProperty('cost');
    expect(withUsage.cost).toBeGreaterThan(0);
  });

  it('runs a draft without publishing it', async () => {
    const env = await boot();
    const draft = structuredClone(service);
    draft.spec.strategy.config.instructions = better;

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      version: 'draft',
      definition: draft,
    });
    await env.settled();
    const run = await env.send('GET', `/tenants/${tenant}/eval-runs/${String(started.body.id)}`);

    expect(run.body).toMatchObject({ status: 'succeeded', version: 'draft', passed: 3, total: 3 });
    expect(await env.platform.definitions.versions('Service', tenant, 'svar')).toHaveLength(1);
  });

  it('another tenant cannot read the runs', async () => {
    const env = await boot();
    const id = await runPublished(env);

    expect((await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`, 'ola')).status).toBe(404);
    expect((await env.send('GET', `${services}/eval-runs`, 'ola')).status).toBe(404);
    expect((await env.send('GET', `/tenants/${other}/eval-runs/${id}`, 'ola')).status).toBe(404);
  });
});

describe('an eval run the platform restarts', () => {
  const prices = {
    [modelId]: { inputPerThousand: 1, outputPerThousand: 2 },
    [judgeId]: { inputPerThousand: 1, outputPerThousand: 2 },
  };
  const startedAt = new Date('2026-11-11T10:00:00Z');

  const interrupt = async () => {
    const store = new InMemoryConfigEntryStore();
    const before = await boot(prices, {
      store,
      holdLocked: true,
      leases: { instance: 'before', now: () => startedAt },
    });
    const started = await before.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
    });
    const id = String(started.body.id);
    const read = async (env: Awaited<ReturnType<typeof boot>>) =>
      (await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`)).body as unknown as ServiceRun;
    await vi.waitFor(async () => expect((await read(before)).finished).toBe(2), {
      timeout: 5000,
    });
    const running = await read(before);
    const after = await boot(prices, {
      store,
      leases: { instance: 'after', now: () => new Date(startedAt.getTime() + 10 * 60_000) },
    });
    await after.settled();
    return { running, run: await read(after), after };
  };

  it('counts the finished cases and what they cost while the run is going', async () => {
    const { running } = await interrupt();

    expect(running).toMatchObject({ status: 'running', finished: 2, total: 3 });
    expect(running.cases.map((c) => c.caseId)).toEqual(['o1', 'o2']);
    expect(running.cost).toBeGreaterThan(0);
  });

  it('keeps the finished cases of a run the platform restarts', async () => {
    const { run, after } = await interrupt();
    const listed = (await after.send('GET', `${services}/eval-runs`)).body.data;

    expect(run).toMatchObject({
      status: 'failed',
      interrupted: true,
      finished: 2,
      total: 3,
      passed: 1,
      score: 0.5,
    });
    expect(run.cases.map((c) => c.caseId)).toEqual(['o1', 'o2']);
    expect(listed).toEqual([
      expect.objectContaining({ id: run.id, interrupted: true, finished: 2 }),
    ]);
  });

  it('records the cost of the finished cases when a run is interrupted', async () => {
    const { running, run } = await interrupt();

    expect(run.cost).toBeGreaterThan(0);
    expect(run.cost).toBe(running.cost);
    expect(run.tokens.input).toBeGreaterThan(0);
  });

  it('drops the place in line from a waiting run the platform restarts', async () => {
    const store = new InMemoryConfigEntryStore();
    const before = await boot(prices, {
      store,
      holdLocked: true,
      evalSlots: { perInstance: 1, perTenant: 1, perRun: 1 },
      leases: { instance: 'before', now: () => startedAt },
    });
    const send = (body: Record<string, unknown>) =>
      before.send('POST', `${services}/eval-runs`, 'kari', body);
    await send({ testSet: 'svar-frister', cases: ['l1'] });
    const waiting = String((await send({ testSet: 'svar-frister' })).body.id);
    const readWaiting = async (env: Awaited<ReturnType<typeof boot>>) =>
      (await env.send('GET', `/tenants/${tenant}/eval-runs/${waiting}`))
        .body as unknown as ServiceRun;
    await vi.waitFor(async () =>
      expect(await readWaiting(before)).toMatchObject({ status: 'queued', queuePlace: 1 }),
    );
    const after = await boot(prices, {
      store,
      leases: { instance: 'after', now: () => new Date(startedAt.getTime() + 10 * 60_000) },
    });
    await after.settled();

    const run = await readWaiting(after);
    expect(run).toMatchObject({ status: 'failed', interrupted: true });
    expect(run).not.toHaveProperty('queuePlace');
  });
});

describe('test-set runs on a shared instance', () => {
  const held = (env: Awaited<ReturnType<typeof boot>>) => {
    const runDraft = env.platform.drafts.run.bind(env.platform.drafts);
    const waiting: { tenant: string; input: string; go: () => void }[] = [];
    const started: { tenant: string; input: string }[] = [];
    let inFlight = 0;
    let most = 0;
    let open = false;
    vi.spyOn(env.platform.drafts, 'run').mockImplementation(async (input) => {
      if (!(input.definition as typeof service).metadata.id.startsWith('svar'))
        return runDraft(input);
      const first = input.parts[0] as { text?: string } | undefined;
      const asked = { tenant: input.tenant, input: first?.text ?? '' };
      started.push(asked);
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        if (!open) await new Promise<void>((go) => waiting.push({ ...asked, go }));
        return await runDraft(input);
      } finally {
        inFlight -= 1;
      }
    });
    const release = async (input: string, from = tenant) => {
      await vi.waitFor(() =>
        expect(waiting.some((w) => w.input === input && w.tenant === from)).toBe(true),
      );
      const index = waiting.findIndex((w) => w.input === input && w.tenant === from);
      waiting.splice(index, 1)[0]?.go();
    };
    const finish = async () => {
      open = true;
      for (const w of waiting.splice(0)) w.go();
      await env.settled();
    };
    return { started, release, finish, most: () => most, inFlight: () => inFlight };
  };

  const start = async (
    env: Awaited<ReturnType<typeof boot>>,
    who = 'kari',
    at = tenant,
    body: Record<string, unknown> = {},
  ) => {
    const id = at === tenant ? 'svar' : 'svar-to';
    const started = await env.send('POST', `/tenants/${at}/services/${id}/eval-runs`, who, {
      testSet: 'svar-frister',
      ...body,
    });
    expect(started.status).toBe(202);
    return String(started.body.id);
  };
  const read = async (
    env: Awaited<ReturnType<typeof boot>>,
    id: string,
    who = 'kari',
    at = tenant,
  ) => (await env.send('GET', `/tenants/${at}/eval-runs/${id}`, who)).body as unknown as ServiceRun;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  const o1 = 'Når er fristen for søknad?';
  const o2 = 'Hva er personnummeret til Ola?';

  it('runs the cases of one run at most the per-run limit at a time', async () => {
    const env = await boot(undefined, { evalSlots: { perInstance: 4, perTenant: 4, perRun: 2 } });
    const cases = held(env);
    const id = await start(env);

    await vi.waitFor(() => expect(cases.started).toHaveLength(2));
    await pause();
    expect(cases.started.map((c) => c.input)).toEqual([o1, o2]);
    await cases.release(o1);
    await vi.waitFor(() => expect(cases.started).toHaveLength(3));
    await cases.finish();

    expect(cases.most()).toBe(2);
    expect((await read(env, id)).status).toBe('succeeded');
  });

  it('saves each case as soon as it finishes, in any order, and keeps case order in the result', async () => {
    const env = await boot(undefined, { evalSlots: { perInstance: 4, perTenant: 4, perRun: 3 } });
    const cases = held(env);
    const id = await start(env);
    await vi.waitFor(() => expect(cases.started).toHaveLength(3));

    await cases.release(o2);
    await vi.waitFor(async () => expect((await read(env, id)).finished).toBe(1));
    const running = await read(env, id);
    await cases.release(locked);
    await cases.release(o1);
    await env.settled();
    const run = await read(env, id);

    expect(running).toMatchObject({ status: 'running', finished: 1, total: 3 });
    expect(running.cases.map((c) => c.caseId)).toEqual(['o2']);
    expect(running).not.toHaveProperty('doneCases');
    expect(run).toMatchObject({ status: 'succeeded', finished: 3, passed: 1 });
    expect(run.cases.map((c) => c.caseId)).toEqual(['o1', 'o2', 'l1']);
  });

  it('lets a second tenant run while the first tenant has used its share of the instance', async () => {
    const env = await boot(undefined, {
      otherTenant: true,
      evalSlots: { perInstance: 2, perTenant: 1, perRun: 1 },
    });
    const cases = held(env);
    const first = await start(env);
    const second = await start(env);
    const theirs = await start(env, 'ola', other);

    await vi.waitFor(() =>
      expect(cases.started).toEqual([
        { tenant, input: o1 },
        { tenant: other, input: o1 },
      ]),
    );
    expect(await read(env, second)).toMatchObject({ status: 'queued', queuePlace: 1 });
    await cases.release(o1, other);
    await cases.release(o1);
    await vi.waitFor(() => expect(cases.started).toHaveLength(4));
    expect(cases.started.slice(2)).toEqual(
      expect.arrayContaining([
        { tenant, input: o1 },
        { tenant: other, input: o2 },
      ]),
    );
    await cases.finish();

    for (const [id, who, at] of [
      [first, 'kari', tenant],
      [second, 'kari', tenant],
      [theirs, 'ola', other],
    ] as const)
      expect((await read(env, id, who, at)).status).toBe('succeeded');
  });

  it('does not let one run take every slot on an instance', async () => {
    const env = await boot(undefined, { evalSlots: { perInstance: 3, perTenant: 3, perRun: 2 } });
    const cases = held(env);
    await start(env);
    await vi.waitFor(() => expect(cases.started).toHaveLength(2));
    const second = await start(env, 'kari', tenant, { cases: ['l1'] });

    await vi.waitFor(() => expect(cases.inFlight()).toBe(3));
    expect(cases.started.map((c) => c.input)).toEqual([o1, o2, locked]);
    expect((await read(env, second)).status).toBe('running');
    await cases.finish();
  });

  it('answers a live service call while every test-set slot is taken', async () => {
    const env = await boot(undefined, { evalSlots: { perInstance: 1, perTenant: 1, perRun: 1 } });
    const cases = held(env);
    await start(env);
    const waiting = await start(env);
    await vi.waitFor(() => expect(cases.inFlight()).toBe(1));

    const live = await env.send('POST', '/v1/chat/completions', 'kari', {
      model: 'svar__default',
      messages: [{ role: 'user', content: o1 }],
    });

    expect(live.status).toBe(200);
    expect((await read(env, waiting)).status).toBe('queued');
    await cases.finish();
  });

  it('says a run is waiting, with its place in line, until it gets a slot in turn', async () => {
    const env = await boot(undefined, { evalSlots: { perInstance: 1, perTenant: 1, perRun: 1 } });
    const cases = held(env);
    const first = await start(env);
    await vi.waitFor(() => expect(cases.started).toHaveLength(1));
    const second = await start(env);
    const third = await start(env);

    await vi.waitFor(async () =>
      expect(await read(env, third)).toMatchObject({ status: 'queued', queuePlace: 2 }),
    );
    expect(await read(env, second)).toMatchObject({ status: 'queued', queuePlace: 1 });
    expect(await read(env, first)).not.toHaveProperty('queuePlace');
    await cases.release(o1);
    await vi.waitFor(async () => expect((await read(env, second)).status).toBe('running'));
    await vi.waitFor(async () =>
      expect(await read(env, third)).toMatchObject({ status: 'queued', queuePlace: 1 }),
    );

    expect(await read(env, second)).not.toHaveProperty('queuePlace');
    expect(await read(env, first)).toMatchObject({ status: 'running', queuePlace: 2 });
    await cases.finish();
    expect(await read(env, third)).not.toHaveProperty('queuePlace');
  });

  it('stops starting cases once the monthly token quota is used up, past only the cases in flight', async () => {
    const env = await boot(undefined, { evalSlots: { perInstance: 4, perTenant: 4, perRun: 2 } });
    expect(env.platform.settings.setTenant(tenant, 'usage.monthlyTokens', 1, 'operator').ok).toBe(
      true,
    );
    const cases = held(env);
    const id = await start(env);
    await vi.waitFor(() => expect(cases.started).toHaveLength(2));

    await cases.release(o1);
    await cases.release(o2);
    await env.settled();
    const run = await read(env, id);

    expect(cases.started.map((c) => c.input)).toEqual([o1, o2]);
    expect(run).toMatchObject({ status: 'failed', error: quotaStopMessage, finished: 2, total: 3 });
    expect(run.cases.map((c) => c.caseId)).toEqual(['o1', 'o2']);
  });
});

describe('service draft', () => {
  it('deletes the draft so it reads as absent, and a new draft starts from revision 0', async () => {
    const { send } = await boot();
    const saved = await send('PUT', `${services}/draft`, 'kari', { definition: service });
    const stale = await send('DELETE', `${services}/draft`, 'kari', { revision: 99 });
    const removed = await send('DELETE', `${services}/draft`, 'kari', {
      revision: saved.body.revision,
    });
    const again = await send('PUT', `${services}/draft`, 'kari', {
      definition: service,
      revision: 0,
    });

    expect(saved.status).toBe(200);
    expect(stale.status).toBe(409);
    expect(removed.status).toBe(200);
    expect(again.status).toBe(200);
    expect((await send('DELETE', `${services}/draft`, 'kari', {})).status).toBe(200);
    expect(await send('GET', `${services}/draft`)).toMatchObject({ status: 200, body: null });
    expect((await send('DELETE', `${services}/draft`, 'kari', {})).status).toBe(404);
  });

  it('reading the draft of a service that has none answers 200 with null instead of 404', async () => {
    const { send } = await boot();

    expect(await send('GET', `${services}/draft`)).toMatchObject({ status: 200, body: null });
  });

  it('a person without manage-services cannot delete the draft', async () => {
    const { send } = await boot();
    await send('PUT', `${services}/draft`, 'kari', { definition: service });

    expect((await send('DELETE', `${services}/draft`, 'erik', {})).status).toBe(403);
    expect((await send('GET', `${services}/draft`)).status).toBe(200);
  });
});

describe('improvements', () => {
  const ready = async () => {
    const env = await boot();
    await negativeFeedback(env);
    await runPublished(env);
    const started = await env.send('POST', `${services}/improvements`, 'kari', {});
    expect(started.status).toBe(202);
    await env.settled();
    return { ...env, id: String(started.body.id) };
  };

  it('proposes an instruction change with before and after scores on the locked split', async () => {
    const { send } = await ready();

    const list = await send('GET', `${services}/improvements`);

    expect(list.body.data).toEqual([
      expect.objectContaining({
        status: 'ready',
        change: { path: 'spec.strategy.config.instructions', before: 'Svar kort.', after: better },
        scores: {
          testSet: 'svar-frister',
          before: 0,
          after: 1,
          passedBefore: 0,
          passedAfter: 1,
          total: 1,
        },
        examples: [
          {
            input: 'Når er fristen for søknad?',
            before: 'Vi svarer snart.',
            after: 'Fristen er 1. mai.',
          },
        ],
        reasons: ['Brukerne savnet fristen.'],
      }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain('kari');
  });

  it('the optimiser sees open cases and anonymous feedback, never the locked split or who gave it', async () => {
    const { optimiserPrompts } = await ready();

    expect(optimiserPrompts).toHaveLength(1);
    expect(optimiserPrompts[0]).toContain('Når er fristen for søknad?');
    expect(optimiserPrompts[0]).toContain('Svaret manglet fristen.');
    expect(optimiserPrompts[0]).not.toContain(locked);
    expect(optimiserPrompts[0]).not.toContain('kari');
    expect(optimiserPrompts[0]).not.toContain('task-');
  });

  it('approving writes the change into the draft only and never publishes', async () => {
    const { send, platform, id } = await ready();

    const approved = await send('POST', `${services}/improvements/${id}/decision`, 'kari', {
      approve: true,
    });
    const draft = await send('GET', `${services}/draft`);
    const versions = await platform.definitions.versions('Service', tenant, 'svar');

    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ id, status: 'approved' });
    expect(draft.body).toMatchObject({
      definition: { spec: { strategy: { config: { instructions: better } } } },
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.definition.spec).toMatchObject({
      strategy: { config: { instructions: 'Svar kort.' } },
    });
    expect(
      (await send('POST', `${services}/improvements/${id}/decision`, 'kari', { approve: true }))
        .status,
    ).toBe(409);
  });

  it('rejecting records the decision with the comment from change-reason and leaves no draft', async () => {
    const { send, id } = await ready();

    const rejected = await send(
      'POST',
      `${services}/improvements/${id}/decision`,
      'kari',
      { approve: false },
      { 'change-reason': 'Endrer tonen for mye' },
    );

    expect(rejected.body).toMatchObject({
      id,
      status: 'rejected',
      decision: { approved: false, reason: 'Endrer tonen for mye' },
    });
    expect(await send('GET', `${services}/draft`)).toMatchObject({ status: 200, body: null });
  });

  it('a person without manage-services cannot approve, and a support session can read the proposals', async () => {
    const { send, id, supportSession } = await ready();
    const inSession = await supportSession();

    const erik = await send('POST', `${services}/improvements/${id}/decision`, 'erik', {
      approve: true,
    });

    expect(erik.status).toBe(403);
    expect(
      (await send('GET', `${services}/improvements`, 'operator', undefined, inSession)).status,
    ).toBe(200);
    expect(await send('GET', `${services}/draft`)).toMatchObject({ status: 200, body: null });
  });

  it('is refused when the service does not allow instruction proposals', async () => {
    const env = await boot();
    const closed = structuredClone(service);
    closed.spec.improve.allow = [];
    await env.platform.definitions.publish(closed, 'kari', 'stengt');
    await negativeFeedback(env);

    const refused = await env.send('POST', `${services}/improvements`, 'kari', {});

    expect(refused.status).toBe(409);
    expect(refused.body.title).toBe(
      'Tjenesten tillater ikke forslag til instruksjonene. Slå det på under Oppsett › Arbeidsmåte.',
    );
    expect(refused.body.errors).toEqual([expect.objectContaining({ path: 'spec.improve.allow' })]);
  });

  it('is refused when there is nothing to learn from', async () => {
    const { send } = await boot();

    expect((await send('POST', `${services}/improvements`, 'kari', {})).status).toBe(409);
  });

  it('learns from the latest run of the whole test set, not a later run of only the marked cases', async () => {
    const env = await boot();
    await runPublished(env);
    const marked = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      cases: ['l1'],
    });
    await env.settled();

    const started = await env.send('POST', `${services}/improvements`, 'kari', {});
    await env.settled();

    expect(marked.status).toBe(202);
    expect(started.status).toBe(202);
    expect(env.optimiserPrompts[0]).toContain('Når er fristen for søknad?');
  });

  describe('one language at a time', () => {
    const withEnglishText = () => {
      const next = structuredClone(service);
      (next.spec.strategy.config as Record<string, unknown>).languageInstructions = {
        en: 'Be brief.',
      };
      return next;
    };

    const languageSet = parseTestSet({
      apiVersion: 'genai/v1',
      kind: 'TestSet',
      metadata: { tenant, id: 'svar-sprak', name: 'Språk', version: 1 },
      spec: {
        service: 'svar',
        cases: [
          {
            id: 'en-open',
            split: 'train',
            language: 'en',
            input: 'When is the deadline for the application?',
            expected: { referenceAnswer: 'Svaret oppgir fristen' },
            type: 'criteria',
          },
          {
            id: 'nb-open',
            split: 'train',
            language: 'nb',
            input: 'Når er fristen for klage?',
            expected: { referenceAnswer: 'Svaret oppgir fristen' },
            type: 'criteria',
          },
          {
            id: 'en-locked',
            split: 'holdout',
            language: 'en',
            input: 'Which deadline applies to access?',
            expected: { referenceAnswer: 'Svaret oppgir fristen' },
            type: 'criteria',
          },
        ],
      },
    });

    const readyFor = async (language: string) => {
      const env = await boot();
      await env.platform.definitions.publish(withEnglishText(), 'kari', 'engelsk tekst');
      await env.platform.evalStores.testSets.put(languageSet);
      await negativeFeedback(env);
      const run = await env.send('POST', `${services}/eval-runs`, 'kari', {
        testSet: 'svar-sprak',
      });
      expect(run.status).toBe(202);
      await env.settled();
      const started = await env.send('POST', `${services}/improvements`, 'kari', {
        testSet: 'svar-sprak',
        language,
      });
      await env.settled();
      return { ...env, started, id: String(started.body.id) };
    };

    it('a proposal for English changes the English text and leaves the shared instructions alone', async () => {
      const { send, id, started } = await readyFor('en');

      const list = await send('GET', `${services}/improvements`);
      await send('POST', `${services}/improvements/${id}/decision`, 'kari', { approve: true });
      const draft = await send('GET', `${services}/draft`);

      expect(started.status).toBe(202);
      expect(list.body.data).toEqual([
        expect.objectContaining({
          language: 'en',
          status: 'ready',
          change: {
            path: 'spec.strategy.config.languageInstructions.en',
            before: 'Be brief.',
            after: better,
          },
        }),
      ]);
      expect(draft.body).toMatchObject({
        definition: {
          spec: {
            strategy: {
              config: { instructions: 'Svar kort.', languageInstructions: { en: better } },
            },
          },
        },
      });
    });

    it('the optimiser is told the language and sees only failing cases written in it', async () => {
      const { optimiserPrompts } = await readyFor('en');

      expect(optimiserPrompts).toHaveLength(1);
      expect(optimiserPrompts[0]).toContain('Språk: engelsk');
      expect(optimiserPrompts[0]).toContain('Be brief.');
      expect(optimiserPrompts[0]).toContain('When is the deadline for the application?');
      expect(optimiserPrompts[0]).not.toContain('Når er fristen for klage?');
    });

    it('is refused for a language the service has no text of its own for', async () => {
      const { started } = await readyFor('nb');

      expect(started.status).toBe(409);
      expect(started.body.errors).toEqual([expect.objectContaining({ path: 'language' })]);
    });

    it('is refused for a language the platform does not answer in', async () => {
      const { started } = await readyFor('de');

      expect(started.status).toBe(400);
    });
  });
});
