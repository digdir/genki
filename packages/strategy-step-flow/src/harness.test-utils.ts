import { textPart, type Event, type Input, type Part, type Principal } from '@genai/contracts';
import { readFileSync } from 'node:fs';
import {
  stepFlowDefinition,
  strategyKey,
  validateYaml,
  type Definition,
  type PluginSchemas,
  type StepFlowDefinition,
} from '@genai/definitions';
import { z } from 'zod';
import { createKernel, type PortProvider, type Strategy } from '@genai/kernel';
import { ModelError, type ChatRequest, type ChatResult, type ModelPort } from '@genai/port-model';
import { ToolRegistry } from '@genai/port-tools';
import { builtinBlocks } from './builtins.js';
import type { BlockRegistry } from './blocks.js';
import { createStepFlow, stepFlowConfig } from './runtime.js';
import type { FlowChunk, FlowRetrieval } from './services.js';

export const tenant = '991825827';
export const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant,
};

export interface Truncated {
  truncated: string;
}

type Scripted = string | Error | Truncated;

export type Reply = Scripted | ((request: ChatRequest) => Scripted | Promise<Scripted>);

export const fakeModels = (
  script: Record<string, Reply[]>,
  options: { stream?: boolean; capabilities?: ('reasoning' | 'json-schema')[] } = {},
) => {
  const seen: { model: string; request: ChatRequest }[] = [];
  const counters: Record<string, number> = {};
  const answer = async (model: string, request: ChatRequest): Promise<ChatResult> => {
    seen.push({ model, request });
    const replies = script[model] ?? [];
    const i = counters[model] ?? 0;
    counters[model] = i + 1;
    const step = replies[Math.min(i, replies.length - 1)];
    if (step === undefined) throw new Error(`no scripted reply for ${model}`);
    const value = typeof step === 'function' ? await step(request) : step;
    if (value instanceof Error) throw value;
    const cut = typeof value === 'object';
    return {
      content: cut ? value.truncated : value,
      toolCalls: [],
      finishReason: cut ? 'length' : 'stop',
      usage: { inputTokens: 1, outputTokens: 1, requests: 1 },
      servedModel: model,
    };
  };
  const provider = {
    open: (ref: { id: string }): ModelPort => ({
      info: () => ({
        id: ref.id,
        residency: 'global',
        capabilities: [
          ...(options.stream ? (['stream'] as const) : []),
          ...(options.capabilities ?? ['json-schema']),
        ],
      }),
      chat: (request) => answer(ref.id, request),
      chatStream: async function* (request) {
        const result = await answer(ref.id, request);
        for (const word of result.content.split(/(?<= )/)) yield { kind: 'delta', text: word };
        yield { kind: 'done', result };
      },
    }),
  };
  return { provider, seen };
};

export const unavailable = () => new ModelError('unavailable', 'the model is down');

export const chunk = (id: string, extra: Partial<FlowChunk> = {}): FlowChunk => ({
  chunkId: id,
  content: `Tekst for ${id}.`,
  document: `d-${id}`,
  position: 0,
  title: `Dokument ${id}`,
  url: `https://kudos.dfo.no/${id}`,
  headers: ['Kapittel'],
  ...extra,
});

export const stubRetrieval = (chunks: FlowChunk[], reranked?: FlowChunk[]) => {
  const calls: { method: string; args: unknown[] }[] = [];
  const configs: unknown[] = [];
  const backend: FlowRetrieval = {
    plan: async (query, history) => {
      calls.push({ method: 'plan', args: [query, history] });
      return { queries: [query, `${query} utvidet`], userIntent: query };
    },
    retrieve: async (queries, options) => {
      calls.push({ method: 'retrieve', args: [queries, options] });
      return { chunks };
    },
    rerank: async (query, input) => {
      calls.push({ method: 'rerank', args: [query, input.map((c) => c.chunkId)] });
      return reranked ?? input;
    },
  };
  return {
    calls,
    configs,
    factory: (_ctx: unknown, config: unknown) => {
      configs.push(config);
      return backend;
    },
  };
};

export const flowFrom = (doc: Record<string, unknown>): StepFlowDefinition =>
  stepFlowDefinition.parse({ apiVersion: 'genai/v1', kind: 'StepFlow', ...doc });

export const steps = (id: string, list: unknown[], purpose = 'Test'): StepFlowDefinition =>
  flowFrom({ metadata: { tenant, id }, spec: { purpose, steps: list } });

export interface RunOptions {
  flows: StepFlowDefinition[];
  entry: string;
  models?: ReturnType<typeof fakeModels>;
  retrieval?: ReturnType<typeof stubRetrieval>;
  agent?: Strategy<unknown>;
  tools?: PortProvider;
  config?: Record<string, unknown>;
  strategy?: Record<string, unknown>;
  blocks?: BlockRegistry;
  fallback?: boolean;
}

export const setup = (options: RunOptions) => {
  const byRef = new Map(options.flows.map((f) => [`${f.metadata.id}@1`, f]));
  const strategy = createStepFlow({
    blocks: options.blocks ?? builtinBlocks(),
    flows: (ref, owner) => (owner === tenant ? byRef.get(ref) : undefined),
    now: () => new Date('2026-10-06T10:00:00Z'),
    ...(options.retrieval ? { retrieval: options.retrieval.factory } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
  });
  const models = options.models ?? fakeModels({});
  const modelRef = (id: string) => ({ kind: 'model', id, tenant });
  const kernel = createKernel({
    strategies: [strategy],
    capabilities: [
      {
        descriptor: {
          id: 'flow',
          version: '1',
          tenant,
          title: 'flow',
          description: 'flow',
          input: {},
          interaction: ['unary'],
          accepts: ['text/plain'],
          produces: ['text/plain'],
          emits: [],
          oversight: { interrupts: true, riskClass: 'limited', aiDisclosure: 'KI' },
        },
        strategy: { id: 'step-flow', version: '1' },
        config: {
          strategy: { flow: options.entry, ...options.strategy },
          model: {
            primary: 'primary',
            ...(options.fallback ? { fallback: 'fallback' } : {}),
            tenant,
          },
          knowledge: { datasets: [{ dataset: 'digdir/kudos' }], retrieval: { maxPerDocument: 10 } },
          ...options.config,
        },
        grants: [
          { port: 'model', ref: modelRef('primary') },
          { port: 'model', ref: modelRef('fallback') },
          ...((options.config?.tools as string[] | undefined) ?? []).map((id) => ({
            port: 'tools',
            ref: { kind: 'tool', id, tenant },
          })),
        ],
      },
    ],
    ports: {
      model: models.provider,
      tools: options.tools ?? new ToolRegistry(),
    },
    policy: { decide: async () => ({ allow: true }) },
  });
  return { kernel, models };
};

export const collect = async (events: AsyncIterable<Event>) => {
  const out: Event[] = [];
  for await (const e of events) out.push(e);
  return out;
};

export const run = async (
  options: RunOptions,
  input: Input = { parts: [textPart('Hva sier kildene?')] },
) => {
  const { kernel, models } = setup(options);
  const started = await kernel.invoke(kari, 'flow', input);
  const result = await started.result.catch((e: unknown) => e);
  const events = await collect(started.events);
  const task = await kernel.task(kari, started.task);
  return { kernel, models, task, events, result, taskId: started.task };
};

export const notices = (events: Event[]) =>
  events.filter((e) => e.type === 'kernel.notice').map((e) => e.data as Record<string, unknown>);

export const textOf = (parts: unknown) =>
  (parts as Part[]).flatMap((p) => (p.body.kind === 'text' ? [p.body.text] : [])).join('');

export const plugins: PluginSchemas = {
  strategies: new Map<string, z.ZodType>([[strategyKey('step-flow', 1), stepFlowConfig]]),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(builtinBlocks().refs()),
  models: new Map([
    [
      'foundry-openai/gpt-4o-2m-tps',
      { residency: 'global', capabilities: ['stream', 'tools', 'json-schema'] },
    ],
  ]),
  retrieval: z.unknown(),
  rerankers: new Set(['colbert']),
  datasets: new Set(['digdir/kudos']),
};

export const loadDefinition = (path: string): Definition => {
  const result = validateYaml(readFileSync(path, 'utf8'), plugins);
  if (!result.ok) throw new Error(`${path}: ${JSON.stringify(result.errors)}`);
  return result.definition;
};

export const loadFlow = (path: string): StepFlowDefinition => {
  const definition = loadDefinition(path);
  if (definition.kind !== 'StepFlow') throw new Error(`${path} is not a step flow`);
  return definition;
};
