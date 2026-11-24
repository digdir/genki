import type { Event } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { mapRun, RunMapper, type RunChange } from './run-steps.js';

let seq = 0;
const at = (ms: number, type: string, data: unknown, audience?: 'audit'): Event => ({
  type,
  v: 1,
  task: 't1',
  seq: seq++,
  ts: new Date(Date.UTC(2026, 9, 9, 10, 0, 0, ms)).toISOString(),
  data,
  actor: 'strategy',
  ...(audience ? { audience } : {}),
});
const notice = (ms: number, data: unknown) => at(ms, 'kernel.notice', data);
const usage = (ms: number, input: number, output: number, model = 'gpt-test') =>
  at(
    ms,
    'kernel.usage',
    {
      usage: { inputTokens: input, outputTokens: output },
      port: 'model',
      model: { kind: 'model', id: model },
    },
    'audit',
  );

const answerParts = [
  {
    mime: 'text/plain',
    body: { kind: 'text', text: 'Svaret [1].' },
    meta: { citations: [{ index: 1, chunkId: 'c1' }] },
  },
  {
    mime: 'application/vnd.genai.sources+json',
    body: {
      kind: 'json',
      json: { sources: [{ chunkId: 'c1', title: '## Rapport om veiledning' }] },
    },
  },
  {
    mime: 'application/vnd.genai.retrieval+json',
    body: { kind: 'json', json: { queries: ['veiledning'] } },
  },
];

const ragRun = () => {
  seq = 0;
  return [
    at(0, 'kernel.task.status', { status: 'queued' }),
    at(
      5,
      'kernel.task.input',
      { input: { data: { query: 'Hva sier rapportene?', history: [] } } },
      'audit',
    ),
    at(10, 'kernel.task.status', { status: 'running' }),
    usage(400, 120, 30, 'planner'),
    notice(410, {
      kind: 'plan',
      queries: ['veiledning', 'ventetid'],
      userIntent: 'Funn om veiledning',
      ms: 400,
    }),
    notice(700, {
      kind: 'retrieval',
      queries: ['veiledning', 'ventetid'],
      hits: [
        { id: 'c1', document: 'd1', position: 3, score: 0.91, title: 'Rapport om veiledning' },
        { id: 'c2', document: 'd2', position: 0, score: 0.5 },
      ],
    }),
    notice(900, { kind: 'rerank', ms: 200, fallback: true, count: 2 }),
    notice(905, {
      kind: 'read',
      chunks: [
        { id: 'c1', document: 'd1' },
        { id: 'c2', document: 'd2' },
      ],
    }),
    at(1200, 'kernel.part.delta', { text: 'Svaret ' }),
    at(1500, 'kernel.part.delta', { text: '[1].' }),
    usage(1510, 900, 40),
    at(1520, 'kernel.result', answerParts),
    at(1530, 'kernel.task.status', { status: 'completed' }),
  ];
};

describe('the run mapper', () => {
  it('a read step names the document, position and page of each chunk it read', () => {
    seq = 0;
    const events = [
      at(0, 'kernel.task.status', { status: 'running' }),
      notice(10, {
        kind: 'read',
        chunks: [
          { id: 'c7', document: 'd1', position: 0, page: 1, score: 0.4, title: 'Rapport' },
          { id: 'c8', document: 'd1', position: 1, page: 2, title: 'Rapport' },
        ],
        request: { document: 'd1', chunkRange: { from: 0, to: 1 } },
      }),
    ];

    const [manager] = mapRun(events, { details: true }).steps.filter((s) => s.type === 'read');
    seq = 0;
    const [starter] = mapRun(events).steps.filter((s) => s.type === 'read');

    expect(manager?.reads).toEqual([
      {
        chunks: [
          { id: 'c7', document: 'd1', position: 0, page: 1, title: 'Rapport' },
          { id: 'c8', document: 'd1', position: 1, page: 2, title: 'Rapport' },
        ],
        request: { document: 'd1', chunkRange: { from: 0, to: 1 } },
      },
    ]);
    expect(manager?.blocks.at(-1)?.items).toEqual([
      ['Rapport', '2 tekstbiter · deler 1, 2 · sider 1, 2'],
    ]);
    expect(starter?.reads?.[0]?.chunks.map((c) => c.id)).toEqual(['c7', 'c8']);
    expect(starter?.reads?.[0]?.request).toBeUndefined();
  });

  it('shows what a search detected in the query and how it was used', () => {
    seq = 0;
    const steps = mapRun([
      at(0, 'kernel.task.status', { status: 'running' }),
      notice(700, {
        kind: 'retrieval',
        queries: ['Hva sier DFØ om Datatilsynet?'],
        hits: [{ id: 'c1', document: 'd1' }],
        detections: [
          {
            kind: 'organisation',
            field: 'orgs_long',
            values: ['Datatilsynet'],
            queries: ['Hva sier DFØ om Datatilsynet?'],
            use: 'hint',
          },
          { kind: 'year', field: 'title', values: ['2023'], queries: ['x'], use: 'boost' },
          { kind: 'rule', field: 'type', values: ['Evaluering'], queries: ['x'], use: 'filter' },
        ],
      }),
    ]).steps;

    const search = steps.find((s) => s.type === 'search');
    expect(search?.blocks).toContainEqual({
      kind: 'tags',
      label: 'Gjenkjent i søket',
      items: [
        'orgs_long: Datatilsynet, foreslått for agenten',
        'title: 2023, løftet i rangeringen',
        'type: Evaluering, brukt som filter',
      ],
    });
  });

  it('a failed search strategy shows as a warning on the search step in the timeline', () => {
    seq = 0;
    const run = mapRun([
      at(0, 'kernel.task.status', { status: 'running' }),
      notice(420, { stage: 'tool', tool: 'search', iteration: 0 }),
      notice(16_000, {
        kind: 'retrieval',
        queries: ['ventetid'],
        hits: [{ id: 'c1', document: 'd1' }],
        failed: [
          { strategy: 'content', reason: 'timeout' },
          { strategy: 'metadata', reason: 'error' },
        ],
      }),
      notice(16_100, { kind: 'read', auto: true, chunks: [{ id: 'c1', document: 'd1' }] }),
      notice(16_200, {
        event: 'agent/turn-completed',
        iteration: 0,
        'tool-calls': [
          { tool: 'search', args: { queries: ['ventetid'] }, 'ok?': true, 'duration-ms': 15_600 },
        ],
      }),
    ]);

    const search = run.steps.find((s) => s.type === 'search');
    const failed = 'innholdssøket tok for lang tid, metadatasøket feilet';
    expect(search).toMatchObject({ warning: true, state: 'partial', durationSeconds: 15.6 });
    expect(search?.summary).toBe(
      `${failed} · «ventetid» · 1 treff · leste 1 tekstbit fra 1 dokument`,
    );
    expect(search?.blocks).toContainEqual({
      kind: 'note',
      text: 'Innholdssøket tok for lang tid, metadatasøket feilet. Treffene kommer bare fra søkene som virket.',
    });
    expect(run.stats().warnings).toEqual(['Innholdssøket tok for lang tid, metadatasøket feilet.']);
  });

  it('names every failed strategy and why, an unknown strategy by its own name', () => {
    seq = 0;
    const run = mapRun([
      at(0, 'kernel.task.status', { status: 'running' }),
      notice(700, {
        kind: 'retrieval',
        queries: ['ventetid'],
        hits: [],
        failed: [
          { strategy: 'doc-title', reason: 'query-too-long' },
          { strategy: 'phrase', reason: 'text-unavailable' },
          { strategy: 'metadata', reason: 'vector-unavailable' },
          { strategy: '__proto__', reason: 'timeout' },
          { strategy: 'toString', reason: 'error' },
          { strategy: 'all', reason: 'error' },
        ],
      }),
    ]);

    const search = run.steps.find((s) => s.type === 'search');
    expect(search).toMatchObject({ warning: true, state: 'partial' });
    expect(run.stats().warnings).toEqual([
      'Tittelsøket fikk en for lang spørring, frasesøket fikk ikke søkt på ord, bare på betydning, metadatasøket fikk ikke søkt på betydning, søket «__proto__» tok for lang tid, søket «toString» feilet, søket «all» feilet.',
    ]);
  });

  it('a search that fails completely shows as a failed search step', () => {
    seq = 0;
    const run = mapRun([
      at(0, 'kernel.task.status', { status: 'running' }),
      notice(420, { stage: 'tool', tool: 'search', iteration: 0 }),
      notice(16_000, {
        kind: 'retrieval',
        queries: ['ventetid'],
        hits: [],
        failedCompletely: 'timeout',
      }),
      notice(16_200, {
        event: 'agent/turn-completed',
        iteration: 0,
        'tool-calls': [
          { tool: 'search', args: { queries: ['ventetid'] }, 'ok?': true, 'duration-ms': 15_600 },
        ],
      }),
    ]);

    const search = run.steps.find((s) => s.type === 'search');
    expect(search).toMatchObject({ warning: true, state: 'failed', durationSeconds: 15.6 });
    expect(search?.summary).toBe('alle søkene tok for lang tid · «ventetid» · 0 treff');
    expect(search?.blocks).toContainEqual({ kind: 'note', text: 'Alle søkene tok for lang tid.' });
    expect(run.stats().warnings).toEqual(['Alle søkene tok for lang tid.']);
  });

  it("shows a whole search failure's engine message only to people with details rights", () => {
    const events = () => {
      seq = 0;
      return [
        at(0, 'kernel.task.status', { status: 'running' }),
        notice(420, { stage: 'tool', tool: 'search', iteration: 0 }),
        notice(900, {
          kind: 'retrieval',
          queries: ['ventetid'],
          hits: [],
          failedCompletely: 'error',
        }),
        at(900, 'x.search.error', { error: 'connect ECONNREFUSED 10.0.0.4:5432' }, 'audit'),
      ];
    };

    const shown = mapRun(events(), { details: true }).steps.find((s) => s.type === 'search');
    expect(shown?.raw).toMatchObject({ searchError: 'connect ECONNREFUSED 10.0.0.4:5432' });
    const hidden = mapRun(events()).steps;
    expect(JSON.stringify(hidden)).not.toContain('ECONNREFUSED');
  });

  it('a search with no failed strategy is not marked as a warning', () => {
    seq = 0;
    const search = mapRun([
      at(0, 'kernel.task.status', { status: 'running' }),
      notice(700, { kind: 'retrieval', queries: ['ventetid'], hits: [{ id: 'c1' }] }),
    ]).steps.find((s) => s.type === 'search');

    expect(search?.warning).toBeUndefined();
    expect(search?.blocks.some((b) => b.kind === 'note')).toBe(false);
  });

  it('shows steps whose content was erased as one card that says so, not as unknown steps', () => {
    seq = 0;
    const steps = mapRun([
      at(0, 'kernel.task.status', { status: 'running' }),
      notice(200, { erased: true }),
      notice(2200, { erased: true }),
      notice(5900, { erased: true }),
      at(6000, 'kernel.result', answerParts),
      at(6010, 'kernel.task.status', { status: 'completed' }),
    ]).steps;

    const unreadable = steps.filter((s) => s.title === 'Innholdet er ikke tilgjengelig');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatchObject({ type: 'note', at: 0.2, durationSeconds: 5.7 });
    expect(unreadable[0]?.summary).toContain('3 steg');
    expect(steps.some((s) => s.title === 'Ukjent hendelse')).toBe(false);
  });

  const erasedRun = () => {
    seq = 0;
    return [
      at(0, 'kernel.task.status', { status: 'queued' }),
      at(5, 'kernel.task.input', { erased: true }, 'audit'),
      at(10, 'kernel.task.status', { status: 'running' }),
      notice(200, { erased: true }),
      notice(2200, { erased: true }),
      usage(5800, 900, 40),
      at(6000, 'kernel.result', { erased: true }),
      at(6010, 'kernel.task.status', { status: 'completed' }),
    ];
  };

  it('an erased run shows no unreadable steps and says the answer was erased', () => {
    const mapper = mapRun(erasedRun(), { erased: true });

    expect(mapper.steps.map((s) => [s.type, s.title, s.summary])).toEqual([
      ['trigger', 'Startet', 'Oppgaven ble mottatt'],
      ['model', 'Modellkall', 'gpt-test · 900 inn, 40 ut'],
      ['result', 'Svar', 'Svaret er slettet'],
    ]);
    expect(mapper.steps.at(-1)?.blocks).toEqual([]);
    expect(mapper.stats()).toMatchObject({ inputTokens: 900, outputTokens: 40 });
  });

  it('a run with unreadable content that was not erased still shows as unreadable', () => {
    const steps = mapRun(erasedRun()).steps;

    expect(
      steps.filter((s) => s.title === 'Innholdet er ikke tilgjengelig').length,
    ).toBeGreaterThan(0);
    expect(steps.some((s) => s.summary === 'Svaret ble levert')).toBe(false);
    expect(steps.some((s) => s.summary === 'Svaret er slettet')).toBe(false);
  });

  it('fills the answer block with the answer text and source titles, not raw JSON', () => {
    const result = mapRun(ragRun()).steps.at(-1);

    expect(result).toMatchObject({ type: 'result', summary: 'Svar med 1 kilde' });
    expect(result?.blocks).toEqual([
      { kind: 'answer', text: 'Svaret [1].', sources: ['Rapport om veiledning'] },
    ]);
  });

  it('turns a RAG run into plan, search, rerank, read, model and result steps with real durations', () => {
    const mapper = mapRun(ragRun());

    expect(mapper.steps.map((s) => [s.type, s.summary])).toEqual([
      ['trigger', 'Spørsmålet ble mottatt'],
      ['plan', 'Genererte 2 søk: «veiledning», «ventetid»'],
      ['search', '2 søk: «veiledning», «ventetid» · 2 treff'],
      ['search', 'Feilet, brukte rekkefølgen fra søket'],
      ['read', '2 tekstbiter fra 2 dokumenter'],
      ['model', 'gpt-test · 900 inn, 40 ut'],
      ['result', 'Svar med 1 kilde'],
    ]);
    const [, plan, search, rerank, , model] = mapper.steps;
    expect(plan).toMatchObject({ at: 0.01, durationSeconds: 0.4, tokens: 150, model: 'planner' });
    expect(search).toMatchObject({ at: 0.41, durationSeconds: 0.29 });
    expect(search?.blocks).toContainEqual({
      kind: 'list',
      label: 'Beste treff',
      items: [
        ['Rapport om veiledning', 'relevans 0,91 · del 4'],
        ['d2', 'relevans 0,5 · del 1'],
      ],
    });
    expect(rerank).toMatchObject({ durationSeconds: 0.2, state: 'partial', warning: true });
    expect(model).toMatchObject({ at: 0.91, durationSeconds: 0.61, tokens: 940 });
    expect(mapper.steps[0]?.blocks[0]).toEqual({ kind: 'quote', text: 'Hva sier rapportene?' });
  });

  it('counts chunks, documents, warnings and tokens per model', () => {
    const stats = mapRun(ragRun()).stats();

    expect(stats).toMatchObject({
      chunksRead: 2,
      documents: 2,
      inputTokens: 1020,
      outputTokens: 70,
      warnings: ['Rerangeringen feilet, så rekkefølgen fra søket ble brukt.'],
      byModel: [
        { model: 'planner', inputTokens: 120, outputTokens: 30, calls: 1 },
        { model: 'gpt-test', inputTokens: 900, outputTokens: 40, calls: 1 },
      ],
    });
    expect(mapRun(ragRun()).hits.get('c1')).toMatchObject({ score: 0.91 });
  });

  it("keeps a model call's tokens and cost out of its raw data when usage is hidden", () => {
    seq = 0;
    const steps = mapRun([usage(10, 12, 3)], { details: true, usage: false }).steps;

    expect(JSON.stringify(steps)).not.toMatch(/inputTokens|outputTokens/);
    expect(mapRun([usage(10, 12, 3)], { details: true }).steps[0]?.raw).toBeDefined();
  });

  it('leaves token counts out of the steps when usage is hidden, but keeps the model', () => {
    const steps = mapRun(ragRun(), { usage: false }).steps;
    const model = steps.find((s) => s.type === 'model');

    expect(steps.some((s) => s.tokens !== undefined)).toBe(false);
    expect(JSON.stringify(steps)).not.toMatch(/1[\s\u00a0]?020|900/);
    expect(model?.model).toBe('gpt-test');
  });

  it('keeps raw data out unless the caller may see details', () => {
    expect(JSON.stringify(mapRun(ragRun()).steps)).not.toContain('"raw"');
    expect(
      mapRun(ragRun(), { details: true }).steps.find((s) => s.type === 'plan')?.raw,
    ).toMatchObject({
      kind: 'plan',
    });
  });

  describe('an agent loop', () => {
    const agentRun = () => {
      seq = 0;
      return [
        at(0, 'kernel.task.status', { status: 'queued' }),
        notice(100, { event: 'agent/iteration-started', iteration: 0, 'max-iterations': 4 }),
        at(300, 'kernel.part.delta', { text: 'Jeg søker først.' }),
        usage(400, 500, 20),
        notice(410, { event: 'agent/thinking', iteration: 0, reasoning: 'Jeg søker først.' }),
        notice(420, { stage: 'tool', tool: 'search', iteration: 0 }),
        notice(700, {
          kind: 'retrieval',
          queries: ['ventetid'],
          filters: [{ field: 'year', selectedOptions: ['2024'] }],
          hits: [{ id: 'c1', document: 'd1', score: 2 }],
        }),
        notice(710, { kind: 'read', auto: true, chunks: [{ id: 'c1', document: 'd1' }] }),
        notice(720, {
          event: 'agent/turn-completed',
          iteration: 0,
          'tool-calls': [
            {
              tool: 'search',
              args: { queries: ['ventetid'] },
              'ok?': true,
              'duration-ms': 290,
              'result-summary': 'Found 1',
            },
          ],
        }),
        usage(900, 300, 10),
        notice(910, { stage: 'read-signal', status: 'support-found', degraded: false }),
        notice(920, { event: 'agent/iteration-started', iteration: 1, 'max-iterations': 4 }),
        usage(1000, 600, 30),
        notice(1010, { stage: 'tool', tool: 'generate_response', iteration: 1 }),
        at(1100, 'kernel.part.delta', { text: 'Utkast' }),
        usage(1300, 700, 50),
        notice(1310, {
          event: 'agent/turn-completed',
          iteration: 1,
          'tool-calls': [{ tool: 'generate_response', args: {}, 'ok?': true, 'duration-ms': 300 }],
        }),
        notice(1320, {
          stage: 'gate',
          source: 'llm-sufficiency-gate',
          status: 'insufficient',
          strategy: 're-search',
        }),
        notice(1330, { stage: 'answer-discarded', iteration: 1 }),
      ];
    };

    it('shows rounds with reasoning, tool calls, searches and gates, and retracts a discarded answer', () => {
      const mapper = new RunMapper({ details: true });
      const changes: RunChange[] = agentRun().flatMap((e) => mapper.push(e));

      expect(mapper.steps.map((s) => [s.type, s.title])).toEqual([
        ['trigger', 'Startet'],
        ['model', 'Modellkall · runde 1'],
        ['search', 'Søk'],
        ['guard', 'Vurderte det som ble lest'],
        ['model', 'Modellkall · runde 2'],
        ['model', 'Skrev svaret'],
        ['guard', 'Kontrollerte kildene'],
        ['note', 'Svarutkast forkastet'],
      ]);
      const [, round, search, readSignal, , generate, gate] = mapper.steps;
      expect(round?.blocks).toContainEqual({
        kind: 'reasoning',
        label: 'Resonnering',
        text: 'Jeg søker først.',
      });
      expect(round?.blocks).toContainEqual({
        kind: 'list',
        label: 'Verktøykall (1)',
        items: [['Søk', '«ventetid»']],
        calls: true,
      });
      expect(round).toMatchObject({ tokens: 520, durationSeconds: 0.3, iteration: 0 });
      expect(search).toMatchObject({
        durationSeconds: 0.29,
        summary: '«ventetid» · 1 treff · leste 1 tekstbit fra 1 dokument',
      });
      expect(search?.blocks).toContainEqual({
        kind: 'tags',
        label: 'Filter',
        items: ['year: 2024'],
      });
      expect(search?.raw).toMatchObject({ call: { 'result-summary': 'Found 1' } });
      expect(readSignal).toMatchObject({ summary: 'Fant støtte i kildene', tokens: 310 });
      expect(generate).toMatchObject({ tokens: 750, durationSeconds: 0.3 });
      expect(gate?.summary).toBe('Kildene holder ikke · neste: søker på nytt');
      expect(changes.filter((c) => c.kind === 'delta')).toEqual([
        { kind: 'delta', text: 'Jeg søker først.', channel: 'reasoning' },
        { kind: 'delta', text: 'Utkast', channel: 'answer' },
      ]);
      expect(changes).toContainEqual({ kind: 'retract', reason: 'discarded' });
      expect(mapper.stats()).toMatchObject({
        iterations: 2,
        toolCalls: 2,
        chunksRead: 1,
        documents: 1,
      });
    });

    it('shows the finish reason on a model step', () => {
      seq = 0;
      const mapper = new RunMapper();
      [
        notice(100, { event: 'agent/iteration-started', iteration: 0, 'max-iterations': 4 }),
        at(
          400,
          'kernel.usage',
          {
            usage: { inputTokens: 500, outputTokens: 20 },
            port: 'model',
            model: { kind: 'model', id: 'gpt-test' },
            finishReason: 'length',
          },
          'audit',
        ),
      ].forEach((e) => mapper.push(e));

      const [round] = mapper.steps;
      expect(round).toMatchObject({ type: 'model', finishReason: 'length' });
      expect(round?.refusalCategory).toBeUndefined();
      expect(round?.blocks.find((b) => b.kind === 'kv')?.rows).toContainEqual([
        'Stopp',
        'kuttet ved maks lengde',
      ]);
    });

    it('shows a model refusal with its category', () => {
      seq = 0;
      const mapper = new RunMapper();
      [
        notice(100, { event: 'agent/iteration-started', iteration: 0, 'max-iterations': 4 }),
        at(
          400,
          'kernel.usage',
          {
            usage: { inputTokens: 4923, outputTokens: 0 },
            port: 'model',
            model: { kind: 'model', id: 'claude-opus-5-5' },
            finishReason: 'content_filter',
            refusalCategory: 'reasoning_extraction',
          },
          'audit',
        ),
        notice(410, { stage: 'model-refused', iteration: 0, category: 'reasoning_extraction' }),
      ].forEach((e) => mapper.push(e));

      const [round, refused] = mapper.steps;
      expect(round).toMatchObject({
        finishReason: 'content_filter',
        refusalCategory: 'reasoning_extraction',
      });
      expect(round?.blocks.find((b) => b.kind === 'kv')?.rows).toContainEqual([
        'Stopp',
        'avvist (reasoning_extraction)',
      ]);
      expect(refused).toMatchObject({
        title: 'Modellen avviste',
        summary: 'Modellen avviste forespørselen (reasoning_extraction)',
        warning: true,
      });
      expect(mapper.steps.map((s) => s.title)).not.toContain('Tomt svar');
    });

    it('shows a model refusal without a category', () => {
      seq = 0;
      const mapper = new RunMapper();
      mapper.push(notice(100, { stage: 'model-refused', iteration: 0 }));

      expect(mapper.steps[0]).toMatchObject({
        title: 'Modellen avviste',
        summary: 'Modellen avviste forespørselen',
      });
    });

    it('upserts the same step id while it runs and when it finishes', () => {
      const mapper = new RunMapper();
      const changes = agentRun()
        .slice(0, 4)
        .flatMap((e) => mapper.push(e));
      const round = changes.filter(
        (c): c is Extract<RunChange, { kind: 'step' }> =>
          c.kind === 'step' && c.step.type === 'model',
      );

      expect(new Set(round.map((c) => c.step.id)).size).toBe(1);
      expect(round.at(-1)?.step.state).toBeUndefined();
      expect(round.at(-1)?.step.summary).toBe('gpt-test · 500 inn, 20 ut');
    });
  });

  it('names who decided at a gate and the read status it overrode', () => {
    const mapper = new RunMapper();
    [
      notice(0, {
        stage: 'gate',
        source: 'llm-sufficiency-gate',
        status: 'sufficient',
        strategy: 'finalize',
        overriddenReadStatus: 'gap-remaining',
      }),
      notice(1, {
        stage: 'gate',
        source: 'shadow-read-signals',
        status: 'insufficient',
        strategy: 'read-more',
      }),
    ].forEach((e) => mapper.push(e));

    const [overrode, plain] = mapper.steps.filter((s) => s.type === 'guard');
    expect(overrode?.blocks).toEqual([
      {
        kind: 'kv',
        rows: [
          ['Avgjort av', 'Modellen som vurderer kildene'],
          ['Overstyrte lesesjekken', 'Mangler fortsatt noe'],
        ],
      },
    ]);
    expect(plain?.blocks).toEqual([{ kind: 'kv', rows: [['Avgjort av', 'Lesesjekken']] }]);
  });

  it('replaces a renumbered answer without a warning step', () => {
    const mapper = new RunMapper({ details: true });
    const changes = [
      notice(0, { stage: 'answer-discarded', reason: 'renumbered' }),
      at(1, 'kernel.part.delta', { text: 'Svar [1].' }),
    ].flatMap((e) => mapper.push(e));

    expect(changes).toContainEqual({ kind: 'retract', reason: 'discarded' });
    expect(mapper.steps.filter((s) => s.type === 'note')).toEqual([]);
  });

  it('shows a clarification as the result', () => {
    seq = 0;
    const steps = mapRun([
      at(0, 'kernel.result', [
        { mime: 'text/plain', body: { kind: 'text', text: 'Hvilket år?' } },
        {
          mime: 'application/vnd.genai.sources+json',
          body: {
            kind: 'json',
            json: {
              sources: [],
              clarification: { question: 'Hvilket år?', options: ['2024', '2025'] },
            },
          },
        },
      ]),
    ]).steps;

    expect(steps.at(-1)).toMatchObject({
      title: 'Ba om en avklaring',
      blocks: [
        { kind: 'quote', label: 'Spørsmål til brukeren', text: 'Hvilket år?' },
        { kind: 'tags', label: 'Valg', items: ['2024', '2025'] },
      ],
    });
  });

  it('shows an event it does not know by its name, with raw data only for details', () => {
    seq = 0;
    const events = [notice(0, { event: 'x/new-thing', value: 1 })];

    expect(mapRun(events).steps[0]).toMatchObject({
      type: 'x/new-thing',
      title: 'Ukjent hendelse',
    });
    expect(mapRun(events).steps[0]?.raw).toBeUndefined();
    expect(mapRun(events, { details: true }).steps[0]?.raw).toEqual({
      event: 'x/new-thing',
      value: 1,
    });
  });

  it('shows a tool call and the steps of a remote agent as steps of their own, without argument values', () => {
    seq = 0;
    const events = [
      notice(0, {
        kind: 'external-step',
        origin: 'tool',
        step: 'sok',
        tool: 'saker.sok',
        ok: true,
        ms: 400,
        arguments: ['q', 'limit'],
      }),
      notice(500, {
        kind: 'external-step',
        origin: 'remote-agent',
        title: 'Slo opp fristen',
        summary: 'fant 2 treff',
        ok: true,
      }),
      notice(600, {
        kind: 'external-step',
        origin: 'remote-agent',
        host: 'agent.example.no',
        ok: false,
        ms: 100,
      }),
    ];

    const { steps } = mapRun(events);

    expect(steps.map((s) => [s.type, s.title, s.summary, s.state])).toEqual([
      ['tool', 'Verktøy «saker.sok»', 'Ferdig', undefined],
      ['tool', 'Slo opp fristen', 'fant 2 treff', undefined],
      ['error', 'Egen motor «agent.example.no»', 'Kallet feilet', 'failed'],
    ]);
    expect(steps[0]?.blocks).toEqual([
      { kind: 'tags', label: 'Sendte felt', items: ['q', 'limit'] },
    ]);
    expect(steps[0]?.durationSeconds).toBe(0.4);
    expect(mapRun(events).stats().toolCalls).toBe(1);
  });
});
