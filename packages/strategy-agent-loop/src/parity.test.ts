import { describe, expect, it } from 'vitest';
import {
  computeBudgetRefund,
  enforceStrategyQuota,
  evaluateRead,
  evaluateSufficiency,
  evaluatorSystemPrompt,
  expandShortDocReads,
  gateSystemHint,
  groundingDecision,
  plannedQueryBatch,
  recordReadEvaluation,
  rescoreWithTitleBonus,
  Workspace,
  type EvidencePlan,
  type EvidenceSummary,
  type ReadSignal,
} from './index.js';

const signal = new AbortController().signal;

const summary = (
  overrides: Omit<Partial<EvidenceSummary>, 'query-intent'> & {
    'query-intent': Partial<EvidenceSummary['query-intent']>;
  },
): EvidenceSummary => ({
  query: '',
  'budget-state': {
    'max-search-passes': 4,
    'max-read-operations': 6,
    'max-read-content-length': 12000,
  },
  'search-history': [],
  'read-history': [],
  'readable-chunks': [],
  'latest-search-queries': [],
  'latest-search-summaries': [],
  'unread-chunk-ids': [],
  'unread-range': null,
  ...overrides,
  'query-intent': {
    'answer-type': 'lookup',
    entity: null,
    'year-or-date': null,
    metric: null,
    'doc-family-preference': null,
    'scope-signals': [],
    ...overrides['query-intent'],
  },
});

const heuristic = (query: string, s: EvidenceSummary) =>
  evaluateSufficiency(query, s, undefined, signal);

describe('sufficiency evaluator (ported from sufficiency_test.clj)', () => {
  it('marks two different values for the same year and metric as conflicting', async () => {
    const d = await heuristic(
      'Hvor mange årsverk hadde Digdir i 2022?',
      summary({
        'query-intent': {
          'answer-type': 'numeric-fact',
          entity: 'Digdir',
          'year-or-date': '2022',
          metric: 'årsverk',
        },
        'readable-chunks': [
          {
            'chunk-id': 'c1',
            title: 'Årsrapport Digdir 2022',
            'content-preview': 'Digdir hadde 326 utførte årsverk i 2022.',
          },
          {
            'chunk-id': 'c2',
            title: 'Bemanning Digdir 2022',
            'content-preview': 'Digdir hadde 356 utførte årsverk i 2022.',
          },
        ],
      }),
    );
    expect(d).toMatchObject({
      status: 'conflicting',
      contradictionDetected: true,
      suggestedStrategy: 're-search',
    });
  });

  it('marks evidence for the wrong year as insufficient', async () => {
    const d = await heuristic(
      'Hvor mange årsverk hadde Digdir i 2022?',
      summary({
        'query-intent': {
          'answer-type': 'numeric-fact',
          entity: 'Digdir',
          'year-or-date': '2022',
          metric: 'årsverk',
        },
        'readable-chunks': [
          {
            'chunk-id': 'c1',
            title: 'Årsrapport Digdir 2021',
            'content-preview': 'Digdir hadde 300 utførte årsverk i 2021.',
          },
        ],
      }),
    );
    expect(d).toMatchObject({ status: 'insufficient', suggestedStrategy: 're-search' });
    expect(d.missingInfo.some((m) => m.includes('2022'))).toBe(true);
  });

  it('marks evidence for the wrong entity as off-topic', async () => {
    const d = await heuristic(
      'Hvor mange årsverk hadde Altinn i 2022?',
      summary({
        'query-intent': {
          'answer-type': 'numeric-fact',
          entity: 'Altinn',
          'year-or-date': '2022',
          metric: 'årsverk',
        },
        'readable-chunks': [
          {
            'chunk-id': 'c1',
            title: 'Årsrapport Digdir 2022',
            'content-preview': 'Digdir hadde 326 utførte årsverk i 2022.',
          },
        ],
      }),
    );
    expect(d).toMatchObject({ status: 'off-topic', suggestedStrategy: 're-search' });
    expect(d.reasoning).toMatch(/scope/);
  });

  it('rejects evidence about the entity that misses the topic, and accepts evidence that addresses it', async () => {
    const intent = { 'answer-type': 'lookup', entity: 'Altinn' } as const;
    const missing = await heuristic(
      'Hvordan abonnerer jeg på hendelser i Altinn 3?',
      summary({
        'query-intent': intent,
        'readable-chunks': [
          {
            'chunk-id': 'c1',
            title: 'Om Altinn',
            'content-preview':
              'Altinn er en digital plattform utviklet av Digitaliseringsdirektoratet. Plattformen brukes av offentlige etater og næringsliv for rapportering og kommunikasjon.',
          },
          {
            'chunk-id': 'c2',
            title: 'Altinn organisering',
            'content-preview':
              'Altinn driftes av Digdir og tilbyr tjenester for digital kommunikasjon mellom næringslivet og offentlig sektor.',
          },
        ],
      }),
    );
    const addressed = await heuristic(
      'Hvordan abonnerer jeg på hendelser i Altinn 3?',
      summary({
        'query-intent': intent,
        'readable-chunks': [
          {
            'chunk-id': 'c1',
            title: 'Events - Abonnement',
            'content-preview':
              'For å abonnere på hendelser i Altinn 3, bruk Events API. POST til /subscriptions med webhook-URL og filter for å opprette et abonnement.',
          },
        ],
      }),
    );
    expect(missing.status).toBe('insufficient');
    expect(missing.reasoning).toMatch(/does not.*address/);
    expect(addressed.status).toBe('sufficient');
  });

  const fixture = summary({
    'query-intent': { 'answer-type': 'lookup', entity: 'Altinn' },
    'readable-chunks': [
      {
        'chunk-id': 'c1',
        title: 'Altinn 3',
        'content-preview': 'Altinn 3 is the third generation of the Altinn platform.',
      },
    ],
  });

  it('marks heuristic decisions as degraded and LLM decisions as not degraded', async () => {
    const heuristicD = await heuristic('What is Altinn 3?', fixture);
    const llm = await evaluateSufficiency(
      'What is Altinn 3?',
      fixture,
      async () =>
        '{"status":"sufficient","reasoning":"Looks good.","missing_info":[],"contradiction_detected":false,"suggested_strategy":"finalize"}',
      signal,
    );
    expect(heuristicD).toMatchObject({ degraded: true, degradedReason: 'heuristic-fallback' });
    expect(llm).toMatchObject({ status: 'sufficient', degraded: false });
  });

  it('normalizes case variants and tolerates fenced JSON', async () => {
    const upper = await evaluateSufficiency(
      'q',
      fixture,
      async () =>
        '{"status":"SUFFICIENT","reasoning":"ok","missing_info":[],"contradiction_detected":false,"suggested_strategy":"FINALIZE"}',
      signal,
    );
    const fenced = await evaluateSufficiency(
      'q',
      fixture,
      async () =>
        '```json\n{"status":"insufficient","reasoning":"need more","missing_info":["year"],"contradiction_detected":false,"suggested_strategy":"re-search"}\n```',
      signal,
    );
    expect(upper).toMatchObject({
      status: 'sufficient',
      suggestedStrategy: 'finalize',
      degraded: false,
    });
    expect(fenced).toMatchObject({
      status: 'insufficient',
      missingInfo: ['year'],
      degraded: false,
    });
  });

  it('falls back to the heuristic when the evaluator fails, and sends the language rule', async () => {
    let system = '';
    const failed = await evaluateSufficiency(
      'What is Altinn 3?',
      fixture,
      async () => {
        throw new Error('LLM timeout');
      },
      signal,
    );
    await evaluateSufficiency(
      'Når ble Altinn 3 lansert?',
      fixture,
      async (s) => {
        system = s;
        return '{"status":"sufficient","reasoning":"ok","suggested_strategy":"finalize"}';
      },
      signal,
    );
    expect(failed).toMatchObject({ degraded: true, degradedReason: 'heuristic-fallback' });
    expect(system).toBe(evaluatorSystemPrompt);
    expect(system).toMatch(/SAME LANGUAGE/);
  });

  it('applies the grounding floor and names both permitted outcomes in its hint', () => {
    const w = new Workspace({ searches: 4, reads: 6, readChars: 12000 });
    expect(groundingDecision(w)).toBeUndefined();
    w.citationValidation = {
      grounded: true,
      allValid: true,
      totalReferences: 2,
      validIndices: [1, 2],
      invalidIndices: [],
    };
    expect(groundingDecision(w)).toBeUndefined();
    w.citationValidation = {
      grounded: false,
      allValid: false,
      totalReferences: 1,
      validIndices: [],
      invalidIndices: [9],
    };
    const d = groundingDecision(w);
    expect(d).toMatchObject({
      status: 'insufficient',
      source: 'grounding-gate',
      suggestedStrategy: 'grounding',
    });
    const hint = gateSystemHint(
      'What is the capital of France?',
      d as NonNullable<typeof d>,
      undefined,
    );
    expect(hint).toMatch(/cite/i);
    expect(hint).toMatch(/knowledge base does not cover/i);
    expect(hint).toMatch(/prior knowledge or memory/i);
  });
});

const plan: EvidencePlan = {
  query: 'q',
  queryIntent: {
    'answer-type': 'lookup',
    entity: null,
    'year-or-date': null,
    metric: null,
    'doc-family-preference': null,
    'scope-signals': [],
  },
  requiredClaims: [
    { claimId: 'topic-match', text: 'Topic matches query', kind: 'topic', critical: true },
    {
      claimId: 'answer-bearing-evidence',
      text: 'Contains answer-bearing details',
      kind: 'support',
      critical: true,
    },
  ],
};

const read = (llm: () => string, p: EvidencePlan = plan) =>
  evaluateRead({
    query: 'How do I subscribe to Altinn events?',
    intent: p.queryIntent,
    plan: p,
    openClaims: p.requiredClaims,
    chunks: [
      {
        chunkId: 'c1',
        document: 'd1',
        position: 0,
        title: 'Events API',
        content: 'Use POST /subscriptions.',
      },
    ],
    llm: async () => llm(),
    signal,
  });

describe('read-signal evaluator (ported from read_signals_test.clj)', () => {
  it('maps claim ids back to the evidence plan and keeps support levels and confidence', async () => {
    const s = await read(() =>
      JSON.stringify({
        status: 'support-found',
        scope_assessment: 'aligned',
        supported_claims: [
          {
            claim_id: 'topic-match',
            support: 'explicit',
            chunk_ids: ['c1'],
            notes: 'Directly addresses subscriptions.',
          },
          { claim_id: 'answer-bearing-evidence', support: 'partial', chunk_ids: ['c1'] },
        ],
        remaining_gaps: [],
        contradictions: [],
        next_action_hint: 'finalize',
        confidence: 0.82,
      }),
    );
    expect(s).toMatchObject({
      status: 'support-found',
      scopeAssessment: 'aligned',
      nextActionHint: 'finalize',
      degraded: false,
      confidence: 0.82,
    });
    expect(s.supportedClaims.map((c) => [c.claimId, c.supportLevel])).toEqual([
      ['topic-match', 'explicit'],
      ['answer-bearing-evidence', 'partial'],
    ]);
  });

  it('falls back to a conservative degraded signal on invalid output', async () => {
    const numeric: EvidencePlan = {
      ...plan,
      requiredClaims: [
        { claimId: 'requested-value', text: 'Explicit value', kind: 'value', critical: true },
      ],
    };
    const s = await read(() => '{not valid json}', numeric);
    expect(s).toMatchObject({
      degraded: true,
      evaluationMode: 'degraded-fallback',
      status: 'unclear',
      scopeAssessment: 'ambiguous',
      supportedClaims: [],
      nextActionHint: 're-search',
      confidence: 0,
      degradedReason: 'local-evaluator-failed',
    });
    expect(s.remainingGaps[0]).toEqual({
      claimId: 'requested-value',
      reason: 'not-addressed',
      critical: true,
    });
  });

  it('accepts underscore and case variants without degrading', async () => {
    const s = await read(
      () =>
        '{"status":"Support_Found","scope_assessment":"Aligned","supported_claims":[{"claim_id":"topic-match","support":"Explicit","chunk_ids":["c1"]}],"remaining_gaps":[],"contradictions":[],"next_action_hint":"Finalize","confidence":0.9}',
    );
    expect(s).toMatchObject({
      degraded: false,
      status: 'support-found',
      scopeAssessment: 'aligned',
      nextActionHint: 'finalize',
    });
    expect(s.supportedClaims[0]?.supportLevel).toBe('explicit');
  });
});

const workspaceWith = (lengths: number[]) => {
  const w = new Workspace({ searches: 4, reads: 6, readChars: 12000 });
  lengths.forEach((len, i) =>
    w.chunks.set(`c${i + 1}`, { chunkId: `c${i + 1}`, contentLength: len, content: '' }),
  );
  w.readCharsUsed = lengths.reduce((a, b) => a + b, 0);
  return w;
};

const sig = (
  o: Partial<ReadSignal> & { chunkIds: string[] },
): ReadSignal & { chunkIds: string[] } => ({
  status: 'support-found',
  scopeAssessment: 'aligned',
  supportedClaims: [],
  partialClaims: [],
  remainingGaps: [],
  contradictions: [],
  nextActionHint: 'finalize',
  confidence: 0.8,
  degraded: false,
  evaluationMode: 'llm',
  ...o,
});

describe('read budget refund (ported from workspace_test.clj)', () => {
  it('refunds nothing when every read chunk supports a claim', () => {
    const w = workspaceWith([1000, 2000]);
    expect(
      computeBudgetRefund(
        w,
        sig({
          chunkIds: ['c1', 'c2'],
          supportedClaims: [
            { claimId: 'topic-match', supportLevel: 'explicit', chunkIds: ['c1', 'c2'] },
          ],
        }),
      ),
    ).toEqual({ refundedIds: [], refundedChars: 0 });
  });

  it.each([
    ['low confidence', { confidence: 0 }],
    ['a degraded signal', { degraded: true, status: 'unclear' as const, confidence: 0.9 }],
    ['an unclear status', { status: 'unclear' as const, confidence: 0.9 }],
  ])('refunds nothing for %s', (_label, overrides) => {
    expect(
      computeBudgetRefund(workspaceWith([1500]), sig({ chunkIds: ['c1'], ...overrides })),
    ).toEqual({ refundedIds: [], refundedChars: 0 });
  });

  it('refunds only unsupported chunks, and never twice', () => {
    const w = workspaceWith([1000, 2000, 3000]);
    const s = sig({
      chunkIds: ['c1', 'c2', 'c3'],
      confidence: 0.7,
      supportedClaims: [{ claimId: 'topic-match', supportLevel: 'explicit', chunkIds: ['c1'] }],
    });
    expect(computeBudgetRefund(w, s)).toEqual({ refundedIds: ['c2', 'c3'], refundedChars: 5000 });

    w.evidencePlan = { ...plan, requiredClaims: [] };
    recordReadEvaluation(w, s);
    expect(w.readCharsUsed).toBe(1000);
    expect([...w.refunded].sort()).toEqual(['c2', 'c3']);
    recordReadEvaluation(w, s);
    expect(w.readCharsUsed).toBe(1000);
  });

  it('marks chunks that were confidently read without support as non-supporting', () => {
    const w = workspaceWith([500, 500]);
    w.evidencePlan = plan;
    recordReadEvaluation(w, sig({ chunkIds: ['c1', 'c2'], status: 'gap-remaining' }));
    expect([...w.nonSupporting].sort()).toEqual(['c1', 'c2']);
    recordReadEvaluation(
      w,
      sig({
        chunkIds: ['c2'],
        supportedClaims: [{ claimId: 'topic-match', supportLevel: 'partial', chunkIds: ['c2'] }],
      }),
    );
    expect([...w.nonSupporting]).toEqual(['c1']);
  });
});

describe('short documents', () => {
  it('are not expanded, because headless-rag never sees their size in search summaries', () => {
    const w = new Workspace({ searches: 4, reads: 6, readChars: 12000 });
    w.recordSearch(['q'], [{ chunkId: 'c1', document: 'd1', position: 0, totalChunks: 3 }], false);
    expect(expandShortDocReads(w, ['c1'])).toEqual({ chunkIdReads: ['c1'], docRangeReads: [] });
  });
});

describe('search rescoring and quota', () => {
  const hits = [
    {
      chunkId: 'a',
      rerankScore: 20,
      title: 'Generelt om økonomi',
      searchTypes: ['content' as const],
    },
    {
      chunkId: 'b',
      rerankScore: 19,
      title: 'Create user in Altinn Studio',
      url: 'https://docs/altinn-studio/create-user',
      searchTypes: ['phrase' as const],
    },
    {
      chunkId: 'c',
      rerankScore: 18,
      title: 'Annet',
      searchTypes: ['metadata' as const, 'content' as const],
    },
  ];

  it('leaves the order alone at weight 0 and lifts title matches at weight 5', () => {
    expect(rescoreWithTitleBonus(hits, 'create user studio', 0).map((h) => h.chunkId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const rescored = rescoreWithTitleBonus(hits, 'create user studio', 5);
    expect(rescored.map((h) => [h.chunkId, h.titleOverlapBonus])).toEqual([
      ['b', 3],
      ['a', 0],
      ['c', 0],
    ]);
  });

  it('interleaves the top chunks of each strategy when a quota is set', () => {
    const many = [
      { chunkId: 'm1', searchTypes: ['metadata' as const] },
      { chunkId: 'c1', searchTypes: ['content' as const] },
      { chunkId: 'm2', searchTypes: ['metadata' as const] },
      { chunkId: 'p1', searchTypes: ['phrase' as const, 'content' as const] },
      { chunkId: 'x', searchTypes: [] },
    ];
    expect(enforceStrategyQuota(many, 0).map((c) => c.chunkId)).toEqual([
      'm1',
      'c1',
      'm2',
      'p1',
      'x',
    ]);
    expect(enforceStrategyQuota(many, 2).map((c) => c.chunkId)).toEqual([
      'p1',
      'm1',
      'c1',
      'm2',
      'x',
    ]);
  });
});

describe('planned query batch', () => {
  it('keeps planner phrases first, normalizes and caps the batch at six', () => {
    expect(
      plannedQueryBatch(
        'Hvor mange årsverk hadde Digdir i 2022?',
        [],
        ['Hvor mange årsverk hadde Digdir i 2022?', 'Digdir årsverk 2022'],
      ),
    ).toEqual([
      'hvor mange årsverk hadde digdir i 2022',
      'digdir årsverk 2022',
      'årsverk digdir 2022',
      'utførte årsverk digdir 2022',
      'digdir årsrapport 2022 årsverk',
      'digdir antall ansatte årsverk 2022',
    ]);
  });
});
