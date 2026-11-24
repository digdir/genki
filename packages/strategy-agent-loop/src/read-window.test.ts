import { describe, expect, it } from 'vitest';
import {
  baseConfig,
  call,
  chunk,
  readSignal,
  result,
  retrieval,
  run,
  toolMessages,
  type Script,
} from './harness.test-utils.js';
import type { AgentLoopRuntimeConfig } from './index.js';
import type { Chunk, ChunkSummary } from './workspace.js';

// One 20-chunk document, a Kudos report of about a page a chunk.
const report = new Map<string, Chunk>(
  Array.from({ length: 20 }, (_, i) => [
    `p${i}`,
    chunk(i, {
      chunkId: `p${i}`,
      document: 'dA',
      position: i,
      totalChunks: 20,
      title: 'Digitalisering i politiet',
      content: `Side ${i}.`,
    }),
  ]),
);

const hit = (position: number, score: number): ChunkSummary => ({
  chunkId: `p${position}`,
  document: 'dA',
  position,
  totalChunks: 20,
  title: 'Digitalisering i politiet',
  score,
});

// Each search returns the next list of hits, in the order given.
const searches = (...lists: ChunkSummary[][]) => {
  let n = 0;
  const r = retrieval(
    {
      search: async () => ({
        chunks: (lists[Math.min(n++, lists.length - 1)] ?? []).map((c, i) => ({
          ...c,
          rank: i + 1,
        })),
      }),
    },
    report,
  );
  return r;
};

const readRange = (from: number, to: number): Script['loop'] => [
  () => result('', [call('search', { queries: ['x'] })]),
  () => result('', [call('read_chunks', { doc_num: 'dA', chunk_range: { from, to } })]),
  () => result('Ferdig.'),
];

const withBudget = (budget: Record<string, number>): AgentLoopRuntimeConfig => ({
  ...baseConfig,
  strategy: {
    ...baseConfig.strategy,
    budget: { searches: 4, reads: 6, readChars: 150000, ...budget },
  },
});

const ranges = (r: ReturnType<typeof retrieval>) =>
  r.calls.filter((c) => c.op === 'range').map((c) => c.args);

describe('range reads', () => {
  it('a range read returns every chunk asked for up to the read cap', async () => {
    for (const [from, to] of [
      [0, 5],
      [0, 9],
    ] as const) {
      const r = searches([hit(1, 0.9)]);
      await run({
        retrieval: r.impl,
        config: withBudget({}),
        scripts: { primary: { loop: readRange(from, to) } },
      });
      expect(ranges(r)).toEqual([['dA', from, to]]);
    }
  });

  it('a range wider than the cap is centred on the best-scoring unread hit in it', async () => {
    // The best hit (position 13) came from the first search; the last search lists
    // the contents (position 1) first.
    const r = searches([hit(13, 1.71), hit(2, 0.4)], [hit(1, 0.9), hit(13, 1.2)]);
    await run({
      retrieval: r.impl,
      config: withBudget({}),
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('search', { queries: ['y'] })]),
            () =>
              result('', [
                call('read_chunks', { doc_num: 'dA', chunk_range: { from: 0, to: 19 } }),
              ]),
            () => result('Ferdig.'),
          ],
        },
      },
    });
    expect(ranges(r)).toEqual([['dA', 9, 18]]);
  });

  it('the read cap shrinks when the remaining read budget cannot hold it', async () => {
    // About 1,500 characters a chunk, so 4,500 characters hold 3 chunks.
    const r = searches([hit(1, 0.9)]);
    await run({
      retrieval: r.impl,
      config: withBudget({ readChars: 4500 }),
      scripts: { primary: { loop: readRange(0, 16) } },
    });
    const [, from, to] = ranges(r)[0] as [string, number, number];
    expect(to - from + 1).toBe(3);
  });

  it('a cut read says which positions it left out', async () => {
    const r = searches([hit(13, 1.71)]);
    const out = await run({
      retrieval: r.impl,
      config: withBudget({}),
      scripts: {
        primary: { loop: readRange(0, 19), read: [() => readSignal('gap-remaining')] },
      },
    });
    expect(toolMessages(out.loops[2])[1]).toContain(
      'This read was cut to the read cap of 10 chunks. Returned chunk_index 9–18 of doc_num="dA". Left out chunk_index 0–8, 19. To read them, call read_chunks with {"doc_num": "dA", "chunk_range": {"from": 0, "to": 8}}.',
    );
  });

  it('budget.chunksPerRead sets the cap', async () => {
    const r = searches([hit(1, 0.9)]);
    await run({
      retrieval: r.impl,
      config: withBudget({ chunksPerRead: 4 }),
      scripts: { primary: { loop: readRange(0, 9) } },
    });
    expect(ranges(r)).toEqual([['dA', 0, 3]]);
  });
});
