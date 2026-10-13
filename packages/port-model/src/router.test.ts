import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { textPart, type Principal } from '@genai/contracts';
import { createKernel, envSecrets } from '@genai/kernel';
import {
  ModelError,
  ModelRouter,
  parseCatalog,
  parseCatalogYaml,
  type ChatRequest,
  type ChatResult,
  type Credential,
  type DeploymentConfig,
  type ModelAdapter,
  type ModelPort,
} from './index.js';
import { testContext } from './testing.js';

const answer = (content: string): ChatResult => ({
  content,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 3, outputTokens: 2, requests: 1 },
  servedModel: 'served',
});

const recording = (protocol: string, behave?: (request: ChatRequest) => Promise<ChatResult>) => {
  const calls: {
    baseURL: string;
    credential: Credential;
    model: DeploymentConfig;
    request: ChatRequest;
  }[] = [];
  const adapter: ModelAdapter<{ region: string }, { flavour: string }> = {
    protocol,
    endpointOptions: z.strictObject({ region: z.string().default('west') }),
    modelOptions: z.strictObject({ flavour: z.string().default('plain') }),
    connect: (endpoint) => ({
      chat: async (model, request) => {
        calls.push({ baseURL: endpoint.baseURL, credential: endpoint.credential, model, request });
        return behave ? behave(request) : answer(`${protocol}:${model.deployment}`);
      },
      chatStream: async function* (model, request) {
        calls.push({ baseURL: endpoint.baseURL, credential: endpoint.credential, model, request });
        yield { kind: 'delta', text: 'del' };
        yield { kind: 'done', result: answer('del') };
      },
    }),
  };
  return { adapter, calls };
};

const catalog = {
  endpoints: {
    one: {
      protocol: 'proto-a',
      baseURL: 'https://a.example/v1',
      auth: { kind: 'api-key', secret: 'secret://env/key-a' },
    },
    two: {
      protocol: 'proto-b',
      baseURL: 'https://b.example',
      auth: { kind: 'token-provider', provider: 'entra' },
    },
  },
  models: [
    {
      id: 'a/small',
      endpoint: 'one',
      deployment: 'small-dep',
      residency: 'norway',
      capabilities: ['stream'],
    },
    {
      id: 'b/large',
      endpoint: 'two',
      deployment: 'large-dep',
      residency: 'global',
      capabilities: ['tools'],
      options: { flavour: 'spicy' },
    },
  ],
};

const setup = () => {
  const a = recording('proto-a');
  const b = recording('proto-b');
  const router = new ModelRouter({
    catalog,
    adapters: [a.adapter, b.adapter],
    secrets: envSecrets({ KEY_A: 'key-from-env' }),
    tokenProviders: { entra: async () => 'entra-token' },
  });
  return { router, a, b };
};

const open = (router: ModelRouter, id: string, ctx = testContext().ctx): ModelPort =>
  router.open({ kind: 'model', id }, ctx);

describe('model catalog', () => {
  it('accepts the example catalog', () => {
    const permissive = (protocol: string): ModelAdapter => ({
      protocol,
      endpointOptions: z.record(z.string(), z.unknown()),
      modelOptions: z.record(z.string(), z.unknown()),
      connect: () => {
        throw new Error('not used');
      },
    });
    const text = readFileSync(join(import.meta.dirname, '..', 'examples', 'models.yaml'), 'utf8');

    expect(
      parseCatalogYaml(text, [permissive('openai-chat'), permissive('anthropic-messages')]).ok,
    ).toBe(true);
  });

  it('refuses a protocol without an adapter, adapter options it does not know, and a literal key', () => {
    const result = parseCatalog(
      {
        endpoints: {
          one: {
            protocol: 'proto-a',
            baseURL: 'https://a.example',
            auth: { kind: 'bearer', secret: 'sk-live-123' },
            options: { colour: 'red' },
          },
          two: {
            protocol: 'proto-x',
            baseURL: 'https://x.example',
            auth: { kind: 'bearer', secret: 'secret://vault/x' },
          },
        },
        models: [],
      },
      [recording('proto-a').adapter],
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map((e) => e.path)).toEqual(['endpoints.one.auth.secret']);

    const second = parseCatalog(
      {
        ...catalog,
        endpoints: {
          ...catalog.endpoints,
          one: { ...catalog.endpoints.one, options: { colour: 'red' } },
        },
      },
      [recording('proto-a').adapter],
    );
    expect(!second.ok && second.errors.map((e) => e.path)).toEqual([
      'endpoints.one.options',
      'endpoints.two.protocol',
    ]);
  });

  it('refuses a model on an unknown endpoint and the same model id twice', () => {
    const result = parseCatalog(
      { ...catalog, models: [...catalog.models, { ...catalog.models[0], endpoint: 'nowhere' }] },
      [recording('proto-a').adapter, recording('proto-b').adapter],
    );

    expect(!result.ok && result.errors.map((e) => e.message)).toEqual([
      'duplicate model a/small',
      'unknown endpoint nowhere',
    ]);
  });

  it('refuses to start with a token provider nobody registered', () => {
    expect(
      () =>
        new ModelRouter({
          catalog,
          adapters: [recording('proto-a').adapter, recording('proto-b').adapter],
          secrets: envSecrets({}),
        }),
    ).toThrow(/unknown token provider entra/);
  });
});

describe('model router', () => {
  it('routes each model to the adapter for its protocol with parsed options', async () => {
    const { router, a, b } = setup();

    expect((await open(router, 'a/small').chat({ messages: [] })).content).toBe(
      'proto-a:small-dep',
    );
    expect((await open(router, 'b/large').chat({ messages: [] })).content).toBe(
      'proto-b:large-dep',
    );
    expect(a.calls[0]?.model).toEqual({ deployment: 'small-dep', options: { flavour: 'plain' } });
    expect(b.calls[0]?.model.options).toEqual({ flavour: 'spicy' });
  });

  it('hands adapters credentials that resolve secrets and tokens when called', async () => {
    const { router, a, b } = setup();
    await open(router, 'a/small').chat({ messages: [] });
    await open(router, 'b/large').chat({ messages: [] });

    const keyed = a.calls[0]?.credential;
    const tokened = b.calls[0]?.credential;
    expect(keyed?.kind === 'api-key' && (await keyed.key())).toBe('key-from-env');
    expect(tokened?.kind === 'bearer' && (await tokened.token())).toBe('entra-token');
  });

  it('refuses a request the model cannot serve before calling the provider', async () => {
    const { router, a } = setup();
    const small = open(router, 'a/small');
    const tools = { name: 't', description: 'd', parameters: {} };

    await expect(small.chat({ messages: [], tools: [tools] })).rejects.toThrow(
      /does not support tools/,
    );
    await expect(small.chat({ messages: [], reasoning: 'high' })).rejects.toThrow(
      /does not support reasoning/,
    );
    await expect(
      open(router, 'b/large').chatStream({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toThrow(/does not support stream/);
    expect(a.calls).toHaveLength(0);
  });

  it('refuses an unknown model and a model outside the allowed residency', () => {
    const a = recording('proto-a');
    const b = recording('proto-b');
    const norwayOnly = new ModelRouter({
      catalog,
      adapters: [a.adapter, b.adapter],
      secrets: envSecrets({}),
      tokenProviders: { entra: async () => 't' },
      maxResidency: 'norway',
    });

    expect(() => open(norwayOnly, 'c/none')).toThrow(ModelError);
    expect(() => open(norwayOnly, 'b/large')).toThrow(/outside norway/);
    expect(open(norwayOnly, 'a/small').info()).toEqual({
      id: 'a/small',
      residency: 'norway',
      capabilities: ['stream'],
    });
  });

  it('meters a call and a finished stream once each', async () => {
    const { router } = setup();
    const { ctx, metered } = testContext();
    const port = open(router, 'a/small', ctx);

    await port.chat({ messages: [] });
    const chunks = [];
    for await (const c of port.chatStream({ messages: [] })) chunks.push(c.kind);

    expect(chunks).toEqual(['delta', 'done']);
    expect(metered).toEqual([
      {
        usage: { inputTokens: 3, outputTokens: 2, requests: 1 },
        model: { kind: 'model', id: 'a/small' },
      },
      {
        usage: { inputTokens: 3, outputTokens: 2, requests: 1 },
        model: { kind: 'model', id: 'a/small' },
      },
    ]);
  });

  it('reports a provider crash as unavailable, a cancelled task as cancelled, and lets a metering refusal through', async () => {
    const crashing = recording('proto-a', async () => {
      throw new TypeError('socket hang up');
    });
    const router = new ModelRouter({
      catalog: { endpoints: { one: catalog.endpoints.one }, models: [catalog.models[0]] },
      adapters: [crashing.adapter],
      secrets: envSecrets({}),
    });
    const controller = new AbortController();
    controller.abort();
    const refusing = testContext();
    refusing.ctx.meter = async () => {
      throw new Error('budget exceeded');
    };
    const fine = setup().router;

    await expect(open(router, 'a/small').chat({ messages: [] })).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(
      open(router, 'a/small', testContext(controller.signal).ctx).chat({ messages: [] }),
    ).rejects.toMatchObject({
      code: 'cancelled',
    });
    await expect(open(fine, 'a/small', refusing.ctx).chat({ messages: [] })).rejects.toThrow(
      'budget exceeded',
    );
  });

  it('lists the catalog for publish-time checks', () => {
    expect(setup().router.models()).toEqual(
      new Map([
        ['a/small', { residency: 'norway', capabilities: ['stream'] }],
        ['b/large', { residency: 'global', capabilities: ['tools'] }],
      ]),
    );
  });

  it('charges model usage to the task and records the deployment that served it', async () => {
    const { router } = setup();
    const kari: Principal = {
      kind: 'employee',
      issuer: 'test',
      subject: 'kari',
      tenant: '999888777',
    };
    const model = { kind: 'model', id: 'a/small', tenant: '999888777' };
    const kernel = createKernel({
      strategies: [
        {
          id: 'ask',
          version: '1',
          requires: { kernel: 1, ports: ['model'], features: [] },
          run: async function* (ctx) {
            const port = await ctx.use<ModelPort>('model', model);
            const result = await port.chat({ messages: [{ role: 'user', content: 'hei' }] });
            yield { type: 'kernel.result', data: [textPart(result.content)] };
          },
        },
      ],
      capabilities: [
        {
          descriptor: {
            id: 'ask',
            version: '1',
            tenant: '999888777',
            title: 'ask',
            description: 'ask',
            input: {},
            interaction: ['unary'],
            accepts: [],
            produces: [],
            emits: [],
            oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: 'KI' },
          },
          strategy: { id: 'ask', version: '1' },
          config: {},
          grants: [{ port: 'model', ref: model }],
        },
      ],
      ports: { model: router },
      policy: { decide: async () => ({ allow: true }) },
    });

    const run = await kernel.invoke(kari, 'ask', {});

    expect(await run.result).toEqual([textPart('proto-a:small-dep')]);
    expect((await kernel.task(kari, run.task)).usage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      requests: 1,
    });
    expect((await kernel.task(kari, run.task)).service.models).toEqual([
      { id: 'a/small', endpoint: 'one', deployment: 'small-dep' },
    ]);
  });

  it('caps each request at the output tokens the invocation has left', async () => {
    const { router, a } = setup();
    const kari: Principal = {
      kind: 'employee',
      issuer: 'test',
      subject: 'kari',
      tenant: '999888777',
    };
    const model = { kind: 'model', id: 'a/small', tenant: '999888777' };
    const kernel = createKernel({
      strategies: [
        {
          id: 'twice',
          version: '1',
          requires: { kernel: 1, ports: ['model'], features: [] },
          run: async function* (ctx) {
            const port = await ctx.use<ModelPort>('model', model);
            await port.chat({ messages: [], maxTokens: 4000 });
            await port.chat({ messages: [], maxTokens: 100 });
            yield { type: 'kernel.result', data: [] };
          },
        },
      ],
      capabilities: [
        {
          descriptor: {
            id: 'twice',
            version: '1',
            tenant: '999888777',
            title: 'twice',
            description: 'twice',
            input: {},
            interaction: ['unary'],
            accepts: [],
            produces: [],
            emits: [],
            oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: 'KI' },
          },
          strategy: { id: 'twice', version: '1' },
          config: {},
          grants: [{ port: 'model', ref: model }],
        },
      ],
      ports: { model: router },
      policy: { decide: async () => ({ allow: true }) },
    });

    const capped = await kernel.invoke(kari, 'twice', {}, { maxOutputTokens: 300 });
    await capped.result;
    const budgeted = await kernel.invoke(kari, 'twice', {}, { budget: { outputTokens: 50 } });
    await budgeted.result;

    expect(a.calls.map((c) => c.request.maxTokens)).toEqual([300, 100, 50, 48]);
  });
});

describe('model discovery', () => {
  const listing = (deployments: { deployment: string; model?: string }[], fail = false) => ({
    kind: 'stub-listing',
    calls: 0,
    async list() {
      this.calls += 1;
      if (fail) throw new Error('listing is down');
      return deployments;
    },
  });

  const discoveringCatalog = {
    endpoints: {
      one: {
        protocol: 'proto-a',
        baseURL: 'https://a.example/v1',
        auth: { kind: 'api-key', secret: 'secret://env/key-a' },
        discovery: {
          source: 'stub-listing',
          exclude: ['claude-*', 'text-embedding-*'],
          capabilities: ['stream', 'tools'],
        },
      },
      two: {
        protocol: 'proto-b',
        baseURL: 'https://b.example',
        auth: { kind: 'api-key', secret: 'secret://env/key-a' },
        discovery: {
          source: 'stub-listing',
          from: 'one',
          include: ['claude-*'],
          capabilities: ['stream', 'reasoning'],
        },
      },
    },
    models: [
      {
        id: 'a/pinned',
        endpoint: 'one',
        deployment: 'gpt-4o-prod',
        residency: 'norway',
        capabilities: ['stream'],
      },
    ],
  };

  const saved: Record<string, unknown> = {};
  const setup = (
    source = listing([
      { deployment: 'gpt-4o-prod', model: 'gpt-4o' },
      { deployment: 'gpt-5-mini', model: 'gpt-5-mini' },
      { deployment: 'claude-sonnet-5-5', model: 'claude-sonnet-5-5' },
      { deployment: 'text-embedding-3-small' },
    ]),
  ) => {
    const a = recording('proto-a');
    const b = recording('proto-b');
    const router = new ModelRouter({
      catalog: discoveringCatalog,
      adapters: [a.adapter, b.adapter],
      secrets: envSecrets({ KEY_A: 'k' }),
      sources: [source],
      classifications: {
        load: async () => structuredClone(saved) as Record<string, never>,
        save: async (id, c) => {
          saved[id] = c;
        },
      },
    });
    return { router, source, a, b };
  };

  it('finds deployments per endpoint, routes them by pattern, keeps catalog entries, and lists once per resource', async () => {
    const { router, source } = setup();

    expect(await router.refresh()).toEqual({ discovered: 2, failed: [] });
    expect(
      router.describe().map((m) => [m.id, m.origin, m.residency, m.capabilities, m.family]),
    ).toEqual([
      ['a/pinned', 'catalog', 'norway', ['stream'], undefined],
      ['one/gpt-5-mini', 'discovered', 'global', ['stream', 'tools'], 'gpt-5-mini'],
      [
        'two/claude-sonnet-5-5',
        'discovered',
        'global',
        ['stream', 'reasoning'],
        'claude-sonnet-5-5',
      ],
    ]);
    expect(source.calls).toBe(1);
  });

  it('routes a discovered model to its endpoint with the deployment name', async () => {
    const { router, b } = setup();
    await router.refresh();

    await open(router, 'two/claude-sonnet-5-5').chat({ messages: [] });

    expect(b.calls[0]?.model.deployment).toBe('claude-sonnet-5-5');
  });

  it('lets an operator classify a model, keeps it across refreshes, and updates the live map publish checks use', async () => {
    const { router } = setup();
    await router.refresh();
    const live = router.models();

    await router.classify('one/gpt-5-mini', {
      residency: 'eu',
      capabilities: ['stream', 'tools', 'json-schema'],
    });
    expect(live.get('one/gpt-5-mini')).toEqual({
      residency: 'eu',
      capabilities: ['stream', 'tools', 'json-schema'],
    });

    const again = setup().router;
    await again.refresh();
    expect(again.describe().find((m) => m.id === 'one/gpt-5-mini')).toMatchObject({
      residency: 'eu',
      classified: true,
    });
  });

  it('turns a model off for new calls and for publishing', async () => {
    const { router } = setup();
    await router.refresh();

    await router.classify('two/claude-sonnet-5-5', { enabled: false });

    expect(router.models().has('two/claude-sonnet-5-5')).toBe(false);
    expect(() => open(router, 'two/claude-sonnet-5-5')).toThrow(/turned off/);
    await router.classify('two/claude-sonnet-5-5', { enabled: true });
  });

  it('reports a failing listing without losing the catalog models', async () => {
    const { router } = setup(listing([], true));

    const result = await router.refresh();

    expect(result.failed.map((f) => f.endpoint)).toEqual(['one', 'two']);
    expect([...router.models().keys()]).toEqual(['a/pinned']);
  });

  it('refuses a discovery source nobody registered and a listing endpoint that does not exist', () => {
    const result = parseCatalog(
      {
        endpoints: {
          one: {
            ...discoveringCatalog.endpoints.one,
            discovery: { source: 'nope', from: 'ghost' },
          },
        },
      },
      [recording('proto-a').adapter],
      ['stub-listing'],
    );
    expect(!result.ok && result.errors.map((e) => e.path)).toEqual([
      'endpoints.one.discovery.source',
      'endpoints.one.discovery.from',
    ]);
  });
});

describe('reloading the catalog', () => {
  it('swaps in a new catalog atomically and keeps a tenant model to its tenant', async () => {
    const { router } = setup();
    const tenantModel = {
      id: '991825827/egen',
      endpoint: 'one',
      deployment: 'egen-dep',
      residency: 'norway',
      tenants: ['991825827'],
    };

    expect(() => router.reload({ endpoints: {}, models: [tenantModel] })).toThrow(
      /unknown endpoint/,
    );
    expect(router.models().has('a/small')).toBe(true);

    router.reload({ ...catalog, models: [...catalog.models, tenantModel] });
    const own = router.open(
      { kind: 'model', id: '991825827/egen' },
      { ...testContext().ctx, tenant: '991825827' },
    );
    expect((await own.chat({ messages: [{ role: 'user', content: 'hei' }] })).content).toBe(
      'proto-a:egen-dep',
    );
    expect(() => router.open({ kind: 'model', id: '991825827/egen' }, testContext().ctx)).toThrow(
      /not shared/,
    );
  });
});
