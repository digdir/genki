import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';

const digdir = '991825827';
const principals: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  } as Principal,
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const completion = (content: string) => ({
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-test',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const boot = async (traces?: { content: boolean; residency?: 'norway' | 'eu' | 'global' }) => {
  const model = await fakeHttp(() => ({ status: 200, json: completion('Klart svar.') }));
  servers.push(model);
  const auth = { kind: 'api-key', secret: 'secret://env/model-key' } as const;
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: { test: { protocol: 'openai-chat', baseURL: `${model.url}/v1`, auth } },
        models: [
          {
            id: 'test/chat',
            endpoint: 'test',
            deployment: 'chat',
            residency: 'norway',
            capabilities: ['stream'],
          },
        ],
      },
      knowledge: {
        endpoints: {
          ka: {
            engine: 'typesense',
            baseURL: 'http://127.0.0.1:9',
            auth: { kind: 'api-key', secret: 'secret://env/model-key' },
            sharing: { tenants: '*' },
          },
        },
        datasets: [
          {
            id: 'digdir/veiledning',
            endpoint: 'ka',
            residency: 'norway',
            embedding: { model: 'test/embed', dimensions: 8 },
            options: {
              collections: { docs: 'd', chunks: 'c' },
              profiles: { content: { collection: 'chunks', queryBy: ['text'], textField: 'text' } },
            },
          },
          {
            id: 'digdir/kudos',
            endpoint: 'ka',
            residency: 'norway',
            options: {
              collections: { docs: 'd', chunks: 'c' },
              profiles: { content: { collection: 'chunks', queryBy: ['text'], textField: 'text' } },
            },
          },
        ],
      },
      rerank: { endpoints: {}, rerankers: [] },
      embeddings: {
        endpoints: {
          test: { protocol: 'openai-embeddings', baseURL: `${model.url}/v1`, auth },
        },
        models: [
          {
            id: 'test/embed',
            endpoint: 'test',
            deployment: 'embed',
            residency: 'global',
            dimensions: 8,
          },
        ],
      },
    },
    secrets: envSecrets({ MODEL_KEY: 'k' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
    ...(traces ? { traces: () => ({ endpoint: 'https://traces.example', ...traces }) } : {}),
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
    models: platform.models,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (
    path: string,
    init: { body?: unknown; as?: string; headers?: Record<string, string> } = {},
  ) =>
    app.request(path, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${init.as ?? 'kari'}`,
        'content-type': 'application/json',
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { platform, admin, call, app };
};

const service = (
  patch: { instructions?: string; residency?: string; datasets?: string[] } = {},
) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id: 'svar', name: 'Svar' },
  spec: {
    purpose: 'Svarer kort',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: {
      id: 'single-call',
      version: 1,
      config: { instructions: patch.instructions ?? 'Svar kort.' },
    },
    model: { primary: 'test/chat', residency: patch.residency ?? 'norway' },
    knowledge: { datasets: (patch.datasets ?? []).map((dataset) => ({ dataset })) },
    exposure: { openai: true, rest: true, mcp: true },
  },
});

const ask = { model: 'svar__default', messages: [{ role: 'user', content: 'Hei' }] };

describe('residency end to end', () => {
  it('refuses a Norway service whose dataset is embedded by a global model, naming both', async () => {
    const { platform } = await boot();
    const result = await platform.definitions.publish(
      service({ datasets: ['digdir/veiledning'] }),
      'test',
      'test',
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toEqual([
      {
        path: 'spec.knowledge.datasets[0].dataset',
        message:
          'Datasettet digdir/veiledning søkes med embeddingmodellen test/embed, som behandler data utenfor EU/EØS. Tjenesten krever at data behandles i Norge.',
      },
    ]);
    expect(
      (await platform.definitions.publish(service({ datasets: ['digdir/kudos'] }), 't', 't')).ok,
    ).toBe(true);
  });

  it('refuses a Norway service while content traces go to a global sink', async () => {
    const global = await boot({ content: true });
    const norwegian = await boot({ content: true, residency: 'norway' });

    expect((await global.platform.definitions.publish(service(), 't', 't')).ok).toBe(false);
    expect((await norwegian.platform.definitions.publish(service(), 't', 't')).ok).toBe(true);
  });

  it('shows the effective residency of a dataset as the widest of storage and embedding', async () => {
    const { call } = await boot();
    const list = (await (await call(`/tenants/${digdir}/datasets`)).json()) as {
      data: { fullId: string; residency: string; effectiveResidency: string }[];
    };

    expect(list.data.find((d) => d.fullId === 'digdir/veiledning')).toMatchObject({
      residency: 'norway',
      effectiveResidency: 'global',
      embeddingResidency: 'global',
    });
    expect(list.data.find((d) => d.fullId === 'digdir/kudos')?.effectiveResidency).toBe('norway');
  });
});

describe('model retirement', () => {
  it('pauses a service whose primary model is turned off, with 503 and a paused overview', async () => {
    const { platform, admin, call } = await boot();
    await platform.definitions.publish(service(), 'test', 'test');
    expect((await call('/v1/chat/completions', { body: ask })).status).toBe(200);

    const classified = await admin.classifyModel(
      principals.drift as Principal,
      'test/chat',
      { enabled: false },
      'Modellen er avviklet',
    );
    const refused = await call('/v1/chat/completions', { body: ask });
    const tool = await call('/api/tools/call/svar__default', { body: { query: 'Hei' } });
    const overview = (await (await call(`/tenants/${digdir}/overview`)).json()) as {
      services: { id: string; status: string; statusReason: string | null }[];
    };

    expect(classified.ok && classified.value.services).toEqual([
      expect.objectContaining({ id: 'svar', primary: true, status: 'paused' }),
    ]);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      error: { code: 'service_paused', message: 'Modellen tjenesten bruker er tatt ut av bruk' },
    });
    expect(tool.status).toBe(503);
    expect(overview.services).toEqual([
      expect.objectContaining({ id: 'svar', status: 'paused', statusReason: expect.any(String) }),
    ]);
  });

  it('marks a paused service in /v1/models with its status and reason', async () => {
    const { platform, admin, call } = await boot();
    await platform.definitions.publish(service(), 'test', 'test');
    const listed = async () =>
      ((await (await call('/v1/models')).json()) as { data: Record<string, unknown>[] }).data;
    expect((await listed()).every((m) => m.status === undefined)).toBe(true);

    await admin.classifyModel(
      principals.drift as Principal,
      'test/chat',
      { enabled: false },
      'Modellen er avviklet',
    );

    const entries = await listed();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries)
      expect(entry).toMatchObject({
        status: 'paused',
        status_reason: expect.stringContaining('Modellen tjenesten bruker er tatt ut av bruk'),
      });
  });

  it('warns when the primary model is reclassified outside the service residency', async () => {
    const { platform, admin, call } = await boot();
    await platform.definitions.publish(service(), 'test', 'test');
    await admin.classifyModel(
      principals.drift as Principal,
      'test/chat',
      { residency: 'global' },
      'x',
    );
    const overview = (await (await call(`/tenants/${digdir}/overview`)).json()) as {
      services: { status: string; warnings: { model: string; message: string }[] }[];
    };

    expect(overview.services[0]?.status).toBe('active');
    expect(overview.services[0]?.warnings).toEqual([
      expect.objectContaining({ model: 'test/chat' }),
    ]);
  });
});

describe('AI marking and version pinning end to end', () => {
  it('names the model that answered and the version that ran', async () => {
    const { platform, call } = await boot();
    await platform.definitions.publish(service(), 'test', 'test');
    const response = await call('/v1/chat/completions', { body: ask });

    expect(response.headers.get('genai-generated-by')).toBe('ai');
    expect(response.headers.get('genai-model')).toBe('test/chat');
    expect(response.headers.get('genai-service-version')).toBe('1');
    expect(await response.json()).toMatchObject({ ai_generated: true });
  });

  it('runs a pinned older version and records it on the task', async () => {
    const { platform, call } = await boot();
    await platform.definitions.publish(service({ instructions: 'Første.' }), 'test', 'test');
    await platform.definitions.publish(service({ instructions: 'Andre.' }), 'test', 'test');
    const pinned = await call('/v1/chat/completions', {
      body: ask,
      headers: { 'GenAI-Version': '1' },
    });
    const latest = await call('/api/tools/call/svar__default', { body: { query: 'Hei' } });
    const missing = await call('/v1/chat/completions', {
      body: ask,
      headers: { 'GenAI-Version': '7' },
    });
    const task = await platform.kernel.task(
      principals.kari as Principal,
      pinned.headers.get('genai-task') ?? '',
    );

    expect(pinned.status).toBe(200);
    expect(pinned.headers.get('genai-service-version')).toBe('1');
    expect(task.service.capability.version).toBe('1');
    expect(latest.headers.get('genai-service-version')).toBe('2');
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: { code: 'version_not_found' } });
  });

  it('pins the version with metadata.version on /v1 and records the model deployment on the task', async () => {
    const { platform, call } = await boot();
    await platform.definitions.publish(service({ instructions: 'Første.' }), 'test', 'test');
    await platform.definitions.publish(service({ instructions: 'Andre.' }), 'test', 'test');
    const pinned = await call('/v1/chat/completions', {
      body: { ...ask, metadata: { version: '1' } },
    });
    const disagreeing = await call('/v1/chat/completions', {
      body: { ...ask, metadata: { version: '1' } },
      headers: { 'GenAI-Version': '2' },
    });
    const task = await platform.kernel.task(
      principals.kari as Principal,
      pinned.headers.get('genai-task') ?? '',
    );

    expect(pinned.headers.get('genai-service-version')).toBe('1');
    expect(task.service.capability.version).toBe('1');
    expect(task.service.models).toEqual([
      { id: 'test/chat', endpoint: 'test', deployment: 'chat' },
    ]);
    expect(disagreeing.status).toBe(400);
    expect(await disagreeing.json()).toMatchObject({ error: { code: 'invalid_version' } });
  });
});

describe('pausing and archiving a service', () => {
  const lifecycle = (app: Hono, state: string, reason = 'Venter på ny modell fra leverandøren') =>
    app.request(`/tenants/${digdir}/services/svar/lifecycle`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer kari',
        'content-type': 'application/json',
        'change-reason': reason,
      },
      body: JSON.stringify({ state }),
    });

  it('refuses runs on every channel with the reason while paused, and runs again when resumed', async () => {
    const { platform, admin, call, app } = await boot();
    await platform.definitions.publish(service(), 'test', 'test');

    const paused = await lifecycle(app, 'paused');
    const refused = await call('/v1/chat/completions', { body: ask });
    const tool = await call('/api/tools/call/svar__default', { body: { query: 'Hei' } });
    const resumed = await lifecycle(app, 'active');

    expect(paused.status).toBe(200);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      error: {
        code: 'service_paused',
        message: 'Tjenesten er satt på pause. Begrunnelse: Venter på ny modell fra leverandøren',
      },
    });
    expect(tool.status).toBe(503);
    expect(resumed.status).toBe(200);
    expect((await call('/v1/chat/completions', { body: ask })).status).toBe(200);
    expect(await admin.audit(digdir)).toContainEqual(
      expect.objectContaining({ action: 'platform.service.lifecycle', outcome: 'applied' }),
    );
  });

  it('hides an archived service from the channels and the overview, keeps it in the list, and restores it', async () => {
    const { platform, call, app } = await boot();
    await platform.definitions.publish(service(), 'test', 'test');

    await lifecycle(app, 'archived');
    const refused = await call('/v1/chat/completions', { body: ask });
    const models = (await (await call('/v1/models')).json()) as { data: { id: string }[] };
    const overview = (await (await call(`/tenants/${digdir}/overview`)).json()) as {
      services: { id: string }[];
    };
    const listed = (await (await call(`/tenants/${digdir}/services`)).json()) as {
      data: { id: string; lifecycle: string }[];
    };
    const versions = await platform.definitions.versions('Service', digdir, 'svar');
    await lifecycle(app, 'active');

    expect(refused.status).toBe(404);
    expect(models.data.some((m) => m.id.startsWith('svar'))).toBe(false);
    expect(overview.services).toEqual([]);
    expect(listed.data).toEqual([expect.objectContaining({ id: 'svar', lifecycle: 'archived' })]);
    expect(versions).toHaveLength(1);
    expect((await call('/v1/chat/completions', { body: ask })).status).toBe(200);
  });

  it('lists a paused service in /v1/models as paused with the reason, and leaves an archived one out, which is what the workspace reads', async () => {
    const { platform, call, app } = await boot();
    await platform.definitions.publish(service(), 'test', 'test');
    const listed = async () =>
      (
        (await (await call('/v1/models')).json()) as { data: Record<string, unknown>[] }
      ).data.filter((m) => String(m.id).startsWith('svar'));

    await lifecycle(app, 'paused');
    const paused = await listed();
    await lifecycle(app, 'archived');
    const archived = await listed();

    expect(paused.length).toBeGreaterThan(0);
    for (const m of paused)
      expect(m).toMatchObject({
        status: 'paused',
        status_reason:
          'Tjenesten er satt på pause. Begrunnelse: Venter på ny modell fra leverandøren',
      });
    expect(archived).toEqual([]);
  });

  it('needs a change reason and the right to manage services', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(service(), 'test', 'test');

    expect((await lifecycle(app, 'paused', 'kort')).status).toBe(400);
    expect((await lifecycle(app, 'borte')).status).toBe(400);
    const otherTenant = await app.request(`/tenants/405003309/services/svar/lifecycle`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer kari',
        'content-type': 'application/json',
        'change-reason': 'Prøver en annen virksomhet',
      },
      body: JSON.stringify({ state: 'paused' }),
    });
    expect(otherTenant.status).toBe(404);
  });
});
