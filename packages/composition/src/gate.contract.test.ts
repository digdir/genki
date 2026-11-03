import { describe, it } from 'vitest';
import { z } from 'zod';
import type { Usage } from '@genai/contracts';
import { createVault, modelGuard } from '@genai/guardrails';
import {
  createGate,
  envSecrets,
  type GateRecord,
  type GateRefusal,
  type PortContext,
} from '@genai/kernel';
import {
  gateContract,
  type GateContractSubject,
  type GateLane,
  type GateLaneRun,
  type GateLaneSetup,
} from '@genai/kernel/gate-contract';
import { EmbeddingRouter, type EmbeddingAdapter } from '@genai/port-embedding';
import {
  ModelRouter,
  type ChatResult,
  type DecisionRequest,
  type ModelAdapter,
} from '@genai/port-model';
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
  return undefined;
};

const endpoint = (protocol: string) => ({
  protocol,
  engine: protocol,
  baseURL: 'https://provider.example',
  auth: { kind: 'api-key', secret: 'secret://env/k' },
});

const without = (value: Record<string, unknown>, key: string) => {
  const copy = { ...value };
  Reflect.deleteProperty(copy, key);
  return copy;
};

const lanes = () => {
  const watched = (setup: GateLaneSetup) => {
    const upstream: string[] = [];
    const metered: Usage[] = [];
    const audit: GateRecord[] = [];
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
      ...(setup.guards ? { guards: setup.guards } : {}),
      ...(setup.serviceResidency ? { serviceResidency: setup.serviceResidency } : {}),
    };
    const gate = createGate({ admits: () => setup.admitted ?? true });
    const shared = setup.sharedWith ? { tenants: setup.sharedWith } : {};
    return { upstream, metered, audit, ctx, gate, shared };
  };
  const has = { enabled: false, sharing: true, routerResidency: true, requestResidency: false };

  const model: GateLane = {
    port: 'model',
    operation: 'chat',
    admission: 'admitted',
    tenant,
    has: { ...has, enabled: true },
    answersWithText: true,
    refusalOf,
    open: (setup): GateLaneRun => {
      const w = watched(setup);
      const adapter: ModelAdapter = {
        protocol: 'fake',
        endpointOptions: z.object({}),
        modelOptions: z.object({}),
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
            return answer;
          },
          chatStream: async function* () {
            yield* [];
            throw new Error('not used');
          },
        }),
      };
      const router = new ModelRouter({
        gate: w.gate,
        admits: () => setup.admitted ?? true,
        catalog: {
          endpoints: { fake: without(endpoint('fake'), 'engine') },
          models: [
            {
              id: 'fake/model',
              endpoint: 'fake',
              deployment: 'd',
              residency: setup.residency ?? 'norway',
              capabilities: [],
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
          return (await port.chat({ messages: [{ role: 'user', content }] })).content;
        },
      };
    },
  };

  const decision: GateLane = {
    port: 'decision',
    operation: 'decide',
    admission: 'admitted',
    tenant,
    has: { ...has, enabled: true },
    answersWithText: false,
    refusalOf,
    open: (setup): GateLaneRun => {
      const w = watched(setup);
      const adapter: ModelAdapter = {
        protocol: 'fake',
        endpointOptions: z.object({}),
        modelOptions: z.object({}),
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
            return {
              answers: [{ type: 'predicate', name: 'purpose', probability: 0.9 }],
              usage: { inputTokens: 1, outputTokens: 0, requests: 1 },
              servedModel: 'fake',
              calibrated: true,
            };
          },
        }),
      };
      const router = new ModelRouter({
        gate: w.gate,
        admits: () => setup.admitted ?? true,
        catalog: {
          endpoints: { fake: without(endpoint('fake'), 'engine') },
          models: [
            {
              id: 'fake/decider',
              endpoint: 'fake',
              deployment: 'd',
              residency: setup.residency ?? 'norway',
              operations: ['chat', 'decide'],
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
            input: extra.media ? [{ role: 'user', content: image }] : text,
            questions: [{ type: 'predicate', name: 'purpose', instructions: 'Is this in scope?' }],
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
        protocol: 'fake',
        endpointOptions: z.object({}),
        modelOptions: z.object({}),
        connect: () => ({
          embed: async (_model, texts) => {
            w.upstream.push(...texts);
            if (setup.failUpstream) throw new Error('the provider is down');
            return { vectors: texts.map(() => [0.1, 0.2]), usage: { inputTokens: texts.length } };
          },
        }),
      };
      const router = new EmbeddingRouter({
        gate: w.gate,
        catalog: {
          endpoints: { fake: without(endpoint('fake'), 'engine') },
          models: [
            {
              id: 'fake/embedder',
              endpoint: 'fake',
              deployment: 'd',
              residency: setup.residency ?? 'norway',
              dimensions: 2,
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
          await port.embed([extra.media ? (image as unknown as string) : text]);
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
            return request.documents.map((_d, index) => ({ index, score: 1, rank: index + 1 }));
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
          await port.rerank({
            query: extra.media ? (image as unknown as string) : text,
            documents: [text],
          });
          return undefined;
        },
      };
    },
  };

  return [model, decision, embedding, rerank];
};

const subject: GateContractSubject = {
  lanes: lanes(),
  nationalIdGuard: () => modelGuard({ vault: createVault(['national-id']) }),
};

describe(`${gateContract.contract} contract: the model, decision, embedding and rerank routers`, () => {
  for (const check of gateContract.checks)
    it(check.name, async () => {
      await check.run(subject, new AbortController().signal);
    });
});
