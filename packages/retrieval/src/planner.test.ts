import { describe, expect, it } from 'vitest';
import type { FilterValue, Hit, KnowledgePort, SearchRequest } from '@genai/port-knowledge';
import { ModelError, type ChatRequest, type ModelPort } from '@genai/port-model';
import { createPlanner, keywordProbes, rrfRank } from './planner.js';
import { defaultPlannerPrompt, formatConversation } from './prompts.js';

const signal = new AbortController().signal;

const model = (
  intent: string | undefined,
  blind: string[],
  grounded: string[] = [],
  failures: (Error | undefined)[] = [],
) => {
  const calls: { name: string; request: ChatRequest }[] = [];
  const port: ModelPort = {
    info: () => ({ id: 'm', residency: 'norway', capabilities: ['json-schema'] }),
    chat: async (request) => {
      const name = request.jsonSchema?.name ?? '';
      calls.push({ name, request });
      const failure = failures.shift();
      if (failure) throw failure;
      const content =
        name === 'groundedQueries'
          ? JSON.stringify({ search_phrases: grounded })
          : JSON.stringify({ user_intent: intent ?? '', search_phrases: blind });
      return { content, toolCalls: [], finishReason: 'stop', usage: {}, servedModel: 'm' };
    },
    chatStream: () => {
      throw new Error('not used');
    },
  };
  return { port, calls, names: () => calls.map((c) => c.name) };
};

const phrase = (text: string, document: string): Hit => ({
  id: `${document}-${text}`,
  score: 1,
  text,
  document,
  fields: {},
});

const harvester = (empty = false) => {
  const filters: (Record<string, FilterValue> | undefined)[] = [];
  const requests: SearchRequest[][] = [];
  const port: KnowledgePort = {
    info: () => ({
      id: 'docs',
      residency: 'norway',
      filters: { doc_num: 'multiselect' },
      profiles: ['phrase', 'content'],
    }),
    searchMany: async (batch) => {
      requests.push(batch);
      filters.push(batch[0]?.filters);
      if (empty) return batch.map(() => ({ hits: [] }));
      const scoped = batch[0]?.filters !== undefined;
      return batch.map((_r, i) =>
        i > 0
          ? { hits: [] }
          : scoped
            ? { hits: [phrase('choose a component field to add the expression to', 'D1')] }
            : {
                hits: [
                  phrase('Show/hide fields based on form values', 'D1'),
                  phrase('form field shown or hidden', 'D2'),
                ],
              },
      );
    },
    search: async () => ({ hits: [] }),
    fetch: async () => [],
    range: async () => [],
    facets: async () => ({}),
  };
  return { port, filters, requests };
};

const noSleep = async () => undefined;

describe('blind planning (ported from query_planner_test)', () => {
  const blind = { expansionMode: 'blind' };

  it('returns the raw query without calling the model when disabled', async () => {
    const m = model('x', [], []);
    const plan = await createPlanner({ model: m.port, config: { enabled: false } })(
      'What is X?',
      [],
      signal,
    );
    expect(plan).toMatchObject({ queries: ['What is X?'], trace: { disabled: true } });
    expect(plan.userIntent).toBeUndefined();
    expect(m.calls).toHaveLength(0);
  });

  it('puts the user intent first, dedupes it, and respects max phrases', async () => {
    const one = await createPlanner({
      model: model('Hvordan opprette dialog som tjenesteeier', [
        'Hvordan opprette dialog som tjenesteeier',
        'a',
        'b',
        'c',
      ]).port,
      config: blind,
    })('q', [], signal);
    expect(one.userIntent).toBe('Hvordan opprette dialog som tjenesteeier');
    expect(one.queries).toHaveLength(4);

    const deduped = await createPlanner({
      model: model('Canonical Q', ['Canonical Q', 'alt phrase 1', 'alt phrase 2']).port,
      config: blind,
    })('q', [], signal);
    expect(deduped.queries).toEqual(['Canonical Q', 'alt phrase 1', 'alt phrase 2']);

    const capped = await createPlanner({
      model: model('Canonical', ['p1', 'p2', 'p3', 'p4']).port,
      config: { ...blind, maxPhrases: 3 },
    })('q', [], signal);
    expect(capped.queries).toEqual(['Canonical', 'p1', 'p2']);
  });

  it('keeps phrases when the intent is empty, and falls back on undecodable output', async () => {
    const noIntent = await createPlanner({
      model: model('', ['expansion 1', 'expansion 2']).port,
      config: blind,
    })('q', [], signal);
    expect(noIntent).toMatchObject({ queries: ['expansion 1', 'expansion 2'] });
    expect(noIntent.userIntent).toBeUndefined();

    const broken: ModelPort = {
      ...model('', [], []).port,
      chat: async () => ({
        content: 'not json',
        toolCalls: [],
        finishReason: 'stop',
        usage: {},
        servedModel: 'm',
      }),
    };
    expect(
      await createPlanner({ model: broken, config: blind })('Raw query', [], signal),
    ).toMatchObject({
      queries: ['Raw query'],
      trace: { fallback: true },
    });
  });

  it('retries transient errors up to three times with the headless delays, but not permanent ones', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const transient = () => new ModelError('unavailable', 'the model is unavailable');

    const recovering = model('Recovered', ['alt 1', 'alt 2'], [], [transient(), transient()]);
    expect(
      await createPlanner({ model: recovering.port, config: blind, sleep })('q', [], signal),
    ).toMatchObject({
      queries: ['Recovered', 'alt 1', 'alt 2'],
      userIntent: 'Recovered',
    });
    expect(recovering.calls).toHaveLength(3);
    expect(delays).toEqual([500, 2000]);

    const exhausted = model(
      'x',
      [],
      [],
      [transient(), transient(), new Error('read timed out'), transient()],
    );
    expect(
      await createPlanner({ model: exhausted.port, config: blind, sleep: noSleep })(
        'Raw',
        [],
        signal,
      ),
    ).toMatchObject({
      queries: ['Raw'],
      trace: { fallback: true },
    });
    expect(exhausted.calls).toHaveLength(4);

    const permanent = model('x', [], [], [new ModelError('bad_request', 'invalid')]);
    await createPlanner({ model: permanent.port, config: blind, sleep: noSleep })(
      'Raw',
      [],
      signal,
    );
    expect(permanent.calls).toHaveLength(1);
  });

  it('uses temperature 0.1 for blind planning and 0 for corpus-aware planning unless set', async () => {
    const b = model('i', [], []);
    await createPlanner({ model: b.port, config: blind })('q', [], signal);
    const c = model('i', [], []);
    await createPlanner({ model: c.port })('q', [], signal);
    const fixed = model('i', [], []);
    await createPlanner({ model: fixed.port, config: { temperature: 0.4 } })('q', [], signal);
    expect([
      b.calls[0]?.request.temperature,
      c.calls[0]?.request.temperature,
      fixed.calls[0]?.request.temperature,
    ]).toEqual([0.1, 0, 0.4]);
  });
});

describe('planner prompts', () => {
  it('keeps the language rule, including the sentence #75 restored, when no corpus language is set', () => {
    const prompt = defaultPlannerPrompt('User: "Hva er X?"', undefined, false);
    expect(prompt).toContain('LANGUAGE: Use EXACTLY the same language');
    expect(prompt).toContain(
      "Every phrase MUST be in the same language as the user's message (see LANGUAGE rule above). ",
    );
    expect(prompt).toContain('- The first search phrase should be the user-intent verbatim');
  });

  it('asks for translation when a corpus language is set, and salient nouns when enabled', () => {
    const prompt = defaultPlannerPrompt('User: "x"', 'Norwegian (bokmål)', true);
    expect(prompt).toContain('Translate it to the corpus language: Norwegian (bokmål). ');
    expect(prompt).not.toContain('LANGUAGE:');
    expect(prompt).toContain('SALIENT-NOUN COVERAGE (REQUIRED)');
  });

  it('formats the conversation with the current question last, and fills a custom prompt', async () => {
    const m = model('i', [], []);
    await createPlanner({
      model: m.port,
      config: { expansionMode: 'blind', prompt: 'CUSTOM: {messages}' },
    })(
      'Hva heter hovedstaden?',
      [
        { role: 'user', text: 'Hei' },
        { role: 'assistant', text: 'Hei!' },
      ],
      signal,
    );
    expect(m.calls[0]?.request.messages[0]?.content).toBe(
      'CUSTOM: User: "Hei"\n\nAssistant: "Hei!"\n\nUser: "Hva heter hovedstaden?"',
    );
    expect(formatConversation([{ role: 'user', text: 'q' }])).toBe('User: "q"');
  });
});

describe('corpus-aware planning (ported from query_planner_test)', () => {
  it('grounds on one harvest in 1-hop mode and returns the intent plus grounded phrases', async () => {
    const m = model(
      'Show field conditionally',
      ['conditional visibility'],
      ['dynamic expressions hidden property', 'show/hide fields'],
    );
    const k = harvester();

    const plan = await createPlanner({
      model: m.port,
      knowledge: k.port,
      config: { expansionMode: 'corpus-aware-1hop' },
    })('How do I show a field only when another has a value?', [], signal);

    expect(m.names()).toEqual(['planQueries', 'groundedQueries']);
    expect(k.filters).toEqual([undefined]);
    expect(k.requests[0]?.map((r) => [r.query, r.profile, r.limit])).toEqual([
      ['Show field conditionally', 'phrase', 12],
      ['conditional visibility', 'phrase', 12],
    ]);
    expect(plan.queries).toEqual([
      'Show field conditionally',
      'dynamic expressions hidden property',
      'show/hide fields',
    ]);
    expect(m.calls[1]?.request.messages[0]?.content).toContain(
      '- Show/hide fields based on form values\n- form field shown or hidden',
    );
  });

  it('scopes the second harvest to the documents the first one surfaced', async () => {
    const m = model(
      'Show field conditionally',
      ['conditional visibility'],
      ['dynamic expressions', 'choose a component field'],
    );
    const k = harvester();

    const plan = await createPlanner({ model: m.port, knowledge: k.port })(
      'How do I show a field conditionally?',
      [],
      signal,
    );

    expect(k.filters).toEqual([undefined, { doc_num: ['D1', 'D2'] }]);
    expect(plan.trace).toMatchObject({
      expansionMode: 'corpus-aware-2hop',
      hop1Documents: ['D1', 'D2'],
      hop2PhraseCount: 1,
    });
  });

  it('falls back to the blind result without a phrase profile or when the harvest is empty', async () => {
    const noProfile: KnowledgePort = {
      ...harvester().port,
      info: () => ({ id: 'd', residency: 'norway', filters: {}, profiles: ['content'] }),
    };
    const m1 = model('Intent', ['a', 'b'], ['x']);
    const p1 = await createPlanner({ model: m1.port, knowledge: noProfile })(
      'How do I X?',
      [],
      signal,
    );
    expect(p1).toMatchObject({
      queries: ['Intent', 'a', 'b'],
      trace: { expansionMode: 'blind', corpusAwareFallback: true },
    });
    expect(m1.names()).toEqual(['planQueries']);

    const m2 = model('Intent', ['a'], ['x']);
    const p2 = await createPlanner({
      model: m2.port,
      knowledge: harvester(true).port,
      config: { expansionMode: 'corpus-aware-1hop' },
    })('How do I X?', [], signal);
    expect(p2).toMatchObject({ queries: ['Intent', 'a'], trace: { corpusAwareFallback: true } });
    expect(m2.names()).toEqual(['planQueries']);
  });

  it('caps grounded output at max(max phrases, 10) and puts salient nouns after the intent', async () => {
    const many = Array.from({ length: 15 }, (_, i) => `g${i}`);
    const plain = await createPlanner({
      model: model('I', ['s1', 's2', 's3'], many).port,
      knowledge: harvester().port,
    })('q', [], signal);
    expect(plain.queries).toEqual(['I', ...many.slice(0, 9)]);

    const salient = await createPlanner({
      model: model('I', ['s1', 's2', 's3'], ['g1']).port,
      knowledge: harvester().port,
      config: { salientNounCoverage: true },
    })('q', [], signal);
    expect(salient.queries).toEqual(['I', 's1', 's2', 'g1']);
  });

  it('makes one model call in the one-call variant and scopes hop 2 the same way', async () => {
    const m = model(
      'Show field conditionally',
      ['dynamic expressions hidden', 'show/hide fields'],
      ['UNUSED'],
    );
    const k = harvester();

    const plan = await createPlanner({
      model: m.port,
      knowledge: k.port,
      config: { expansionVariant: 'one-call' },
    })('How do I show a field conditionally?', [], signal);

    expect(m.names()).toEqual(['planQueries']);
    expect(k.filters).toEqual([undefined, { doc_num: ['D1', 'D2'] }]);
    expect(k.requests[0]?.map((r) => r.query)).toEqual([
      'How do I show a field conditionally?',
      'show field conditionally',
    ]);
    expect(plan).toMatchObject({
      userIntent: 'Show field conditionally',
      queries: ['Show field conditionally', 'dynamic expressions hidden', 'show/hide fields'],
      trace: { expansionVariant: 'one-call' },
    });
  });

  it('falls back to the raw query without any model call when the one-call harvest is empty', async () => {
    const m = model('intent', ['p1'], ['x']);
    const plan = await createPlanner({
      model: m.port,
      knowledge: harvester(true).port,
      config: { expansionVariant: 'one-call', expansionMode: 'corpus-aware-1hop' },
    })('Q?', [], signal);
    expect(plan.queries).toEqual(['Q?']);
    expect(m.calls).toHaveLength(0);
  });

  it('keeps going on the blind result when the harvest itself fails', async () => {
    const failing: KnowledgePort = {
      ...harvester().port,
      searchMany: async () => {
        throw new Error('typesense down');
      },
    };
    const plan = await createPlanner({
      model: model('Intent', ['a'], ['x']).port,
      knowledge: failing,
    })('q', [], signal);
    expect(plan).toMatchObject({
      queries: ['Intent', 'a'],
      trace: { corpusAwareFallback: true, errors: ['harvest failed: typesense down'] },
    });
  });
});

describe('planner helpers', () => {
  it('ranks harvested phrases by reciprocal rank across probes, ties by phrase', () => {
    expect(
      rrfRank(
        [
          { phrase: 'b', document: 'D2', probeRank: 0 },
          { phrase: 'a', document: 'D1', probeRank: 0 },
          { phrase: 'c', document: 'D3', probeRank: 1 },
          { phrase: 'c', document: 'D4', probeRank: 3 },
          { phrase: ' ', probeRank: 0 },
        ],
        60,
      ).map((r) => [r.phrase, r.document]),
    ).toEqual([
      ['c', 'D3'],
      ['a', 'D1'],
      ['b', 'D2'],
    ]);
  });

  it('builds keyword probes from ASCII content words, as headless-rag does', () => {
    expect(keywordProbes('How do I show a field in the form?')).toEqual([
      'How do I show a field in the form?',
      'show field form',
    ]);
    expect(keywordProbes('Når får jeg svar?')).toEqual(['Når får jeg svar?', 'jeg svar']);
  });
});
