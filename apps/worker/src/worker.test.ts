import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  createRuntime,
  mayUseModels,
  resolveCatalog,
  TenantSecretVault,
  type RuntimeInput,
} from '@genai/composition';
import { InMemoryDefinitionStore } from '@genai/definitions';
import {
  batchResultMime,
  monthlyModelQuota,
  systemPrincipal,
  type BatchResult,
  type TriggerRun,
} from '@genai/jobs';
import { envSecrets, InMemoryEventLog, InMemoryStateStore, InMemoryTaskStore } from '@genai/kernel';
import { InMemoryBlobStore, observable } from '@genai/port-blob';
import { fakeHttp, type FakeReply, type FakeServer } from '@genai/port-model/testing';
import { seedOnTypesense } from '@genai/composition/typesense-seed.test-utils';
import { createWorker, ownTenantOnly } from './worker.js';

const root = join(import.meta.dirname, '..', '..', '..');
const examples = join(root, 'packages', 'jobs', 'examples');
const configDir = join(root, 'apps', 'api', 'config', 'local');
const read = (file: string) => readFileSync(join(examples, file), 'utf8');
const config = (file: string) => parseYaml(readFileSync(join(configDir, file), 'utf8')) as unknown;
const tenant = '991825827';
const model = 'foundry-openai/gpt-4o-2m-tps';
const klarsprakFiles = { 'prompts/klarsprak.nb.md': read('prompts/klarsprak.nb.md') };

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const completion = (content: string, stream: boolean): FakeReply =>
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

const reply = (body: Record<string, unknown>): FakeReply => {
  if (!body.messages)
    return {
      status: 200,
      json: { data: [{ id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' }] },
    };
  const format = body.response_format as { json_schema?: { name?: string } } | undefined;
  const content =
    format?.json_schema?.name === 'classification'
      ? JSON.stringify({ label: 'klage', reason: 'Brukeren klager.' })
      : JSON.stringify({ text: 'Du får tilskudd.', changes: ['Kortere'] });
  return completion(content, Boolean(body.stream));
};

const classifyFlow = {
  apiVersion: 'genai/v1',
  kind: 'StepFlow',
  metadata: { tenant, id: 'sortering', name: 'Sortering' },
  spec: {
    purpose: 'Sorter innkommende post',
    steps: [
      {
        id: 'classify',
        block: 'classify@1',
        params: { labels: ['tilskudd', 'klage', 'innsyn'] },
      },
      { id: 'route', block: 'route@1', params: { queue: 'klager' } },
    ],
  },
};

const sortering = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'sortering', name: 'Sortering' },
  spec: {
    purpose: 'Sorter innkommende post etter tema',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'fields', fields: [{ name: 'queue', type: 'string', description: 'Køen' }] },
    strategy: { id: 'step-flow', version: 1, config: { flow: 'sortering@1' } },
    model: { primary: model, residency: 'global' },
    exposure: { rest: true },
    triggers: [{ kind: 'document-arrives', folder: 'sortering/innboks' }],
  },
};

const kunnskapsassistent = () => {
  const definition = parseYaml(
    readFileSync(
      join(root, 'packages', 'definitions', 'examples', 'kunnskapsassistenten.yaml'),
      'utf8',
    ),
  ) as { spec: Record<string, unknown> };
  const dropped = ['guardrails', 'tools', 'evaluation'];
  const spec = Object.fromEntries(
    Object.entries(definition.spec).filter(([key]) => !dropped.includes(key)),
  );
  return {
    ...definition,
    spec: {
      ...spec,
      model: { primary: model, residency: 'global' },
      triggers: [{ kind: 'document-arrives', folder: 'kunnskap/innboks' }],
    },
  };
};

const setup = async (
  active?: () => boolean,
  blocked?: Parameters<typeof createWorker>[0]['blocked'],
  lockdown = false,
  modelQuota?: RuntimeInput['modelQuota'],
  kudosOnTypesense = false,
) => {
  const upstream = await fakeHttp(reply);
  servers.push(upstream);
  const env = { FOUNDRY_OPENAI_BASE_URL: `${upstream.url}/v1` };
  const seed = config('knowledge.yaml');
  const knowledge = resolveCatalog(
    kudosOnTypesense ? seedOnTypesense(seed, upstream.url) : seed,
    'datasets',
    env,
  );
  const blob = observable(new InMemoryBlobStore());
  const tasks = new InMemoryTaskStore();
  const runtime = await createRuntime({
    platformTenant: tenant,
    catalogs: {
      models: resolveCatalog(config('models.yaml'), 'models', env).catalog,
      knowledge: knowledge.catalog,
      rerank: resolveCatalog(config('rerank.yaml'), 'rerankers', env).catalog,
    },
    secrets: envSecrets({
      FOUNDRY_OPENAI_KEY: 'm',
      ...(kudosOnTypesense ? { TYPESENSE_KEY: 't' } : {}),
    }),
    vault: new TenantSecretVault(),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: ownTenantOnly(),
    ...(lockdown ? { admitsModelUse: mayUseModels } : {}),
    ...(modelQuota ? { modelQuota } : {}),
    log: new InMemoryEventLog(),
    tasks,
    state: new InMemoryStateStore(),
    blobStore: blob,
  });
  const publish = async (
    definition: unknown,
    files: Record<string, string> = {},
    reason = 'test',
  ) => {
    const result = await runtime.store.publish(definition, 'test', reason, files);
    expect(result).toMatchObject({ ok: true });
  };
  await publish(parseYaml(read('klarsprak.yaml')), klarsprakFiles);
  const runs: TriggerRun[] = [];
  const worker = createWorker({
    runtime,
    onRun: (r) => runs.push(r),
    ...(active ? { active } : {}),
    ...(blocked ? { blocked } : {}),
    locked: lockdown,
  });
  return { worker, runtime, blob, runs, tasks, upstream, publish, knowledge };
};

const drop = (blob: ReturnType<typeof observable>, path: string, text: string) =>
  blob.put({ tenant, path }, new TextEncoder().encode(text), 'text/plain');

describe('worker', () => {
  it('the worker starts and seeds its catalog without Typesense or ColBERT settings', async () => {
    const { runtime, knowledge } = await setup();

    expect(knowledge.skipped).toEqual([]);
    expect(
      runtime.catalog
        .skipped()
        .filter((e) => e.kind === 'dataset' || e.kind === 'knowledge-endpoint'),
    ).toEqual([]);

    expect([...(runtime.plugins.rerankers ?? [])]).toEqual([]);
    const seed = config('models.yaml') as { models: { id: string; apis?: { rerank?: string } }[] };
    expect(seed.models.filter((m) => m.apis?.rerank !== undefined).map((m) => m.id)).toEqual([]);
    expect(runtime.plugins.models.size).toBeGreaterThan(0);
  });

  it('registers each service, a batch companion when batch is on, and its triggers', async () => {
    const { worker } = await setup();

    expect(await worker.sync()).toMatchObject({ capabilities: 2, triggers: 1, started: 1 });
    worker.stop();
  });

  it('binds a trigger published after start and drops it when the service has none', async () => {
    const { worker, blob, runs, publish } = await setup();
    const yaml = parseYaml(read('klarsprak.yaml'));
    await worker.sync();
    expect(await worker.sync()).toMatchObject({ started: 0, stopped: 0, kept: 1 });

    const without = { ...yaml, spec: { ...yaml.spec, triggers: [] } };
    await publish(without, klarsprakFiles, 'unpublish trigger');
    expect(await worker.sync()).toMatchObject({ triggers: 0, stopped: 1 });
    await drop(blob, 'klarsprak/innboks/a.txt', 'x');
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toHaveLength(0);
    worker.stop();
  });

  it('fires nothing while another worker holds the lease and takes over when it is free', async () => {
    let leader = false;
    const { worker, blob, runs } = await setup(() => leader);
    expect(await worker.sync()).toMatchObject({ active: false, started: 0 });
    leader = true;
    expect(await worker.sync()).toMatchObject({ active: true, started: 1 });
    leader = false;
    expect(await worker.sync()).toMatchObject({ active: false, stopped: 1 });
    await drop(blob, 'klarsprak/innboks/b.txt', 'x');
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toHaveLength(0);
    worker.stop();
  });

  it('refuses a document trigger of a paused service with the service problem code and does not call the model', async () => {
    const { worker, blob, runs, upstream } = await setup(undefined, async () => ({
      code: 'service_paused',
      error: 'Tjenesten er satt på pause. Begrunnelse: Venter på ny modell',
    }));
    await worker.sync();

    await drop(blob, 'klarsprak/innboks/vedtak.txt', 'Det vises til Deres søknad.');
    await vi.waitFor(() => expect(runs).toHaveLength(1));

    expect(runs[0]).toMatchObject({ outcome: 'failed', code: 'service_paused' });
    expect(upstream.seen.filter((r) => r.body.messages)).toEqual([]);
    worker.stop();
  });

  it('rewrites a letter as soon as it lands in the service folder', async () => {
    const { worker, blob, runs, upstream } = await setup();
    await worker.sync();

    await drop(blob, 'klarsprak/innboks/vedtak.txt', 'Det vises til Deres søknad om tilskudd.');
    await vi.waitFor(() => expect(runs).toHaveLength(1));

    expect(runs[0]).toMatchObject({ outcome: 'completed', binding: { service: 'klarsprak' } });
    const chat = upstream.seen.filter((r) => r.body.messages);
    expect(JSON.stringify(chat.at(-1)?.body.messages)).toContain(
      'Det vises til Deres søknad om tilskudd.',
    );
    worker.stop();
  });

  it('runs the batch companion over a folder as the agency system user', async () => {
    const { worker, blob } = await setup();
    await worker.sync();
    for (const name of ['a', 'b']) await drop(blob, `klarsprak/arkiv/${name}.txt`, `Brev ${name}`);

    const run = await worker.kernel.invoke(
      systemPrincipal()(tenant),
      `${tenant}/klarsprak/default.batch`,
      {
        data: { folder: 'arkiv', batchId: 'arkiv-1' },
      },
    );
    const parts = await run.result;
    const result = parts.find((p) => p.mime === batchResultMime);

    expect(result?.body.kind === 'json' && (result.body.json as BatchResult)).toMatchObject({
      succeeded: 2,
      failed: 0,
    });
    expect(await blob.head({ tenant, path: 'klarsprak/results/arkiv-1.json' })).toBeDefined();
    worker.stop();
  });

  it('the worker skips its triggers in lockdown and says so', async () => {
    const { worker, blob, runs, upstream } = await setup(undefined, undefined, true);

    expect(await worker.sync()).toMatchObject({ locked: true, active: false, started: 0 });
    await drop(blob, 'klarsprak/innboks/vedtak.txt', 'Det vises til Deres søknad.');
    await new Promise((r) => setTimeout(r, 20));

    expect(runs).toHaveLength(0);
    expect(upstream.seen.filter((r) => r.body.messages)).toEqual([]);
    worker.stop();
  });

  it('the worker refuses a trigger that runs a service in lockdown', async () => {
    const { worker, upstream } = await setup(undefined, undefined, true);
    await worker.sync();

    const run = await worker.kernel.invoke(
      systemPrincipal()(tenant),
      `${tenant}/klarsprak/default`,
      {
        parts: [
          { mime: 'text/plain', body: { kind: 'text', text: 'Det vises til Deres søknad.' } },
        ],
      },
    );

    await expect(run.result).rejects.toThrow(/may not use models/);
    expect(upstream.seen.filter((r) => r.body.messages)).toEqual([]);
    worker.stop();
  });

  it('refuses callers that are not the worker system user', async () => {
    const { worker } = await setup();
    await worker.sync();

    await expect(
      worker.kernel.invoke(
        { kind: 'employee', issuer: 'x', subject: 'kari', tenant },
        `${tenant}/klarsprak/default`,
        {},
      ),
    ).rejects.toThrow(/agency system user/);
    worker.stop();
  });

  it('runs a step-flow service when a document lands in its folder, with the same cost limits as the API', async () => {
    const { worker, runtime, blob, runs, upstream, publish } = await setup();
    await publish(classifyFlow);
    await publish(sortering);
    await worker.sync();
    expect(runtime.quarantined()).toEqual([]);

    await drop(blob, 'sortering/innboks/brev.txt', 'Jeg klager på vedtaket.');
    await vi.waitFor(() => expect(runs).toHaveLength(1));

    expect(runs[0]).toMatchObject({ outcome: 'completed', binding: { service: 'sortering' } });
    expect(
      upstream.seen.some((r) =>
        JSON.stringify(r.body.messages ?? '').includes('Jeg klager på vedtaket.'),
      ),
    ).toBe(true);
    const registered = runtime.registry
      .all()
      .find((c) => c.descriptor.id === `${tenant}/sortering/default`);
    expect(registered?.budget).toEqual({ inputTokens: 2_000_000 });
    expect(registered?.deadlineMs).toBe(300_000);
    worker.stop();
  });

  it('refuses the next model call of a run once its tenant crosses the monthly token quota mid-run', async () => {
    const held: { upstream?: FakeServer } = {};
    const modelCalls = () => held.upstream?.seen.filter((r) => r.body.messages).length ?? 0;
    const { worker, blob, runs, upstream, publish } = await setup(
      undefined,
      undefined,
      false,
      monthlyModelQuota({
        monthlyTokens: () => 15,
        usedTokens: async () => modelCalls() * 15,
        now: () => new Date(Date.parse('2026-11-16T10:00:00Z') + modelCalls() * 60_000),
      }),
    );
    held.upstream = upstream;
    await publish({
      ...classifyFlow,
      spec: {
        ...classifyFlow.spec,
        steps: [
          { id: 'first', block: 'classify@1', params: { labels: ['tilskudd', 'klage'] } },
          { id: 'second', block: 'classify@1', params: { labels: ['tilskudd', 'klage'] } },
        ],
      },
    });
    await publish(sortering);
    await worker.sync();

    await drop(blob, 'sortering/innboks/brev.txt', 'Jeg klager på vedtaket.');
    await vi.waitFor(() => expect(runs).toHaveLength(1));

    expect(runs[0]).toMatchObject({
      outcome: 'failed',
      error: expect.stringMatching(/monthly token quota/),
    });
    expect(modelCalls()).toBe(1);
    worker.stop();
  });

  it('runs an agent-loop service with its datasets and reranker instead of skipping it, metering usage on the task', async () => {
    const { worker, runtime, blob, runs, tasks, publish } = await setup(
      undefined,
      undefined,
      false,
      undefined,
      true,
    );
    await publish(kunnskapsassistent(), {
      'prompts/ka-system.nb.md': readFileSync(
        join(root, 'packages', 'definitions', 'examples', 'prompts', 'ka-system.nb.md'),
        'utf8',
      ),
    });

    expect(await worker.sync()).toMatchObject({ triggers: 2 });
    expect(runtime.quarantined()).toEqual([]);
    expect(runtime.registry.all().map((c) => c.descriptor.id)).toContain(
      `${tenant}/kunnskapsassistenten/default`,
    );

    await drop(blob, 'kunnskap/innboks/spm.txt', 'Hva sier tildelingsbrevet?');
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toMatchObject({
      outcome: 'completed',
      binding: { service: 'kunnskapsassistenten' },
    });
    const stored = await tasks.get(runs[0]?.task ?? '');
    expect(stored?.task.usage.inputTokens).toBeGreaterThan(0);
    worker.stop();
  });

  it('gives a triggered service the published skills it references', async () => {
    const { worker, runtime, publish } = await setup();
    await publish({
      apiVersion: 'genai/v1',
      kind: 'Skill',
      metadata: { tenant, id: 'klarsprak-skill', name: 'Klarspråk' },
      spec: {
        description: 'Skriv om tekst til klarspråk.',
        instructions: 'Bruk korte setninger.',
        examples: [],
        tools: [],
        attachments: [],
      },
    });
    const yaml = parseYaml(read('klarsprak.yaml'));
    await publish(
      { ...yaml, spec: { ...yaml.spec, skills: ['klarsprak-skill@1'] } },
      klarsprakFiles,
    );
    await worker.sync();

    const registered = runtime.registry
      .all()
      .find((c) => c.descriptor.id === `${tenant}/klarsprak/default`);
    expect((registered?.config as { skills?: { name: string }[] }).skills).toMatchObject([
      { name: 'klarsprak-skill', instructions: 'Bruk korte setninger.' },
    ]);
    worker.stop();
  });
});
