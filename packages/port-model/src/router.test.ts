import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { textPart, type Principal } from '@genai/contracts';
import { createGate, createKernel, envSecrets, InMemoryProviderObjects } from '@genai/kernel';
import {
  bundledDescriptorDir,
  descriptorRegistry,
  loadDescriptors,
  parseDescriptor,
} from '@genai/operations';
import { contractFailures, fixturesFor, operationContract } from '@genai/operations/contract';
import {
  apiRegistry,
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

const recording = (family: string, behave?: (request: ChatRequest) => Promise<ChatResult>) => {
  const calls: {
    baseURL: string;
    credential: Credential;
    model: DeploymentConfig;
    request: ChatRequest;
  }[] = [];
  const adapter: ModelAdapter<{ flavour: string }> = {
    apis: [
      {
        id: `${family}/chat@1`,
        kind: 'chat',
        family,
        modelOptions: z.strictObject({ flavour: z.string().default('plain') }),
        default: true,
      },
    ],
    connect: (endpoint) => ({
      chat: async (model, request) => {
        calls.push({ baseURL: endpoint.baseURL, credential: endpoint.credential, model, request });
        return behave ? behave(request) : answer(`${family}:${model.deployment}`);
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
      baseURL: 'https://a.example',
      auth: { kind: 'api-key', secret: 'secret://env/key-a' },
      families: { 'proto-a': '/v1' },
    },
    two: {
      baseURL: 'https://b.example',
      auth: { kind: 'token-provider', provider: 'entra' },
      families: { 'proto-b': '' },
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
    const builtIn = (id: string, family: string, options: z.ZodRawShape = {}): ModelAdapter => ({
      apis: [{ id, kind: 'chat', family, modelOptions: z.strictObject(options), default: true }],
      connect: () => {
        throw new Error('not used');
      },
    });
    const text = readFileSync(join(import.meta.dirname, '..', 'examples', 'models.yaml'), 'utf8');

    expect(
      parseCatalogYaml(text, [
        builtIn('openai/chat-completions@1', 'openai', { tokenParam: z.string() }),
        builtIn('openai/responses@1', 'openai'),
        builtIn('anthropic/messages@1', 'anthropic', { defaultMaxTokens: z.number() }),
      ]),
    ).toMatchObject({ ok: true });
  });

  it('refuses options no bound API declares and a literal key', () => {
    const result = parseCatalog(
      {
        endpoints: {
          one: {
            baseURL: 'https://a.example',
            auth: { kind: 'bearer', secret: 'sk-live-123' },
            families: { 'proto-a': '' },
          },
          two: {
            baseURL: 'https://x.example',
            families: { 'proto-x': '' },
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
        models: [{ ...catalog.models[0], options: { colour: 'red' } }],
      },
      [recording('proto-a').adapter],
    );
    expect(!second.ok && second.errors.map((e) => e.path)).toEqual(['models.0.options']);
  });

  it('a model binds an API only when it exists, is of the bound kind and its family is offered', () => {
    const decider: ModelAdapter = {
      apis: [
        {
          id: 'proto-a/decide@1',
          kind: 'decide',
          family: 'proto-a',
          modelOptions: z.strictObject({}),
        },
      ],
      connect: () => ({
        chat: async () => answer(''),
        chatStream: async function* () {
          yield { kind: 'done', result: answer('') };
        },
      }),
    };
    const bound = (apis: Record<string, string>) =>
      parseCatalog({ ...catalog, models: [{ ...catalog.models[0], apis }] }, [
        recording('proto-a').adapter,
        recording('proto-b').adapter,
        decider,
      ]);

    expect(bound({ chat: 'proto-a/chat@1', decide: 'proto-a/decide@1' }).ok).toBe(true);
    expect(
      !bound({ chat: 'proto-a/none@1' }).ok && bound({ chat: 'proto-a/none@1' }),
    ).toMatchObject({
      errors: [{ path: 'models.0.apis.chat', message: 'no API proto-a/none@1' }],
    });
    expect(bound({ decide: 'proto-a/chat@1' })).toMatchObject({
      errors: [{ message: 'proto-a/chat@1 is an API for chat, not decide' }],
    });
    expect(bound({ chat: 'proto-b/chat@1' })).toMatchObject({
      errors: [
        { message: 'the connection does not offer the proto-b family proto-b/chat@1 needs' },
      ],
    });
  });

  it('a connection offers an API only for the families it names', () => {
    const both = {
      endpoints: {
        one: {
          baseURL: 'https://a.example',
          auth: { kind: 'api-key', secret: 'secret://env/key-a' },
          families: { 'proto-a': '/a', 'proto-b': 'https://b.a.example/b' },
        },
      },
      models: [
        {
          id: 'a/one',
          endpoint: 'one',
          deployment: 'one',
          residency: 'eu',
          apis: { chat: 'proto-a/chat@1' },
        },
        {
          id: 'b/one',
          endpoint: 'one',
          deployment: 'two',
          residency: 'eu',
          apis: { chat: 'proto-b/chat@1' },
        },
      ],
    };
    const adapters = [recording('proto-a').adapter, recording('proto-b').adapter];
    expect(parseCatalog(both, adapters).ok).toBe(true);
    expect(
      parseCatalog(
        { ...both, endpoints: { one: { ...both.endpoints.one, families: { 'proto-a': '' } } } },
        adapters,
      ),
    ).toMatchObject({ ok: false, errors: [{ path: 'models.1.apis.chat' }] });
  });

  it('a model on a connection with several families names its APIs', () => {
    const result = parseCatalog(
      {
        endpoints: {
          one: { ...catalog.endpoints.one, families: { 'proto-a': '', 'proto-b': '' } },
        },
        models: [{ ...catalog.models[0] }],
      },
      [recording('proto-a').adapter, recording('proto-b').adapter],
    );
    expect(result).toMatchObject({ ok: false, errors: [{ path: 'models.0.apis' }] });
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

  const withOne = (extra: Record<string, unknown>) =>
    parseCatalog(
      {
        ...catalog,
        endpoints: { ...catalog.endpoints, one: { ...catalog.endpoints.one, ...extra } },
      },
      [recording('proto-a').adapter, recording('proto-b').adapter],
    );

  it('a setting named constructor with no keys is accepted', () => {
    expect(withOne({ settings: { constructor: 'x' } }).ok).toBe(true);
  });

  it('refuses a name that is both a setting and a key, at the key', () => {
    expect(withOne({ settings: { signing: 'x' }, keys: { signing: 'secret://env/k' } })).toEqual({
      ok: false,
      errors: [{ path: 'endpoints.one.keys', message: 'a name is a setting or a key, not both' }],
    });
  });

  it('refuses a setting name that is not an identifier, naming the rule', () => {
    expect(withOne({ settings: { 'key id': 'x' } })).toEqual({
      ok: false,
      errors: [
        {
          path: 'endpoints.one.settings.key id',
          message: 'a lowercase letter, then letters, digits or _, at most 32 characters',
        },
      ],
    });
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
  it('routes each model to the implementation of the API it binds, with parsed options', async () => {
    const { router, a, b } = setup();

    expect((await open(router, 'a/small').chat({ messages: [] })).content).toBe(
      'proto-a:small-dep',
    );
    expect((await open(router, 'b/large').chat({ messages: [] })).content).toBe(
      'proto-b:large-dep',
    );
    expect(a.calls[0]?.model).toEqual({
      deployment: 'small-dep',
      api: 'proto-a/chat@1',
      options: { flavour: 'plain' },
    });
    expect(a.calls[0]?.baseURL).toBe('https://a.example/v1');
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
        baseURL: 'https://a.example',
        auth: { kind: 'api-key', secret: 'secret://env/key-a' },
        families: { 'proto-a': '/v1' },
        discovery: [
          {
            source: 'stub-listing',
            exclude: ['claude-*', 'text-embedding-*'],
            capabilities: ['stream', 'tools'],
          },
        ],
      },
      two: {
        baseURL: 'https://b.example',
        auth: { kind: 'api-key', secret: 'secret://env/key-a' },
        families: { 'proto-b': '' },
        discovery: [
          {
            source: 'stub-listing',
            from: 'one',
            include: ['claude-*'],
            capabilities: ['stream', 'reasoning'],
          },
        ],
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
            discovery: [{ source: 'nope', from: 'ghost' }],
          },
        },
      },
      [recording('proto-a').adapter],
      ['stub-listing'],
    );
    expect(!result.ok && result.errors.map((e) => e.path)).toEqual([
      'endpoints.one.discovery.0.source',
      'endpoints.one.discovery.0.from',
    ]);
  });

  it('one connection with two discovery rules binds each rule its APIs and keeps the ids each rule names', async () => {
    const a = recording('proto-a');
    const b = recording('proto-b');
    const source = listing([
      { deployment: 'gpt-5-mini', model: 'gpt-5-mini' },
      { deployment: 'claude-sonnet-5-5', model: 'claude-sonnet-5-5' },
    ]);
    const router = new ModelRouter({
      catalog: {
        endpoints: {
          foundry: {
            baseURL: 'https://res.example',
            auth: { kind: 'api-key', secret: 'secret://env/key-a' },
            families: { 'proto-a': '/openai/v1', 'proto-b': '/anthropic' },
            discovery: [
              {
                source: 'stub-listing',
                idPrefix: 'foundry-openai',
                exclude: ['claude-*'],
                apis: { chat: 'proto-a/chat@1' },
              },
              {
                source: 'stub-listing',
                idPrefix: 'foundry-claude',
                include: ['claude-*'],
                apis: { chat: 'proto-b/chat@1' },
              },
            ],
          },
        },
      },
      adapters: [a.adapter, b.adapter],
      secrets: envSecrets({ KEY_A: 'k' }),
      sources: [source],
    });

    await router.refresh();
    expect(router.describe().map((m) => [m.id, m.endpoint, m.apis])).toEqual([
      ['foundry-claude/claude-sonnet-5-5', 'foundry', { chat: 'proto-b/chat@1' }],
      ['foundry-openai/gpt-5-mini', 'foundry', { chat: 'proto-a/chat@1' }],
    ]);
    await open(router, 'foundry-openai/gpt-5-mini').chat({ messages: [] });
    await open(router, 'foundry-claude/claude-sonnet-5-5').chat({ messages: [] });
    expect(a.calls[0]?.baseURL).toBe('https://res.example/openai/v1');
    expect(b.calls[0]?.baseURL).toBe('https://res.example/anthropic');
    expect(source.calls).toBe(1);
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
  const both = { chat: 'proto-a/chat@1', decide: 'proto-a/decide@1' };
  const deciding = (adapter: ModelAdapter): ModelAdapter => ({
    ...adapter,
    apis: [
      ...adapter.apis,
      {
        id: 'proto-a/decide@1',
        kind: 'decide',
        family: 'proto-a',
        modelOptions: z.strictObject({}),
      },
    ],
  });
  const decider = (apis?: Record<string, string>) => {
    const a = recording('proto-a');
    const decided: unknown[] = [];
    const adapter: ModelAdapter = {
      ...deciding(a.adapter),
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
            ...(apis ? { apis } : {}),
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

    await router.classify('a/luna', { apis: both });
    expect(router.describe()[0]?.operations).toEqual(['chat', 'decide']);
    expect(router.describe()[0]?.apis).toEqual(both);
    await expect(decide(router).decide(question)).resolves.toMatchObject({ calibrated: true });
  });

  it('a descriptor call on a model that does not offer its operation is refused', async () => {
    const yaml = readFileSync(join(bundledDescriptorDir, 'openai', 'decide@1.yaml'), 'utf8');
    const descriptor = parseDescriptor(yaml.replace('family: openai', 'family: proto-a'));
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

    await router.classify('a/luna', { apis: { chat: 'proto-a/chat@1', decide: descriptor.id } });
    await expect(call(router.operations())).resolves.toMatchObject({ calibrated: true });
    expect(sent).toHaveLength(1);
  });

  it('a decide binding to a descriptor without a built-in implementation runs through the executor', async () => {
    const yaml = readFileSync(join(bundledDescriptorDir, 'openai', 'decide@1.yaml'), 'utf8');
    const descriptor = parseDescriptor(yaml.replace('family: openai', 'family: proto-a'));
    const urls: string[] = [];
    const egress: typeof fetch = async (url) => {
      urls.push(String(url));
      return Response.json({
        answers: [{ type: 'predicate', name: 'purpose', probability: 0.9 }],
        usage: { input_tokens: 5, output_tokens: 0 },
      });
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
            apis: { decide: descriptor.id },
          },
        ],
      },
      adapters: [recording('proto-a').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      descriptors: descriptorRegistry([descriptor]),
      gate: { ...createGate({ tier: 'test' }), egress: () => egress },
    });
    await expect(decide(router).decide(question)).resolves.toMatchObject({ calibrated: true });
    expect(urls).toEqual(['https://a.example/v1/decisions']);
  });

  it("a descriptor call reads the connection's settings, which the operator set on the catalogue", async () => {
    const yaml = readFileSync(join(bundledDescriptorDir, 'openai', 'decide@1.yaml'), 'utf8')
      .replace('family: openai', 'family: proto-a')
      .replace(
        '  path: /decisions\n',
        '  path: /decisions\n  headers:\n    x-key-id: $connection.keyId\n',
      )
      .replace(
        'wire:\n  request:',
        'wire:\n  headers:\n    object:\n      x-key-id: plain\n  request:',
      );
    const descriptor = parseDescriptor(yaml);
    const keyIds: (string | null)[] = [];
    const egress: typeof fetch = async (_url, init) => {
      keyIds.push(new Headers(init?.headers).get('x-key-id'));
      return Response.json({
        answers: [{ type: 'predicate', name: 'purpose', probability: 0.9 }],
        usage: { input_tokens: 5, output_tokens: 0 },
      });
    };
    const router = new ModelRouter({
      catalog: {
        endpoints: { one: { ...catalog.endpoints.one, settings: { keyId: 'AKID-7' } } },
        models: [
          {
            id: 'a/luna',
            endpoint: 'one',
            deployment: 'luna',
            residency: 'eu',
            apis: { decide: descriptor.id },
          },
        ],
      },
      adapters: [recording('proto-a').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      descriptors: descriptorRegistry([descriptor]),
      gate: { ...createGate({ tier: 'test' }), egress: () => egress },
    });
    await expect(decide(router).decide(question)).resolves.toMatchObject({ calibrated: true });
    expect(keyIds).toEqual(['AKID-7']);
  });

  it('a descriptor module signs with a named key the operator set on the connection, which no request carries', async () => {
    const module = new Uint8Array(
      readFileSync(
        join(
          import.meta.dirname,
          '..',
          '..',
          'operations',
          'src',
          'testdata',
          'modules',
          'named-key-signer.wasm',
        ),
      ),
    );
    const descriptor = parseDescriptor(`
id: proto-a/signed-order@1
operation: signed-order
status: described
summary: A made-up API whose requests a module signs with a named key of the connection.
api: { family: proto-a, version: '1' }
auth: { signedBy: module }
modules:
  signer: { sha256: ${createHash('sha256').update(module).digest('hex')}, keys: [connection, connection.signing] }
input: { object: { item: text } }
output: { object: { status: plain } }
result: { status: $response.status }
steps:
  - name: place
    request: { method: POST, path: /orders, body: { item: $input.item } }
    module:
      use: signer
      emits: { sig: { ref: '^[0-9a-f]{64}$' } }
      headers: { x-signature: sig }
    wire:
      request: { object: { item: text } }
      response: { object: { status: plain } }
    usage: { request: 1 }
`);
    const seen: { headers: string; url: string; body: string }[] = [];
    const egress: typeof fetch = async (url, init) => {
      seen.push({
        headers: JSON.stringify(init?.headers),
        url: String(url),
        body: String(init?.body),
      });
      return Response.json({ status: 'placed' });
    };
    const router = new ModelRouter({
      catalog: {
        endpoints: {
          one: { ...catalog.endpoints.one, keys: { signing: 'secret://env/signing-key' } },
        },
        models: [
          {
            id: 'a/luna',
            endpoint: 'one',
            deployment: 'luna',
            residency: 'eu',
            apis: { 'signed-order': descriptor.id },
          },
        ],
      },
      adapters: [recording('proto-a').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env', SIGNING_KEY: 'named-signing-key' }),
      descriptors: { ...descriptorRegistry([descriptor]), module: () => module },
      governance: { maturity: async () => 'production', processorRecorded: async () => true },
      gate: { ...createGate({ tier: 'test' }), egress: () => egress },
    });
    await expect(
      router
        .described()
        .open({ kind: 'model', id: 'a/luna' }, testContext().ctx)
        .call(descriptor.id, { item: 'pen' }),
    ).resolves.toEqual({ status: 'placed' });
    const sent = seen[0] as (typeof seen)[number];
    expect(JSON.parse(sent.headers)).toMatchObject({
      'x-signature': createHmac('sha256', 'named-signing-key').update(sent.body).digest('hex'),
    });
    for (const secret of ['named-signing-key', 'key-from-env'])
      expect(`${sent.headers}${sent.url}${sent.body}`).not.toContain(secret);
  });

  it('a descriptor decide error keeps the provider status and body for the audit', async () => {
    const yaml = readFileSync(join(bundledDescriptorDir, 'openai', 'decide@1.yaml'), 'utf8');
    const descriptor = parseDescriptor(yaml.replace('family: openai', 'family: proto-a'));
    const egress: typeof fetch = async () =>
      Response.json({ error: { message: 'the deployment is overloaded' } }, { status: 503 });
    const router = new ModelRouter({
      catalog: {
        endpoints: { one: catalog.endpoints.one },
        models: [
          {
            id: 'a/luna',
            endpoint: 'one',
            deployment: 'luna',
            residency: 'eu',
            apis: { decide: descriptor.id },
          },
        ],
      },
      adapters: [recording('proto-a').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      descriptors: descriptorRegistry([descriptor]),
      gate: { ...createGate({ tier: 'test' }), egress: () => egress },
    });
    const error = await decide(router)
      .decide(question)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'unavailable',
      message: 'the model is unavailable',
      provider: { status: 503, body: expect.stringContaining('the deployment is overloaded') },
    });
  });

  it('a descriptor call names the API the model binds for its kind', async () => {
    const yaml = readFileSync(join(bundledDescriptorDir, 'openai', 'decide@1.yaml'), 'utf8');
    const descriptor = parseDescriptor(yaml.replace('family: openai', 'family: proto-a'));
    const router = new ModelRouter({
      catalog: {
        endpoints: { one: catalog.endpoints.one },
        models: [
          { id: 'a/luna', endpoint: 'one', deployment: 'luna', residency: 'eu', apis: both },
        ],
      },
      adapters: [deciding(recording('proto-a').adapter)],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      descriptors: descriptorRegistry([descriptor]),
    });
    await expect(
      router
        .operations()
        .open({ kind: 'model', id: 'a/luna' }, testContext().ctx)
        .call(descriptor.id, question),
    ).rejects.toMatchObject({
      code: 'unsupported',
      message: 'model a/luna binds proto-a/decide@1 for decide, not openai/decide@1',
    });
  });

  it('a model without the chat operation refuses chat as unsupported', async () => {
    const { router, chats } = decider({ decide: 'proto-a/decide@1' });
    await expect(
      router.open({ kind: 'model', id: 'a/luna' }, testContext().ctx).chat({ messages: [] }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(chats).toEqual([]);
  });

  it('a bound API whose implementation has no decide refuses decide as unsupported', async () => {
    const adapter = deciding(recording('proto-a').adapter);
    const router = new ModelRouter({
      catalog: {
        endpoints: { one: catalog.endpoints.one },
        models: [
          {
            id: 'a/luna',
            endpoint: 'one',
            deployment: 'luna',
            residency: 'eu',
            apis: { decide: 'proto-a/decide@1' },
          },
        ],
      },
      adapters: [adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
    });
    await expect(decide(router).decide(question)).rejects.toMatchObject({
      code: 'unsupported',
      message: 'proto-a/decide@1 has no implementation for decide',
    });
  });

  it('the kernel port decision needs its own grant and passes the use:decision policy', async () => {
    const { router } = decider(both);
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
  const sorter = (apis: Record<string, string>) => ({
    endpoints: { one: catalog.endpoints.one },
    models: [{ id: 'a/sorter', endpoint: 'one', deployment: 'sorter', residency: 'eu', apis }],
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
      return Response.json(fixture.response?.body);
    };
    const router = new ModelRouter({
      catalog: sorter({ classify: id }),
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
    expect(sent).toEqual([fixture.request?.body, fixture.request?.body]);
  });

  it('the catalogue refuses a binding to an API no implementation or descriptor defines', async () => {
    const options = {
      adapters: [recording('proto-a').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      descriptors: registry,
    };
    expect(
      () => new ModelRouter({ ...options, catalog: sorter({ translate: 'example/translate@1' }) }),
    ).toThrow('no API example/translate@1');
    const router = new ModelRouter({ ...options, catalog: sorter({ chat: 'proto-a/chat@1' }) });
    await expect(
      router.classify('a/sorter', { apis: { translate: 'example/translate@1' } }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await router.classify('a/sorter', { apis: { chat: 'proto-a/chat@1', classify: id } });
    expect(router.models().get('a/sorter')?.operations).toEqual(['chat', 'classify']);
  });

  it('the API registry lists built-in implementations and descriptors under one id each', () => {
    const router = new ModelRouter({
      catalog: sorter({ chat: 'proto-a/chat@1' }),
      adapters: [recording('proto-a').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      descriptors: registry,
    });
    expect(
      router
        .apis()
        .list()
        .map((a) => [a.id, a.kind, a.family, a.source]),
    ).toEqual([
      ['example/classify@1', 'classify', 'proto-a', 'bundled'],
      ['proto-a/chat@1', 'chat', 'proto-a', 'built-in'],
    ]);
  });
});

describe('typed calls and processor records (ADR 0048)', () => {
  const recorded = (endpoints: string[]) => ({
    maturity: async () => 'test' as const,
    processorRecorded: async (endpoint: string) => endpoints.includes(endpoint),
  });

  it('a typed chat call on a connection without a processor record is refused for real data when the check is enforced', async () => {
    const a = recording('proto-a');
    const router = new ModelRouter({
      catalog,
      adapters: [a.adapter, recording('proto-b').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      tokenProviders: { entra: async () => 'entra-token' },
      governance: recorded(['two']),
      typedCalls: 'enforce',
    });

    await expect(open(router, 'a/small').chat({ messages: [] })).rejects.toMatchObject({
      message: expect.stringMatching(/has no processor record/),
    });
    expect(a.calls).toEqual([]);
    await expect(open(router, 'b/large').chat({ messages: [] })).resolves.toMatchObject({
      content: 'proto-b:large-dep',
    });
  });

  it('a typed chat call without a processor record goes through and warns once per connection when the check warns', async () => {
    const warned: string[] = [];
    const router = new ModelRouter({
      catalog,
      adapters: [recording('proto-a').adapter, recording('proto-b').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      tokenProviders: { entra: async () => 'entra-token' },
      governance: recorded([]),
      onUnrecordedProcessor: (endpoint, kind) => warned.push(`${endpoint}:${kind}`),
    });

    await open(router, 'a/small').chat({ messages: [] });
    await open(router, 'a/small').chat({ messages: [] });
    for await (const chunk of open(router, 'a/small').chatStream({ messages: [] })) void chunk;
    await open(router, 'b/large').chat({ messages: [] });

    expect(warned).toEqual(['one:chat', 'two:chat']);
  });

  it('a typed call is production by construction, so a kind still in test does not stop it', async () => {
    const router = new ModelRouter({
      catalog,
      adapters: [recording('proto-a').adapter, recording('proto-b').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      tokenProviders: { entra: async () => 'entra-token' },
      governance: recorded(['one']),
      typedCalls: 'enforce',
      gate: createGate({ tier: 'production' }),
    });

    await expect(open(router, 'a/small').chat({ messages: [] })).resolves.toMatchObject({
      content: 'proto-a:small-dep',
    });
  });
});

describe('prices per kind and unit (ADR 0048)', () => {
  it('a chat call is priced with the chat prices of its model, and shown per 1,000 tokens', async () => {
    const a = recording('proto-a', async () => ({
      ...answer('ok'),
      usage: { inputTokens: 2000, outputTokens: 500, cachedInputTokens: 1000, requests: 1 },
    }));
    const router = new ModelRouter({
      catalog,
      adapters: [a.adapter, recording('proto-b').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      tokenProviders: { entra: async () => 'entra-token' },
      priceOf: (id) =>
        id === 'a/small'
          ? {
              chat: {
                'input-token': 0.00002,
                'output-token': 0.0001,
                'cached-input-token': 0.000005,
              },
              decide: { 'input-token': 1 },
            }
          : undefined,
    });
    const { ctx, metered } = testContext();

    await open(router, 'a/small', ctx).chat({ messages: [] });

    expect(metered.map((m) => m.usage.costMicroNok)).toEqual([75_000]);
    expect(router.describe().find((m) => m.id === 'a/small')).toMatchObject({
      price: { inputPerThousand: 0.02, outputPerThousand: 0.1 },
      prices: { chat: { 'input-token': 0.00002 } },
    });
  });

  it('a model that names no price for a kind leaves its calls of that kind unpriced', async () => {
    const router = new ModelRouter({
      catalog,
      adapters: [recording('proto-a').adapter, recording('proto-b').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      tokenProviders: { entra: async () => 'entra-token' },
      priceOf: () => ({ decide: { 'input-token': 1, 'output-token': 1 } }),
    });
    const { ctx, metered } = testContext();

    await open(router, 'a/small', ctx).chat({ messages: [] });

    expect(metered[0]?.usage.costMicroNok).toBeUndefined();
  });
});

describe('embedding and rerank models in the model catalogue (ADR 0048)', () => {
  const portApis = [
    { id: 'proto-a/embed@1', kind: 'embed', family: 'proto-a', modelOptions: z.strictObject({}) },
  ];
  const embedder = (extra: Record<string, unknown> = {}) => ({
    endpoints: catalog.endpoints,
    models: [
      {
        id: 'a/embedder',
        endpoint: 'one',
        deployment: 'emb',
        residency: 'eu',
        apis: { embed: 'proto-a/embed@1' },
        ...extra,
      },
    ],
  });

  it('an embedding model in the catalogue names its dimensions under embed', () => {
    const apis = apiRegistry([recording('proto-a').adapter], undefined, portApis);

    expect(parseCatalog(embedder(), apis)).toMatchObject({
      ok: false,
      errors: [{ path: 'models.0.embed' }],
    });
    expect(parseCatalog(embedder({ embed: { dimensions: 8, maxBatch: 4 } }), apis)).toMatchObject({
      ok: true,
    });
  });

  it('a model that binds only another port kind is listed for operators but is not a model a service can name', () => {
    const router = new ModelRouter({
      catalog: embedder({ embed: { dimensions: 8 } }),
      adapters: [recording('proto-a').adapter],
      portApis,
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      tokenProviders: { entra: async () => 'entra-token' },
    });

    expect(router.describe().map((m) => [m.id, m.operations])).toEqual([['a/embedder', ['embed']]]);
    expect(router.models().has('a/embedder')).toBe(false);
  });

  it('an API renamed after models bound it is found by its old id', () => {
    const apis = apiRegistry([], loadDescriptors());

    expect(apis.get('openai/embed@1')).toMatchObject({ id: 'openai/embeddings@1', kind: 'embed' });
    expect(apis.get('openai/embeddings@1')?.units).toEqual(['input-token', 'request']);
  });
});

describe('provider-side objects and the processor record', () => {
  const keepNote = parseDescriptor(`
id: example/keep-note@1
operation: keep-note
status: described
summary: A made-up API that stores a note at the provider, answers from it and deletes it.
api: { family: example, version: '1' }
input: { object: { text: text } }
output: { object: { answer: text } }
resources:
  - { id: create.note, delete: remove_note, longestSeconds: 3600 }
steps:
  - name: create
    request: { method: POST, path: /notes, body: { text: $input.text } }
    wire:
      request: { object: { text: text } }
      response: { object: { id: plain } }
    bind:
      note: { from: $response.id, class: { issued: '^note-[a-z0-9]+$' } }
  - name: ask
    request: { method: POST, path: /answers, body: { note: $steps.create.note } }
    wire:
      request: { object: { note: { issued: '^note-[a-z0-9]+$' } } }
      response: { object: { text: text } }
finally:
  - name: remove_note
    request: { method: DELETE, path: '/notes/{steps.create.note}' }
    wire: { response: { object: { deleted: boolean } } }
result: { answer: $response.text }
`);
  const lab = {
    endpoints: {
      lab: {
        baseURL: 'https://lab.example/v1',
        auth: { kind: 'api-key', secret: 'secret://env/key-a' },
        families: { example: '' },
      },
    },
    models: [
      {
        id: 'lab/small',
        endpoint: 'lab',
        deployment: 'small',
        residency: 'eu',
        apis: { 'keep-note': 'example/keep-note@1' },
      },
    ],
  };

  const provider = (failDelete = false) => {
    const seen: string[] = [];
    const egress: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      seen.push(`${init?.method} ${path}`);
      if (path === '/v1/notes') return Response.json({ id: 'note-a1' });
      if (path === '/v1/answers') return Response.json({ text: 'done' });
      return failDelete ? new Response('no', { status: 500 }) : Response.json({ deleted: true });
    };
    return { seen, egress };
  };

  const routerFor = (
    stateAllowed: boolean,
    egress: typeof fetch,
    objects: InMemoryProviderObjects,
  ) =>
    new ModelRouter({
      catalog: lab,
      adapters: [recording('proto-a').adapter],
      secrets: envSecrets({ KEY_A: 'key-from-env' }),
      descriptors: descriptorRegistry([keepNote]),
      governance: {
        maturity: async () => 'production',
        processorRecorded: async () => true,
        providerStateAllowed: async () => stateAllowed,
      },
      objects,
      gate: { ...createGate({ tier: 'test' }), egress: () => egress },
    });

  const run = (router: ModelRouter) =>
    router
      .described()
      .open({ kind: 'model', id: 'lab/small' }, testContext().ctx)
      .call('example/keep-note@1', { text: 'hei' });

  it('a descriptor that leaves objects at the provider is refused as processor when the processor record does not allow provider state', async () => {
    const { seen, egress } = provider();
    await expect(
      run(routerFor(false, egress, new InMemoryProviderObjects())),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/does not name the provider's retention/),
    });
    expect(seen).toEqual([]);
  });

  it('writes the object to the ledger when it is issued and strikes it when the finally step deletes it', async () => {
    const { seen, egress } = provider();
    const objects = new InMemoryProviderObjects();
    await expect(run(routerFor(true, egress, objects))).resolves.toEqual({ answer: 'done' });
    expect(seen).toEqual(['POST /v1/notes', 'POST /v1/answers', 'DELETE /v1/notes/note-a1']);
    const [note] = await objects.list(testContext().ctx.tenant);
    expect(note).toMatchObject({ objectId: 'note-a1', state: 'deleted', connection: 'lab' });
  });

  it('leaves the object open in the ledger when the provider will not delete it, so the sweep finds it', async () => {
    const { egress } = provider(true);
    const objects = new InMemoryProviderObjects();
    await run(routerFor(true, egress, objects)).catch(() => undefined);
    const [note] = await objects.list(testContext().ctx.tenant);
    expect(note).toMatchObject({ objectId: 'note-a1', state: 'open' });
  });

  it('the sweep deletes a leftover object through the descriptor of the call that made it', async () => {
    const failing = provider(true);
    const objects = new InMemoryProviderObjects();
    await run(routerFor(true, failing.egress, objects)).catch(() => undefined);
    const [left] = await objects.list(testContext().ctx.tenant, 'open');
    const healthy = provider();
    await routerFor(true, healthy.egress, objects).removeProviderObject(left as never);
    expect(healthy.seen).toEqual(['DELETE /v1/notes/note-a1']);
  });
});
