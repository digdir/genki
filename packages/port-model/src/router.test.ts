import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { textPart, type Principal } from '@genai/contracts';
import { createGate, createKernel, envSecrets } from '@genai/kernel';
import {
  bundledDescriptorDir,
  descriptorRegistry,
  loadDescriptors,
  parseDescriptor,
} from '@genai/operations';
import { contractFailures, fixturesFor, operationContract } from '@genai/operations/contract';
import {
  ModelError,
  ModelRouter,
  modelOutputCeiling,
  parseCatalog,
  parseCatalogYaml,
  type ChatRequest,
  type ChatResult,
  type Credential,
  type DecisionPort,
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

  it('refuses an unknown model at open and a model outside the allowed residency at the gate', async () => {
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
    await expect(
      open(norwayOnly, 'b/large').chat({ messages: [{ role: 'user', content: 'hei' }] }),
    ).rejects.toThrow(/outside norway/);
    expect(open(norwayOnly, 'a/small').info()).toEqual({
      id: 'a/small',
      residency: 'norway',
      capabilities: ['stream'],
      operations: ['chat'],
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

  it('meters a call at its list price, keeps a reported cost and leaves an unpriced call unpriced', async () => {
    const a = recording('proto-a', async () => ({
      ...answer('ok'),
      usage: { inputTokens: 2000, outputTokens: 500, requests: 1 },
    }));
    let reported = true;
    const b = recording('proto-b', async () => ({
      ...answer('ok'),
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        requests: 1,
        ...(reported ? { costMicroNok: 42 } : {}),
      },
    }));
    const router = new ModelRouter({
      catalog,
      adapters: [a.adapter, b.adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      tokenProviders: { entra: async () => 'entra-token' },
      priceOf: (id) =>
        id === 'a/small' ? { inputPerThousand: 0.0238, outputPerThousand: 0.0952 } : undefined,
    });
    const { ctx, metered } = testContext();

    await open(router, 'a/small', ctx).chat({ messages: [] });
    await open(router, 'b/large', ctx).chat({ messages: [] });
    reported = false;
    await open(router, 'b/large', ctx).chat({ messages: [] });

    expect(metered.map((m) => m.usage.costMicroNok)).toEqual([95_200, 42, undefined]);
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
        ['a/small', { residency: 'norway', capabilities: ['stream'], operations: ['chat'] }],
        ['b/large', { residency: 'global', capabilities: ['tools'], operations: ['chat'] }],
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

describe('output tokens a model is asked for', () => {
  const limited = (left: number | undefined, maxOutputTokens?: number) => {
    const a = recording('proto-a');
    const b = recording('proto-b');
    const router = new ModelRouter({
      catalog: {
        ...catalog,
        models: catalog.models
          .slice(0, 1)
          .map((m) => ({ ...m, ...(maxOutputTokens ? { maxOutputTokens } : {}) })),
      },
      adapters: [a.adapter, b.adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      tokenProviders: { entra: async () => 'entra-token' },
    });
    const ctx = {
      ...testContext().ctx,
      ...(left === undefined ? {} : { outputLimit: () => left }),
    };
    return { port: open(router, 'a/small', ctx), a };
  };

  it('never asks a model for more output than it can give, even with a large budget left', async () => {
    const { port, a } = limited(200_000);
    await port.chat({ messages: [] });
    expect(a.calls[0]?.request.maxTokens).toBe(modelOutputCeiling);
  });

  it('uses the output limit a catalog model declares', async () => {
    const { port, a } = limited(200_000, 128_000);
    await port.chat({ messages: [] });
    expect(a.calls[0]?.request.maxTokens).toBe(128_000);
  });

  it('cuts an explicit request above the model limit, without a budget', async () => {
    const { port, a } = limited(undefined, 8_000);
    await port.chat({ messages: [], maxTokens: 50_000 });
    await port.chat({ messages: [] });
    expect(a.calls.map((c) => c.request.maxTokens)).toEqual([8_000, undefined]);
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
      operations: ['chat'],
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
    await expect(
      open(router, 'two/claude-sonnet-5-5').chat({ messages: [{ role: 'user', content: 'hei' }] }),
    ).rejects.toThrow(/turned off/);
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
    await expect(
      router
        .open({ kind: 'model', id: '991825827/egen' }, testContext().ctx)
        .chat({ messages: [{ role: 'user', content: 'hei' }] }),
    ).rejects.toThrow(/not shared/);
  });
});

describe('model calls through the gate', () => {
  it('a payload with an image is refused before it leaves', async () => {
    const { router, a } = setup();
    const image = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];

    await expect(
      open(router, 'a/small').chat({
        messages: [{ role: 'user', content: image as unknown as string }],
      }),
    ).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/image/) });
    expect(a.calls).toEqual([]);
  });

  it("a chat call outside the service's residency is refused", async () => {
    const { router, b } = setup();
    const { ctx } = testContext();

    await expect(
      open(router, 'b/large', { ...ctx, serviceResidency: 'eu' }).chat({ messages: [] }),
    ).rejects.toMatchObject({ code: 'residency', message: 'model b/large runs outside eu' });
    expect(b.calls).toEqual([]);
  });

  it('every gate call writes one kernel.gate.call audit event without payload text', async () => {
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
            const port = await ctx.use<ModelPort>('model', model, { serviceResidency: 'norway' });
            await port.chat({ messages: [{ role: 'user', content: 'hemmelig spørsmål' }] });
            for await (const chunk of port.chatStream({
              messages: [{ role: 'user', content: 'hemmelig strøm' }],
            }))
              if (chunk.kind === 'done') yield { type: 'kernel.result', data: [] };
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
    await run.result;
    const audit = [];
    for await (const e of await kernel.events(kari, run.task, { audience: 'audit' }))
      if (e.type === 'kernel.gate.call') audit.push(e.data);

    expect(audit).toEqual([
      {
        port: 'model',
        operation: 'chat',
        model: 'a/small',
        endpoint: 'one',
        residency: 'norway',
        outcome: 'ok',
        usage: { inputTokens: 3, outputTokens: 2, requests: 1 },
      },
      {
        port: 'model',
        operation: 'chat',
        model: 'a/small',
        endpoint: 'one',
        residency: 'norway',
        outcome: 'ok',
        usage: { inputTokens: 3, outputTokens: 2, requests: 1 },
      },
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/hemmelig/);
  });
});

describe('operations on the catalogue', () => {
  const question = {
    input: 'Kan jeg søke om dette?',
    questions: [{ type: 'predicate' as const, name: 'purpose', instructions: 'I formålet?' }],
  };
  const decider = (operations?: string[]) => {
    const a = recording('proto-a');
    const decided: unknown[] = [];
    const adapter: ModelAdapter = {
      ...a.adapter,
      connect: (endpoint) => ({
        ...a.adapter.connect(endpoint as never),
        decide: async (_model, request) => {
          decided.push(request);
          return {
            answers: [{ type: 'predicate', name: 'purpose', probability: 0.9 }],
            usage: { inputTokens: 5, outputTokens: 0, requests: 1 },
            servedModel: 'served',
            calibrated: true,
          };
        },
      }),
    };
    const router = new ModelRouter({
      catalog: {
        endpoints: { one: catalog.endpoints.one },
        models: [
          {
            id: 'a/luna',
            endpoint: 'one',
            deployment: 'luna',
            residency: 'eu',
            ...(operations ? { operations } : {}),
          },
        ],
      },
      adapters: [adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
    });
    return { router, decided, chats: a.calls };
  };
  const decide = (router: ModelRouter, ctx = testContext().ctx) =>
    router.decisions().open({ kind: 'model', id: 'a/luna' }, ctx);

  it('a catalogue model offers chat and nothing else unless an operator classifies more', async () => {
    const { router, decided } = decider();
    expect(router.models().get('a/luna')?.operations).toEqual(['chat']);
    await expect(decide(router).decide(question)).rejects.toMatchObject({ code: 'unsupported' });
    expect(decided).toEqual([]);

    await router.classify('a/luna', { operations: ['chat', 'decide'] });
    expect(router.describe()[0]?.operations).toEqual(['chat', 'decide']);
    await expect(decide(router).decide(question)).resolves.toMatchObject({ calibrated: true });
  });

  it('a descriptor call on a model that does not offer its operation is refused', async () => {
    const yaml = readFileSync(join(bundledDescriptorDir, 'openai', 'decide@1.yaml'), 'utf8');
    const descriptor = parseDescriptor(yaml.replace('protocol: openai-chat', 'protocol: proto-a'));
    const sent: unknown[] = [];
    const egress: typeof fetch = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({
        answers: [{ type: 'predicate', name: 'purpose', probability: 0.9 }],
        usage: { input_tokens: 5, output_tokens: 0 },
      });
    };
    const { adapter } = recording('proto-a');
    const router = new ModelRouter({
      catalog: {
        endpoints: { one: catalog.endpoints.one },
        models: [{ id: 'a/luna', endpoint: 'one', deployment: 'luna', residency: 'eu' }],
      },
      adapters: [adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      descriptors: descriptorRegistry([descriptor]),
      gate: { ...createGate({ tier: 'test' }), egress: () => egress },
    });
    const call = (ports: ReturnType<ModelRouter['operations']>) =>
      ports.open({ kind: 'model', id: 'a/luna' }, testContext().ctx).call(descriptor.id, question);
    for (const ports of [router.operations(), router.described()])
      await expect(call(ports)).rejects.toMatchObject({
        code: 'unsupported',
        message: 'model a/luna does not offer the decide operation',
      });
    expect(sent).toEqual([]);

    await router.classify('a/luna', { operations: ['chat', 'decide'] });
    await expect(call(router.operations())).resolves.toMatchObject({ calibrated: true });
    expect(sent).toHaveLength(1);
  });

  it('a model without the chat operation refuses chat as unsupported', async () => {
    const { router, chats } = decider(['decide']);
    await expect(
      router.open({ kind: 'model', id: 'a/luna' }, testContext().ctx).chat({ messages: [] }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(chats).toEqual([]);
  });

  it('an adapter that does not implement decide refuses decide as unsupported', async () => {
    const { adapter } = recording('proto-a');
    const router = new ModelRouter({
      catalog: {
        endpoints: { one: catalog.endpoints.one },
        models: [
          {
            id: 'a/luna',
            endpoint: 'one',
            deployment: 'luna',
            residency: 'eu',
            operations: ['decide'],
          },
        ],
      },
      adapters: [adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
    });
    await expect(decide(router).decide(question)).rejects.toMatchObject({
      code: 'unsupported',
      message: 'the adapter for one does not implement the decide operation',
    });
  });

  it('the kernel port decision needs its own grant and passes the use:decision policy', async () => {
    const { router } = decider(['chat', 'decide']);
    const kari: Principal = {
      kind: 'employee',
      issuer: 'test',
      subject: 'kari',
      tenant: '999888777',
    };
    const model = { kind: 'model', id: 'a/luna', tenant: '999888777' };
    const asked: string[] = [];
    const kernelWith = (grants: { port: string; ref: typeof model }[]) =>
      createKernel({
        strategies: [
          {
            id: 'decide',
            version: '1',
            requires: { kernel: 1, ports: ['model', 'decision'], features: [] },
            run: async function* (ctx) {
              const port = await ctx.use<DecisionPort>('decision', model);
              const result = await port.decide(question);
              yield { type: 'kernel.result', data: [textPart(JSON.stringify(result.answers))] };
            },
          },
        ],
        capabilities: [
          {
            descriptor: {
              id: 'decide',
              version: '1',
              tenant: '999888777',
              title: 'decide',
              description: 'decide',
              input: {},
              interaction: ['unary'],
              accepts: [],
              produces: [],
              emits: [],
              oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: 'KI' },
            },
            strategy: { id: 'decide', version: '1' },
            config: {},
            grants,
          },
        ],
        ports: { model: router, decision: router.decisions() },
        policy: {
          decide: async (_p, action) => {
            asked.push(action);
            return { allow: true };
          },
        },
      });

    const ungranted = kernelWith([{ port: 'model', ref: model }]);
    const refused = await ungranted.invoke(kari, 'decide', {});
    await expect(refused.result).rejects.toThrow(/no grant for decision/);

    const granted = kernelWith([{ port: 'decision', ref: model }]);
    const run = await granted.invoke(kari, 'decide', {});
    await run.result;
    expect(asked).toContain('use:decision');
    const audit = [];
    for await (const e of await granted.events(kari, run.task, { audience: 'audit' }))
      if (e.type === 'kernel.gate.call') audit.push(e.data);
    expect(audit).toEqual([
      {
        port: 'decision',
        operation: 'decide',
        model: 'a/luna',
        endpoint: 'one',
        residency: 'eu',
        outcome: 'ok',
        usage: { inputTokens: 5, outputTokens: 0, requests: 1 },
      },
    ]);
  });
});

describe('a new operation kind from a descriptor alone', () => {
  const fixtures = join(import.meta.dirname, '..', 'test-fixtures');
  const registry = loadDescriptors(join(fixtures, 'descriptors'));
  const id = 'example/classify@1';
  const recorded = fixturesFor(join(fixtures, 'operations'), id);
  const sorter = (operations: string[]) => ({
    endpoints: { one: catalog.endpoints.one },
    models: [
      { id: 'a/sorter', endpoint: 'one', deployment: 'sorter', residency: 'eu', operations },
    ],
  });

  it('a descriptor for a new kind runs on a model that declares it, with no code for the kind', async () => {
    const descriptor = registry.get(id);
    if (!descriptor) throw new Error(`${id} did not load`);
    expect(descriptor.operation).toBe('classify');
    expect(contractFailures(await operationContract(descriptor, recorded))).toEqual([]);
    const fixture = recorded[0];
    if (!fixture) throw new Error('no fixture');
    const sent: unknown[] = [];
    const egress: typeof fetch = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json(fixture.response.body);
    };
    const router = new ModelRouter({
      catalog: sorter(['classify']),
      adapters: [recording('proto-a').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      descriptors: registry,
      governance: { maturity: async () => 'production', processorRecorded: async () => true },
      gate: { ...createGate({ tier: 'test' }), egress: () => egress },
    });
    for (const ports of [router.operations(), router.described()])
      await expect(
        ports.open({ kind: 'model', id: 'a/sorter' }, testContext().ctx).call(id, fixture.input),
      ).resolves.toEqual(fixture.result);
    expect(sent).toEqual([fixture.request.body, fixture.request.body]);
  });

  it('the catalogue refuses an operation kind no descriptor defines', async () => {
    const options = {
      adapters: [recording('proto-a').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      descriptors: registry,
    };
    expect(() => new ModelRouter({ ...options, catalog: sorter(['translate']) })).toThrow(
      'no descriptor defines the translate operation',
    );
    const router = new ModelRouter({ ...options, catalog: sorter(['chat']) });
    await expect(router.classify('a/sorter', { operations: ['translate'] })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await router.classify('a/sorter', { operations: ['chat', 'classify'] });
    expect(router.models().get('a/sorter')?.operations).toEqual(['chat', 'classify']);
  });
});
