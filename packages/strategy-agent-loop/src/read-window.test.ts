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
    const r = searches([hit(13, 1.71), hit(2, 0.4)], [hit(1, 0.9), hit(13, 0.3)]);
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
    // About 1,500 characters a chunk, so 7,500 characters hold 5 chunks.
    const r = searches([hit(1, 0.9)]);
    await run({
      retrieval: r.impl,
      config: withBudget({ readChars: 7500 }),
      scripts: { primary: { loop: readRange(0, 16) } },
    });
    const [, from, to] = ranges(r)[0] as [string, number, number];
    expect(to - from + 1).toBe(5);
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
      'This read was cut to the read cap of 10 chunks. Returned chunk_index 9–18 of doc_num="dA". Left out chunk_index 0–8, 19.',
    );
  });

  it('a read cut by the budget says so, not the read cap', async () => {
    const r = searches([{ ...hit(13, 1.71), contentLength: 600 }]);
    const out = await run({
      retrieval: r.impl,
      config: withBudget({ readChars: 12000 }),
      scripts: {
        primary: { loop: readRange(0, 19), read: [() => readSignal('gap-remaining')] },
      },
    });
    const note = toolMessages(out.loops[2])[1];
    const [, from, to] = ranges(r)[0] as [string, number, number];
    expect(to - from + 1).toBeLessThan(10);
    expect(note).toContain(
      'This read was cut to fit the read budget left: 12000 characters and 6 reads.',
    );
    expect(note).not.toContain('read cap');
  });

  it('a cut read does not list positions already read as left out', async () => {
    const r = searches([hit(15, 1)]);
    const out = await run({
      retrieval: r.impl,
      config: withBudget({}),
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () =>
              result('', [call('read_chunks', { doc_num: 'dA', chunk_range: { from: 0, to: 9 } })]),
            () =>
              result('', [
                call('read_chunks', { doc_num: 'dA', chunk_range: { from: 0, to: 19 } }),
              ]),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('gap-remaining')],
        },
      },
    });
    expect(ranges(r)).toEqual([
      ['dA', 0, 9],
      ['dA', 10, 19],
    ]);
    expect(toolMessages(out.loops[3])[2]).not.toContain('Left out');
  });

  it('a range read that finds nothing does not claim it was cut', async () => {
    const r = searches([hit(1, 0.9)]);
    const out = await run({
      retrieval: r.impl,
      config: withBudget({}),
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () =>
              result('', [
                call('read_chunks', { doc_num: 'nope', chunk_range: { from: 0, to: 4 } }),
              ]),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('gap-remaining')],
        },
      },
    });
    expect(out.loops.flatMap((l) => toolMessages(l)).join('\n')).not.toContain('This read was cut');
  });

  it('a read that leaves out two spans names a call for each', async () => {
    const r = searches([hit(13, 1.71)]);
    const out = await run({
      retrieval: r.impl,
      config: withBudget({}),
      scripts: {
        primary: { loop: readRange(0, 19), read: [() => readSignal('gap-remaining')] },
      },
    });
    expect(toolMessages(out.loops[2])[1]).toContain(
      'To read them, call read_chunks with {"doc_num": "dA", "chunk_range": {"from": 0, "to": 8}} and with {"doc_num": "dA", "chunk_range": {"from": 19, "to": 19}}.',
    );
  });

  it('a first range read past the end uses the length the search reported', async () => {
    const short = new Map<string, Chunk>(
      [...report].slice(0, 12).map(([id, c]) => [id, { ...c, totalChunks: 12 }]),
    );
    const r = retrieval(
      {
        search: async () => ({
          chunks: [{ ...hit(10, 1), totalChunks: 12, rank: 1 }],
        }),
      },
      short,
    );
    await run({
      retrieval: r.impl,
      config: withBudget({}),
      scripts: { primary: { loop: readRange(0, 30) } },
    });
    expect(ranges(r)).toEqual([['dA', 2, 11]]);
  });

  it('a read trimmed after the fetch says budget, not read cap', async () => {
    // The search reports 100 characters a chunk, but each holds 1,500.
    const long = new Map<string, Chunk>(
      [...report].map(([id, c]) => [id, { ...c, content: 'x'.repeat(1500) }]),
    );
    const r = retrieval(
      {
        search: async () => ({
          chunks: Array.from({ length: 20 }, (_, i) => ({
            ...hit(i, i === 13 ? 1.71 : 0.1),
            contentLength: 100,
            rank: i + 1,
          })),
        }),
      },
      long,
    );
    const out = await run({
      retrieval: r.impl,
      config: withBudget({ readChars: 12000 }),
      scripts: {
        primary: { loop: readRange(0, 19), read: [() => readSignal('gap-remaining')] },
      },
    });
    expect(ranges(r)).toEqual([['dA', 9, 18]]);
    const note = toolMessages(out.loops[2])[1];
    expect(note).toContain(
      'This read was cut to fit the read budget left: 12000 characters and 6 reads.',
    );
    expect(note).not.toContain('read cap');
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
