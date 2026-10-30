import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
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
import { createQualityModule, qualityModule } from './quality.js';
import type { ServiceRun } from './service-eval.js';

const servers: FakeServer[] = [];
afterEach(async () => {
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

const boot = async (prices?: Record<string, ModelPrice>) => {
  const optimiserPrompts: string[] = [];
  const model = await fakeHttp((body: Record<string, unknown>) => {
    if (!body.messages)
      return {
        status: 200,
        json: {
          data: [
            { id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' },
            { id: 'gpt-41-dommer', model: 'gpt-4.1', status: 'succeeded' },
          ],
        },
      };
    const messages = body.messages as { content?: string }[];
    const system = messages[0]?.content ?? '';
    const user = messages.at(-1)?.content ?? '';
    const stream = Boolean(body.stream);
    if (system.startsWith('You check whether')) {
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
    modules: [
      ...platformModules.filter((m) => m !== qualityModule),
      createQualityModule({ onBackground: (w) => background.push(w) }),
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
  return { platform, send, settled, optimiserPrompts, supportSession };
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

  it('adds a case with a reference answer and named criteria as they are, and refuses other shapes', async () => {
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
