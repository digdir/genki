import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ResourceProvenance, Usage } from '@genai/contracts';
import { createVault, modelGuard } from '@genai/guardrails';
import {
  createGate,
  envSecrets,
  GateError,
  shape,
  type Gate,
  type GatePayload,
  type GateRecord,
  type GateRefusal,
  type GateTarget,
  type PortContext,
} from '@genai/kernel';
import {
  gateContract,
  type GateContractSubject,
  type GateLane,
  type GateLaneRun,
  type GateLaneSetup,
  type Smuggled,
} from '@genai/kernel/gate-contract';
import { EmbeddingRouter, type EmbeddingAdapter } from '@genai/port-embedding';
import {
  ModelRouter,
  type ChatChunk,
  type ChatResult,
  type DecisionRequest,
  type ModelAdapter,
} from '@genai/port-model';
import { descriptorRegistry, parseDescriptor } from '@genai/operations';
import { RerankRouter, type RerankAdapter } from '@genai/port-rerank';

const tenant = '999888777';
const image = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];

const refusalOf = (error: unknown): GateRefusal | undefined => {
  const { code, message } = error as { code?: string; message?: string };
  if (code === 'unauthorized') return 'admission';
  if (code === 'residency') return 'residency';
  if (message?.includes('is turned off')) return 'disabled';
  if (message?.includes('is not shared')) return 'not-shared';
  if (message?.includes('image, audio or file')) return 'media';
  if (message?.includes('outside its shape')) return 'shape';
  return undefined;
};

const endpoint = (protocol: string) => ({
  protocol,
  engine: protocol,
  baseURL: 'https://provider.example',
  auth: { kind: 'api-key', secret: 'secret://env/k' },
});

const connection = (family: string) => ({
  baseURL: 'https://provider.example',
  auth: { kind: 'api-key', secret: 'secret://env/k' },
  families: { [family]: '' },
});

const fakeApi = (kind: string) => ({
  id: `fake/${kind}@1`,
  kind,
  family: 'fake',
  modelOptions: z.strictObject({}),
  default: true,
});

const without = (value: Record<string, unknown>, key: string) => {
  const copy = { ...value };
  Reflect.deleteProperty(copy, key);
  return copy;
};

const classifyDescriptor = parseDescriptor(`
id: example/classify@1
operation: classify
status: review
summary: A made-up classification API for the gate contract.
api:
  family: openai
  version: v1
request:
  method: POST
  path: /classifications
  body:
    model: $deployment
    text: $input.text
    label: $input.label
input:
  object:
    text: text
    label: ref
output:
  object:
    label: plain
wire:
  request:
    object:
      model: plain
      text: text
      label: ref
  response:
    object:
      label: plain
      usage: { object: { input_tokens: { number: { integer: true, min: 0 } } } }
result:
  label: $response.label
usage:
  inputTokens: $response.usage.input_tokens
  requests: 1
stream: none
`);

const reviewedClassify = { ...classifyDescriptor, status: 'described' as const };

const fakeChatAdapter: ModelAdapter = {
  apis: [fakeApi('chat')],
  connect: () => ({
    chat: async () => {
      throw new Error('not used');
    },
    chatStream: async function* () {
      yield* [];
      throw new Error('not used');
    },
  }),
};

type GateMaker = (setup: GateLaneSetup) => Gate;

const realGate: GateMaker = (setup) => createGate({ admits: () => setup.admitted ?? true });

const answering = <T extends object>(setup: GateLaneSetup, answer: T): T =>
  setup.unknownAnswerField ? { ...answer, surprise: 1 } : answer;

const toolMessage = (smuggle: Smuggled | undefined) =>
  smuggle === 'url' || smuggle === 'object-id'
    ? [
        {
          role: 'tool' as const,
          content: 'svar',
          toolCallId: smuggle === 'url' ? 'https://evil.example/call' : 'file-abc123',
        },
      ]
    : [];

const routerLanes = (makeGate: GateMaker = realGate) => {
  const watched = (setup: GateLaneSetup) => {
    const upstream: string[] = [];
    const metered: Usage[] = [];
    const audit: GateRecord[] = [];
    const provenance: ResourceProvenance[] = [];
    const ctx: PortContext = {
      tenant,
      principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant },
      task: 't1',
      signal: new AbortController().signal,
      meter: async (usage) => {
        metered.push(usage);
      },
      audit: async (record) => {
        audit.push(record);
      },
      provenance: async (resource) => {
        provenance.push(resource);
      },
      ...(setup.guards ? { guards: setup.guards } : {}),
      ...(setup.serviceResidency ? { serviceResidency: setup.serviceResidency } : {}),
    };
    const gate = makeGate(setup);
    const shared = setup.sharedWith ? { tenants: setup.sharedWith } : {};
    return { upstream, metered, audit, provenance, ctx, gate, shared };
  };
  const has = { enabled: false, sharing: true, routerResidency: true, requestResidency: false };

  const model: GateLane = {
    port: 'model',
    operation: 'chat',
    admission: 'admitted',
    tenant,
    has: { ...has, enabled: true, provenance: true },
    answersWithText: true,
    refusalOf,
    open: (setup): GateLaneRun => {
      const w = watched(setup);
      const adapter: ModelAdapter = {
        apis: [fakeApi('chat')],
        connect: () => ({
          chat: async (_model, request) => {
            w.upstream.push(...request.messages.map((m) => m.content));
            if (setup.failUpstream) throw new Error('the provider is down');
            const answer: ChatResult = {
              content: request.messages.at(-1)?.content ?? '',
              toolCalls: [],
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, requests: 1 },
              servedModel: 'fake',
            };
            return answering(setup, answer);
          },
          chatStream: async function* (_model, request) {
            const content = request.messages.at(-1)?.content ?? '';
            w.upstream.push(content);
            yield { kind: 'delta', text: content };
            if (setup.unknownStreamEvent)
              yield { kind: 'tool-call', text: '' } as unknown as ChatChunk;
            yield {
              kind: 'done',
              result: {
                content,
                toolCalls: [],
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, requests: 1 },
                servedModel: 'fake',
              },
            };
          },
        }),
      };
      const router = new ModelRouter({
        gate: w.gate,
        catalog: {
          endpoints: { fake: connection('fake') },
          models: [
            {
              id: 'fake/model',
              endpoint: 'fake',
              deployment: 'd',
              residency: setup.residency ?? 'norway',
              capabilities: ['stream'],
              ...w.shared,
            },
          ],
        },
        adapters: [adapter],
        secrets: envSecrets({ K: 'k' }),
        ...(setup.routerResidency ? { maxResidency: setup.routerResidency } : {}),
        classifications: {
          load: async () => (setup.enabled === false ? { 'fake/model': { enabled: false } } : {}),
          save: async () => undefined,
        },
      });
      return {
        ...w,
        call: async (text, extra = {}) => {
          await router.refresh();
          const port = router.open({ kind: 'model', id: 'fake/model', tenant }, w.ctx);
          const content = (extra.media ? image : text) as string;
          const request = {
            messages: [...toolMessage(extra.smuggle), { role: 'user' as const, content }],
            ...(extra.smuggle === 'field' ? { previous_response_id: 'resp_1' } : {}),
          };
          return (await port.chat(request)).content;
        },
        stream: async (text) => {
          await router.refresh();
          const port = router.open({ kind: 'model', id: 'fake/model', tenant }, w.ctx);
          let out = '';
          for await (const chunk of port.chatStream({
            messages: [{ role: 'user', content: text }],
          }))
            if (chunk.kind === 'delta') out += chunk.text;
          return out;
        },
      };
    },
  };

  const decision: GateLane = {
    port: 'decision',
    operation: 'decide',
    admission: 'admitted',
    tenant,
    has: { ...has, enabled: true, provenance: true },
    answersWithText: false,
    refusalOf,
    open: (setup): GateLaneRun => {
      const w = watched(setup);
      const adapter: ModelAdapter = {
        apis: [fakeApi('chat'), fakeApi('decide')],
        connect: () => ({
          chat: async () => {
            throw new Error('not used');
          },
          chatStream: async function* () {
            yield* [];
            throw new Error('not used');
          },
          decide: async (_model, request) => {
            const input = request.input;
            w.upstream.push(...(typeof input === 'string' ? [input] : input.map((m) => m.content)));
            if (setup.failUpstream) throw new Error('the provider is down');
            return answering(setup, {
              answers: [{ type: 'predicate' as const, name: 'purpose', probability: 0.9 }],
              usage: { inputTokens: 1, outputTokens: 0, requests: 1 },
              servedModel: 'fake',
              calibrated: true,
            });
          },
        }),
      };
      const router = new ModelRouter({
        gate: w.gate,
        catalog: {
          endpoints: { fake: connection('fake') },
          models: [
            {
              id: 'fake/decider',
              endpoint: 'fake',
              deployment: 'd',
              residency: setup.residency ?? 'norway',
              apis: { chat: 'fake/chat@1', decide: 'fake/decide@1' },
              ...w.shared,
            },
          ],
        },
        adapters: [adapter],
        secrets: envSecrets({ K: 'k' }),
        ...(setup.routerResidency ? { maxResidency: setup.routerResidency } : {}),
        classifications: {
          load: async () => (setup.enabled === false ? { 'fake/decider': { enabled: false } } : {}),
          save: async () => undefined,
        },
      });
      return {
        ...w,
        call: async (text, extra = {}) => {
          await router.refresh();
          const port = router
            .decisions()
            .open({ kind: 'model', id: 'fake/decider', tenant }, w.ctx);
          const request = {
            input: extra.media
              ? [{ role: 'user', content: image }]
              : extra.smuggle === 'object-id'
                ? [{ role: 'user', content: text, file_id: 'file-abc123' }]
                : text,
            questions: [
              {
                type: 'predicate',
                name: extra.smuggle === 'url' ? 'https://evil.example' : 'purpose',
                instructions: 'Is this in scope?',
              },
            ],
            ...(extra.smuggle === 'field' ? { store: true } : {}),
          } as DecisionRequest;
          await port.decide(request);
          return undefined;
        },
      };
    },
  };

  const embedding: GateLane = {
    port: 'embedding',
    operation: 'embed',
    admission: 'open',
    tenant,
    has: { ...has, requestResidency: true },
    answersWithText: false,
    refusalOf,
    open: (setup) => {
      const w = watched(setup);
      const adapter: EmbeddingAdapter = {
        api: { id: 'fake/embeddings@1', family: 'fake' },
        modelOptions: z.object({}),
        connect: () => ({
          embed: async (_model, texts) => {
            w.upstream.push(...texts);
            if (setup.failUpstream) throw new Error('the provider is down');
            return answering(setup, {
              vectors: texts.map(() => [0.1, 0.2]),
              usage: { inputTokens: texts.length },
            });
          },
        }),
      };
      const router = new EmbeddingRouter({
        gate: w.gate,
        catalog: {
          endpoints: { fake: connection('fake') },
          models: [
            {
              id: 'fake/embedder',
              endpoint: 'fake',
              deployment: 'd',
              residency: setup.residency ?? 'norway',
              apis: { embed: 'fake/embeddings@1' },
              embed: { dimensions: 2 },
              ...w.shared,
            },
          ],
        },
        adapters: [adapter],
        secrets: envSecrets({ K: 'k' }),
        ...(setup.routerResidency ? { maxResidency: setup.routerResidency } : {}),
      });
      return {
        ...w,
        call: async (text, extra = {}) => {
          const port = router.open({ kind: 'embedder', id: 'fake/embedder', tenant }, w.ctx, {
            ...(setup.requestResidency ? { maxResidency: setup.requestResidency } : {}),
          });
          const smuggled =
            extra.smuggle === 'field'
              ? [42]
              : extra.smuggle === 'url'
                ? [{ url: 'https://evil.example' }]
                : extra.smuggle === 'object-id'
                  ? [{ file_id: 'file-abc123' }]
                  : [];
          await port.embed([
            extra.media ? (image as unknown as string) : text,
            ...(smuggled as unknown as string[]),
          ]);
          return undefined;
        },
      };
    },
  };

  const rerank: GateLane = {
    port: 'rerank',
    operation: 'rerank',
    admission: 'admitted',
    tenant,
    has,
    answersWithText: false,
    refusalOf,
    open: (setup) => {
      const w = watched(setup);
      const adapter: RerankAdapter = {
        engine: 'fake',
        endpointOptions: z.object({}),
        rerankerOptions: z.object({}),
        connect: () => ({
          rerank: async (_reranker, request) => {
            w.upstream.push(request.query, ...request.documents);
            if (setup.failUpstream) throw new Error('the provider is down');
            return request.documents.map((_d, index) =>
              answering(setup, { index, score: 1, rank: index + 1 }),
            );
          },
        }),
      };
      const router = new RerankRouter({
        gate: w.gate,
        catalog: {
          endpoints: { fake: without(endpoint('fake'), 'protocol') },
          rerankers: [
            {
              id: 'fake/reranker',
              endpoint: 'fake',
              residency: setup.residency ?? 'norway',
              ...w.shared,
            },
          ],
        },
        adapters: [adapter],
        secrets: envSecrets({ K: 'k' }),
        ...(setup.routerResidency ? { maxResidency: setup.routerResidency } : {}),
      });
      return {
        ...w,
        call: async (text, extra = {}) => {
          const port = router.open({ kind: 'reranker', id: 'fake/reranker', tenant }, w.ctx);
          const result = await port.rerank({
            query: (extra.media
              ? image
              : extra.smuggle === 'url'
                ? { url: 'https://evil.example' }
                : text) as string,
            documents: [
              (extra.smuggle === 'object-id' ? { file_id: 'file-abc123' } : text) as string,
            ],
            ...(extra.smuggle === 'field' ? { model: 'other' } : {}),
          });
          if (result.degraded) throw new Error(result.degraded.message);
          return undefined;
        },
      };
    },
  };

  const descriptorLane = (tier: 'operation' | 'described'): GateLane => ({
    port: tier,
    operation: 'classify',
    admission: 'admitted',
    tenant,
    has: { ...has, enabled: true, provenance: true },
    answersWithText: false,
    refusalOf: (error) => (error instanceof GateError ? error.refusal : refusalOf(error)),
    open: (setup) => {
      const w = watched(setup);
      const fetcher: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { text: string };
        w.upstream.push(body.text);
        if (setup.failUpstream) return new Response('{}', { status: 503 });
        return Response.json(answering(setup, { label: 'billing', usage: { input_tokens: 1 } }));
      };
      const router = new ModelRouter({
        gate: { ...w.gate, egress: () => fetcher },
        catalog: {
          endpoints: { fake: connection('openai') },
          models: [
            {
              id: 'fake/described',
              endpoint: 'fake',
              deployment: 'd',
              residency: setup.residency ?? 'norway',
              apis: { classify: classifyDescriptor.id },
              ...w.shared,
            },
          ],
        },
        adapters: [fakeChatAdapter],
        secrets: envSecrets({ K: 'k' }),
        descriptors: descriptorRegistry([
          tier === 'operation' ? classifyDescriptor : reviewedClassify,
        ]),
        governance: {
          maturity: async () => 'production',
          processorRecorded: async () => true,
        },
        ...(setup.routerResidency ? { maxResidency: setup.routerResidency } : {}),
        classifications: {
          load: async () =>
            setup.enabled === false ? { 'fake/described': { enabled: false } } : {},
          save: async () => undefined,
        },
      });
      return {
        ...w,
        call: async (text, extra = {}) => {
          await router.refresh();
          const ports = tier === 'operation' ? router.operations() : router.described();
          const port = ports.open({ kind: 'model', id: 'fake/described', tenant }, w.ctx);
          await port.call(reviewedClassify.id, {
            text: extra.media ? image : text,
            label:
              extra.smuggle === 'url'
                ? 'https://evil.example'
                : extra.smuggle === 'object-id'
                  ? 'file-abc123'
                  : 'billing',
            ...(extra.smuggle === 'field' ? { store: true } : {}),
          });
          return undefined;
        },
      };
    },
  });

  return [
    model,
    decision,
    embedding,
    rerank,
    descriptorLane('operation'),
    descriptorLane('described'),
  ];
};

const subject: GateContractSubject = {
  lanes: routerLanes(),
  nationalIdGuard: () => modelGuard({ vault: createVault(['national-id']) }),
};

describe(`${gateContract.contract} contract: the model, decision, embedding and rerank routers and the descriptor executor`, () => {
  for (const check of gateContract.checks)
    it(check.name, async () => {
      await check.run(subject, new AbortController().signal);
    });
});

const dropped = <T extends object>(value: T, ...keys: string[]): T => {
  const copy = { ...value };
  for (const key of keys) Reflect.deleteProperty(copy, key);
  return copy;
};

interface Mutation {
  admits?: false;
  target?: (target: GateTarget) => GateTarget;
  ctx?: (ctx: PortContext) => PortContext;
  shape?: true;
}

const mutant =
  (mutation: Mutation): GateMaker =>
  (setup) => {
    const real = createGate(
      mutation.admits === false ? {} : { admits: () => setup.admitted ?? true },
    );
    const ctxOf = (ctx: PortContext) => mutation.ctx?.(ctx) ?? ctx;
    const targetOf = (target: GateTarget) => mutation.target?.(target) ?? target;
    const payloadOf = <Res>(payload: GatePayload<Res>): GatePayload<Res> =>
      mutation.shape ? { ...payload, shape: { request: shape.json, result: shape.json } } : payload;
    return {
      egress: real.egress,
      call: (ctx, target, payload, request, send) =>
        real.call(ctxOf(ctx), targetOf(target), payloadOf(payload), request, send),
      stream: (ctx, target, payload, request, send) =>
        real.stream(ctxOf(ctx), targetOf(target), payloadOf(payload), request, send),
    };
  };

const mutants: [string, Mutation][] = [
  ['admission', { admits: false }],
  ['the enabled check', { target: (t) => dropped(t, 'enabled') }],
  ['tenant sharing', { target: (t) => dropped(t, 'tenants') }],
  [
    'the residency ceilings',
    {
      target: (t) => dropped(t, 'routerResidency', 'requestResidency'),
      ctx: (c) => dropped(c, 'serviceResidency'),
    },
  ],
  ['the payload guards', { ctx: (c) => dropped(c, 'guards') }],
  ['the closed shapes', { shape: true }],
  ['metering', { ctx: (c) => ({ ...c, meter: async () => undefined }) }],
  ['provenance', { ctx: (c) => dropped(c, 'provenance') }],
  ['the audit event', { ctx: (c) => ({ ...c, audit: async () => undefined }) }],
];

describe(`${gateContract.contract} proves the routers hold no governance of their own`, () => {
  it('passes with the gate behind the same wrapper and nothing left out', async () => {
    const mutated: GateContractSubject = { ...subject, lanes: routerLanes(mutant({})) };
    for (const check of gateContract.checks) await check.run(mutated, new AbortController().signal);
  });

  for (const [name, mutation] of mutants)
    it(`fails when the gate leaves out ${name}`, async () => {
      const lanes = routerLanes(mutant(mutation));
      const mutated: GateContractSubject = { ...subject, lanes };
      const failed: string[] = [];
      for (const check of gateContract.checks)
        await check.run(mutated, new AbortController().signal).catch(() => {
          failed.push(check.name);
        });
      expect(failed).not.toEqual([]);
    });
});
