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
