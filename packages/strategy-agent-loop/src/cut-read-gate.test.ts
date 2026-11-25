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
import type { AgentLoopRuntimeConfig } from './index.js';
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
});
