import { describe, expect, it } from 'vitest';
import {
  baseConfig,
  call,
  chunk,
  decision,
  readSignal,
  result,
  retrieval,
  run,
  section,
  toolMessages,
  type Script,
} from './harness.test-utils.js';
import {
  aggregateReadSignals,
  recordReadEvaluation,
  Workspace,
  type AgentLoopRuntimeConfig,
  type EvidencePlan,
} from './index.js';
import type { Chunk, ChunkSummary } from './workspace.js';

// One 20-chunk report, a page a chunk, as the Tromsø KI evaluation of case 014.
const report = new Map<string, Chunk>(
  Array.from({ length: 20 }, (_, i) => [
    `p${i}`,
    chunk(i, {
      chunkId: `p${i}`,
      document: 'dA',
      position: i,
      totalChunks: 20,
      title: 'Evaluering av bruk av kunstig intelligens i Tromsø kommune',
      content: `Side ${i}.`,
    }),
  ]),
);

const hit = (position: number, score: number): ChunkSummary => ({
  chunkId: `p${position}`,
  document: 'dA',
  position,
  totalChunks: 20,
  title: 'Evaluering av bruk av kunstig intelligens i Tromsø kommune',
  score,
});

const searching = (hits: ChunkSummary[]) =>
  retrieval(
    { search: async () => ({ chunks: hits.map((c, i) => ({ ...c, rank: i + 1 })) }) },
    report,
  );

// The scores of run 1932d959: the cap returns 0–9, and a hit in the left-out 10–16
// scored below the best returned hit but above the weakest.
const case014 = (leftOut: number) => [hit(2, 1.802), hit(10, leftOut), hit(9, 1.75), hit(3, 1.693)];

// The read check finds every planned claim explicitly supported, as the summary pages did.
const supportFound = (prompt: string) => {
  const plan = JSON.parse(section(prompt, 'Evidence plan JSON:') ?? '{"required_claims":[]}') as {
    required_claims: { claim_id: string }[];
  };
  const chunks = JSON.parse(section(prompt, 'Newly read chunks JSON:') ?? '[]') as {
    chunk_id: string;
  }[];
  return readSignal('support-found', {
    supported_claims: plan.required_claims.map((c) => ({
      claim_id: c.claim_id,
      support: 'explicit',
      chunk_ids: chunks.map((x) => x.chunk_id),
    })),
    remaining_gaps: [],
    next_action_hint: 'finalize',
  });
};

const withBudget = (budget: Record<string, number>): AgentLoopRuntimeConfig => ({
  ...baseConfig,
  strategy: {
    ...baseConfig.strategy,
    budget: { searches: 4, reads: 6, readChars: 150000, ...budget },
  },
});

const readThenLeftOut: Script['loop'] = [
  () => result('', [call('search', { queries: ['Tromsø kommune KI rapport'] })]),
  () => result('', [call('read_chunks', { doc_num: 'dA', chunk_range: { from: 0, to: 16 } })]),
  () => result('', [call('read_chunks', { doc_num: 'dA', chunk_range: { from: 10, to: 16 } })]),
  () => result('Ferdig.'),
];

const ranges = (r: ReturnType<typeof retrieval>) =>
  r.calls.filter((c) => c.op === 'range').map((c) => c.args);

const shadowGates = (out: Awaited<ReturnType<typeof run>>) =>
  out.notices.filter((n) => n.stage === 'gate' && n.source === 'shadow-read-signals');

describe('the read check after a cut read', () => {
  it('a cut read with a better unread hit in the left-out part does not finalize', async () => {
    const r = searching(case014(1.78));
    const out = await run({
      retrieval: r.impl,
      config: withBudget({}),
      scripts: { primary: { loop: readThenLeftOut, read: [supportFound] } },
    });

    expect(ranges(r)).toEqual([
      ['dA', 0, 9],
      ['dA', 10, 16],
    ]);
    expect(shadowGates(out)).toHaveLength(1);
  });

  it('a cut read whose left-out hits all score below the returned hits finalizes', async () => {
    const r = searching(case014(1.6));
    const out = await run({
      retrieval: r.impl,
      config: withBudget({}),
      scripts: { primary: { loop: readThenLeftOut, read: [supportFound] } },
    });

    expect(ranges(r)).toEqual([['dA', 0, 9]]);
    expect(shadowGates(out)[0]).toMatchObject({ status: 'sufficient', strategy: 'finalize' });
  });

  it('a cut read with no reads left finalizes as before', async () => {
    const r = searching(case014(1.78));
    const out = await run({
      retrieval: r.impl,
      config: withBudget({ reads: 1 }),
      scripts: { primary: { loop: readThenLeftOut, read: [supportFound] } },
    });

    expect(ranges(r)).toHaveLength(1);
    expect(shadowGates(out)[0]).toMatchObject({ status: 'sufficient', strategy: 'finalize' });
  });

  it('the read-more hint after a cut read names the left-out chunk_range', async () => {
    const r = searching(case014(1.78));
    const out = await run({
      retrieval: r.impl,
      config: withBudget({}),
      scripts: {
        primary: {
          loop: [
            readThenLeftOut[0] as Script['loop'][number],
            readThenLeftOut[1] as Script['loop'][number],
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('Ferdig.'),
          ],
          read: [supportFound],
          synth: [() => 'Svar fra sammendraget [1].'],
          sufficiency: [() => decision('insufficient', 'read-more')],
        },
      },
    });

    expect(toolMessages(out.loops[3]).join('\n')).toContain(
      'read_chunks {"doc_num":"dA","chunk_range":{"from":10,"to":16}}',
    );
  });

  it('a read the character budget cut with no room for one more chunk finalizes as before', async () => {
    // 1,500 characters a chunk and 6,700 to read: the budget cuts 0–16 to 1–4, and 700 are left.
    const long = new Map(
      [...report].map(([id, c]) => [id, { ...c, content: 'x'.repeat(1500) }] as const),
    );
    const r = retrieval(
      {
        search: async () => ({
          chunks: case014(1.78).map((c, i) => ({ ...c, contentLength: 1500, rank: i + 1 })),
        }),
      },
      long,
    );
    const out = await run({
      retrieval: r.impl,
      config: withBudget({ readChars: 6700 }),
      scripts: { primary: { loop: readThenLeftOut, read: [supportFound] } },
    });

    expect(ranges(r)).toHaveLength(1);
    expect(shadowGates(out)[0]).toMatchObject({ status: 'sufficient', strategy: 'finalize' });
  });

  it('a cut read with only one round left finalizes as before', async () => {
    const r = searching(case014(1.78));
    const out = await run({
      retrieval: r.impl,
      config: { ...withBudget({}), strategy: { ...withBudget({}).strategy, maxIterations: 4 } },
      scripts: { primary: { loop: readThenLeftOut, read: [supportFound] } },
    });

    expect(out.notices.filter((n) => n.stage === 'exhausted')).toEqual([]);
    expect(shadowGates(out)[0]).toMatchObject({ status: 'sufficient', strategy: 'finalize' });
  });

  it('a cut read with two rounds left reads the rest', async () => {
    const r = searching(case014(1.78));
    await run({
      retrieval: r.impl,
      config: { ...withBudget({}), strategy: { ...withBudget({}).strategy, maxIterations: 5 } },
      scripts: { primary: { loop: readThenLeftOut, read: [supportFound] } },
    });

    expect(ranges(r)).toEqual([
      ['dA', 0, 9],
      ['dA', 10, 16],
    ]);
  });

  it('a read-more hint after a read check that found a gap in a cut read does not name the left-out range', async () => {
    const r = searching(case014(1.78));
    const out = await run({
      retrieval: r.impl,
      config: withBudget({}),
      scripts: {
        primary: {
          loop: [
            readThenLeftOut[0] as Script['loop'][number],
            readThenLeftOut[1] as Script['loop'][number],
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('gap-remaining')],
          synth: [() => 'Svar fra sammendraget [1].'],
          sufficiency: [() => decision('insufficient', 'read-more')],
        },
      },
    });

    const hint = toolMessages(out.loops[3]).join('\n');
    expect(hint).toContain('Read more from the current result set');
    expect(hint).not.toContain('read_chunks {"doc_num":"dA","chunk_range":{"from":10,"to":16}}');
  });

  it('an answer written after a cut read that says it found nothing still gets its citations added', async () => {
    const r = searching(case014(1.78));
    const out = await run({
      retrieval: r.impl,
      config: withBudget({}),
      scripts: {
        primary: {
          loop: [
            readThenLeftOut[0] as Script['loop'][number],
            readThenLeftOut[1] as Script['loop'][number],
            () => result('Jeg fant ikke årsakene i rapporten.'),
          ],
          read: [supportFound],
        },
      },
    });

    expect(out.notices.find((n) => n.stage === 'citations')).toMatchObject({
      action: 'backfill',
    });
  });
});

const claimPlan: EvidencePlan = {
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
    { claimId: 'answer-bearing-evidence', text: 'Answer', kind: 'support', critical: true },
  ],
};

// A workspace after one search and a 0–16 read the cap cut to 0–9, which the read check
// found explicit support in.
const afterCutRead = (hits: ChunkSummary[], limits = { readChars: 150000, reads: 6 }) => {
  const w = new Workspace({ searches: 4, ...limits });
  w.evidencePlan = claimPlan;
  w.recordSearch(['q'], hits, false);
  const returned = [...report.values()].filter((c) => (c.position ?? 0) <= 9);
  w.addChunks(returned);
  w.recordRead(
    { document: 'dA', chunkRange: { from: 0, to: 9 }, requestedRange: { from: 0, to: 16 } },
    returned,
  );
  recordReadEvaluation(w, {
    status: 'support-found',
    scopeAssessment: 'aligned',
    supportedClaims: [
      { claimId: 'answer-bearing-evidence', supportLevel: 'explicit', chunkIds: ['p2'] },
    ],
    partialClaims: [],
    remainingGaps: [],
    contradictions: [],
    nextActionHint: 'finalize',
    confidence: 0.9,
    degraded: false,
    evaluationMode: 'llm',
    chunkIds: returned.map((c) => c.chunkId),
  });
  return w;
};

describe('the read-signal verdict after a cut read', () => {
  it('a left-out hit as good as the weakest returned hit asks to read the left-out part', () => {
    expect(aggregateReadSignals(afterCutRead(case014(1.693)))).toMatchObject({
      status: 'insufficient',
      suggestedStrategy: 'read-more',
      reasonCode: 'cut-read-left-out-better-hit',
    });
  });

  it('a cut read that returned no search hit asks to read a left-out part with one', () => {
    expect(aggregateReadSignals(afterCutRead([hit(12, 0.2)]))).toMatchObject({
      status: 'insufficient',
      reasonCode: 'cut-read-left-out-better-hit',
    });
  });

  it('a cut read with no characters left finalizes as before', () => {
    const used = afterCutRead(case014(1.78)).readCharsUsed;
    const w = afterCutRead(case014(1.78), { readChars: used, reads: 6 });
    expect(w.budget().readCharsRemaining).toBe(0);
    expect(aggregateReadSignals(w)).toMatchObject({
      status: 'sufficient',
      reasonCode: 'all-critical-claims-covered',
    });
  });
});
