import { describe, expect, it } from 'vitest';
import {
  allSupported,
  baseConfig,
  call,
  chunk,
  readSignal,
  result,
  retrieval,
  run,
} from './harness.test-utils.js';

const unsure = () => readSignal('gap-remaining', { scope_assessment: 'ambiguous' });
const promptFrom = (out: Awaited<ReturnType<typeof run>>) =>
  out.seen.find((s) => s.kind === 'synth')?.request.messages[1]?.content ?? '';
// Each numbered source in the synthesis prompt as `[N] text`, without its untrusted-data frame.
const sourcesIn = (out: Awaited<ReturnType<typeof run>>) =>
  promptFrom(out)
    .split('\n</untrusted_data>')
    .flatMap((part) => {
      const open = part.lastIndexOf('<untrusted_data ');
      const number = part.slice(0, open).match(/\[(\d+)\] $/)?.[1];
      return open < 0 || !number
        ? []
        : [`[${number}] ${part.slice(part.indexOf('>\n', open) + 2)}`];
    });
const attached = {
  mime: 'text/plain',
  body: { kind: 'text' as const, text: 'Attached instructions.' },
  meta: { attached: true, name: 'instructions.txt', sha256: 'abc' },
};

describe('synthesis context selection', () => {
  it.each(['agent', 'sufficiency gate'])(
    'includes decisive evidence read after more than ten chunks when the %s finalizes',
    async (finalizer) => {
      const earlier = Array.from({ length: 12 }, (_, i) => chunk(i + 1, { contentLength: 100 }));
      const decisive = chunk(13, { content: 'The EU AI Act supplies the decisive answer.' });
      const unread = chunk(14, { content: 'This search hit was never read.' });
      const store = new Map([...earlier, decisive, unread].map((c) => [c.chunkId, c]));
      const r = retrieval({}, store);
      const out = await run({
        retrieval: r.impl,
        scripts: {
          primary: {
            loop: [
              () => result('', [call('search', { queries: ['AI Act'] })]),
              () => result('', [call('read_chunks', { chunk_ids: earlier.map((c) => c.chunkId) })]),
              () => result('', [call('read_chunks', { chunk_ids: [decisive.chunkId] })]),
              () =>
                finalizer === 'agent'
                  ? result('', [call('generate_response', { query: 'AI Act' })])
                  : result('', [call('search', { queries: ['AI Act artikkel'] })]),
            ],
            read: [unsure, finalizer === 'sufficiency gate' ? allSupported : unsure],
            synth: [() => 'Svar [1].'],
          },
        },
      });

      expect(out.task.status).toBe('completed');
      expect(r.calls.filter((c) => c.op === 'read')[0]?.args).toEqual(
        earlier.map((c) => c.chunkId),
      );
      // The last read's check runs alongside the fourth turn, so the gate finalizes after it.
      expect(out.loops).toHaveLength(4);
      expect(promptFrom(out)).toContain(decisive.content);
      for (const c of earlier) expect(promptFrom(out)).toContain(c.content);
      expect(promptFrom(out)).not.toContain(unread.content);
      expect(r.calls.filter((c) => c.op === 'rerank')).toEqual([]);
      if (finalizer === 'sufficiency gate')
        expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c13' }] });
    },
  );

  const explicitAndAutoReads = () =>
    run({
      parts: [attached],
      retrieval: retrieval().impl,
      config: {
        ...baseConfig,
        strategy: { ...baseConfig.strategy, search: { autoReadTopK: 2 } },
      },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['instructions'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c4', 'c3'] })]),
            () => result('', [call('generate_response', { query: 'instructions' })]),
          ],
          read: [unsure],
          synth: [() => 'Svar [1][2][3][4][5].'],
        },
      },
    });

  it('puts attachments first when no rerank selected the context', async () => {
    const out = await explicitAndAutoReads();

    expect(sourcesIn(out)[0]).toBe('[1] Attached instructions.');
  });

  it('ranks explicit reads ahead of auto-reads ranked higher in search', async () => {
    const out = await explicitAndAutoReads();

    // Read results carry no scores: use search summaries, where c3 ranks above c4.
    expect(sourcesIn(out).slice(1)).toEqual([
      '[2] Innhold i chunk 3.',
      '[3] Innhold i chunk 4.',
      '[4] Innhold i chunk 1.',
      '[5] Innhold i chunk 2.',
    ]);
    expect(out.meta).toEqual({
      citations: [
        { index: 1, chunkId: 'attached:abc:0' },
        { index: 2, chunkId: 'c3' },
        { index: 3, chunkId: 'c4' },
        { index: 4, chunkId: 'c1' },
        { index: 5, chunkId: 'c2' },
      ],
    });
  });

  const rerankThenRead = () =>
    run({
      parts: [attached],
      retrieval: retrieval({ rerank: async () => [chunk(3), chunk(1)] }).impl,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['instructions'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3'] })]),
            () => result('', [call('rerank_results', { query: 'instructions' })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c4'] })]),
            () => result('', [call('generate_response', { query: 'instructions' })]),
          ],
          read: [unsure],
          synth: [() => 'Svar [1][2][3].'],
        },
      },
    });

  it('keeps the reranked selection and its order after later reads', async () => {
    const out = await rerankThenRead();

    expect(out.loops).toHaveLength(5);
    expect(sourcesIn(out).slice(1)).toEqual(['[2] Innhold i chunk 3.', '[3] Innhold i chunk 1.']);
    expect(promptFrom(out)).not.toContain(chunk(2).content);
    expect(promptFrom(out)).not.toContain(chunk(4).content);
    expect(out.meta).toEqual({
      citations: [
        { index: 1, chunkId: 'attached:abc:0' },
        { index: 2, chunkId: 'c3' },
        { index: 3, chunkId: 'c1' },
      ],
    });
  });

  it('puts attachments first when a rerank selected the context', async () => {
    const out = await rerankThenRead();

    expect(sourcesIn(out)[0]).toBe('[1] Attached instructions.');
  });

  const earlier = chunk(1, { content: 'a'.repeat(600), contentLength: 600 });
  const decisive = chunk(2, { content: 'Decisive evidence.'.repeat(30), contentLength: 1 });
  const refundedThenSupported = (sources?: 'read') =>
    run({
      retrieval: retrieval({}, new Map([earlier, decisive].map((c) => [c.chunkId, c]))).impl,
      config: {
        ...baseConfig,
        strategy: { ...baseConfig.strategy, budget: { readChars: 700 }, sources },
      },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['evidence'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c2'] })]),
          ],
          read: [unsure, allSupported],
          synth: [() => 'Svar [1].'],
        },
      },
    });

  it('ranks a read that supports a claim ahead of earlier reads', async () => {
    const out = await refundedThenSupported();

    expect(sourcesIn(out)[0]).toBe(`[1] ${decisive.content}`);
    expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c2' }] });
  });

  it('leaves a read out of the synthesis when refunds let the reads exceed the read budget', async () => {
    const out = await refundedThenSupported();

    expect(promptFrom(out)).not.toContain(earlier.content);
  });

  it('keeps every read chunk as a source when the synthesis is bounded and the service lists what it read', async () => {
    const out = await refundedThenSupported('read');

    expect(out.sources.map((s) => s.chunkId)).toEqual(['c2', 'c1']);
  });

  const sized = (n: number, length: number) =>
    chunk(n, { content: `Kilde ${n}. `.padEnd(length, 'x'), contentLength: 1 });
  const numbered = (...chunks: ReturnType<typeof chunk>[]) =>
    chunks.map((c, i) => `[${i + 1}] ${c.content}`);
  const answerWithin = (
    readChars: number,
    chunks: ReturnType<typeof chunk>[],
    reads: string[][],
    options: {
      summaries?: Record<string, { rank: number; score: number; hitCount: number }>;
      read?: (() => string)[];
    } = {},
  ) =>
    run({
      retrieval: retrieval(
        {
          search: async () => ({
            chunks: chunks.map(({ content: _content, ...summary }, i) => ({
              ...summary,
              rank: i + 1,
              score: 1 - i / 10,
              ...options.summaries?.[summary.chunkId],
            })),
          }),
        },
        new Map(chunks.map((c) => [c.chunkId, c])),
      ).impl,
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, budget: { readChars } } },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['evidence'] })]),
            ...reads.map((ids) => () => result('', [call('read_chunks', { chunk_ids: ids })])),
            () => result('', [call('generate_response', { query: 'evidence' })]),
          ],
          read: options.read ?? reads.map(() => unsure),
          synth: [() => 'Svar [1].'],
        },
      },
    });

  it('ranks a read that a contradiction cites ahead of reads ranked higher in search', async () => {
    const chunks = [1, 2, 3].map((n) => sized(n, 400));
    const out = await answerWithin(500, chunks, [['c1', 'c2', 'c3']], {
      read: [
        () =>
          readSignal('conflicting', {
            contradictions: [{ claim_id: 'answer-bearing-evidence', chunk_ids: ['c3'] }],
          }),
      ],
    });

    expect(sourcesIn(out)).toEqual(numbered(chunks[2] as ReturnType<typeof chunk>));
  });

  it('ranks a read judged not to support the answer after a later read', async () => {
    const [first, second] = [sized(1, 600), sized(2, 594)];
    const out = await answerWithin(700, [first, second], [['c1'], ['c2']], {
      read: [() => readSignal('gap-remaining'), unsure],
    });

    expect(sourcesIn(out)).toEqual(numbered(second));
  });

  it('breaks equal rerank scores by the higher retrieval prior', async () => {
    const chunks = [sized(1, 400), sized(2, 400)];
    const out = await answerWithin(500, chunks, [['c1', 'c2']], {
      summaries: {
        c1: { rank: 1, score: 0.5, hitCount: 1 },
        c2: { rank: 1, score: 0.9, hitCount: 1 },
      },
    });

    expect(sourcesIn(out)).toEqual(numbered(chunks[1] as ReturnType<typeof chunk>));
  });

  it('breaks equal retrieval priors by the higher hit count', async () => {
    const chunks = [sized(1, 400), sized(2, 400)];
    const out = await answerWithin(500, chunks, [['c1', 'c2']], {
      summaries: {
        c1: { rank: 1, score: 0.5, hitCount: 1 },
        c2: { rank: 1, score: 0.5, hitCount: 3 },
      },
    });

    expect(sourcesIn(out)).toEqual(numbered(chunks[1] as ReturnType<typeof chunk>));
  });

  it('breaks equal hit counts by the lower original rank', async () => {
    const chunks = [sized(1, 400), sized(2, 400)];
    const out = await answerWithin(500, chunks, [['c1', 'c2']], {
      summaries: {
        c1: { rank: 5, score: 0.5, hitCount: 1 },
        c2: { rank: 2, score: 0.5, hitCount: 1 },
      },
    });

    expect(sourcesIn(out)).toEqual(numbered(chunks[1] as ReturnType<typeof chunk>));
  });

  it('skips a read that no longer fits the read budget and adds a smaller one after it', async () => {
    const chunks = [sized(1, 400), sized(2, 400), sized(3, 100)];
    const out = await answerWithin(700, chunks, [['c1', 'c2', 'c3']]);

    expect(sourcesIn(out)).toEqual(
      numbered(chunks[0] as ReturnType<typeof chunk>, chunks[2] as ReturnType<typeof chunk>),
    );
  });

  it('keeps the top-ranked read when it alone is longer than the read budget', async () => {
    const long = sized(1, 1_000);
    const out = await answerWithin(700, [long], [['c1']]);

    expect(sourcesIn(out)).toEqual(numbered(long));
  });

  it('keeps the latest known rerank score when a later search omits it', async () => {
    const chunks = [1, 2, 3].map((n) =>
      chunk(n, { content: `Evidence ${n}.`.repeat(40), contentLength: 1 }),
    );
    let searches = 0;
    const r = retrieval(
      {
        search: async () => {
          searches += 1;
          const scores = searches === 1 ? [0.9, 0.8, 0.95] : [0.1, undefined, 0];
          return {
            chunks: chunks.map(({ content: _content, ...summary }, i) => {
              const rerankScore = scores[i];
              return { ...summary, ...(rerankScore === undefined ? {} : { rerankScore }) };
            }),
          };
        },
      },
      new Map(chunks.map((c) => [c.chunkId, c])),
    );
    const out = await run({
      retrieval: r.impl,
      config: {
        ...baseConfig,
        strategy: { ...baseConfig.strategy, budget: { readChars: 700 } },
      },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['evidence'] })]),
            () => result('', [call('search', { queries: ['targeted evidence'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3'] })]),
            () => result('', [call('generate_response', { query: 'evidence' })]),
          ],
          read: [unsure],
          synth: [() => 'Svar [1].'],
        },
      },
    });

    expect(out.task.status).toBe('completed');
    expect(sourcesIn(out)).toEqual([`[1] ${chunks[1]?.content}`]);
    expect(promptFrom(out)).not.toContain(chunks[0]?.content);
    expect(promptFrom(out)).not.toContain(chunks[2]?.content);
    expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c2' }] });
  });
});
