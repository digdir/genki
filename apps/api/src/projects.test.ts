import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import type { Clock } from '@genai/jobs';
import { envSecrets } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import type { ModelCatalog } from '@genai/port-model';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { batchRunsModule, createBatchRunsModule } from './batch-run-routes.js';
import { resolveCatalog } from './catalogs.js';
import { createPlatform, platformModules } from './composition.js';
import { appendVersion, InMemoryConfigEntryStore } from './config-store.js';
import { InMemoryIngestionBackend, pipelineSpec } from './ingestion.js';
import type { ModuleDeps } from './platform-modules.js';
import { createProjectsModule, projectsModule } from './project-routes.js';
import { subscriptionStateKind, type SubscriptionState } from './projects.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) => parseYaml(readFileSync(join(config, file), 'utf8')) as unknown;
const tenant = '991825827';
const other = '889640782';
const modelId = 'foundry-openai/gpt-4o-2m-tps';

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
  lise: {
    kind: 'employee',
    issuer: 'test',
    subject: 'lise',
    tenant,
    authorizedFor: [{ org: tenant, actions: ['view-usage'] }],
  },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
};

interface KudosDoc {
  doc_num: string;
  title: string;
  type: string;
  concerned_years: string;
  orgs_short: string;
  total_chunks: number;
}

const report = (n: number, org: string): KudosDoc => ({
  doc_num: `d${n}`,
  title: `Årsrapport 2024 ${org}`,
  type: 'Årsrapport',
  concerned_years: '2024',
  orgs_short: org,
  total_chunks: 10,
});

const initialDocs = (): KudosDoc[] => [
  report(1, 'BRREG'),
  report(2, 'DIGDIR'),
  report(3, 'SKATT'),
  {
    doc_num: 'd9',
    title: 'Evaluering av tilskudd',
    type: 'Evaluering',
    concerned_years: '2023',
    orgs_short: 'DIGDIR',
    total_chunks: 30,
  },
];

const docsCollection = 'KUDOS_preprod_v4_documents_ab897fbdedfa';

const clauseHolds = (record: Record<string, unknown>, clause: string): boolean => {
  const joined = /^\$\w+\((.*)\)$/.exec(clause);
  if (joined) return (joined[1] ?? '').split(' && ').every((c) => clauseHolds(record, c));
  const m = /^(\w+):(>=|<=|=)?(.*)$/.exec(clause);
  if (!m) return true;
  const value = record[m[1] ?? ''];
  const raw = (m[3] ?? '').replace(/`/g, '');
  const list = raw.startsWith('[') ? raw.slice(1, -1).split(',') : [raw];
  return list.includes(String(value));
};

const matchesFilter = (record: Record<string, unknown>, filter: unknown) => {
  if (typeof filter !== 'string') return true;
  const joined = /^\$\w+\((.*)\)$/.exec(filter);
  const clauses = (joined ? (joined[1] ?? '') : filter).split(' && ');
  return clauses.every((c) => clauseHolds(record, c));
};

const typesenseSearch = (docs: KudosDoc[], s: Record<string, unknown>) => {
  const records: Record<string, unknown>[] =
    s.collection === docsCollection
      ? docs.map((d) => ({ ...d }))
      : docs.flatMap((d) =>
          [0, 1].map((position) => ({
            ...d,
            chunk_id: `${d.doc_num}-${position}`,
            chunk_index: position,
            content_markdown: `Fra ${d.title}: tekst ${position + 1}.`,
            [docsCollection]: { title: d.title, url: `https://kudos.example.no/${d.doc_num}` },
          })),
        );
  const found = records.filter((r) => matchesFilter(r, s.filter_by));
  if (typeof s.facet_by === 'string') return { found: found.length, hits: [], facet_counts: [] };
  const perPage = Number(s.per_page ?? 10);
  const page = Number(s.page ?? 1);
  return {
    found: found.length,
    hits: found
      .slice((page - 1) * perPage, page * perPage)
      .map((document) => ({ document, text_match_info: { score: 1 } })),
  };
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

const manualClock = (start: string) => {
  let current = new Date(start);
  let timers: (() => void)[] = [];
  const clock: Clock = {
    now: () => current,
    setTimer: (_at, run) => {
      timers.push(run);
      return () => {
        timers = timers.filter((t) => t !== run);
      };
    },
  };
  return {
    clock,
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    fire: () => {
      const due = timers;
      timers = [];
      for (const run of due) run();
    },
  };
};

interface Shared {
  store: InMemoryConfigEntryStore;
  docs: KudosDoc[];
  time: ReturnType<typeof manualClock>;
}

const shared = (): Shared => ({
  store: new InMemoryConfigEntryStore(),
  docs: initialDocs(),
  time: manualClock('2026-10-08T10:00:00.000Z'),
});

const boot = async (world: Shared = shared()) => {
  const state = { modelCalls: [] as string[], modelDown: false };
  const model = await fakeHttp((body: Record<string, unknown>) => {
    if (!body.messages)
      return {
        status: 200,
        json: { data: [{ id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' }] },
      };
    if (state.modelDown) return { status: 503, json: { error: { message: 'nede' } } };
    const messages = body.messages as { content?: string }[];
    const user = messages.at(-1)?.content ?? '';
    state.modelCalls.push(user.split('\n')[0] ?? '');
    return reply(`Sammendrag av ${user.split('\n')[0] ?? ''}`, Boolean(body.stream));
  });
  const search = await fakeHttp((body: Record<string, unknown>) => {
    const searches = (body.searches ?? []) as Record<string, unknown>[];
    return {
      status: 200,
      json: { results: searches.map((s) => typesenseSearch(world.docs, s)) },
    };
  });
  servers.push(model, search);
  const env = {
    FOUNDRY_OPENAI_BASE_URL: `${model.url}/v1`,
    TYPESENSE_URL: search.url,
    COLBERT_API_URL: search.url,
  };
  const background: Promise<void>[] = [];
  let deps: ModuleDeps | undefined;
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
    prices: { [modelId]: { inputPerThousand: 0.05, outputPerThousand: 0.15 } },
    configurables: {
      store: world.store,
      scheduleIntervalMs: 0,
      ingestion: new InMemoryIngestionBackend(() => {
        world.docs.push(report(7, 'NAV'));
        return [];
      }),
    },
    modules: [
      ...platformModules.filter((m) => m !== batchRunsModule && m !== projectsModule),
      createBatchRunsModule({ onBackground: (w) => background.push(w) }),
      createProjectsModule({
        onBackground: (w) => background.push(w),
        clock: world.time.clock,
        leases: { now: world.time.now },
      }),
      (moduleDeps) => {
        deps = moduleDeps;
        return { id: 'test-deps', mount: () => undefined };
      },
    ],
    authenticate: async (request) => {
      const who = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';
      const principal = people[who];
      return principal ? { principal } : undefined;
    },
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
  if (!(await platform.definitions.get('Service', tenant, 'oppsummering'))) {
    const published = await platform.definitions.publish(service, 'kari', 'første');
    if (!published.ok) throw new Error(JSON.stringify(published.errors));
  }
  await platform.sync();
  const send = async (
    method: string,
    path: string,
    who = 'kari',
    body?: unknown,
    reason: string | null = 'Testendring i prosjektet',
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${who}`,
        ...(reason ? { 'change-reason': encodeURIComponent(reason) } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const type = res.headers.get('content-type') ?? '';
    const parsed = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, body: parsed as Record<string, unknown> };
  };
  const settled = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      while (background.length > 0) await Promise.all(background.splice(0));
    }
  };
  if (!deps) throw new Error('no module deps');
  return { send, settled, state, deps: deps as ModuleDeps, world };
};

type Env = Awaited<ReturnType<typeof boot>>;

const base = `/tenants/${tenant}/projects`;
const annualReports = {
  id: 'arsrapporter',
  name: 'Årsrapporter 2024',
  dataset: 'digdir/kudos',
  filters: { type: ['Årsrapport'], concerned_years: ['2024'] },
};

const createProject = async (env: Env, body: Record<string, unknown> = {}) => {
  const res = await env.send('POST', base, 'kari', {
    name: 'Inkluderingsdugnaden',
    purpose: 'Hvordan rapporterer etatene på inkluderingsdugnaden?',
    selections: [annualReports],
    services: ['oppsummering'],
    ...body,
  });
  expect(res.status).toBe(201);
  return res.body;
};

const subscriptionPath = (project: string) => `${base}/${project}/subscriptions/arsrapporter`;

const subscribe = async (env: Env, project: string, body: Record<string, unknown>) => {
  const res = await env.send('PUT', subscriptionPath(project), 'kari', body);
  expect(res.status).toBe(200);
  return res.body;
};

const subscriptionOf = async (env: Env, project: string) => {
  const res = await env.send('GET', `${base}/${project}/subscriptions`);
  return (res.body.data as Record<string, unknown>[])[0] ?? {};
};

const runsOf = async (env: Env, project: string) =>
  (await env.send('GET', `${base}/${project}/runs`)).body.data as Record<string, unknown>[];

describe('projects', () => {
  it('creates, reads, updates and deletes a project, with every change versioned and audited', async () => {
    const env = await boot();

    const created = await createProject(env);
    expect(created).toMatchObject({
      id: 'inkluderingsdugnaden',
      version: 1,
      by: 'employee:test:kari',
      reason: 'Testendring i prosjektet',
      selections: [{ id: 'arsrapporter', dataset: 'digdir/kudos' }],
      services: ['oppsummering'],
    });
    const sources = await env.send('GET', `${base}/sources`);
    expect(sources.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'digdir/kudos', name: 'Kudos' })]),
    );
    const listed = await env.send('GET', base);
    expect(listed.body.data).toEqual([
      expect.objectContaining({ id: 'inkluderingsdugnaden', subscriptions: 0, runs: 0 }),
    ]);

    const updated = await env.send('PUT', `${base}/inkluderingsdugnaden`, 'kari', {
      name: 'Inkluderingsdugnaden 2024',
      purpose: 'Ny formulering',
      selections: [annualReports],
      services: ['oppsummering'],
      version: 1,
    });
    expect(updated.body).toMatchObject({ version: 2, name: 'Inkluderingsdugnaden 2024' });
    const stale = await env.send('PUT', `${base}/inkluderingsdugnaden`, 'kari', {
      name: 'Gammel',
      version: 1,
    });
    expect(stale.status).toBe(409);

    const documents = await env.send(
      'GET',
      `${base}/inkluderingsdugnaden/documents?selection=arsrapporter`,
    );
    expect(documents.body).toMatchObject({ found: 3, datasetName: 'Kudos' });

    const history = await env.send('GET', `${base}/inkluderingsdugnaden/history`);
    expect((history.body.data as { version: number }[]).map((h) => h.version)).toEqual([2, 1]);

    expect((await env.send('DELETE', `${base}/inkluderingsdugnaden`)).status).toBe(200);
    expect((await env.send('GET', `${base}/inkluderingsdugnaden`)).status).toBe(404);
    const log = await env.send('GET', `${base}/inkluderingsdugnaden/log`);
    expect(log.status).toBe(404);
  });

  it('keeps assessment points with who wrote them, in order and in the log', async () => {
    const env = await boot();
    const id = String((await createProject(env)).id);

    const first = await env.send('POST', `${base}/${id}/points`, 'kari', {
      text: 'Mål med tall regnes som nådd bare når årsrapporten oppgir resultatet.',
    });
    await env.send('POST', `${base}/${id}/points`, 'erik', {
      text: 'Digitalisering vurderes mot modenhetsmodellen.',
    });
    const empty = await env.send('POST', `${base}/${id}/points`, 'kari', { text: ' ' });
    const unexplained = await env.send(
      'POST',
      `${base}/${id}/points`,
      'kari',
      { text: 'Uten grunn' },
      null,
    );
    const outsider = await env.send('GET', `${base}/${id}/points`, 'ola');

    expect(first.status).toBe(201);
    expect(empty.status).toBe(400);
    expect(unexplained.status).toBe(400);
    expect(outsider.status).toBe(404);
    const points = await env.send('GET', `${base}/${id}/points`);
    expect(points.body.data).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('Mål med tall'),
        by: 'employee:test:kari',
      }),
      expect.objectContaining({
        text: expect.stringContaining('Digitalisering'),
        by: 'employee:test:erik',
      }),
    ]);
    const log = (await env.send('GET', `${base}/${id}/log`)).body.data as { kind: string }[];
    expect(log.filter((e) => e.kind === 'project-point')).toHaveLength(2);
  });

  it('refuses changes without a reason, unknown datasets and services that are not published', async () => {
    const env = await boot();

    const unexplained = await env.send(
      'POST',
      base,
      'kari',
      { name: 'Uten grunn', selections: [annualReports] },
      null,
    );
    expect(unexplained.status).toBe(400);
    const bad = await env.send('POST', base, 'kari', {
      name: 'Feil',
      selections: [{ ...annualReports, dataset: 'finnes/ikke' }],
      services: ['ukjent'],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'selections[0].dataset' }),
        expect.objectContaining({ path: 'services[0]' }),
      ]),
    );
  });

  it('keeps projects inside the tenant and asks for the right to run services', async () => {
    const env = await boot();
    const project = await createProject(env);
    const id = String(project.id);

    expect((await env.send('GET', `${base}/${id}`, 'ola')).status).toBe(404);
    expect((await env.send('GET', base, 'ola')).status).toBe(404);
    expect((await env.send('GET', `/tenants/${other}/projects`, 'ola')).body.data).toEqual([]);
    expect((await env.send('GET', `/tenants/${other}/projects/${id}`, 'ola')).status).toBe(404);

    const byErik = await env.send('POST', base, 'erik', {
      name: 'Eriks prosjekt',
      selections: [annualReports],
    });
    expect(byErik.status).toBe(201);
    const automatic = await env.send('PUT', subscriptionPath(id), 'erik', {
      mode: 'run',
      service: 'oppsummering',
      maxCostNok: 10,
    });
    expect(automatic.status).toBe(403);
    const notify = await env.send('PUT', subscriptionPath(id), 'erik', { mode: 'notify' });
    expect(notify.status).toBe(200);
  });

  it('lets an analyst with only the right to use services run, cancel and retry analyses', async () => {
    const env = await boot();
    const id = String((await createProject(env)).id);
    const selection = { service: 'oppsummering', selection: 'arsrapporter' };

    expect((await env.send('POST', `${base}/${id}/runs/estimate`, 'lise', selection)).status).toBe(
      403,
    );
    const estimate = await env.send('POST', `${base}/${id}/runs/estimate`, 'erik', selection);
    expect(estimate.status).toBe(201);
    const uncapped = await env.send('POST', `${base}/${id}/runs`, 'erik', {
      estimate: estimate.body.id,
      selection: 'arsrapporter',
    });
    expect(uncapped.status).toBe(400);
    expect(uncapped.body.errors).toEqual([expect.objectContaining({ path: 'maxCostNok' })]);
    env.state.modelDown = true;
    const started = await env.send('POST', `${base}/${id}/runs`, 'erik', {
      estimate: estimate.body.id,
      selection: 'arsrapporter',
      maxCostNok: 10,
    });
    expect(started.status).toBe(202);
    const run = String(started.body.id);

    expect((await env.send('POST', `${base}/${id}/runs/${run}/cancel`, 'lise')).status).toBe(403);
    const cancelled = await env.send('POST', `${base}/${id}/runs/${run}/cancel`, 'erik');
    expect(cancelled).toMatchObject({ status: 202, body: { id: run, cancelling: true } });
    await env.settled();
    env.state.modelDown = false;

    expect(
      (await env.send('POST', `${base}/${id}/runs/${run}/retry`, 'lise', { maxCostNok: 5 })).status,
    ).toBe(403);
    const uncappedRetry = await env.send('POST', `${base}/${id}/runs/${run}/retry`, 'erik', {});
    expect(uncappedRetry.status).toBe(400);
    const retried = await env.send('POST', `${base}/${id}/runs/${run}/retry`, 'erik', {
      maxCostNok: 5,
    });
    expect(retried.status).toBe(202);
    expect((await env.send('POST', `${base}/${id}/runs/ukjent/cancel`, 'erik')).status).toBe(404);
  });

  it('runs a linked service over the project documents as a batch run', async () => {
    const env = await boot();
    const project = await createProject(env);
    const id = String(project.id);

    const unlinked = await env.send('POST', `${base}/${id}/runs/estimate`, 'kari', {
      service: 'annen',
      selection: 'arsrapporter',
    });
    expect(unlinked.status).toBe(422);
    const estimate = await env.send('POST', `${base}/${id}/runs/estimate`, 'kari', {
      service: 'oppsummering',
      selection: 'arsrapporter',
    });
    expect(estimate.body).toMatchObject({ items: 3, selection: 'arsrapporter' });
    const started = await env.send('POST', `${base}/${id}/runs`, 'kari', {
      estimate: estimate.body.id,
      selection: 'arsrapporter',
      maxCostNok: 10,
    });
    expect(started.status).toBe(202);
    await env.settled();

    const runs = await runsOf(env, id);
    expect(runs).toEqual([
      expect.objectContaining({
        id: started.body.id,
        trigger: 'manual',
        selection: 'arsrapporter',
        status: 'succeeded',
        counts: expect.objectContaining({ succeeded: 3 }),
      }),
    ]);
    const detail = await env.send(
      'GET',
      `/tenants/${tenant}/services/oppsummering/batch-runs/${String(started.body.id)}`,
    );
    expect(detail.body.items).toHaveLength(3);
  });
});

describe('subscriptions to new documents', () => {
  it('requires a cost cap before the service may run on new documents', async () => {
    const env = await boot();
    const id = String((await createProject(env)).id);

    const uncapped = await env.send('PUT', subscriptionPath(id), 'kari', {
      mode: 'run',
      service: 'oppsummering',
    });
    expect(uncapped.status).toBe(400);
    expect(uncapped.body.errors).toEqual([expect.objectContaining({ path: 'maxCostNok' })]);
  });

  it('finds new documents by polling the dataset on a schedule and runs the service on them only', async () => {
    const env = await boot();
    const id = String((await createProject(env)).id);
    const subscribed = await subscribe(env, id, {
      mode: 'run',
      service: 'oppsummering',
      maxCostNok: 20,
    });
    expect(subscribed).toMatchObject({ status: 'active', known: 3, detection: 'poll' });

    env.world.time.fire();
    await env.settled();
    expect(env.state.modelCalls).toEqual([]);

    env.world.docs.push(report(5, 'NAV'));
    env.world.time.fire();
    await env.settled();

    expect(env.state.modelCalls).toEqual(['Årsrapport 2024 NAV']);
    const runs = await runsOf(env, id);
    expect(runs).toEqual([
      expect.objectContaining({ trigger: 'subscription', total: 1, status: 'succeeded' }),
    ]);
    const subscription = await subscriptionOf(env, id);
    expect(subscription).toMatchObject({
      known: 4,
      waiting: 0,
      fresh: [{ document: { id: 'd5' }, run: runs[0]?.id }],
    });
    expect((subscription.spentThisMonth as { costMicroNok: number }).costMicroNok).toBe(8000);

    env.world.time.fire();
    await env.settled();
    expect(env.state.modelCalls).toHaveLength(1);
  });

  it('shows the cost of project runs and subscriptions only with view-usage or to the person who started the run', async () => {
    const env = await boot();
    const id = String((await createProject(env)).id);
    await subscribe(env, id, { mode: 'run', service: 'oppsummering', maxCostNok: 20 });
    env.world.docs.push(report(5, 'NAV'));
    env.world.time.fire();
    await env.settled();
    const estimate = await env.send('POST', `${base}/${id}/runs/estimate`, 'erik', {
      service: 'oppsummering',
      selection: 'arsrapporter',
    });
    const own = await env.send('POST', `${base}/${id}/runs`, 'erik', {
      estimate: estimate.body.id,
      selection: 'arsrapporter',
      maxCostNok: 10,
    });
    await env.settled();

    const runsFor = async (who: string) =>
      (await env.send('GET', `${base}/${id}/runs`, who)).body.data as Record<string, unknown>[];
    const subscriptionFor = async (who: string) =>
      (
        (await env.send('GET', `${base}/${id}/subscriptions`, who)).body.data as Record<
          string,
          unknown
        >[]
      )[0];
    const analyst = await runsFor('erik');
    const usage = await runsFor('lise');

    expect(analyst.find((r) => r.trigger === 'subscription')).not.toHaveProperty('costMicroNok');
    expect(analyst.find((r) => r.id === own.body.id)).toHaveProperty('costMicroNok');
    expect(usage.every((r) => 'costMicroNok' in r)).toBe(true);
    expect(await subscriptionFor('erik')).not.toHaveProperty('spentThisMonth');
    expect(await subscriptionFor('lise')).toHaveProperty('spentThisMonth');
  });

  it('reacts when an ingestion into the dataset completes', async () => {
    const env = await boot();
    const id = String((await createProject(env)).id);
    await subscribe(env, id, { mode: 'notify' });

    const executed = await env.deps.ingestion.execute({
      pipeline: {
        dataset: 'digdir/kudos',
        id: 'kudos',
        version: 1,
        spec: pipelineSpec.parse({ name: 'Kudos', source: { kind: 'kudos' } }),
        by: 'test',
        at: '2026-10-08T09:00:00.000Z',
        reason: 'test',
      },
      target: { dataset: 'digdir/kudos', endpoint: 'kudos-typesense', collections: {} },
      by: 'test',
    });
    if (!executed.ok) throw new Error(JSON.stringify(executed.errors));
    await executed.done;
    await env.settled();

    const subscription = await subscriptionOf(env, id);
    expect(subscription).toMatchObject({
      mode: 'notify',
      fresh: [{ document: { id: 'd7', title: 'Årsrapport 2024 NAV' } }],
    });
    expect(env.state.modelCalls).toEqual([]);
    expect(await runsOf(env, id)).toEqual([]);
  });

  it('pauses the subscription and says why when the monthly cap would be exceeded', async () => {
    const env = await boot();
    const id = String((await createProject(env)).id);
    await subscribe(env, id, { mode: 'run', service: 'oppsummering', maxCostNok: 0.1 });

    env.world.docs.push(report(5, 'NAV'), report(6, 'SB'));
    const checked = await env.send('POST', `${subscriptionPath(id)}/check`);
    await env.settled();

    expect(checked.body).toMatchObject({ status: 'paused', arrived: 2, waiting: 2 });
    const subscription = await subscriptionOf(env, id);
    expect(subscription).toMatchObject({
      status: 'paused',
      waiting: 2,
      paused: {
        kind: 'cost-cap',
        reason: 'Månedsgrensen på 0,1 kr er nådd. 2 nye dokumenter venter.',
      },
      by: 'platform:subscription',
    });
    expect(env.state.modelCalls).toEqual([]);

    const raised = await subscribe(env, id, {
      mode: 'run',
      service: 'oppsummering',
      maxCostNok: 20,
    });
    expect(raised.status).toBe('active');
    await env.send('POST', `${subscriptionPath(id)}/check`);
    await env.settled();
    expect([...env.state.modelCalls].sort()).toEqual(['Årsrapport 2024 NAV', 'Årsrapport 2024 SB']);
  });

  it('can be paused and resumed by a person, with the reason recorded', async () => {
    const env = await boot();
    const id = String((await createProject(env)).id);
    await subscribe(env, id, { mode: 'run', service: 'oppsummering', maxCostNok: 20 });

    const paused = await env.send(
      'POST',
      `${subscriptionPath(id)}/pause`,
      'kari',
      {},
      'Venter på ny versjon',
    );
    expect(paused.body).toMatchObject({
      status: 'paused',
      paused: { kind: 'manual', reason: 'Venter på ny versjon' },
    });
    env.world.docs.push(report(5, 'NAV'));
    env.world.time.fire();
    await env.settled();
    expect(env.state.modelCalls).toEqual([]);

    await env.send('POST', `${subscriptionPath(id)}/resume`, 'kari', {}, 'Ny versjon er klar');
    await env.settled();
    expect(env.state.modelCalls).toEqual(['Årsrapport 2024 NAV']);
    const log = await env.send('GET', `${base}/${id}/log`);
    expect((log.body.data as { reason: string }[]).map((e) => e.reason)).toEqual(
      expect.arrayContaining(['Venter på ny versjon', 'Ny versjon er klar']),
    );
  });

  it('survives a restart without running documents twice, and picks up an interrupted claim', async () => {
    const world = shared();
    const first = await boot(world);
    const id = String((await createProject(first)).id);
    await subscribe(first, id, { mode: 'run', service: 'oppsummering', maxCostNok: 20 });
    world.docs.push(report(5, 'NAV'));
    first.world.time.fire();
    await first.settled();
    expect(first.state.modelCalls).toHaveLength(1);

    const second = await boot(world);
    world.time.fire();
    await second.settled();
    expect(second.state.modelCalls).toEqual([]);

    world.docs.push(report(6, 'SB'));
    const key = `${id}/arsrapporter`;
    const before = (await world.store.history(subscriptionStateKind, tenant, key)).at(-1);
    const state = before?.spec as SubscriptionState;
    await appendVersion<SubscriptionState>(world.store, {
      kind: subscriptionStateKind,
      scope: tenant,
      id: key,
      spec: {
        ...state,
        seen: [...state.seen, 'd6'],
        fresh: [
          ...state.fresh,
          {
            document: { id: 'd6', title: 'Årsrapport 2024 SB' },
            arrivedAt: world.time.now().toISOString(),
          },
        ],
        claim: { id: 'avbrutt', documents: ['d6'], at: world.time.now().toISOString() },
      },
      deleted: false,
      by: 'platform:subscription',
      reason: 'krasj midt i',
    });

    const busy = await second.send('POST', `${subscriptionPath(id)}/check`);
    expect(busy.body).toMatchObject({ status: 'busy' });

    world.time.advance(11 * 60_000);
    const third = await boot(world);
    const resumed = await third.send('POST', `${subscriptionPath(id)}/check`);
    await third.settled();
    expect(resumed.body).toMatchObject({ status: 'started' });
    expect(third.state.modelCalls).toEqual(['Årsrapport 2024 SB']);
    expect(await runsOf(third, id)).toHaveLength(2);
  });
});

describe('approving results from automatic runs', () => {
  const automaticRun = async (env: Env, id: string) => {
    await subscribe(env, id, { mode: 'run', service: 'oppsummering', maxCostNok: 20 });
    env.world.docs.push(report(5, 'NAV'));
    env.world.time.fire();
    await env.settled();
    const run = (await runsOf(env, id)).find((r) => r.trigger === 'subscription');
    return String(run?.id);
  };

  it('starts every subscription run as pending, lists pending runs first, and lets a user of services approve or reject with a reason', async () => {
    const env = await boot();
    const id = String((await createProject(env)).id);
    const auto = await automaticRun(env, id);
    const estimate = await env.send('POST', `${base}/${id}/runs/estimate`, 'kari', {
      service: 'oppsummering',
      selection: 'arsrapporter',
      sample: false,
    });
    const manual = await env.send('POST', `${base}/${id}/runs`, 'kari', {
      estimate: estimate.body.id,
      maxCostNok: 50,
    });
    await env.settled();

    const before = await runsOf(env, id);
    expect(before.map((r) => r.id)).toEqual([auto, manual.body.id]);
    expect(before[0]?.approval).toEqual({ status: 'pending' });
    expect(before[1]?.approval).toBeUndefined();

    const path = `${base}/${id}/runs/${auto}/review`;
    expect((await env.send('POST', path, 'lise', { decision: 'approved' })).status).toBe(403);
    expect((await env.send('POST', path, 'erik', { decision: 'kanskje' })).status).toBe(400);
    expect((await env.send('POST', path, 'erik', { decision: 'approved' }, null)).status).toBe(400);
    expect(
      (
        await env.send('POST', `${base}/${id}/runs/${String(manual.body.id)}/review`, 'erik', {
          decision: 'approved',
        })
      ).status,
    ).toBe(409);

    const rejected = await env.send(
      'POST',
      path,
      'erik',
      { decision: 'rejected' },
      'Sammendraget mangler tallene fra rapporten',
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({
      run: auto,
      status: 'rejected',
      reason: 'Sammendraget mangler tallene fra rapporten',
      by: expect.stringContaining('erik'),
    });
    const approved = await env.send(
      'POST',
      path,
      'erik',
      { decision: 'approved' },
      'Sjekket mot kilden',
    );
    expect(approved.body).toMatchObject({ status: 'approved' });

    const after = await runsOf(env, id);
    expect(after.find((r) => r.id === auto)?.approval).toMatchObject({
      status: 'approved',
      reason: 'Sjekket mot kilden',
    });
    const log = (await env.send('GET', `${base}/${id}/log`)).body.data as Record<string, unknown>[];
    expect(
      log.filter((e) => e.kind === 'project-run-review').map((e) => [e.version, e.reason]),
    ).toEqual(
      expect.arrayContaining([
        [1, 'Sammendraget mangler tallene fra rapporten'],
        [2, 'Sjekket mot kilden'],
      ]),
    );
  });

  it('marks the rows of an unapproved run in the CSV and JSON exports', async () => {
    const env = await boot();
    const id = String((await createProject(env)).id);
    const auto = await automaticRun(env, id);
    const exported = (format: string) =>
      env.send(
        'GET',
        `/tenants/${tenant}/services/oppsummering/batch-runs/${auto}/export?format=${format}`,
      );

    const csv = String((await exported('csv')).body)
      .replace(/^\uFEFF/, '')
      .split('\r\n');
    const json = (await exported('json')).body;

    expect(csv[0]?.endsWith(';Godkjenning')).toBe(true);
    expect(csv[1]?.endsWith(';Venter på godkjenning')).toBe(true);
    expect(json.run).toMatchObject({ approval: { status: 'pending' } });
    expect((json.items as Record<string, unknown>[])[0]).toMatchObject({ approved: false });

    await env.send('POST', `${base}/${id}/runs/${auto}/review`, 'erik', { decision: 'approved' });
    const approved = String((await exported('csv')).body).split('\r\n');
    expect(approved[1]?.endsWith(';Godkjent')).toBe(true);
  });
});
