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
import { resolveSentenceMarkers } from './citations.js';
import type { AgentLoopRuntimeConfig } from './index.js';

const findings =
  'Hovedfunnene er inndelt i tre deler. Valget av kontraktstrategi var en direkte årsak til problemene, jf. kap. 5. Makspris ble satt for lavt.';

const store = new Map([
  ['c1', chunk(1, { content: findings })],
  ['c2', chunk(2, { content: 'Turnover var 8 prosent. Sykefraværet var 5,1 prosent.' })],
]);

const byExcerpt: AgentLoopRuntimeConfig = {
  ...baseConfig,
  strategy: { ...baseConfig.strategy, citeBy: 'excerpt' as const },
};

const readAll = [
  () => result('', [call('search', { queries: ['evaluering'] })]),
  () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2'] })]),
];

const answerFrom = (synth: string, config: AgentLoopRuntimeConfig = byExcerpt) =>
  run({
    retrieval: retrieval({}, store).impl,
    config,
    scripts: { primary: { loop: readAll, synth: [() => synth] } },
  });

const synthPrompts = (out: Awaited<ReturnType<typeof run>>) =>
  out.seen.filter((s) => s.kind === 'synth').map((s) => String(s.request.messages.at(-1)?.content));

const quote = (exact: string, prefix: string, suffix: string) => ({
  type: 'TextQuoteSelector',
  exact,
  prefix,
  suffix,
});

const deltas = (out: Awaited<ReturnType<typeof run>>) =>
  out.events
    .filter((e) => e.type === 'kernel.part.delta')
    .map((e) => (e.data as { text: string }).text);

describe('citing the sentences of an excerpt', () => {
  it('numbers the sentences of every excerpt the model reads when the service cites excerpts', async () => {
    const out = await answerFrom('Kontraktstrategien var en årsak [1:2].');

    expect(synthPrompts(out)[0]).toContain(
      '⟨1⟩ Hovedfunnene er inndelt i tre deler. ⟨2⟩ Valget av kontraktstrategi var en direkte årsak til problemene, jf. kap. 5. ⟨3⟩ Makspris ble satt for lavt.',
    );
    expect(synthPrompts(out)[0]).toContain('[N:4]');
  });

  it('leaves the context unnumbered when the service cites documents', async () => {
    const out = await answerFrom('Kontraktstrategien var en årsak [1].', baseConfig);

    expect(synthPrompts(out)[0]).not.toContain('⟨1⟩');
    expect(synthPrompts(out)[0]).not.toContain('[N:4]');
  });

  it('turns [1:2] into [1] in the answer and puts sentence 2 as exact, prefix and suffix in the citation', async () => {
    const out = await answerFrom('Kontraktstrategien var en årsak [1:2].');

    expect(out.text).toBe('Kontraktstrategien var en årsak [1].');
    expect(out.meta?.citations).toEqual([
      {
        index: 1,
        chunkId: 'c1',
        document: 'd1',
        quote: quote(
          'Valget av kontraktstrategi var en direkte årsak til problemene, jf. kap. 5.',
          'Hovedfunnene er inndelt i tre deler. '.slice(-32),
          ' Makspris ble satt for lavt.',
        ),
      },
    ]);
  });

  it('turns [1:2-3] into one quote that spans sentences 2 and 3', async () => {
    const out = await answerFrom('Strategien og makspris [1:2-3].');

    expect(out.text).toBe('Strategien og makspris [1].');
    expect(out.meta?.citations).toEqual([
      expect.objectContaining({
        quote: expect.objectContaining({
          exact:
            'Valget av kontraktstrategi var en direkte årsak til problemene, jf. kap. 5. Makspris ble satt for lavt.',
          suffix: '',
        }),
      }),
    ]);
  });

  it('gives two places in one excerpt two markers, so each footnote opens its own words', async () => {
    const out = await answerFrom('Tre deler [1:1]. Makspris var for lav [1:3]. Igjen [1:1].');

    expect(out.text).toBe('Tre deler [1]. Makspris var for lav [2]. Igjen [1].');
    expect(out.meta?.citations).toEqual([
      expect.objectContaining({
        index: 1,
        chunkId: 'c1',
        quote: expect.objectContaining({ exact: 'Hovedfunnene er inndelt i tre deler.' }),
      }),
      expect.objectContaining({
        index: 2,
        chunkId: 'c1',
        quote: expect.objectContaining({ exact: 'Makspris ble satt for lavt.' }),
      }),
    ]);
  });

  it('keeps a plain excerpt citation and counts a miss when the sentence id does not exist in the excerpt', async () => {
    const out = await answerFrom('Turnover var 8 prosent [2:7].');

    expect(out.text).toBe('Turnover var 8 prosent [1].');
    expect(out.meta?.citations).toEqual([{ index: 1, chunkId: 'c2', document: 'd2' }]);
    expect(out.notices).toContainEqual({ stage: 'sentence-citations', located: 0, missed: 1 });
  });

  it('counts the citations that got a location in the run', async () => {
    const out = await answerFrom('Tre deler [1:1]. Turnover [2].');

    expect(out.notices).toContainEqual({ stage: 'sentence-citations', located: 1, missed: 0 });
  });

  it('never lets a sentence id point into another excerpt', () => {
    const texts = new Map([
      ['c1', 'Bare én setning.'],
      ['c2', 'Første. Andre.'],
    ]);
    const resolved = resolveSentenceMarkers(
      'Svar [1:2].',
      new Map([
        [1, 'c1'],
        [2, 'c2'],
      ]),
      (id) => texts.get(id),
    );

    expect(resolved.text).toBe('Svar [1].');
    expect([...resolved.index]).toEqual([[1, 'c1']]);
    expect(resolved.quotes.size).toBe(0);
    expect(resolved.missed).toBe(1);
  });

  it('removes a sentence id the model copies into the answer as text', () => {
    const resolved = resolveSentenceMarkers('⟨2⟩ Svar [1:1].', new Map([[1, 'c1']]), () => 'En.');

    expect(resolved.text).toBe('Svar [1].');
  });

  it('numbers sentences in the backfill context too, so a re-written answer gets locations', async () => {
    const out = await run({
      retrieval: retrieval({}, store).impl,
      config: byExcerpt,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['turnover'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c2'] })]),
            () => result('Turnover var 8 prosent.'),
          ],
          read: [() => readSignal('gap-remaining', { scope_assessment: 'ambiguous' })],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Turnover var 8 prosent [1:1].'],
        },
      },
    });

    expect(synthPrompts(out).at(-1)).toContain('⟨1⟩ Turnover var 8 prosent. ⟨2⟩ Sykefraværet');
    expect(out.text).toBe('Turnover var 8 prosent [1].');
    expect(out.meta?.citations).toEqual([
      expect.objectContaining({
        chunkId: 'c2',
        quote: expect.objectContaining({ exact: 'Turnover var 8 prosent.' }),
      }),
    ]);
  });

  it('a streamed answer never shows a sentence id to the reader', async () => {
    const out = await run({
      retrieval: retrieval({}, store).impl,
      config: byExcerpt,
      stream: true,
      scripts: {
        primary: { loop: readAll, synth: [() => 'Tre deler [1:1]. Makspris var for lav [1:2-3].'] },
      },
    });

    expect(deltas(out).length).toBeGreaterThan(0);
    for (const text of deltas(out)) expect(text).not.toMatch(/\[\d+:\d/);
    expect(deltas(out).join('')).not.toContain(':1]');
  });
});
