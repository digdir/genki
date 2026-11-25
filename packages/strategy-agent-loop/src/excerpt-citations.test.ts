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
} from './harness.test-utils.js';
import { buildCitationIndex, dropUnknownMarkers, numberByExcerpt } from './citations.js';
import type { AgentLoopRuntimeConfig } from './index.js';

const store = new Map([
  ['c1', chunk(1, { content: 'Sykefraværet var 5,1 prosent.' })],
  [
    'c2',
    chunk(2, {
      document: 'd1',
      position: 1,
      title: 'Rapport 1',
      url: 'https://kudos.dfo.no/d1',
      content: 'Turnover var 8 prosent.',
    }),
  ],
  ['c3', chunk(3, { content: 'Budsjettet var 120 millioner.' })],
]);

const byExcerpt: AgentLoopRuntimeConfig = {
  ...baseConfig,
  strategy: { ...baseConfig.strategy, citeBy: 'excerpt' as const },
};

const readAll = [
  () => result('', [call('search', { queries: ['årsrapport'] })]),
  () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3'] })]),
];

const answerFrom = (synth: string, config: AgentLoopRuntimeConfig = byExcerpt) =>
  run({
    retrieval: retrieval({}, store).impl,
    config,
    scripts: { primary: { loop: readAll, synth: [() => synth] } },
  });

const synthPrompts = (out: Awaited<ReturnType<typeof run>>) =>
  out.seen.filter((s) => s.kind === 'synth').map((s) => String(s.request.messages.at(-1)?.content));

describe('citing excerpts, not documents', () => {
  it('gives each excerpt its own number, so two passages of one document are cited apart and each marker leads to its own excerpt', async () => {
    const out = await answerFrom('Sykefraværet var 5,1 prosent [1]. Turnover var 8 prosent [2].');

    expect(synthPrompts(out)[0]).toContain(
      '[1] <untrusted_data kind="source" id="d1" title="Rapport 1">\n⟨1⟩ Sykefraværet var 5,1 prosent.\n</untrusted_data>\n\n[2] <untrusted_data kind="source" id="d1" title="Rapport 1">\n⟨1⟩ Turnover var 8 prosent.\n</untrusted_data>\n\n[3] <untrusted_data kind="source" id="d3" title="Rapport 3">\n⟨1⟩ Budsjettet var 120 millioner.\n</untrusted_data>',
    );
    expect(synthPrompts(out)[0]).toContain('Cite the excerpt, not the document as a whole');
    expect(out.text).toBe('Sykefraværet var 5,1 prosent [1]. Turnover var 8 prosent [2].');
    expect(out.meta).toEqual({
      citations: [
        { index: 1, chunkId: 'c1', document: 'd1' },
        { index: 2, chunkId: 'c2', document: 'd1' },
      ],
      citeBy: 'excerpt',
    });
  });

  it('numbers by document, as before, when the service does not ask for excerpts', async () => {
    const out = await answerFrom(
      'Sykefraværet var 5,1 prosent [1]. Budsjettet var 120 millioner [2].',
      baseConfig,
    );

    expect(synthPrompts(out)[0]).toContain(
      '[1] <untrusted_data kind="source" id="d1" title="Rapport 1">\nSykefraværet var 5,1 prosent.\n\nTurnover var 8 prosent.\n</untrusted_data>\n\n[2] <untrusted_data kind="source" id="d3" title="Rapport 3">\nBudsjettet var 120 millioner.\n</untrusted_data>',
    );
    expect(out.meta).toEqual({
      citations: [
        { index: 1, chunkId: 'c1' },
        { index: 2, chunkId: 'c3' },
      ],
    });
  });

  it('removes a marker that leads to no excerpt, so no footnote points nowhere', async () => {
    const out = await answerFrom('Sykefraværet var 5,1 prosent [1]. Noe annet [9].');

    expect(out.text).toBe('Sykefraværet var 5,1 prosent [1]. Noe annet.');
    expect(out.notices).toContainEqual({ stage: 'answer-discarded', reason: 'unknown-markers' });
    expect(out.meta?.citations).toEqual([{ index: 1, chunkId: 'c1', document: 'd1' }]);
  });

  it('turns a chunk id the model writes into the marker of that excerpt, not of its document', async () => {
    const out = await answerFrom(
      'Turnover var 8 prosent [c2]. Sykefraværet var 5,1 prosent (chunk_id: c1).',
    );

    expect(out.text).toBe('Turnover var 8 prosent [1]. Sykefraværet var 5,1 prosent [2].');
    expect(out.meta?.citations).toEqual([
      { index: 1, chunkId: 'c2', document: 'd1' },
      { index: 2, chunkId: 'c1', document: 'd1' },
    ]);
  });

  it('backfills an uncited answer per excerpt', async () => {
    const out = await run({
      retrieval: retrieval({}, store).impl,
      config: byExcerpt,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['årsrapport'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c2'] })]),
            () => result('Turnover var 8 prosent.'),
          ],
          read: [() => readSignal('gap-remaining', { scope_assessment: 'ambiguous' })],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Turnover var 8 prosent [1].'],
        },
      },
    });

    expect(synthPrompts(out).at(-1)).toContain(
      '[1] <untrusted_data kind="source" id="d1" title="Rapport 1">\n⟨1⟩ Turnover var 8 prosent.\n</untrusted_data>',
    );
    expect(out.text).toBe('Turnover var 8 prosent [1].');
    expect(out.meta).toEqual({
      citations: [{ index: 1, chunkId: 'c2', document: 'd1' }],
      citeBy: 'excerpt',
    });
    expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: true });
  });

  it('keeps a bracketed year and every marker that leads to an excerpt', () => {
    const index = buildCitationIndex(['c1', 'c2']);

    expect(dropUnknownMarkers('Tall for [2023] [1], [3] og [2].', index)).toBe(
      'Tall for [2023] [1], og [2].',
    );
  });

  it('groups the excerpts of a document together while numbering each one', () => {
    const numbered = numberByExcerpt([
      chunk(1, { content: 'a' }),
      chunk(3, { content: 'c' }),
      chunk(2, { document: 'd1', content: 'b' }),
    ]);

    expect(numbered.context).toBe(
      '[1] <untrusted_data kind="source" id="d1" title="Rapport 1">\n⟨1⟩ a\n</untrusted_data>\n\n[2] <untrusted_data kind="source" id="d1" title="Rapport 2">\n⟨1⟩ b\n</untrusted_data>\n\n[3] <untrusted_data kind="source" id="d3" title="Rapport 3">\n⟨1⟩ c\n</untrusted_data>',
    );
    expect([...numbered.index]).toEqual([
      [1, 'c1'],
      [2, 'c2'],
      [3, 'c3'],
    ]);
  });
});

describe('the sources published under an answer', () => {
  const oneDocument = new Map(
    [1, 2, 3, 4, 5].map((n) => [
      `c${n}`,
      chunk(n, {
        document: 'd1',
        position: n - 1,
        title: 'Rapport 1',
        url: 'https://kudos.dfo.no/d1',
        content: `Avsnitt ${n} i rapporten.`,
      }),
    ]),
  );

  const readFive = (synth: string, config: AgentLoopRuntimeConfig) =>
    run({
      retrieval: retrieval({}, oneDocument).impl,
      config,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['rapport'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3', 'c4', 'c5'] })]),
          ],
          synth: [() => synth],
        },
      },
    });

  it('publishes only the cited excerpts, in footnote order, when citing excerpts', async () => {
    const out = await readFive('Avsnitt fire [4]. Avsnitt to [2].', byExcerpt);

    expect(out.text).toBe('Avsnitt fire [4]. Avsnitt to [2].');
    expect(out.meta?.citations).toEqual([
      { index: 2, chunkId: 'c2', document: 'd1' },
      { index: 4, chunkId: 'c4', document: 'd1' },
    ]);
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c2', 'c4']);
  });

  it('publishes every chunk read from a cited document when citing documents', async () => {
    const out = await readFive('Avsnitt fire og to [1].', baseConfig);

    expect(out.meta?.citations).toEqual([{ index: 1, chunkId: 'c1' }]);
    expect(out.sources.map((s) => s.chunkId).sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('publishes everything read when an answer citing excerpts cites nothing', async () => {
    const out = await readFive('Rapporten har fem avsnitt.', byExcerpt);

    expect(out.meta?.citations ?? []).toEqual([]);
    expect(out.sources.map((s) => s.chunkId).sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('publishes everything read when the service asks for every source read', async () => {
    const out = await readFive('Avsnitt to [2].', {
      ...byExcerpt,
      strategy: { ...byExcerpt.strategy, sources: 'read' as const },
    });

    expect(out.sources.map((s) => s.chunkId).sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });
});
