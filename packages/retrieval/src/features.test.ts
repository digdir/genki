import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { envSecrets, type PortContext } from '@genai/kernel';
import {
  KnowledgeRouter,
  type Hit,
  type KnowledgeAdapter,
  type SearchRequest,
} from '@genai/port-knowledge';
import type { ChatRequest, ModelPort } from '@genai/port-model';
import { RerankRouter, type RerankAdapter, type RerankRequest } from '@genai/port-rerank';
import { retrieve } from './pipeline.js';
import { autoFilterRule, detectFromRules, javaRegex, type AutoFilterRule } from './rules.js';

const ctx: PortContext = {
  tenant: '991825827',
  principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
  task: 't1',
  signal: new AbortController().signal,
  meter: async () => undefined,
};

const language = autoFilterRule.parse({
  type: 'marker-word-classify',
  field: 'language',
  minTokens: 3,
  thresholdRatio: 2.0,
  values: {
    nb: {
      requiresChars: '[æøå]',
      markerWords: [
        'hvordan',
        'hva',
        'hvor',
        'når',
        'hvorfor',
        'og',
        'eller',
        'ikke',
        'jeg',
        'meg',
        'deg',
        'vi',
        'den',
        'det',
        'som',
        'for',
        'med',
        'uten',
        'er',
        'har',
        'kan',
        'skal',
        'vil',
        'må',
        'fra',
        'til',
        'av',
        'noe',
        'noen',
        'også',
      ],
    },
    en: {
      markerWords: [
        'how',
        'what',
        'where',
        'when',
        'why',
        'and',
        'or',
        'not',
        'the',
        'is',
        'are',
        'was',
        'be',
        'i',
        'you',
        'we',
        'they',
        'for',
        'with',
        'from',
        'can',
        'could',
        'should',
        'would',
        'may',
        'do',
        'does',
        'did',
        'this',
        'that',
        'these',
        'using',
      ],
    },
  },
});

const diataxis = autoFilterRule.parse({
  type: 'shape-pattern',
  field: 'diataxis',
  mode: 'permissive',
  universe: ['explanation', 'how-to-guides', 'reference', 'tutorials'],
  patterns: [
    {
      value: 'explanation',
      regex: '(?i)^\\s*(what\\s+is|hva\\s+er|hva\\s+vil\\s+det\\s+si|define|explain)',
    },
    {
      value: 'how-to-guides',
      regex: '(?i)^\\s*(how\\s+(do|can|to|should)|hvordan(\\s+\\w+){0,2}\\s+(jeg|man|setter|kan))',
    },
    {
      value: 'reference',
      regex:
        '(?i)^\\s*(what\\s+are\\s+the|list\\s+(of|all|the)|which\\s+values|hvilke\\s+verdier|hvilke\\s+\\w+\\s+finnes)',
    },
  ],
});

const detect = (rule: AutoFilterRule, query: string, model?: ModelPort) =>
  detectFromRules([rule], [query], model);

describe('auto-filter rules (ported from auto_filter_rules_test)', () => {
  it.each([
    ['What is Dialogporten and what problem does it solve?', 'en'],
    ['How do I create a new dialog as a service owner in Dialogporten?', 'en'],
    ['Hvordan setter jeg opp autentisering for en Altinn-app i utviklingsmiljøet?', 'nb'],
    [
      'Når går Altinn over fra Altinn-roller til Tilgangspakker, og hva er de mest betydningsfulle endringene for tjenesteeiere?',
      'nb',
    ],
    ['Hva er forskjellen mellom Altinn-roller for personer og virksomheter?', 'nb'],
    [
      "Compare how Altinn Studio v7 and v8 handle data model definition — what's the migration story?",
      'en',
    ],
    ['Does Altinn support webhook signatures using HMAC-SHA512?', 'en'],
    ['må jeg ha', 'nb'],
    ['is can the', 'en'],
  ])('classifies the language of %j as %s', async (query, expected) => {
    expect(await detect(language, query)).toEqual({ language: [expected] });
  });

  it('skips short and ambiguous queries', async () => {
    expect(await detect({ ...language, minTokens: 5 } as AutoFilterRule, 'short query')).toEqual(
      {},
    );
    expect(await detect(language, 'is altinn fast')).toEqual({});
  });

  it.each([
    [
      'What is Dialogporten and what problem does it solve?',
      ['how-to-guides', 'reference', 'tutorials'],
    ],
    ['How do I create a new dialog as a service owner?', ['explanation', 'reference', 'tutorials']],
    ['Hvordan setter jeg opp autentisering?', ['explanation', 'reference', 'tutorials']],
    ['Hvilke verdier finnes for status-feltet?', ['explanation', 'how-to-guides', 'tutorials']],
    [
      'Hva er forskjellen mellom Altinn-roller for personer og virksomheter?',
      ['how-to-guides', 'reference', 'tutorials'],
    ],
  ])(
    'classifies the shape of %j as the complement in permissive mode',
    async (query, complement) => {
      expect(await detect(diataxis, query)).toEqual({ diataxis: { not: complement } });
    },
  );

  it('does not match mid-sentence or unknown shapes, and strict mode emits the value', async () => {
    expect(
      await detect(diataxis, 'Compare how Altinn Studio v7 and v8 handle data model definition?'),
    ).toEqual({});
    expect(await detect(diataxis, 'Når går Altinn over til Tilgangspakker?')).toEqual({});
    expect(
      await detect({ ...diataxis, mode: 'strict' } as AutoFilterRule, 'What is Dialogporten?'),
    ).toEqual({ diataxis: ['explanation'] });
  });

  it('merges several rules with the last one winning per field', async () => {
    expect(
      await detectFromRules(
        [language, diataxis],
        ['What is Dialogporten and what problem does it solve?'],
        undefined,
      ),
    ).toEqual({
      language: ['en'],
      diataxis: { not: ['how-to-guides', 'reference', 'tutorials'] },
    });
    expect(await detectFromRules([], ['any query'], undefined)).toEqual({});
  });

  it('translates a leading Java inline flag into a JavaScript flag', () => {
    expect(javaRegex('(?i)^what').test('WHAT is it')).toBe(true);
    expect(javaRegex('^what').test('WHAT is it')).toBe(false);
  });

  describe('llm-classify', () => {
    const rule = autoFilterRule.parse({
      type: 'llm-classify',
      field: 'diataxis',
      universe: ['explanation', 'how-to-guides', 'reference', 'tutorials'],
      promptTemplate: 'Field {{field}}. Pick from {{universe-joined}} for: {{query}}',
    });
    const model = (answer: string | Error) => {
      const calls: ChatRequest[] = [];
      const port: ModelPort = {
        info: () => ({ id: 'm', residency: 'norway', capabilities: ['json-schema'] }),
        chat: async (request) => {
          calls.push(request);
          if (answer instanceof Error) throw answer;
          return {
            content: answer,
            toolCalls: [],
            finishReason: 'stop',
            usage: {},
            servedModel: 'm',
          };
        },
        chatStream: () => {
          throw new Error('not used');
        },
      };
      return { port, calls };
    };

    it('renders the prompt, constrains the answer to the universe, and emits the value', async () => {
      const m = model('{"values":["explanation"]}');

      expect(await detect(rule, 'Hva er Altinn?', m.port)).toEqual({ diataxis: ['explanation'] });
      expect(m.calls[0]?.messages[0]?.content).toBe(
        'Field diataxis. Pick from explanation, how-to-guides, reference, tutorials for: Hva er Altinn?',
      );
      expect(m.calls[0]?.temperature).toBe(0);
      expect(m.calls[0]?.jsonSchema?.schema).toMatchObject({
        properties: {
          values: { items: { enum: rule.type === 'llm-classify' ? rule.universe : [] } },
        },
      });
    });

    it('emits the complement in permissive mode, keeps only universe values, and truncates single-value rules', async () => {
      expect(
        await detect(
          { ...rule, mode: 'permissive' } as AutoFilterRule,
          'x',
          model('{"values":["explanation","bogus"]}').port,
        ),
      ).toEqual({
        diataxis: { not: ['how-to-guides', 'reference', 'tutorials'] },
      });
      expect(
        await detect(
          { ...rule, allowMultiValue: false } as AutoFilterRule,
          'x',
          model('{"values":["reference","how-to-guides"]}').port,
        ),
      ).toEqual({
        diataxis: ['reference'],
      });
      expect(
        await detect(rule, 'x', model('{"values":["how-to-guides","reference"]}').port),
      ).toEqual({ diataxis: ['how-to-guides', 'reference'] });
    });

    it('does nothing without a model, on a model error, or on an empty answer', async () => {
      expect(await detect(rule, 'x')).toEqual({});
      expect(await detect(rule, 'x', model(new Error('down')).port)).toEqual({});
      expect(await detect(rule, 'x', model('{"values":[]}').port)).toEqual({});
    });
  });
});

interface Stub {
  batches: SearchRequest[][];
  ranges: string[];
}

const knowledge = (script: (r: SearchRequest) => { id: string; text?: string }[], stub: Stub) => {
  const toHit = (id: string, score: number, text = `tekst ${id}`): Hit => ({
    id,
    score,
    text,
    title: `Tittel ${id}`,
    document: `d-${id}`,
    position: 0,
    fields: {},
  });
  const adapter: KnowledgeAdapter = {
    engine: 'stub',
    endpointOptions: z.strictObject({}),
    datasetOptions: z.strictObject({}),
    connect: () => ({
      profiles: () => [
        'phrase',
        'metadata',
        'content',
        'doc-title',
        'questions',
        'verified',
        'triples',
      ],
      search: async (_d, requests) => {
        stub.batches.push(requests);
        return requests.map((r) => ({
          hits: script(r).map((h, i) => toHit(h.id, 1 - i * 0.1, h.text)),
        }));
      },
      fetch: async (_d, ids) => ids.map((id) => toHit(id, 0)),
      range: async (_d, document) => {
        stub.ranges.push(document);
        return [toHit(`${document}-c0`, 0)];
      },
      facets: async () => ({}),
    }),
  };
  return new KnowledgeRouter({
    catalog: {
      endpoints: {
        main: {
          engine: 'stub',
          baseURL: 'https://search.example',
          auth: { kind: 'api-key', secret: 'secret://env/k' },
        },
      },
      datasets: [
        {
          id: 'docs',
          endpoint: 'main',
          residency: 'norway',
          filters: { language: 'multiselect', diataxis: 'multiselect' },
        },
      ],
    },
    adapters: [adapter],
    secrets: envSecrets({ K: 'k' }),
  }).open({ kind: 'dataset', id: 'docs' }, ctx);
};

const reranker = (
  rank: (r: RerankRequest) => Promise<{ index: number; score: number; rank: number }[]>,
) => {
  const adapter: RerankAdapter = {
    engine: 'stub',
    endpointOptions: z.strictObject({}),
    rerankerOptions: z.strictObject({}),
    connect: () => ({ rerank: async (_r, request) => rank(request) }),
  };
  return new RerankRouter({
    catalog: {
      endpoints: {
        r: {
          engine: 'stub',
          baseURL: 'https://rerank.example',
          auth: { kind: 'api-key', secret: 'secret://env/k' },
        },
      },
      rerankers: [{ id: 'colbert', endpoint: 'r', residency: 'norway' }],
    },
    adapters: [adapter],
    secrets: envSecrets({ K: 'k' }),
  }).open({ kind: 'reranker', id: 'colbert' }, ctx);
};

describe('enrichment, hierarchical mode and per-strategy rerank', () => {
  it('searches enrichment siblings after the base strategies, weights them like phrases, and carries matched questions', async () => {
    const stub: Stub = { batches: [], ranges: [] };
    const port = knowledge(
      (r) =>
        r.profile === 'questions'
          ? [{ id: 'q1', text: 'Når kom Altinn 3?' }]
          : r.profile === 'triples'
            ? [{ id: 't1' }]
            : r.profile === 'content'
              ? [{ id: 'q1' }]
              : [],
      stub,
    );

    const result = await retrieve({
      knowledge: port,
      queries: ['altinn 3 lansert'],
      config: {
        autoFilter: { enabled: false },
        enrichment: [
          { type: 'hypothetical-questions', profiles: ['questions'] },
          { type: 'fact-assertions', profiles: ['triples'] },
        ],
      },
    });

    expect(stub.batches[0]?.map((r) => r.profile)).toEqual([
      'phrase',
      'metadata',
      'content',
      'questions',
      'triples',
    ]);
    expect(result.trace.expansion.hitsPerStrategy).toEqual({
      phrase: 0,
      metadata: 0,
      content: 1,
      'hypothetical-questions': 1,
      'fact-assertions': 1,
    });
    const merged = result.trace.expansion.merged;
    expect(merged.find((m) => m.id === 'q1')).toMatchObject({
      rank: 1.0 + 0.7,
      matchedQuestions: ['Når kom Altinn 3?'],
    });
    expect(merged.find((m) => m.id === 't1')).toMatchObject({ rank: 0.7 });
    expect(merged.find((m) => m.id === 't1')?.matchedQuestions).toBeUndefined();
    expect(result.chunks.find((c) => c.id === 'q1')?.matchedQuestions).toEqual([
      'Når kom Altinn 3?',
    ]);
  });

  it('runs only the doc-title strategy in hierarchical mode', async () => {
    const stub: Stub = { batches: [], ranges: [] };
    const port = knowledge(
      (r) => (r.profile === 'doc-title' ? [{ id: 'doc-a' }] : [{ id: 'never' }]),
      stub,
    );

    const result = await retrieve({
      knowledge: port,
      queries: ['x'],
      config: {
        mode: 'hierarchical',
        autoFilter: { enabled: false },
        docTitle: { profiles: ['doc-title'] },
        enrichment: [{ type: 'verified-phrases', profiles: ['verified'] }],
      },
    });

    expect(stub.batches[0]?.map((r) => r.profile)).toEqual(['doc-title']);
    expect(result.trace.expansion.hitsPerStrategy).toEqual({ 'doc-title': 1 });
    expect(result.chunks.map((c) => c.id)).toEqual(['d-doc-a-c0']);
  });

  it('applies rule-detected filters the dataset declares', async () => {
    const stub: Stub = { batches: [], ranges: [] };
    const port = knowledge(() => [{ id: 'a' }], stub);

    await retrieve({
      knowledge: port,
      queries: ['What is Dialogporten and what problem does it solve?'],
      config: {
        autoFilter: { rules: [language, diataxis] },
        strategies: [{ name: 'content', profiles: ['content'] }],
      },
    });

    expect(stub.batches[0]?.[0]?.filters).toEqual({
      language: ['en'],
      diataxis: { not: ['how-to-guides', 'reference', 'tutorials'] },
    });
  });

  it('reranks each base strategy separately, interleaves, keeps the best score per chunk, and caps the result', async () => {
    const stub: Stub = { batches: [], ranges: [] };
    const port = knowledge(
      (r) =>
        r.profile === 'phrase'
          ? [{ id: 'p1' }, { id: 'shared' }]
          : r.profile === 'content'
            ? [{ id: 'shared' }, { id: 'c1' }]
            : [],
      stub,
    );
    const scores: Record<string, number> = { p1: 5, shared: 9, c1: 7 };
    const requests: RerankRequest[] = [];
    const rerank = reranker(async (r) => {
      requests.push(r);
      return r.documents.map((d, index) => ({
        index,
        score: scores[/Tittel (\w+)/.exec(d)?.[1] ?? ''] ?? 0,
        rank: index + 1,
      }));
    });

    const result = await retrieve({
      knowledge: port,
      rerank,
      queries: ['x'],
      config: {
        autoFilter: { enabled: false },
        rerank: { enabled: true, perStrategy: true, finalCap: 2 },
      },
    });

    expect(requests).toHaveLength(2);
    expect(result.chunks.map((c) => [c.id, c.rerankScore])).toEqual([
      ['shared', 9],
      ['c1', 7],
    ]);
    expect(result.trace.expansion.rerank).toMatchObject({ status: 'reranked', candidates: 4 });
  });

  it('reports per-strategy rerank failures and keeps the unreranked lists in degrade mode', async () => {
    const stub: Stub = { batches: [], ranges: [] };
    const port = knowledge(
      (r) =>
        r.profile === 'phrase' ? [{ id: 'p1' }] : r.profile === 'content' ? [{ id: 'c1' }] : [],
      stub,
    );
    const rerank = reranker(() => Promise.reject(new Error('down')));

    const result = await retrieve({
      knowledge: port,
      rerank,
      queries: ['x'],
      config: { autoFilter: { enabled: false }, rerank: { enabled: true, perStrategy: true } },
    });

    expect(result.chunks.map((c) => c.id)).toEqual(['p1', 'c1']);
    expect(result.trace.expansion.rerank).toMatchObject({
      status: 'degraded',
      error: 'down; down',
    });
  });
});
