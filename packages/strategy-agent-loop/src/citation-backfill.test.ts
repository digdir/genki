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
  systemMessages,
} from './harness.test-utils.js';
import { buildCitationIndex } from './citations.js';
import { settleCitations, soundsLikeRefusal } from './citation-backfill.js';
import { exhaustionNudge, readBeforeAnswerNudge } from './prompts.js';
import { Workspace } from './workspace.js';

const unsure = () => readSignal('gap-remaining', { scope_assessment: 'ambiguous' });

const workspaceWith = (setup: (w: Workspace) => void) => {
  const w = new Workspace({ searches: 4, reads: 6, readChars: 12000 });
  setup(w);
  return w;
};

const readInto = (w: Workspace, ...ns: number[]) => {
  const chunks = ns.map((n) => chunk(n));
  w.recordRead({ chunkIds: chunks.map((c) => c.chunkId) }, chunks);
  w.addChunks(chunks);
};

describe('citation backfill when the agent answers without citing', () => {
  it('re-synthesises a cited answer when the model writes its own answer after reading', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c2'] })]),
            () => result('Digdir skal levere en ny strategi i 2025.'),
          ],
          read: [unsure],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Digdir skal levere en ny strategi i 2025 [1].'],
        },
      },
    });

    expect(out.text).toBe('Digdir skal levere en ny strategi i 2025 [1].');
    expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c2' }] });
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c2']);
    expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: true });
    expect(out.notices).toContainEqual({ stage: 'answer-discarded', reason: 'uncited' });
  });

  it('reads the top search hits before re-synthesising an answer written from search metadata', async () => {
    const r = retrieval();
    const out = await run({
      retrieval: r.impl,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev Medietilsynet'] })]),
            () => result('Tildelingsbrevet er datert januar 2024.'),
          ],
          synth: [() => 'Tildelingsbrevet er datert 20. desember 2023 [1].'],
        },
      },
    });

    expect(r.calls.filter((c) => c.op === 'read').map((c) => c.args)).toEqual([
      ['c1', 'c2', 'c3', 'c4', 'c5'],
    ]);
    expect(out.text).toBe('Tildelingsbrevet er datert 20. desember 2023 [1].');
    expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c1' }] });
    expect(out.sources.length).toBeGreaterThan(0);
  });

  it('keeps a refusal and cites nothing when re-synthesis over what it read finds no answer either', async () => {
    const out = await run({
      question: 'Hvor mange ansatte hadde Digdir på Mars i 2024?',
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['Digdir Mars'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('Jeg fant ingen informasjon om dette i kunnskapsbasen.'),
          ],
          read: [() => readSignal('no-support')],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Det er ikke nok informasjon i kildene til å svare.'],
        },
      },
    });

    expect(out.text).toBe('Jeg fant ingen informasjon om dette i kunnskapsbasen.');
    expect(out.meta).toEqual({ citations: [], noAnswer: true });
    expect(out.seen.filter((s) => s.kind === 'synth')).toHaveLength(1);
    expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: false });
  });

  it('replaces a refusal written after reading with a cited answer synthesised from what was read', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('Jeg har ikke funnet spesifikk informasjon om dette.'),
          ],
          read: [() => readSignal('no-support')],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Svaret er 42 [1].'],
        },
      },
    });

    expect(out.text).toBe('Svaret er 42 [1].');
    expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: true });
  });

  it('keeps a refusal written after searching only, without reading anything', async () => {
    const r = retrieval();
    const out = await run({
      retrieval: r.impl,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['krypsiv Rysstadbassenget'] })]),
            () =>
              result(
                'Jeg har søkt gjennom dokumentbasen, men fant ingen spesifikk omtale av dette.',
              ),
          ],
        },
      },
    });

    expect(r.calls.some((c) => c.op === 'read')).toBe(false);
    expect(out.sources).toEqual([]);
    expect(out.meta).toEqual({ citations: [], noAnswer: true });
  });

  it('keeps the original answer when the re-synthesis says the sources are not enough', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('Svaret er trolig 42.'),
          ],
          read: [unsure],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Det er ikke nok informasjon i kildene til å svare.'],
        },
      },
    });

    expect(out.text).toBe('Svaret er trolig 42.');
    expect(out.meta).toEqual({ citations: [] });
    expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: false });
  });

  it('does not report the citations of a rejected draft for a different final answer', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('Svaret er 42.'),
          ],
          read: [unsure],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Utkast [1].'],
        },
      },
    });

    expect(out.text).toBe('Svaret er 42.');
    expect(out.meta).toEqual({ citations: [] });
  });
});

describe('settling citations on the final answer', () => {
  it('carries an accepted cited draft through when the final text drops the markers', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1);
      w.citationIndex = buildCitationIndex(['c1']);
      w.lastGeneratedResponse = 'Svar [1].';
    });

    expect(settleCitations('Svar.', w)).toEqual({ action: 'carry-through' });
  });

  it('cites what it read instead of carrying through a draft the gates rejected', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1);
      w.citationIndex = buildCitationIndex(['c1']);
      w.lastGeneratedResponse = 'Svar [1].';
      w.lastGenerateInsufficient = true;
    });

    expect(settleCitations('Svar.', w)).toEqual({ action: 'backfill', readFirst: [] });
  });

  it('backfills a refusal written after reading, even over chunks the read evaluation found non-supporting', () => {
    const unsupported = workspaceWith((w) => {
      readInto(w, 1);
      w.nonSupporting.add('c1');
    });
    const searchedOnly = workspaceWith(() => undefined);
    const refusal = 'Jeg har ikke funnet spesifikk informasjon om dette.';

    expect(settleCitations(refusal, unsupported)).toEqual({
      action: 'backfill',
      readFirst: [],
      refusal: true,
    });
    expect(settleCitations(refusal, searchedOnly)).toEqual({ action: 'keep', reason: 'refusal' });
  });

  it('carries a cited draft through over a refusal, even a draft the gates rejected', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1);
      w.citationIndex = buildCitationIndex(['c1']);
      w.lastGeneratedResponse = 'Svar [1].';
      w.lastGenerateInsufficient = true;
    });

    expect(settleCitations('Jeg fant ingen informasjon om dette.', w)).toEqual({
      action: 'carry-through',
    });
  });

  it('does not backfill over chunks the read evaluation found non-supporting', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1);
      w.nonSupporting.add('c1');
    });

    expect(settleCitations('Svaret er 42.', w)).toEqual({
      action: 'keep',
      reason: 'no-supporting-chunks',
    });
  });
});

describe('recognising a refusal', () => {
  it.each([
    'Jeg kunne ikke finne spesifikk informasjon i tildelingsbrevet for 2025.',
    'Jeg har gjennomgått årsrapporten, men jeg finner ingen spesifikk omtale av temaene.',
    'Basert på den gitte konteksten, er det ingen eksplisitt informasjon om dette.',
    'Jeg har dessverre ikke klart å finne spesifikk informasjon om dette.',
    'Rapporten foreligger ikke i kunnskapsbasen.',
  ])('treats "%s" as a refusal', (text) => {
    expect(soundsLikeRefusal(text)).toBe(true);
  });

  it.each([
    'Kommunene dekker reiseutgiftene når elever deltar på Statpeds elevkurs.',
    'NHH fikk en samlet realnedgang på 40 millioner kroner over to år.',
  ])('treats "%s" as an answer', (text) => {
    expect(soundsLikeRefusal(text)).toBe(false);
  });
});

const draftIn = (out: Awaited<ReturnType<typeof run>>) =>
  String(out.seen.filter((s) => s.kind === 'synth').at(-1)?.request.messages[1]?.content);

describe('an answer after running out of rounds', () => {
  const rejectedThenExhausted = (final: string, synth: string[]) =>
    run({
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, maxIterations: 3 } },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['strategi'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2'] })]),
            () => result('', [call('generate_response', { query: 'strategi' })]),
          ],
          read: [unsure],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: synth.map((t) => () => t),
          final,
        },
      },
    });

  it('asks the model to cite the sources it read by chunk_id', async () => {
    const out = await rejectedThenExhausted('Digdir skal levere en strategi [c2].', [
      'Utkast [1].',
    ]);

    expect(exhaustionNudge).toContain('[chunk_id]');
    expect(out.text).toBe('Digdir skal levere en strategi [1].');
    expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c2' }] });
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c2']);
  });

  it('cites the sources it read when the fallback answer has no citations', async () => {
    const partial = 'Jeg fant bare delvis svargrunnlag: Digdir skal levere en strategi i 2025.';
    const out = await rejectedThenExhausted(partial, [
      'Utkast [1].',
      'Jeg fant bare delvis svargrunnlag: Digdir skal levere en strategi i 2025 [2].',
    ]);

    expect(out.notices).toContainEqual(expect.objectContaining({ stage: 'exhausted' }));
    expect(draftIn(out)).toContain(partial);
    expect(out.text).toBe(
      'Jeg fant bare delvis svargrunnlag: Digdir skal levere en strategi i 2025 [1].',
    );
    expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c2' }] });
    expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: true });
  });
});

describe('an answer from search snippets alone', () => {
  it('sends the agent back to read before it answers from search snippets alone', async () => {
    const r = retrieval();
    const out = await run({
      retrieval: r.impl,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev Digdir'] })]),
            () => result('Ja, tildelingsbrevet for 2025 finnes.'),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('Ja, tildelingsbrevet for 2025 finnes.'),
          ],
          read: [unsure],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Ja, tildelingsbrevet for 2025 finnes [1].'],
        },
      },
    });

    expect(systemMessages(out.loops[2])).toContain(readBeforeAnswerNudge);
    expect(r.calls.filter((c) => c.op === 'read').map((c) => c.args)).toEqual([['c1']]);
    expect(out.text).toBe('Ja, tildelingsbrevet for 2025 finnes [1].');
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c1']);
  });

  it('reads the hits itself when the agent keeps answering from snippets, rather than answer from them', async () => {
    const r = retrieval();
    const out = await run({
      retrieval: r.impl,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev Digdir'] })]),
            () => result('Ja, tildelingsbrevet for 2025 finnes.'),
          ],
          synth: [() => 'Ja, tildelingsbrevet for 2025 finnes [3].'],
        },
      },
    });

    expect(out.loops.filter((l) => systemMessages(l).includes(readBeforeAnswerNudge))).toHaveLength(
      2,
    );
    expect(r.calls.filter((c) => c.op === 'read')).toHaveLength(1);
    expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c3' }] });
  });
});

describe('the sources returned with an answer', () => {
  const citingSecond = (sources?: 'read') =>
    run({
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, sources } },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3'] })]),
          ],
          synth: [() => 'Svaret er 42 [2].'],
        },
      },
    });

  it('lists only the sources the answer cites', async () => {
    const out = await citingSecond();

    expect(out.sources.map((s) => s.chunkId)).toEqual(['c2']);
  });

  it('numbers each marker by its cited document in the order the sources list them', async () => {
    const out = await citingSecond();

    expect(out.text).toBe('Svaret er 42 [1].');
    expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c2' }] });
  });

  it('streams the renumbered answer as the last text before the result', async () => {
    const out = await citingSecond();
    const last = out.events.findLastIndex(
      (e) =>
        e.type === 'kernel.notice' && (e.data as { stage?: string }).stage === 'answer-discarded',
    );
    const streamed = out.events
      .slice(last + 1)
      .flatMap((e) => (e.type === 'kernel.part.delta' ? [(e.data as { text: string }).text] : []))
      .join('');

    expect(out.notices).toContainEqual({ stage: 'answer-discarded', reason: 'renumbered' });
    expect(streamed).toBe(out.text);
  });

  it('keeps the numbering of every document it read when the service lists what it read', async () => {
    const out = await citingSecond('read');

    expect(out.text).toBe('Svaret er 42 [2].');
  });

  it('lists every source it read when the service asks for what it read', async () => {
    const out = await citingSecond('read');

    expect(out.sources.map((s) => s.chunkId).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('lists every excerpt it read of a cited document', async () => {
    const store = new Map([
      ['c1', chunk(1)],
      ['c2', chunk(2, { document: 'd1', position: 1 })],
      ['c3', chunk(3)],
    ]);
    const out = await run({
      retrieval: retrieval({}, store).impl,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3'] })]),
          ],
          synth: [() => 'Svaret er 42 [1].'],
        },
      },
    });

    expect(out.sources.map((s) => s.chunkId).sort()).toEqual(['c1', 'c2']);
  });
});

describe('adding citations to a draft', () => {
  const list =
    '- 2019: tildelingsbrev\n- 2020: tildelingsbrev\n- 2021: tildelingsbrev\n- 2022: tildelingsbrev';

  const uncitedList = (synth: string) =>
    run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2'] })]),
            () => result(list),
          ],
          read: [unsure],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => synth],
        },
      },
    });

  it('keeps the draft and adds citations to it, rather than writing a new answer', async () => {
    const cited = list.replace('2019: tildelingsbrev', '2019: tildelingsbrev [1]');
    const out = await uncitedList(cited);

    expect(draftIn(out)).toContain(list);
    expect(out.text).toBe(cited);
    expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c1' }] });
  });

  it('does not use a rewrite of the same length that changes the wording', async () => {
    const reworded = list
      .replace('2019: tildelingsbrev', '2019: tildelingsbrev [1]')
      .replace('2021: tildelingsbrev', '2021: budsjettbrevet');
    const out = await uncitedList(reworded);

    expect(reworded.replace(' [1]', '').length).toBe(list.length);
    expect(out.text).toBe(list);
    expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: false });
  });

  it('does not use a rewrite that drops part of the draft', async () => {
    const shorter = list
      .replace('2019: tildelingsbrev', '2019: tildelingsbrev [1]')
      .replace('2022: tildelingsbrev', '2022:');
    const out = await uncitedList(shorter);

    expect(shorter.replace(' [1]', '').length / list.length).toBeGreaterThan(0.8);
    expect(out.text).toBe(list);
    expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: false });
  });

  it('does not narrow the answer to what it can cite', async () => {
    const out = await uncitedList('Konteksten inneholder tildelingsbrev for 2019 [1].');

    expect(out.text).toBe(list);
    expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: false });
  });
});
