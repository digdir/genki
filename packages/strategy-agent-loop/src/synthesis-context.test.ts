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
              () => result('', [call('generate_response', { query: 'AI Act' })]),
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
      expect(out.loops).toHaveLength(finalizer === 'sufficiency gate' ? 3 : 4);
      expect(promptFrom(out)).toContain(decisive.content);
      for (const c of earlier) expect(promptFrom(out)).toContain(c.content);
      expect(promptFrom(out)).not.toContain(unread.content);
      expect(r.calls.filter((c) => c.op === 'rerank')).toEqual([]);
      if (finalizer === 'sufficiency gate')
        expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c13' }] });
    },
  );

  it('keeps attachments first and explicit reads ahead of auto-reads ranked higher in search', async () => {
    const r = retrieval();
    const out = await run({
      parts: [attached],
      retrieval: r.impl,
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

    const prompt = promptFrom(out);
    expect(prompt.indexOf('[1] Attached instructions.')).toBeGreaterThanOrEqual(0);
    // Read results carry no scores: use search summaries, where c3 ranks above c4.
    expect(prompt).toContain('[2] Innhold i chunk 3.');
    expect(prompt).toContain('[3] Innhold i chunk 4.');
    expect(prompt).toContain('[4] Innhold i chunk 1.');
    expect(prompt).toContain('[5] Innhold i chunk 2.');
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

  it('preserves rerank selection and numbering after later reads, with attachments first', async () => {
    const r = retrieval({ rerank: async () => [chunk(3), chunk(1)] });
    const out = await run({
      parts: [attached],
      retrieval: r.impl,
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

    expect(out.loops).toHaveLength(5);
    expect(promptFrom(out)).toContain('[1] Attached instructions.');
    expect(promptFrom(out)).toContain('[2] Innhold i chunk 3.');
    expect(promptFrom(out)).toContain('[3] Innhold i chunk 1.');
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

  it('bounds refunded reads by actual content size and puts supporting evidence first', async () => {
    const earlier = [chunk(1, { content: 'a'.repeat(600), contentLength: 600 })];
    const decisive = chunk(2, { content: 'Decisive evidence.'.repeat(30), contentLength: 1 });
    const r = retrieval({}, new Map([...earlier, decisive].map((c) => [c.chunkId, c])));
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
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c2'] })]),
          ],
          read: [() => readSignal('gap-remaining'), allSupported],
          synth: [() => 'Svar [1].'],
        },
      },
    });

    expect(promptFrom(out)).toContain(`[1] ${decisive.content}`);
    expect(promptFrom(out)).not.toContain(earlier[0]?.content);
    // All read sources remain available in output; only synthesis is budgeted.
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c2', 'c1']);
    expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c2' }] });
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
    expect(promptFrom(out)).toContain(`[1] ${chunks[1]?.content}`);
    expect(promptFrom(out)).not.toContain(chunks[0]?.content);
    expect(promptFrom(out)).not.toContain(chunks[2]?.content);
    expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c2' }] });
  });
});
