import type { Event, Part, Principal } from '@genai/contracts';
import { createKernel, type Capability, type PortProvider } from '@genai/kernel';
import type { ChatRequest, ChatResult, ModelPort, ToolCall } from '@genai/port-model';
import { ToolRegistry } from '@genai/port-tools';
import {
  createAgentLoop,
  evaluatorSystemPrompt,
  exhaustionNudge,
  readEvaluatorSystemPrompt,
  SOURCES_MIME,
  type AgentLoopRuntimeConfig,
  type AgentRetrieval,
  type Chunk,
  type SourceRecord,
} from './index.js';

export const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant: '991825827',
};

export const result = (content: string, toolCalls: ToolCall[] = []): ChatResult => ({
  content,
  toolCalls,
  finishReason: toolCalls.length ? 'tool_calls' : 'stop',
  usage: { inputTokens: 10, outputTokens: 5, requests: 1 },
  servedModel: 'served',
});

let callId = 0;
export const call = (name: string, args: unknown): ToolCall => ({
  id: `call_${(callId += 1)}`,
  name,
  arguments: JSON.stringify(args),
});

const section = (prompt: string, title: string) => {
  const start = prompt.indexOf(`${title}\n`);
  if (start < 0) return undefined;
  const rest = prompt.slice(start + title.length + 1);
  return rest.slice(0, rest.indexOf('\n\n') >= 0 ? rest.indexOf('\n\n') : undefined);
};

export const allSupported = (prompt: string) => {
  const plan = JSON.parse(section(prompt, 'Evidence plan JSON:') ?? '{"required_claims":[]}') as {
    required_claims: { claim_id: string }[];
  };
  const chunks = JSON.parse(section(prompt, 'Newly read chunks JSON:') ?? '[]') as {
    chunk_id: string;
  }[];
  return JSON.stringify({
    status: 'support-found',
    scope_assessment: 'aligned',
    supported_claims: plan.required_claims.map((c) => ({
      claim_id: c.claim_id,
      support: 'explicit',
      chunk_ids: chunks.map((x) => x.chunk_id),
    })),
    remaining_gaps: [],
    contradictions: [],
    next_action_hint: 'finalize',
    confidence: 0.9,
  });
};

export const readSignal = (status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    status,
    scope_assessment: 'aligned',
    supported_claims: [],
    remaining_gaps: [
      { claim_id: 'answer-bearing-evidence', reason: 'not-addressed', critical: true },
    ],
    contradictions: [],
    next_action_hint: 'read-more',
    confidence: 0.8,
    ...extra,
  });

export const decision = (status: string, strategy: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    status,
    reasoning: `${status} by test`,
    missing_info: status === 'sufficient' ? [] : ['the requested figure'],
    contradiction_detected: false,
    suggested_strategy: strategy,
    ...extra,
  });

type Step = (request: ChatRequest, signal: AbortSignal) => ChatResult | Promise<ChatResult>;

export interface Script {
  loop: Step[];
  synth?: ((request: ChatRequest) => string)[];
  read?: ((prompt: string) => string)[];
  sufficiency?: ((prompt: string) => string)[];
  deltas?: string[];
  failFirst?: Error;
}

export const models = (scripts: Record<string, Script>, stream = false) => {
  const seen: { model: string; kind: string; request: ChatRequest }[] = [];
  const counters = Object.fromEntries(
    Object.keys(scripts).map((k) => [k, { loop: 0, synth: 0, read: 0, sufficiency: 0 }]),
  );
  let failed = false;
  const provider: PortProvider<ModelPort> = {
    open: (ref, ctx) => {
      const script = scripts[ref.id];
      const n = counters[ref.id];
      if (!script || !n) throw new Error(`no model ${ref.id}`);
      const pick = <T>(list: T[] | undefined, key: 'synth' | 'read' | 'sufficiency') => {
        const item = list?.[n[key]] ?? list?.at(-1);
        n[key] += 1;
        return item;
      };
      const next = async (request: ChatRequest): Promise<ChatResult> => {
        if (script.failFirst && !failed) {
          failed = true;
          throw script.failFirst;
        }
        const system = request.messages[0]?.content;
        const user = request.messages[1]?.content ?? '';
        if (request.tools) {
          seen.push({ model: ref.id, kind: 'loop', request });
          const step = script.loop[n.loop] ?? script.loop.at(-1);
          n.loop += 1;
          if (!step) throw new Error('script ran out');
          return step(request, ctx.signal);
        }
        if (system === readEvaluatorSystemPrompt) {
          seen.push({ model: ref.id, kind: 'read', request });
          return result((pick(script.read, 'read') ?? allSupported)(user));
        }
        if (system === evaluatorSystemPrompt) {
          seen.push({ model: ref.id, kind: 'sufficiency', request });
          return result(
            (pick(script.sufficiency, 'sufficiency') ?? (() => decision('sufficient', 'finalize')))(
              user,
            ),
          );
        }
        if (request.messages.at(-1)?.content === exhaustionNudge) {
          seen.push({ model: ref.id, kind: 'final', request });
          return result('Beste svar ut fra det jeg fant.');
        }
        seen.push({ model: ref.id, kind: 'synth', request });
        const synth = pick(script.synth, 'synth');
        return result(synth ? synth(request) : 'Svar [1].');
      };
      return {
        info: () => ({
          id: ref.id,
          residency: 'norway',
          capabilities: stream ? ['stream', 'tools'] : ['tools'],
        }),
        chat: async (request) => {
          const r = await next(request);
          await ctx.meter(r.usage, ref);
          return r;
        },
        chatStream: async function* (request) {
          const r = await next(request);
          for (const text of request.tools ? [r.content] : (scripts[ref.id]?.deltas ?? [r.content]))
            yield { kind: 'delta' as const, text };
          yield { kind: 'done' as const, result: r };
        },
      };
    },
  };
  return { provider, seen };
};

export const chunk = (n: number, extra: Partial<Chunk> = {}): Chunk => ({
  chunkId: `c${n}`,
  document: `d${n}`,
  position: 0,
  totalChunks: 20,
  title: `Rapport ${n}`,
  url: `https://kudos.dfo.no/d${n}`,
  content: `Innhold i chunk ${n}.`,
  ...extra,
});

export const retrieval = (
  overrides: Partial<AgentRetrieval> = {},
  store = new Map([1, 2, 3, 4, 5].map((n) => [`c${n}`, chunk(n)])),
) => {
  const calls: { op: string; args: unknown }[] = [];
  const impl: AgentRetrieval = {
    search: async (queries, options) => {
      calls.push({ op: 'search', args: { queries, ...options } });
      return {
        chunks: [...store.values()].map(({ content: _c, ...summary }, i) => ({
          ...summary,
          rank: i + 1,
          score: 1 - i / 10,
        })),
        attribution: { phrase: 3, metadata: 1, content: 1 },
      };
    },
    read: async (ids) => {
      calls.push({ op: 'read', args: ids });
      return ids.flatMap((id) => (store.has(id) ? [store.get(id) as Chunk] : []));
    },
    readRange: async (doc, from, to) => {
      calls.push({ op: 'range', args: [doc, from, to] });
      return [...store.values()].filter(
        (c) => c.document === doc && (c.position ?? 0) >= from && (c.position ?? 0) <= to,
      );
    },
    plan: async (query) => {
      calls.push({ op: 'plan', args: query });
      return {
        queries: ['Hva sier tildelingsbrevet?', 'tildelingsbrev 2025', 'Digdir oppdrag'],
        userIntent: 'Hva sier tildelingsbrevet?',
      };
    },
    rerank: async (query, chunks) => {
      calls.push({ op: 'rerank', args: query });
      return [...chunks].reverse();
    },
    filterFields: async () => [{ field: 'orgs_short', type: 'string[]', valueType: 'string' }],
    facets: async (fields) =>
      Object.fromEntries(fields.map((f) => [f, [{ value: 'DIGDIR', count: 12 }]])),
    ...overrides,
  };
  return { impl, calls };
};

export const capability = (config: AgentLoopRuntimeConfig, tools: string[] = []): Capability => ({
  descriptor: {
    id: 'ka',
    version: '1',
    tenant: '991825827',
    title: 'KA',
    description: 'KA',
    input: {},
    interaction: ['unary', 'stream'],
    accepts: [],
    produces: [],
    emits: [],
    oversight: { interrupts: false, riskClass: 'limited', aiDisclosure: 'KI' },
  },
  strategy: { id: 'agent-loop', version: '1' },
  config,
  grants: [
    { port: 'model', ref: { kind: 'model', id: 'primary', tenant: '991825827' } },
    { port: 'model', ref: { kind: 'model', id: 'fallback', tenant: '991825827' } },
    ...tools.map((t) => ({ port: 'tools', ref: { kind: 'tool', id: t, tenant: '991825827' } })),
  ],
});

export const baseConfig: AgentLoopRuntimeConfig = {
  strategy: { budget: { searches: 4, reads: 6, readChars: 12000 } },
  model: { primary: 'primary', fallback: 'fallback', tenant: '991825827' },
};

export const run = async (opts: {
  scripts: Record<string, Script>;
  retrieval?: AgentRetrieval;
  config?: AgentLoopRuntimeConfig;
  stream?: boolean;
  registry?: ToolRegistry;
  tools?: string[];
  question?: string;
  overrides?: Record<string, unknown>;
  parts?: Part[];
}) => {
  const r = opts.retrieval ?? retrieval().impl;
  const requests: unknown[] = [];
  const { provider, seen } = models(opts.scripts, opts.stream);
  const kernel = createKernel({
    strategies: [
      createAgentLoop({
        retrieval: (_ctx, _config, request) => {
          requests.push(request);
          return r;
        },
        now: () => new Date('2026-10-06T10:00:00Z'),
      }),
    ],
    capabilities: [capability(opts.config ?? baseConfig, opts.tools)],
    ports: { model: provider, tools: opts.registry ?? new ToolRegistry() },
    policy: { decide: async () => ({ allow: true }) },
  });
  const started = await kernel.invoke(kari, 'ka', {
    data: {
      query: opts.question ?? 'Hva sier tildelingsbrevet til Digdir for 2025?',
      history: [],
      ...(opts.overrides ? { overrides: opts.overrides } : {}),
    },
    ...(opts.parts ? { parts: opts.parts } : {}),
  });
  const events: Event[] = [];
  for await (const e of started.events) events.push(e);
  const parts = await started.result.catch(() => undefined);
  const task = await kernel.task(kari, started.task);
  const answer = parts?.find((p) => p.mime === 'text/plain');
  const body = (
    parts?.find((p) => p.mime === SOURCES_MIME)?.body as
      | {
          json: {
            sources: SourceRecord[];
            clarification?: unknown;
            filtersApplied?: unknown[];
            insufficient?: boolean;
            executionMetadata?: Record<string, unknown>;
          };
        }
      | undefined
  )?.json;
  const loops = seen.filter((s) => s.kind === 'loop').map((s) => s.request);
  return {
    events,
    requests,
    task,
    seen,
    loops,
    sources: body?.sources ?? [],
    clarification: body?.clarification,
    filtersApplied: body?.filtersApplied,
    insufficient: body?.insufficient,
    executionMetadata: body?.executionMetadata,
    text: answer?.body.kind === 'text' ? answer.body.text : undefined,
    meta: answer?.meta,
    notices: events
      .filter((e) => e.type === 'kernel.notice')
      .map((e) => e.data as Record<string, unknown>),
  };
};

export const toolMessages = (request: ChatRequest | undefined) =>
  (request?.messages ?? []).flatMap((m) => (m.role === 'tool' ? [m.content] : []));

export const systemMessages = (request: ChatRequest | undefined) =>
  (request?.messages ?? []).slice(1).flatMap((m) => (m.role === 'system' ? [m.content] : []));
