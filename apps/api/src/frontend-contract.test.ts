import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import {
  apiKeyDigest,
  createAuthenticator,
  InMemoryApiKeys,
  type StoredApiKey,
} from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { callerFrom, createPlatform } from './composition.js';
import { digdir, files, klarsprak } from './testkit.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const key = (id: string, extra: Partial<StoredApiKey> = {}): StoredApiKey => ({
  id,
  name: id,
  digest: apiKeyDigest(`gp_${id}`),
  tenant: digdir,
  scopes: ['query'],
  datasets: [],
  agents: [],
  ...extra,
});

const boot = async () => {
  const model = await fakeHttp(() => ({
    status: 200,
    json: {
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Enklere tekst.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  }));
  servers.push(model);
  const keys = new InMemoryApiKeys();
  keys.add(key('frontend', { service: 'klarsprak' }));
  keys.add(key('tenant', { agents: ['*'] }));
  const authenticator = createAuthenticator({ apiKeys: keys });
  const settings = new SettingsRegistry(platformSettings);
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: model.url,
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [{ id: 'fake/gpt', endpoint: 'fake', deployment: 'gpt', residency: 'norway' }],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    settings,
    prices: {},
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const found = await authenticator.authenticate(request);
      return found && callerFrom(found);
    },
  });
  const definition = klarsprak({ id: 'klarsprak' });
  await platform.definitions.publish(
    {
      ...definition,
      spec: { ...definition.spec, model: { primary: 'fake/gpt', residency: 'norway' } },
    },
    'test',
    'test',
    files,
  );
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    extensions: platform.extensions,
  });
  const app = createApp('test', {
    platform: {
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      admin,
      auth: { authenticate: async () => undefined },
      tenantGate: platform.tenantGate,
    },
  });
  platform.mount(app, admin);
  const publishForm = async (id: string, output: Record<string, unknown>) => {
    const form = klarsprak({ id });
    await platform.definitions.publish(
      {
        ...form,
        spec: {
          ...form.spec,
          model: { primary: 'fake/gpt', residency: 'norway' },
          input: {
            accepts: ['text/plain'],
            fields: [
              {
                id: 'ministry',
                label: 'Departement',
                kind: 'choice',
                required: true,
                options: ['KD'],
              },
            ],
          },
          output,
        },
      },
      'test',
      'test',
      files,
    );
  };
  await publishForm('skjema', { kind: 'answer' });
  await publishForm('resultat', {
    kind: 'fields',
    fields: [
      { name: 'summary', label: 'Oppsummering', type: 'string', description: 'Kort tekst' },
      { name: 'points', type: 'list', description: 'Punkter' },
    ],
  });
  const request = (
    path: string,
    user: string | undefined,
    body?: unknown,
    init: { method?: string; key?: string; headers?: Record<string, string> } = {},
  ) =>
    app.request(path, {
      method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.key === '' ? {} : { 'x-api-key': init.key ?? 'gp_frontend' }),
        'content-type': 'application/json',
        ...(user ? { 'x-user-id': user } : {}),
        ...init.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const send = (path: string, user: string | undefined, body?: unknown) =>
    request(path, user, body);
  const publish = (definition: Parameters<typeof platform.definitions.publish>[0]) =>
    platform.definitions.publish(definition, 'test', 'test', files);
  return { send, request, publish };
};

describe('frontend contract on a service key bound to a service', () => {
  it('keeps /v1 conversations per X-User-Id so each end user lists only their own', async () => {
    const { send } = await boot();
    const ask = (user: string, extra: Record<string, unknown>) =>
      send('/v1/chat/completions', user, {
        model: 'klarsprak__default',
        messages: [{ role: 'user', content: 'Skriv enklere.' }],
        ...extra,
      });

    const first = await ask('ola', { genai_conversation: true });
    const created = (await first.json()) as { conversation_id: string };
    const olas = (await (await send('/api/conversations', 'ola')).json()) as { total: number };
    const kari = (await (await send('/api/conversations', 'kari')).json()) as { total: number };
    const detail = (await (
      await send(`/api/conversations/${created.conversation_id}`, 'ola')
    ).json()) as {
      messages: { role: string }[];
    };
    const stolen = await ask('kari', { conversation_id: created.conversation_id });

    expect(first.status).toBe(200);
    expect([olas.total, kari.total]).toEqual([1, 0]);
    expect(detail.messages.map((m) => m.role).slice(-2)).toEqual(['user', 'assistant']);
    expect(stolen.status).toBe(404);
  });

  it('saves the run with each answer in a conversation, so a frontend can show its result again', async () => {
    const { send } = await boot();
    const asked = await send('/v1/chat/completions', 'ola', {
      model: 'klarsprak__default',
      messages: [{ role: 'user', content: 'Skriv enklere.' }],
      genai_conversation: true,
    });
    const { conversation_id: id } = (await asked.json()) as { conversation_id: string };
    const detail = (await (await send(`/api/conversations/${id}`, 'ola')).json()) as {
      messages: { role: string; task?: string }[];
    };

    expect(detail.messages.at(-1)).toMatchObject({
      role: 'assistant',
      task: asked.headers.get('genai-task'),
    });
    expect(detail.messages.at(-2)).not.toHaveProperty('task');
  });
});

describe('frontend contract for a form service on a tenant key', () => {
  const tenantKey = { key: 'gp_tenant' };

  it('lists a form service with _default true and a boolean _chat so a form frontend can find it', async () => {
    const { request } = await boot();

    const listed = (await (await request('/v1/models', 'ola', undefined, tenantKey)).json()) as {
      data: { id: string; _default?: boolean; _chat?: unknown; input_fields?: unknown[] }[];
    };
    const form = listed.data.find((m) => m.id === 'skjema__default');

    expect(form).toMatchObject({ _default: true, _chat: false });
    expect(form?.input_fields).toHaveLength(1);
    expect(listed.data.every((m) => typeof m._chat === 'boolean')).toBe(true);
  });

  it('serves the plain purpose as description on /v1/models, with no multi-turn sentence', async () => {
    const { request } = await boot();

    const listed = await (await request('/v1/models', 'ola', undefined, tenantKey)).text();

    expect(listed).not.toContain('Multi-turn');
    expect(listed).not.toContain('structuredContent');
  });

  it('accepts a form call with input and no messages, then stores the input and hides the system prompt', async () => {
    const { request } = await boot();

    const asked = await request(
      '/v1/chat/completions',
      'ola',
      { model: 'skjema__default', input: { ministry: 'KD' }, genai_conversation: true },
      tenantKey,
    );
    const { conversation_id: id } = (await asked.json()) as { conversation_id: string };
    const detail = (await (
      await request(`/api/conversations/${id}`, 'ola', undefined, tenantKey)
    ).json()) as { messages: { role: string | null; input?: unknown }[] };

    expect(asked.status).toBe(200);
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.messages[0]?.input).toEqual({ ministry: 'KD' });
  });

  it('labels fields output properties with the label of the service definition, else the key', async () => {
    const { request } = await boot();

    const schema = (await (
      await request('/v1/models/resultat__default/schema', 'ola', undefined, {
        ...tenantKey,
        headers: { 'accept-language': 'en' },
      })
    ).json()) as { output: { properties: Record<string, { 'x-label': string }> } };

    expect(schema.output.properties.summary?.['x-label']).toBe('Oppsummering');
    expect(schema.output.properties.points?.['x-label']).toBe('points');
  });

  it('refuses an unknown model on the schema route with the OpenAI error shape', async () => {
    const { request } = await boot();

    const missing = await request('/v1/models/nope/schema', 'ola', undefined, tenantKey);

    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'model_not_found' } });
  });

  it('answers invalid_filters when a service that searches no dataset gets filters', async () => {
    const { request } = await boot();

    const refused = await request(
      '/v1/chat/completions',
      undefined,
      {
        model: 'klarsprak__default',
        messages: [{ role: 'user', content: 'Skriv enklere.' }],
        filters: { fields: [{ field: 'year', 'selected-options': [2024] }] },
      },
      tenantKey,
    );

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: { code: 'invalid_filters' },
      errors: [{ path: 'filters' }],
    });
  });

  it('leaves no conversation behind when a request with genai_conversation fails validation', async () => {
    const { request } = await boot();

    const refused = await request(
      '/v1/chat/completions',
      undefined,
      { model: 'skjema__default', input: {}, genai_conversation: true },
      tenantKey,
    );
    const listed = (await (
      await request('/api/conversations', undefined, undefined, tenantKey)
    ).json()) as { total: number };

    expect(refused.status).toBe(400);
    expect(listed.total).toBe(0);
  });

  it('owns conversations by the tenant key itself when no end user is named, and ignores X-User-Id on it', async () => {
    const { request } = await boot();

    await request(
      '/v1/chat/completions',
      'ola',
      {
        model: 'klarsprak__default',
        messages: [{ role: 'user', content: 'Skriv enklere.' }],
        genai_conversation: true,
      },
      tenantKey,
    );
    const asKari = (await (
      await request('/api/conversations', 'kari', undefined, tenantKey)
    ).json()) as { total: number; conversations: { userId: string }[] };

    expect(asKari.total).toBe(1);
    expect(asKari.conversations[0]?.userId).not.toBe('ola');
  });

  it('takes feedback from the key that made the run, with no end-user id, and answers 201 with the task', async () => {
    const { request } = await boot();

    const asked = await request(
      '/v1/chat/completions',
      undefined,
      { model: 'klarsprak__default', messages: [{ role: 'user', content: 'Skriv enklere.' }] },
      tenantKey,
    );
    const task = asked.headers.get('genai-task');
    const rated = await request('/api/feedback', undefined, { task, rating: 'up' }, tenantKey);
    const stranger = await request('/api/feedback', 'ola', { task, rating: 'up' });

    expect(rated.status).toBe(201);
    expect(await rated.json()).toEqual({ ok: true, task });
    expect(stranger.status).toBe(403);
  });

  it('translates a variant title on /v1/models by Accept-Language when the definition gives both languages', async () => {
    const { request, publish } = await boot();
    const definition = klarsprak({ id: 'tolk' });
    await publish({
      ...definition,
      metadata: { ...definition.metadata, name: 'Tolk' },
      spec: {
        ...definition.spec,
        model: { primary: 'fake/gpt', residency: 'norway' },
        variants: ['default', { id: 'kort', title: { nb: 'Kort svar', en: 'Short answer' } }],
      },
    });
    const titleIn = async (language: string) =>
      (
        (await (
          await request('/v1/models', undefined, undefined, {
            ...tenantKey,
            headers: { 'accept-language': language },
          })
        ).json()) as { data: { id: string; title?: string }[] }
      ).data.find((m) => m.id === 'tolk__kort')?.title;

    expect(await titleIn('nb')).toBe('Tolk (Kort svar)');
    expect(await titleIn('en')).toBe('Tolk (Short answer)');
  });

  it('answers feedback without credentials as problem+json, like the rest of /api', async () => {
    const { request } = await boot();

    const refused = await request(
      '/api/feedback',
      undefined,
      { task: 't', rating: 'up' },
      { key: '' },
    );

    expect(refused.status).toBe(401);
    expect(refused.headers.get('content-type')).toContain('application/problem+json');
    expect(await refused.json()).toMatchObject({
      status: 401,
      title: 'Invalid or missing API key',
    });
  });
});

describe('openapi.json for a frontend', () => {
  const frontendOperations: [string, string][] = [
    ['get', '/v1/models'],
    ['post', '/v1/chat/completions'],
    ['get', '/v1/models/{id}/schema'],
    ['get', '/api/conversations'],
    ['post', '/api/conversations'],
    ['get', '/api/conversations/{id}'],
    ['put', '/api/conversations/{id}'],
    ['delete', '/api/conversations/{id}'],
    ['get', '/api/datasets'],
    ['get', '/api/datasets/{id}'],
    ['get', '/api/facets'],
    ['post', '/api/feedback'],
  ];

  it('describes every route the frontend contract names with real responses, not the placeholder', async () => {
    const { request } = await boot();
    const spec = (await (
      await request('/openapi.json', undefined, undefined, { key: '' })
    ).json()) as {
      paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
    };

    for (const [method, path] of frontendOperations) {
      const responses = spec.paths[path]?.[method]?.responses ?? {};
      expect(Object.keys(responses), `${method} ${path}`).not.toContain('default');
      expect(Object.keys(responses).length, `${method} ${path}`).toBeGreaterThan(0);
    }
  });

  it('gives the chat route a request body with model, messages and input, and a response with sources', async () => {
    const { request } = await boot();
    const text = await (await request('/openapi.json', undefined, undefined, { key: '' })).text();
    const spec = JSON.parse(text) as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };

    expect(spec.paths['/v1/chat/completions']?.post?.requestBody).toBeDefined();
    expect(Object.keys(spec.components.schemas.ChatRequest?.properties ?? {})).toEqual(
      expect.arrayContaining(['model', 'messages', 'input', 'conversation_id']),
    );
    expect(Object.keys(spec.components.schemas.ChatResponse?.properties ?? {})).toContain(
      'sources',
    );
    expect(Object.keys(spec.components.schemas.StoredMessage?.properties ?? {})).toEqual(
      expect.arrayContaining(['text', 'chunks', 'task', 'input']),
    );
  });

  it('gives the rename route a body that names title, topic and tags', async () => {
    const { request } = await boot();
    const spec = (await (
      await request('/openapi.json', undefined, undefined, { key: '' })
    ).json()) as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };

    expect(JSON.stringify(spec.paths['/api/conversations/{id}']?.put?.requestBody)).toMatch(
      /title.*topic.*tags/,
    );
  });
});
