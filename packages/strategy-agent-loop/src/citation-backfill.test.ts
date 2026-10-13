import { describe, expect, it } from 'vitest';
import { call, chunk, decision, readSignal, result, retrieval, run } from './harness.test-utils.js';
import { buildCitationIndex } from './citations.js';
import { settleCitations, soundsLikeRefusal } from './citation-backfill.js';
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

  it('does not carry a draft the gates rejected through', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1);
      w.citationIndex = buildCitationIndex(['c1']);
      w.lastGeneratedResponse = 'Svar [1].';
      w.lastGenerateInsufficient = true;
    });

    expect(settleCitations('Svar.', w)).toEqual({ action: 'keep', reason: 'generated-uncited' });
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
