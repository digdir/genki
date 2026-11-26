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
import { citationInstruction, excerptCitationInstruction } from './prompts.js';
import type { AgentLoopRuntimeConfig } from './index.js';
import type { Chunk } from './workspace.js';

const byExcerpt = (readChars = 12000): AgentLoopRuntimeConfig => ({
  ...baseConfig,
  strategy: {
    ...baseConfig.strategy,
    budget: { searches: 4, reads: 6, readChars },
    citeBy: 'excerpt' as const,
  },
});

const sick = chunk(1, { content: 'Sykefraværet var 5,1 prosent.', page: 3 });
const turnover = chunk(2, { document: 'd1', content: 'Turnover var 8 prosent.', page: 25 });
const budget = chunk(3, { content: 'Budsjettet var 120 millioner.' });
const waiting = chunk(4, { content: 'Ventetiden var 4 minutter.' });

const storeOf = (...chunks: Chunk[]) => new Map(chunks.map((c) => [c.chunkId, c]));

const readThem = (ids: string[]) => [
  () => result('', [call('search', { queries: ['årsrapport'] })]),
  () => result('', [call('read_chunks', { chunk_ids: ids })]),
];

const answer = (
  store: Map<string, Chunk>,
  synth: string[],
  opts: { stream?: boolean; config?: AgentLoopRuntimeConfig } = {},
) =>
  run({
    retrieval: retrieval({}, store).impl,
    config: opts.config ?? byExcerpt(),
    ...(opts.stream ? { stream: true } : {}),
    scripts: {
      primary: { loop: readThem([...store.keys()]), synth: synth.map((t) => () => t) },
    },
  });

const synths = (out: Awaited<ReturnType<typeof run>>) =>
  out.seen.filter((s) => s.kind === 'synth').map((s) => String(s.request.messages.at(-1)?.content));

const deltas = (out: Awaited<ReturnType<typeof run>>) =>
  out.events
    .filter((e) => e.type === 'kernel.part.delta')
    .map((e) => (e.data as { text: string }).text);

const citationsOf = (out: Awaited<ReturnType<typeof run>>) =>
  (out.meta?.citations ?? []) as { index: number; chunkId: string; quote?: unknown }[];

const gapNotice = (out: Awaited<ReturnType<typeof run>>) =>
  out.notices.find((n) => n.stage === 'sentence-citations');

const partly =
  'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent.\n\nBudsjettet var 120 millioner.\n\nVentetiden var 4 minutter.';
const fully =
  'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent [2].\n\nBudsjettet var 120 millioner [3].\n\nVentetiden var 4 minutter [4].';

describe('citing every factual block of an excerpt answer', () => {
  it('cites the three uncited factual blocks of a partly cited excerpt answer and publishes all four excerpts', async () => {
    const out = await answer(storeOf(sick, turnover, budget, waiting), [partly, fully]);

    expect(synths(out)).toHaveLength(2);
    expect(synths(out)[1]).toContain('Turnover var 8 prosent.');
    expect(out.text).toBe(fully);
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(out.meta?.citations).toHaveLength(4);
    expect(gapNotice(out)).toMatchObject({ uncited: 0, cited: 4 });
  });

  it('gives «(s. 25)» the [N] of the one read excerpt of a cited document that covers page 25, and puts the page after it', async () => {
    const out = await answer(storeOf(sick, turnover), [
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent (s. 25).',
    ]);

    expect(out.text).toBe(
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent [2] (s. 25).',
    );
    expect(synths(out)).toHaveLength(1);
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c2']);
  });

  describe('with two cited documents', () => {
    const a3 = chunk(1, { document: 'dA', content: 'Sykefraværet var 5,1 prosent.', page: 3 });
    const a25 = chunk(2, { document: 'dA', content: 'Budsjettet i A var 90 millioner.', page: 25 });
    const b3 = chunk(3, { document: 'dB', content: 'Turnover var 9 prosent.', page: 3 });
    const b25 = chunk(4, {
      document: 'dB',
      content: 'Budsjettet i B var 120 millioner.',
      page: 25,
    });

    it('gives «(s. P)» the excerpt of the document its own block cites, not of another cited document', async () => {
      const out = await answer(storeOf(a3, a25, b3, b25), [
        'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 9 prosent [3], og budsjettet var 120 millioner (s. 25).',
      ]);

      expect(out.text).toBe(
        'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 9 prosent [3], og budsjettet var 120 millioner [4] (s. 25).',
      );
      expect(synths(out)).toHaveLength(1);
      expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c3', 'c4']);
    });

    it('leaves «(s. P)» in a block that cites nothing to the gap call when the answer cites two documents', async () => {
      const draft =
        'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 9 prosent [3].\n\nBudsjettet var 120 millioner (s. 25).';
      const out = await answer(storeOf(a3, a25, b3), [draft, draft]);

      expect(synths(out)).toHaveLength(2);
      expect(out.text).toBe(draft);
      expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c3']);
      expect(gapNotice(out)).toMatchObject({ uncited: 1 });
    });
  });

  it('leaves «(s. P)» to the gap call when two read excerpts of cited documents cover page P', async () => {
    const twin = chunk(5, { document: 'd1', content: 'Turnover i 2023 var 7 prosent.', page: 25 });
    const out = await answer(storeOf(sick, turnover, twin), [
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent (s. 25).',
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent [2] (s. 25).',
    ]);

    expect(synths(out)).toHaveLength(2);
    expect(out.text).toBe(
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent [2] (s. 25).',
    );
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c2']);
  });

  it('leaves a block with no read chunk behind it uncited, counts it, and publishes no excerpt for it', async () => {
    const draft =
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent.\n\nDigdir har 400 ansatte.';
    const out = await answer(storeOf(sick, turnover), [
      draft,
      draft.replace('8 prosent.', '8 prosent [2].'),
    ]);

    expect(out.text).toBe(draft.replace('8 prosent.', '8 prosent [2].'));
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c2']);
    expect(gapNotice(out)).toMatchObject({ uncited: 1, cited: 2 });
  });

  it('leaves a fully cited answer unchanged and makes no gap call', async () => {
    const out = await answer(storeOf(sick, turnover, budget, waiting), [fully]);

    expect(synths(out)).toHaveLength(1);
    expect(out.text).toBe(fully);
    expect(out.notices).not.toContainEqual(expect.objectContaining({ stage: 'answer-discarded' }));
    expect(gapNotice(out)).toMatchObject({ uncited: 0, cited: 4 });
  });

  it('lets the gap call cite a read chunk the readChars budget kept from the answer step, numbered after the existing excerpts', async () => {
    const a = chunk(1, { content: 'A'.repeat(39), contentLength: 39 });
    const b = chunk(2, { content: 'B'.repeat(39), contentLength: 39 });
    const cut = chunk(3, { content: 'Turnover var 8 prosent i Rapport 3.....', contentLength: 39 });
    const out = await run({
      retrieval: retrieval({}, storeOf(a, b, cut)).impl,
      config: byExcerpt(100),
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['turnover'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c3'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2'] })]),
            () => result('', [call('generate_response', { query: 'turnover' })]),
          ],
          // The first read is judged to support nothing, so its characters come back and the budget cuts it.
          read: [
            () => readSignal('gap-remaining'),
            () => readSignal('gap-remaining', { scope_assessment: 'ambiguous' }),
          ],
          synth: [
            () => 'Første funn [1].\n\nTurnover var 8 prosent.',
            () => 'Første funn [1].\n\nTurnover var 8 prosent [3].',
          ],
        },
      },
    });

    expect(synths(out)[0]).not.toContain('Turnover var 8 prosent i Rapport 3');
    expect(synths(out)[1]).toMatch(
      /\[3\] <untrusted_data kind="source" id="d3"[^>]*>\nTurnover var 8 prosent i Rapport 3/,
    );
    expect(out.text).toBe('Første funn [1].\n\nTurnover var 8 prosent [3].');
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c3']);
  });

  it('keeps the answer as written and counts its gaps when the gap call changes its words', async () => {
    const out = await answer(storeOf(sick, turnover, budget, waiting), [
      partly,
      fully.replace('Turnover var 8 prosent', 'Turnoveren var 8 prosent'),
    ]);

    expect(synths(out)).toHaveLength(2);
    expect(out.text).toBe(partly);
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c1']);
    expect(gapNotice(out)).toMatchObject({ uncited: 3, cited: 1 });
  });

  it("skips headings and lead-ins ending in ':' when it looks for gaps", async () => {
    const text =
      '## Funn\n\n**Fravær**\n\nSykefraværet var 5,1 prosent [1].\n\nTo tall til:\n\n- Turnover var 8 prosent [2].\n- Budsjettet var 120 millioner [3].';
    const out = await answer(storeOf(sick, turnover, budget), [text]);

    expect(synths(out)).toHaveLength(1);
    expect(out.text).toBe(text);
    expect(gapNotice(out)).toMatchObject({ uncited: 0 });
  });

  describe('when the gap call fails', () => {
    it.each([
      [
        'throws',
        () => {
          throw new Error('model down');
        },
      ],
      ['returns nothing', () => ''],
    ])('keeps the answer as written and counts its gaps when the gap call %s', async (_, fail) => {
      const out = await run({
        retrieval: retrieval({}, storeOf(sick, turnover, budget, waiting)).impl,
        config: byExcerpt(),
        scripts: {
          primary: {
            loop: readThem(['c1', 'c2', 'c3', 'c4']),
            synth: [() => partly, fail],
          },
        },
      });

      expect(synths(out)).toHaveLength(2);
      expect(out.text).toBe(partly);
      expect(out.sources.map((s) => s.chunkId)).toEqual(['c1']);
      expect(gapNotice(out)).toMatchObject({ uncited: 3, cited: 1 });
    });
  });

  it('gives a page a fresh marker with no quote when the excerpt it cites already has a marker quoting another sentence', async () => {
    const both = chunk(2, {
      document: 'd1',
      content: 'Turnover var 8 prosent. Budsjettet var 120 millioner.',
      page: 25,
    });
    const out = await answer(storeOf(sick, both), [
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent [2:1].\n\nBudsjettet var 120 millioner (s. 25).',
    ]);

    expect(out.text).toBe(
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent [2].\n\nBudsjettet var 120 millioner [3] (s. 25).',
    );
    expect(synths(out)).toHaveLength(1);
    expect(out.meta?.citations).toEqual([
      expect.objectContaining({ index: 1, chunkId: 'c1' }),
      expect.objectContaining({
        index: 2,
        chunkId: 'c2',
        quote: expect.objectContaining({ exact: 'Turnover var 8 prosent.' }),
      }),
      expect.not.objectContaining({ quote: expect.anything() }),
    ]);
    expect(citationsOf(out)[2]).toMatchObject({ index: 3, chunkId: 'c2' });
  });

  it('shows the gap call each excerpt once, under a number with no quote', async () => {
    const both = chunk(2, {
      document: 'd1',
      content: 'Turnover var 8 prosent. Budsjettet var 120 millioner.',
    });
    const out = await answer(storeOf(sick, both), [
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent [2:1].\n\nBudsjettet var 120 millioner.',
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent [2].\n\nBudsjettet var 120 millioner [3].',
    ]);

    expect(synths(out)[1]).toMatch(
      /\[3\] <untrusted_data kind="source"[^>]*>\nTurnover var 8 prosent\./,
    );
    expect(synths(out)[1]).not.toMatch(/\[2\] <untrusted_data/);
    expect(out.text).toBe(
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent [2].\n\nBudsjettet var 120 millioner [3].',
    );
    expect(citationsOf(out)[2]).toMatchObject({ index: 3, chunkId: 'c2' });
    expect(citationsOf(out)[2]).not.toHaveProperty('quote');
  });

  it('never binds a marker that leads nowhere to an excerpt the gap step numbers', async () => {
    const a = chunk(1, { content: 'A'.repeat(39), contentLength: 39 });
    const b = chunk(2, { content: 'B'.repeat(39), contentLength: 39 });
    const cut = chunk(3, { content: 'Turnover var 8 prosent i Rapport 3.....', contentLength: 39 });
    const draft = 'Første funn [1][3].\n\nTurnover var 8 prosent.';
    const out = await run({
      retrieval: retrieval({}, storeOf(a, b, cut)).impl,
      config: byExcerpt(100),
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['turnover'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c3'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2'] })]),
            () => result('', [call('generate_response', { query: 'turnover' })]),
          ],
          read: [
            () => readSignal('gap-remaining'),
            () => readSignal('gap-remaining', { scope_assessment: 'ambiguous' }),
          ],
          synth: [() => draft, () => draft],
        },
      },
    });

    expect(out.text).toBe('Første funn [1].\n\nTurnover var 8 prosent.');
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c1']);
  });

  it('asks the gap call for markers only, with no pages', async () => {
    const out = await answer(storeOf(sick, turnover, budget, waiting), [partly, fully]);

    expect(synths(out)[1]).not.toContain('[12] (s. 25)');
    expect(synths(out)[1]).toContain('Add only [N] markers');
  });

  it('refuses a marker the gap call puts inside a word', async () => {
    const out = await answer(storeOf(sick, turnover), [
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent.',
      'Sykefraværet var 5,1 prosent [1].\n\nTurn[2]over var 8 prosent.',
    ]);

    expect(out.text).toBe('Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent.');
    expect(gapNotice(out)).toMatchObject({ uncited: 1 });
  });

  it("looks for gaps in the lines before a lead-in ending in ':', and reads a list item's continuation line as part of the item", async () => {
    const withLeadIn = await answer(storeOf(sick, turnover), [
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent.\nTo tall til:',
      'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent [2].\nTo tall til:',
    ]);
    expect(synths(withLeadIn)).toHaveLength(2);
    expect(withLeadIn.sources.map((s) => s.chunkId)).toEqual(['c1', 'c2']);

    const item = '- Sykefraværet var 5,1 prosent\n  i 2024 [1].\n- Turnover var 8 prosent [2].';
    const continued = await answer(storeOf(sick, turnover), [item]);
    expect(synths(continued)).toHaveLength(1);
    expect(continued.text).toBe(item);
  });

  describe("fills gaps in the agent's own final message, the add-citations result and the chunk-id answer as in generate_response's", () => {
    const store = storeOf(sick, turnover);
    const both = 'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent [2].';

    it("the agent's own final message", async () => {
      const out = await run({
        retrieval: retrieval({}, store).impl,
        config: byExcerpt(),
        scripts: {
          primary: {
            loop: [
              ...readThem(['c1', 'c2']),
              () => result('', [call('generate_response', { query: 'tall' })]),
              () => result('Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent.'),
            ],
            read: [() => readSignal('gap-remaining', { scope_assessment: 'ambiguous' })],
            sufficiency: [() => decision('insufficient', 're-search')],
            synth: [() => 'Sykefraværet var 5,1 prosent [1].', () => both],
          },
        },
      });

      expect(out.text).toBe(both);
      expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c2']);
    });

    it('the add-citations result', async () => {
      const draft = 'Sykefraværet var 5,1 prosent.\n\nTurnover var 8 prosent.';
      const out = await run({
        retrieval: retrieval({}, store).impl,
        config: byExcerpt(),
        scripts: {
          primary: {
            loop: [...readThem(['c1', 'c2']), () => result(draft)],
            read: [() => readSignal('gap-remaining', { scope_assessment: 'ambiguous' })],
            sufficiency: [() => decision('insufficient', 're-search')],
            synth: [
              () => 'Sykefraværet var 5,1 prosent [1].\n\nTurnover var 8 prosent.',
              () => both,
            ],
          },
        },
      });

      expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: true });
      expect(out.text).toBe(both);
      expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c2']);
    });

    it('the chunk-id answer', async () => {
      const out = await run({
        retrieval: retrieval({}, store).impl,
        config: byExcerpt(),
        scripts: {
          primary: {
            loop: [
              ...readThem(['c1', 'c2']),
              () => result('Sykefraværet var 5,1 prosent [c1].\n\nTurnover var 8 prosent.'),
            ],
            read: [() => readSignal('gap-remaining', { scope_assessment: 'ambiguous' })],
            sufficiency: [() => decision('insufficient', 're-search')],
            synth: [() => both],
          },
        },
      });

      expect(out.text).toBe(both);
      expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c2']);
    });
  });

  it.each([false, true])(
    'fills gaps the same way whether the answer streams or not (stream: %s)',
    async (stream) => {
      const out = await answer(storeOf(sick, turnover, budget, waiting), [partly, fully], {
        stream,
      });

      expect(out.text).toBe(fully);
      expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c2', 'c3', 'c4']);
      if (stream) {
        expect(out.notices).toContainEqual({ stage: 'answer-discarded', reason: 'uncited-blocks' });
        expect(deltas(out).at(-1)).toBe(fully);
      }
    },
  );

  it('tells the model to put a page after its [N] with excerpt citations, and keeps the plain page rule for document citations', async () => {
    expect(excerptCitationInstruction).toContain('[12] (s. 25)');
    expect(excerptCitationInstruction).not.toContain('Write a page as plain text');
    expect(citationInstruction).toContain('Write a page as plain text, such as "s. 67"');

    const toolText = async (config: AgentLoopRuntimeConfig) => {
      const out = await answer(storeOf(sick), ['Sykefraværet var 5,1 prosent [1].'], { config });
      const tools = out.loops[0]?.tools ?? [];
      return ['search', 'read_chunks'].map(
        (name) => tools.find((t) => t.name === name)?.description ?? '',
      );
    };
    for (const text of await toolText(byExcerpt())) {
      expect(text).toContain('right after the [N] of the excerpt');
      expect(text).not.toContain('cite that page as plain text');
    }
    for (const text of await toolText(baseConfig))
      expect(text).toContain('cite that page as plain text, such as "s. 67"');
  });
});

// Question 007 of KA's golden set (Langfuse trace 631275a337bc0d3f0442d0301928ecb7): the v25
// answer named page 25 without [N], so its excerpt was not published. The text is the report's.
describe('replaying the 007 answer', () => {
  const report = {
    document: '54d934d6-fd5c-4a88-aec0-d9508250be7b',
    title: 'Orden i eget hus i kunnskapssektoren',
    url: 'https://kudos.dfo.no/dokument/54d934d6-fd5c-4a88-aec0-d9508250be7b',
  };
  const summary = chunk(1, {
    ...report,
    position: 2,
    page: 3,
    content:
      'Vår vurdering er at fremgangen i arbeidet med orden i eget hus har vært begrenset mellom 2021 og 2024. Modenheten i dette arbeidet er derfor fortsatt lav i kunnskapssektoren.',
  });
  const page25 = chunk(2, {
    ...report,
    position: 24,
    page: 25,
    content:
      'I 2021 jobbet flere virksomheter i egne prosjekter eller i linjen med orden i eget hus, mens i 2024 har omtrent halvparten ingen formell organisering (figur 9). Kun fire virksomheter oppgir å ha eller hatt tidsbegrensede prosjekter, og tre har faste tverrfaglige team. Arbeidet ser derfor ut til å ha gått ut av prosjektene uten å bli innlemmet i organisasjonen hos de fleste av virksomhetene.\n\nMangelen på formell organisering av arbeidet kan være en av årsakene til at 10 av virksomhetene oppgir at dagens organisering er begrensende. Dette kan også være en del av årsaken til at 14 virksomheter i liten eller svært liten grad har et system eller prosess for metadataforvaltning.',
  });
  const v25 = [
    'Modenhetsanalysen fra 2024 konkluderer med at arbeidet med orden i eget hus har gått lite framover fra 2021 til 2024. [1]',
    '',
    '**Strategi og organisering mangler**',
    '- Omtrent halvparten har ingen formell organisering av arbeidet. Det ser ut til at arbeidet har gått ut av prosjektene uten å bli en fast del av organisasjonen (s. 25).',
    '- 14 virksomheter har i liten eller svært liten grad et system eller en prosess for å forvalte metadata, altså beskrivelser av dataene sine (s. 25).',
  ].join('\n');

  it("cites the 007 answer's page-25 blocks from the read excerpts of its report (replay)", async () => {
    const out = await answer(storeOf(summary, page25), [v25]);

    expect(out.text).toBe(
      v25
        .replace('organisasjonen (s. 25)', 'organisasjonen [2] (s. 25)')
        .replace('dataene sine (s. 25)', 'dataene sine [2] (s. 25)'),
    );
    expect(synths(out)).toHaveLength(1);
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c1', 'c2']);
    expect(gapNotice(out)).toMatchObject({ uncited: 0, cited: 2 });
  });
});
