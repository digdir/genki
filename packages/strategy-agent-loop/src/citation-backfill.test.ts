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
import { Workspace, type ShadowDecision } from './workspace.js';

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

const decline = 'Kildene i Kudos dekker ikke dette. Vil du at jeg søker etter noe annet?';

const brunostDecline =
  'Kudos har ingen oppskrift på tradisjonell brunost. Dokumentene her er offentlige rapporter.';
const brunostExtra =
  'Rapporten «Gjennomgang av geiteholdet i Norge» forteller hva brunost lages av:\n\n- **Råvarer:** Brunost lages av myse, melk og fløte.';
const brunostOffer = 'Jeg kan søke i Kudos etter mer om seterkultur.';
const fullAnswer = [
  '**Kort svar:** DFØ konkluderer med at konsulentbruken i staten har flatet ut.',
  '**Slik har jeg tolket spørsmålet:** Jeg fant ingen DFØ-evaluering med et eget kapittel som heter «Konklusjoner». Det nærmeste er DFØ-notat 2024:1.',
  '## Hva DFØ konkluderer med\nFunnene peker i samme retning, men DFØ har ikke nok data til å si hvor stor effekten er.',
].join('\n\n');
const brunostDraft = `${brunostDecline}\n\n${brunostExtra}\n\n${brunostOffer}`;

const judged = (w: Workspace, status: string) =>
  w.sufficiencyDecisions.push({
    status,
    reasoning: `${status} by test`,
    missingInfo: status === 'sufficient' ? [] : ['billettpriser 2026'],
    contradictionDetected: status === 'conflicting',
    suggestedStrategy: status === 'sufficient' ? 'finalize' : 're-search',
  });

const readCheck = (
  w: Workspace,
  status: ShadowDecision['status'],
  reasonCode = `${status}-by-test`,
) =>
  w.shadowDecisions.push({
    source: 'read-signals',
    status,
    reasonCode,
    suggestedStrategy: status === 'sufficient' ? 'finalize' : 'read-more',
    missingClaims: status === 'sufficient' ? [] : ['answer-bearing-evidence'],
    contradictions: [],
    supportedClaimCount: 0,
    stagnantGapClaims: [],
  });

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
    expect(settleCitations(refusal, searchedOnly)).toEqual({
      action: 'keep',
      reason: 'no-answer-text',
    });
  });

  it('carries a cited draft through over a refusal, even a draft the gates rejected', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1);
      w.citationIndex = buildCitationIndex(['c1']);
      w.lastGeneratedResponse = 'Svar [1].';
      w.lastGenerateInsufficient = true;
      judged(w, 'insufficient');
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

describe('a decline after the gate judged the evidence', () => {
  it('keeps a decline written after two reads that left a gap and no gate step, as in case 022', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['Hurtigruten billettpriser 2026'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('search', { queries: ['kystruten maksimalpriser billett'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c2'] })]),
            () => result(decline),
          ],
          read: [
            () => readSignal('gap-remaining'),
            () =>
              readSignal('gap-remaining', {
                remaining_gaps: [
                  { claim_id: 'topic-match', reason: 'not-addressed', critical: true },
                ],
              }),
          ],
          synth: [() => 'Staten betaler for kystruten [1].'],
        },
      },
    });

    expect(out.notices.filter((n) => n.stage === 'gate')).toEqual([]);
    expect(out.text).toBe(decline);
    expect(out.notices).toContainEqual({
      stage: 'citations',
      action: 'keep',
      reason: 'declined-after-insufficient',
    });
    expect(out.notices.filter((n) => n.stage === 'answer-discarded')).toEqual([]);
  });

  it('keeps a decline written after the model gate judged the read chunks off-topic and the read check said nothing', async () => {
    const out = await run({
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, ablate: ['read-signal-eval'] } },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['Hurtigruten billettpriser 2026'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3', 'c4', 'c5'] })]),
            () => result(decline),
          ],
          sufficiency: [() => decision('off-topic', 're-search')],
          synth: [() => 'Staten betaler for kystruten [1].'],
        },
      },
    });

    expect(out.text).toBe(decline);
    expect(out.notices).toContainEqual({
      stage: 'citations',
      action: 'keep',
      reason: 'declined-after-insufficient',
    });
    expect(out.notices.filter((n) => n.stage === 'answer-discarded')).toEqual([]);
  });

  it('still rewrites a decline when the model gate could not judge and fell back to a guess', async () => {
    const out = await run({
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, ablate: ['read-signal-eval'] } },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['Hurtigruten billettpriser 2026'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3', 'c4', 'c5'] })]),
            () => result(decline),
          ],
          sufficiency: [() => 'not json'],
          synth: [() => 'Staten betaler for kystruten [1].'],
        },
      },
    });

    expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: true });
  });

  it("keeps a decline when the last read check found the chunks outside the question's scope", () => {
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      readCheck(w, 'ambiguous', 'wrong-scope');
    });

    expect(settleCitations(decline, w)).toEqual({
      action: 'keep',
      reason: 'declined-after-insufficient',
    });
  });

  it('keeps a decline that also states a figure, without citations, after the gate judged the evidence insufficient', () => {
    const partial =
      'Jeg fant ikke billettprisene for 2026. Staten betaler 1,2 milliarder kroner for ruten.';
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      judged(w, 'insufficient');
    });

    expect(settleCitations(partial, w)).toEqual({
      action: 'keep',
      reason: 'declined-after-insufficient',
    });
  });

  it('keeps a decline when the read check that came after the last gate decision found a gap', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      judged(w, 'sufficient');
      readCheck(w, 'insufficient');
    });

    expect(settleCitations(decline, w)).toEqual({
      action: 'keep',
      reason: 'declined-after-insufficient',
    });
  });

  it('rewrites a decline when the gate judged the evidence sufficient after the last read check', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      readCheck(w, 'insufficient');
      judged(w, 'sufficient');
    });

    expect(settleCitations(decline, w)).toEqual({
      action: 'backfill',
      readFirst: [],
      refusal: true,
    });
  });

  it('keeps a decline written after the gate judged the evidence insufficient', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      judged(w, 'sufficient');
      judged(w, 'insufficient');
    });

    expect(settleCitations(decline, w)).toEqual({
      action: 'keep',
      reason: 'declined-after-insufficient',
    });
  });

  it('keeps a decline written after the gate judged the question off-topic', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      judged(w, 'off-topic');
    });

    expect(settleCitations(decline, w)).toEqual({
      action: 'keep',
      reason: 'declined-after-insufficient',
    });
  });

  it('still rewrites a decline from what was read when the gate judged the evidence sufficient', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      judged(w, 'insufficient');
      judged(w, 'sufficient');
    });

    expect(settleCitations(decline, w)).toEqual({
      action: 'backfill',
      readFirst: [],
      refusal: true,
    });
  });

  it('cuts a decline with an extra section to the decline and its offer, with no citations, as in case 024', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['brunost oppskrift'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result(brunostDraft),
          ],
          read: [() => readSignal('gap-remaining')],
          synth: [() => brunostDraft.replace('fløte.', 'fløte [1].')],
        },
      },
    });

    expect(out.text).toBe(`${brunostDecline}\n\n${brunostOffer}`);
    expect(out.meta).toEqual({ citations: [], noAnswer: true });
    expect(out.notices).toContainEqual({ stage: 'citations', action: 'decline' });
    expect(out.notices).toContainEqual({ stage: 'answer-discarded', reason: 'beyond-decline' });
  });

  it('adds footnotes to a full answer that mentions finding nothing, after the read check found a gap', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['DFØ konsulentbruk konklusjoner'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result(fullAnswer),
          ],
          read: [
            () =>
              readSignal('gap-remaining', {
                supported_claims: [
                  { claim_id: 'topic-match', support: 'explicit', chunk_ids: ['c1'] },
                ],
              }),
          ],
          synth: [() => fullAnswer.replace('har flatet ut.', 'har flatet ut [1].')],
        },
      },
    });

    expect(out.text).toContain('har flatet ut [1].');
    expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: true });
  });

  it('keeps a short decline after the read check found a gap', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['brunost oppskrift'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result(brunostDecline),
          ],
          read: [() => readSignal('gap-remaining')],
          synth: [() => `${brunostDecline} [1]`],
        },
      },
    });

    expect(out.text).toBe(brunostDecline);
    expect(out.notices).toContainEqual({
      stage: 'citations',
      action: 'keep',
      reason: 'declined-after-insufficient',
    });
  });

  it('does not cut a decline whose first paragraph leads into what follows', () => {
    const answer =
      'Jeg fant ikke billettprisene for 2026, men rapporten oppgir disse for 2025:\n\n- Bergen-Kirkenes: 12 000 kroner';
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      judged(w, 'insufficient');
    });

    expect(settleCitations(answer, w)).toEqual({ action: 'backfill', readFirst: [] });
  });

  it('keeps an offer that opens with «Hvis du vil» after the cut', () => {
    const offer = 'Hvis du vil, kan jeg søke etter seterkultur.';
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      judged(w, 'insufficient');
    });

    expect(settleCitations(`${brunostDecline}\n\n${brunostExtra}\n\n${offer}`, w)).toEqual({
      action: 'decline',
      text: `${brunostDecline}\n\n${offer}`,
    });
  });

  it('cuts a decline with an extra section and no offer to its first paragraph', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      judged(w, 'insufficient');
    });

    expect(settleCitations(`${brunostDecline}\n\n${brunostExtra}`, w)).toEqual({
      action: 'decline',
      text: brunostDecline,
    });
  });

  it('cites a judged answer whose decline is not its first paragraph', () => {
    const answer =
      'Rapporten beskriver ordningen for kystruten.\n\nJeg fant ikke tallene for 2024.';
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      judged(w, 'insufficient');
    });

    expect(settleCitations(answer, w)).toEqual({ action: 'backfill', readFirst: [] });
  });

  it('still rewrites a decline with an extra section when the gate judged the evidence sufficient', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      judged(w, 'sufficient');
    });

    expect(settleCitations(brunostDraft, w)).toEqual({
      action: 'backfill',
      readFirst: [],
      refusal: true,
    });
  });

  it('leaves a cited answer that opens with «har ingen … men» as it is', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1);
      judged(w, 'insufficient');
      w.citationIndex = buildCitationIndex(['c1']);
    });

    expect(
      settleCitations('Rapporten har ingen anbefalinger om X, men peker på Y [1].', w),
    ).toEqual({ action: 'keep', reason: 'cited' });
  });

  it('still rewrites a decline when the gate found the evidence conflicting', () => {
    const w = workspaceWith((w) => {
      readInto(w, 1, 2);
      judged(w, 'conflicting');
    });

    expect(settleCitations(decline, w)).toEqual({
      action: 'backfill',
      readFirst: [],
      refusal: true,
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
    'Kudos har ingen oppskrift på tradisjonell brunost.',
    'Kudos har ikke noe om billettpriser.',
    'Kudos har ikkje noko om dette.',
    'Kildene har ingen tall for 2028.',
  ])('treats "%s" as a refusal', (text) => {
    expect(soundsLikeRefusal(text)).toBe(true);
  });

  it.each([
    'Kommunene dekker reiseutgiftene når elever deltar på Statpeds elevkurs.',
    'NHH fikk en samlet realnedgang på 40 millioner kroner over to år.',
    'Rapporten har ingen anbefalinger om X, men peker på Y.',
    'Statpeds elevkurs for 2025 har ingen egenandel. Kommunene dekker reisen.',
  ])('treats "%s" as an answer', (text) => {
    expect(soundsLikeRefusal(text)).toBe(false);
  });
});

const draftIn = (out: Awaited<ReturnType<typeof run>>) =>
  String(out.seen.filter((s) => s.kind === 'synth').at(-1)?.request.messages[1]?.content);

describe('an answer after running out of rounds', () => {
  const rejectedThenExhausted = (final: string, synth: string[]) =>
    run({
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, maxIterations: 4 } },
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
    const out = await rejectedThenExhausted('Digdir skal levere en strategi [c2].', ['Utkast.']);

    expect(exhaustionNudge).toContain('[chunk_id]');
    expect(out.text).toBe('Digdir skal levere en strategi [1].');
    expect(out.meta).toEqual({ citations: [{ index: 1, chunkId: 'c2' }] });
    expect(out.sources.map((s) => s.chunkId)).toEqual(['c2']);
  });

  it('cites the sources it read when the fallback answer has no citations', async () => {
    const partial = 'Jeg fant bare delvis svargrunnlag: Digdir skal levere en strategi i 2025.';
    const out = await rejectedThenExhausted(partial, [
      'Utkast.',
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

  it('reads a page the added citation holds inside its bracket as the citation', async () => {
    const draft = list.replace('2019: tildelingsbrev', '2019: tildelingsbrev s. 63');
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2'] })]),
            () => result(draft),
          ],
          read: [unsure],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => draft.replace('tildelingsbrev s. 63', 'tildelingsbrev [1, s. 63]')],
        },
      },
    });

    expect(out.text).toBe(draft.replace('tildelingsbrev s. 63', 'tildelingsbrev [1] s. 63'));
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
