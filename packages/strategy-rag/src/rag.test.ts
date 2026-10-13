import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { Event, Part, Principal } from '@genai/contracts';
import { catalogueSettings, serviceDefinition } from '@genai/definitions';
import { createKernel, type Capability, type PortProvider } from '@genai/kernel';
import {
  defaultMaxOutputTokens,
  ModelError,
  type ChatRequest,
  type ChatResult,
  type ModelPort,
} from '@genai/port-model';
import { SOURCES_MIME, type Chunk, type SourceRecord } from '@genai/strategy-agent-loop';
import {
  createRagSingleShot,
  ragConfig,
  RETRIEVAL_MIME,
  type RagRetrieval,
  type RagRuntimeConfig,
} from './index.js';

const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' };

const chunk = (n: number): Chunk => ({
  chunkId: `c${n}`,
  document: `d${n}`,
  position: n,
  title: `Rapport ${n}`,
  url: `https://kudos.dfo.no/d${n}`,
  content: `Innhold ${n}.`,
  score: 1 / n,
});

const retrieval = (overrides: Partial<RagRetrieval> = {}) => {
  const calls: { op: string; args: unknown }[] = [];
  const impl: RagRetrieval = {
    plan: async (query) => {
      calls.push({ op: 'plan', args: query });
      return {
        queries: ['tildelingsbrev 2025', 'Digdir'],
        userIntent: 'Hva sier tildelingsbrevet?',
      };
    },
    retrieve: async (queries, options) => {
      calls.push({ op: 'retrieve', args: { queries, ...options } });
      return { chunks: [1, 2, 3, 4].map(chunk), attribution: { phrase: 3, content: 1 } };
    },
    rerank: async (query, chunks) => {
      calls.push({ op: 'rerank', args: query });
      return [...chunks].reverse();
    },
    ...overrides,
  };
  return { impl, calls };
};

const model = (answer: string, opts: { stream?: boolean; fail?: ModelError } = {}) => {
  const seen: ChatRequest[] = [];
  const provider: PortProvider<ModelPort> = {
    open: (ref, ctx) => {
      const result = async (request: ChatRequest): Promise<ChatResult> => {
        seen.push(request);
        if (opts.fail && ref.id === 'primary') throw opts.fail;
        return {
          content: answer,
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 3, outputTokens: 2, requests: 1 },
          servedModel: ref.id,
        };
      };
      return {
        info: () => ({
          id: ref.id,
          residency: 'norway',
          capabilities: opts.stream ? ['stream'] : [],
        }),
        chat: async (request) => {
          const r = await result(request);
          await ctx.meter(r.usage, ref);
          return r;
        },
        chatStream: async function* (request) {
          const r = await result(request);
          for (const piece of answer.split(' '))
            yield { kind: 'delta' as const, text: `${piece} ` };
          yield { kind: 'done' as const, result: r };
        },
      };
    },
  };
  return { provider, seen };
};

const capability = (config: RagRuntimeConfig): Capability => ({
  descriptor: {
    id: 'ka-retrieve',
    version: '1',
    tenant: '991825827',
    title: 'KA retrieve-only',
    description: 'KA retrieve-only',
    input: {},
    interaction: ['unary'],
    accepts: [],
    produces: [],
    emits: [],
    oversight: { interrupts: false, riskClass: 'limited', aiDisclosure: 'KI' },
  },
  strategy: { id: 'rag-single-shot', version: '1' },
  config,
  grants: [
    { port: 'model', ref: { kind: 'model', id: 'primary', tenant: '991825827' } },
    { port: 'model', ref: { kind: 'model', id: 'fallback', tenant: '991825827' } },
  ],
});

const run = async (
  config: RagRuntimeConfig,
  r = retrieval().impl,
  m = model('Svar [3] og [1].'),
  attached: Part[] = [],
) => {
  const kernel = createKernel({
    strategies: [
      createRagSingleShot({ retrieval: () => r, now: () => new Date('2026-10-06T10:00:00Z') }),
    ],
    capabilities: [capability(config)],
    ports: { model: m.provider },
    policy: { decide: async () => ({ allow: true }) },
  });
  const started = await kernel.invoke(kari, 'ka-retrieve', {
    data: { query: 'Hva sier tildelingsbrevet?', history: [] },
    parts: [
      { mime: 'text/plain', body: { kind: 'text', text: 'Hva sier tildelingsbrevet?' } },
      ...attached,
    ],
  });
  const events: Event[] = [];
  for await (const e of started.events) events.push(e);
  const parts = await started.result;
  const json = (mime: string) =>
    (parts.find((p) => p.mime === mime)?.body as { json: unknown } | undefined)?.json;
  return {
    events,
    parts,
    seen: m.seen,
    sources: (json(SOURCES_MIME) as { sources: SourceRecord[] }).sources,
    retrieval: json(RETRIEVAL_MIME),
    text: parts.find((p) => p.mime === 'text/plain'),
  };
};

describe('rag-single-shot strategy', () => {
  it('gives an attached document to the model as source [1] before the search results, and searches as before', async () => {
    const r = retrieval();
    const letter: Part = {
      mime: 'text/markdown',
      body: { kind: 'text', text: 'Fristen er 1. mars.' },
      meta: { attached: true, name: 'brev.md', sha256: 'abc' },
    };
    const out = await run(
      { strategy: { topK: 2 }, model: { primary: 'primary', tenant: '991825827' } },
      r.impl,
      model('Fristen er 1. mars [1].'),
      [letter],
    );

    expect(r.calls.map((c) => c.op)).toEqual(['plan', 'retrieve', 'rerank']);
    expect(r.calls[0]?.args).toBe('Hva sier tildelingsbrevet?');
    expect(JSON.stringify(out.seen[0]?.messages)).toContain('[1] Fristen er 1. mars.');
    expect(out.sources.map((s) => [s.chunkId, s.title])).toEqual([
      ['attached:abc:0', 'brev.md'],
      ['c4', 'Rapport 4'],
      ['c3', 'Rapport 3'],
    ]);
    expect(out.text?.meta?.citations).toEqual([{ index: 1, chunkId: 'attached:abc:0' }]);
  });

  it('plans, retrieves and reranks without generating, like headless-rag retrieve-only', async () => {
    const r = retrieval();
    const out = await run({ strategy: { topK: 3 } }, r.impl);

    expect(r.calls.map((c) => c.op)).toEqual(['plan', 'retrieve', 'rerank']);
    expect(r.calls[1]?.args).toEqual({
      queries: ['tildelingsbrev 2025', 'Digdir'],
      userIntent: 'Hva sier tildelingsbrevet?',
    });
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c4', 'c3', 'c2']);
    expect(out.retrieval).toEqual({
      queries: ['tildelingsbrev 2025', 'Digdir'],
      userIntent: 'Hva sier tildelingsbrevet?',
      attribution: { phrase: 3, content: 1 },
    });
    expect(out.text).toBeUndefined();
    expect(out.seen).toHaveLength(0);
  });

  it('passes the version and publish date of each source on to the sources part', async () => {
    const r = retrieval({
      retrieve: async () => ({
        chunks: [{ ...chunk(1), version: '2', publishedAt: '2025-01-15' }, chunk(2)],
        attribution: {},
      }),
      rerank: async (_q, chunks) => chunks,
    });
    const out = await run({ strategy: { topK: 2 } }, r.impl);

    expect(out.sources[0]).toMatchObject({
      chunkId: 'c1',
      version: '2',
      publishedAt: '2025-01-15',
    });
    expect(out.sources[1]).not.toHaveProperty('publishedAt');
  });

  it('generates by default when a model is configured', async () => {
    const out = await run({ strategy: {}, model: { primary: 'primary', tenant: '991825827' } });

    expect(out.text?.body).toEqual({ kind: 'text', text: 'Svar [3] og [1].' });
    expect(out.seen).toHaveLength(1);
  });

  it('stays retrieve-only with a model when generate is false', async () => {
    const out = await run({
      strategy: { generate: false },
      model: { primary: 'primary', tenant: '991825827' },
    });

    expect(out.text).toBeUndefined();
    expect(out.seen).toHaveLength(0);
  });

  it('reports what was retrieved in a retrieval notice', async () => {
    const out = await run({ strategy: {} });

    const notice = out.events.find(
      (e) => e.type === 'kernel.notice' && (e.data as { kind?: string }).kind === 'retrieval',
    );
    expect((notice?.data as { hits: { id: string }[] }).hits).toEqual([
      { id: 'c1', document: 'd1', position: 1, score: 1, title: 'Rapport 1' },
      { id: 'c2', document: 'd2', position: 2, score: 0.5, title: 'Rapport 2' },
      { id: 'c3', document: 'd3', position: 3, score: 1 / 3, title: 'Rapport 3' },
      { id: 'c4', document: 'd4', position: 4, score: 0.25, title: 'Rapport 4' },
    ]);
    expect(notice?.data).toMatchObject({ queries: expect.any(Array) });
    expect(
      out.events
        .filter((e) => e.type === 'kernel.notice')
        .map((e) => (e.data as { kind?: string }).kind),
    ).toEqual(['plan', 'retrieval', 'rerank', 'read']);
  });

  it('generates once with numbered context, keeping the streamed numbers and publishing every numbered source in order', async () => {
    const m = model('Svar [3] og [1].', { stream: true });
    const out = await run(
      { strategy: { generate: true }, model: { primary: 'primary', tenant: '991825827' } },
      undefined,
      m,
    );

    const deltas = out.events
      .filter((e) => e.type === 'kernel.part.delta')
      .map((e) => (e.data as { text: string }).text);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('').trim()).toBe('Svar [3] og [1].');
    expect(out.text?.body).toEqual({ kind: 'text', text: 'Svar [3] og [1].' });
    expect(out.text?.meta).toEqual({
      citations: [
        { index: 1, chunkId: 'c4' },
        { index: 3, chunkId: 'c2' },
      ],
    });
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c4', 'c3', 'c2', 'c1']);
    expect(out.seen[0]?.messages[1]?.content).toContain('[1] Innhold 4.\n\n[2] Innhold 3.');
  });

  it('caps the answer at the platform default when no limit is configured', async () => {
    const m = model('Svar [1].');
    await run(
      { strategy: { generate: true }, model: { primary: 'primary', tenant: '991825827' } },
      undefined,
      m,
    );

    expect(m.seen[0]?.maxTokens).toBe(defaultMaxOutputTokens);
    expect(catalogueSettings.find((s) => s.key === 'synthesis.maxTokens')?.default).toBe(
      defaultMaxOutputTokens,
    );
  });

  it('drops a bare source list line from a refusal, so it cites nothing', async () => {
    const m = model('Det kan jeg ikke hjelpe med.\n\nKilder: [1]-[4]', { stream: true });
    const out = await run(
      { strategy: { generate: true }, model: { primary: 'primary', tenant: '991825827' } },
      undefined,
      m,
    );

    const streamed = out.events
      .filter((e) => e.type === 'kernel.part.delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(streamed).not.toContain('Kilder');
    expect(out.text?.body).toEqual({ kind: 'text', text: 'Det kan jeg ikke hjelpe med.' });
    expect(out.text?.meta).toEqual({ citations: [] });
  });

  it('falls back to the raw question when planning fails and keeps retrieval order when reranking fails', async () => {
    const r = retrieval({
      plan: async () => {
        throw new Error('planner down');
      },
      rerank: async () => {
        throw new Error('colbert down');
      },
    });
    const out = await run({ strategy: { topK: 2 } }, r.impl);

    expect(
      (r.calls.find((c) => c.op === 'retrieve')?.args as { queries: string[] }).queries,
    ).toEqual(['Hva sier tildelingsbrevet?']);
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c2']);
  });

  it('limits the answer context by window and documents, writes with the synthesis model and caps its tokens', async () => {
    const m = model('Svar [1].', { fail: new ModelError('bad_request', 'not this model') });
    const out = await run(
      {
        strategy: {
          generate: true,
          topK: 10,
          contextTopK: 3,
          maxDocs: 2,
          synthesisMaxTokens: 300,
        },
        model: { primary: 'primary', tenant: '991825827', roles: { synthesis: 'fallback' } },
      },
      undefined,
      m,
    );

    expect(out.text?.body).toEqual({ kind: 'text', text: 'Svar [1].' });
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c4', 'c3']);
    expect(m.seen).toHaveLength(1);
    expect(m.seen[0]?.maxTokens).toBe(300);
  });

  it('uses the fallback model when the primary is unavailable', async () => {
    const m = model('Svar [1].', { fail: new ModelError('unavailable', 'down') });
    const out = await run(
      {
        strategy: { generate: true },
        model: { primary: 'primary', fallback: 'fallback', tenant: '991825827' },
      },
      undefined,
      m,
    );

    expect(out.text?.body).toEqual({ kind: 'text', text: 'Svar [1].' });
    expect(m.seen).toHaveLength(2);
  });

  it('accepts the Kunnskapsassistenten example config', () => {
    const file = join(
      import.meta.dirname,
      '..',
      '..',
      'definitions',
      'examples',
      'kunnskapsassistenten.yaml',
    );
    const definition = serviceDefinition.parse(parseYaml(readFileSync(file, 'utf8')));
    expect(ragConfig.safeParse(definition.spec.strategy.config).success).toBe(true);
  });
});

describe('rag-single-shot skills', () => {
  const generating: RagRuntimeConfig = {
    strategy: { generate: true, instructions: 'Svar kort.' },
    model: { primary: 'primary', tenant: '991825827' },
  };

  it('a service without skills gets exactly the same prompt as before', async () => {
    const before = await run(generating, undefined, model('Svar [1].'));
    const empty = await run({ ...generating, skills: [] }, undefined, model('Svar [1].'));

    expect(empty.seen).toEqual(before.seen);
    expect(before.seen[0]?.messages[0]).toEqual({ role: 'system', content: 'Svar kort.' });
  });

  it('appends a Ferdigheter section to the system prompt', async () => {
    const out = await run(
      {
        ...generating,
        skills: [
          {
            ref: 'klarsprak@1',
            name: 'klarsprak',
            description: 'Klarspråk.',
            instructions: 'Bruk korte setninger.',
            examples: [],
          },
        ],
      },
      undefined,
      model('Svar [1].'),
    );

    expect(out.seen[0]?.messages[0]?.content).toBe(
      'Svar kort.\n\n# Ferdigheter\n\n## klarsprak\nKlarspråk.\n\nBruk korte setninger.',
    );
  });
});
