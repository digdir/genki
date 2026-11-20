import { describe, expect, it } from 'vitest';
import {
  agentLoopConfig,
  buildEvidencePlan,
  exhaustionDefaults,
  exhaustionNudge,
  honestMisses,
  inferQueryIntent,
  questionLanguage,
  soundsLikeRefusal,
} from './index.js';
import {
  baseConfig,
  call,
  decision,
  rawToolMessages,
  readSignal,
  result,
  retrieval,
  run,
} from './harness.test-utils.js';

const gates = (out: Awaited<ReturnType<typeof run>>) =>
  out.notices.filter((n) => n.stage === 'gate');

const kinds = (out: Awaited<ReturnType<typeof run>>) => out.seen.map((s) => s.kind);

describe('gates in the agent loop', () => {
  it('shadow rejection counts toward the rejection limit', async () => {
    const reads = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5];
    const out = await run({
      config: {
        ...baseConfig,
        strategy: { budget: { searches: 4, reads: 20, readChars: 50000 }, maxIterations: 14 },
      },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            ...reads.map((n) => () => result('', [call('read_chunks', { chunk_ids: [`c${n}`] })])),
          ],
          read: [() => readSignal('gap-remaining')],
        },
      },
    });

    const shadow = gates(out).filter((n) => n.source === 'shadow-read-signals');
    expect(shadow.map((n) => n.strategy)).toEqual([
      're-search',
      're-search',
      're-search',
      're-search',
      'finalize',
    ]);
  });

  it('a cited draft is never vetoed by the shadow verdict', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining')],
          synth: [() => 'Svar [1].'],
        },
      },
    });

    expect(out.text).toBe('Svar [1].');
    expect(out.loops).toHaveLength(3);
    expect(
      gates(out).filter((n) => n.source === 'shadow-read-signals' && n.status !== 'sufficient'),
    ).toEqual([]);
  });

  it('a judge reads the draft it judges', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining')],
          synth: [() => 'Svar fra utkastet [1].'],
        },
      },
    });

    const judge = out.seen.find((s) => s.kind === 'sufficiency')?.request.messages[1]?.content;
    expect(judge).toContain('Draft answer:');
    expect(judge).toContain('Svar fra utkastet [1].');
  });

  it('a cited draft gets one repair pass and then stands', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining')],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Første [1].', () => 'Andre [1].', () => 'Tredje [1].'],
        },
      },
    });

    expect(kinds(out).filter((k) => k === 'sufficiency')).toHaveLength(1);
    expect(out.text).toBe('Andre [1].');
  });

  it('a judge that is unsure lets the draft stand', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining')],
          sufficiency: [() => decision('unsure', 're-search')],
          synth: [() => 'Svar [1].'],
        },
      },
    });

    expect(out.text).toBe('Svar [1].');
    expect(out.loops).toHaveLength(3);
  });

  it('exhaustion reuses the last cited draft', async () => {
    const out = await run({
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, maxIterations: 5 } },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('', [call('search', { queries: ['y'] })]),
          ],
          read: [() => readSignal('gap-remaining')],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Utkast [1].'],
        },
      },
    });

    expect(out.text).toBe('Utkast [1].');
    expect(kinds(out)).not.toContain('final');
  });

  it('Har and Hvilke do not become required claims', () => {
    const claims = (q: string) =>
      buildEvidencePlan(q, inferQueryIntent(q, [])).requiredClaims.map((c) => c.text);

    expect(inferQueryIntent('Har dere tildelingsbrev for Digdir?', []).entity).toBe('Digdir');
    expect(claims('Har dere tildelingsbrev for Digdir?')).toContain('Evidence is about Digdir');
    expect(inferQueryIntent('Hvilke dokumenter er nyest?', []).entity).toBeNull();
    expect(claims('Hvilke dokumenter er nyest?').join(' ')).not.toMatch(/Har|Hvilke/);
  });

  it('no judge call runs after the budgets are spent', async () => {
    const out = await run({
      config: {
        ...baseConfig,
        strategy: { budget: { searches: 1, reads: 1, readChars: 12000 } },
      },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Svar [1].'],
        },
      },
    });

    expect(kinds(out).filter((k) => k === 'read' || k === 'sufficiency')).toEqual([]);
    expect(out.text).toBe('Svar [1].');
  });
});

describe('the budget an agent sees and how it ends', () => {
  it('every tool result states the remaining budget', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] }), call('inspect_filters', {})]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining')],
          synth: [() => 'Svar [1].'],
        },
      },
    });

    const first = rawToolMessages(out.loops[1]);
    expect(first).toHaveLength(2);
    for (const message of first)
      expect(message).toMatch(
        /\n\nRemaining budget: rounds 8\/9, searches 3\/4, reads \d+\/6, characters \d+\/12000\. When rounds reach 0, you answer without tools\.$/,
      );
    expect(rawToolMessages(out.loops[2]).at(-1)).toMatch(/Remaining budget: rounds 7\/9, /);
  });

  it('the last round runs with tools off', async () => {
    const out = await run({
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, maxIterations: 3 } },
      retrieval: retrieval({ read: async () => [] }).impl,
      scripts: { primary: { loop: [() => result('', [call('search', { queries: ['igjen'] })])] } },
    });

    const turns = out.seen.filter((s) => s.kind === 'loop' || s.kind === 'final');
    expect(turns.map((s) => s.kind)).toEqual(['loop', 'loop', 'final']);
    expect(turns.at(-1)?.request.tools).toBeUndefined();
    expect(out.text).toBe('Beste svar ut fra det jeg fant.');
  });

  const rejectedThenSpent = () =>
    run({
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, maxIterations: 5 } },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining')],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Utkast [1].', () => 'Utkast uten kilder.'],
          final: 'Jeg fant ikke tallet [c1].',
        },
      },
    });

  it('the answer turn names what it could not find', async () => {
    const out = await rejectedThenSpent();

    const final = out.seen.find((s) => s.kind === 'final')?.request.messages ?? [];
    const gaps = final.at(-2);
    expect(gaps?.role).toBe('system');
    expect(gaps?.content).toContain('the requested figure');
    expect(gaps?.content).toContain('Name what of this you could not find.');
  });

  it('the exhaustion message is a closed system message', async () => {
    const out = await rejectedThenSpent();

    const last = out.seen.find((s) => s.kind === 'final')?.request.messages.at(-1);
    expect(last).toEqual({ role: 'system', content: exhaustionNudge });
    expect(exhaustionNudge).not.toMatch(/\[SYSTEM:/);
  });

  it('nynorsk refusals are detected', () => {
    for (const text of [
      'Eg fann ikkje noko om dette i kjeldene.',
      'Kjeldene inneheld ikkje opplysningar om dette.',
      'Det ser ikkje ut til at dokumenta svarar på spørsmålet.',
      'Eg har ikkje funne informasjon om tildelingsbrevet.',
      'Talet er ikkje nemnt i rapporten.',
      'Eg kan ikkje svare på dette ut frå kjeldene.',
    ])
      expect(soundsLikeRefusal(text), text).toBe(true);
    expect(soundsLikeRefusal('Kommunane dekkjer reiseutgiftene for elevane.')).toBe(false);
    expect(soundsLikeRefusal(exhaustionDefaults.nn)).toBe(true);
  });

  it('fallback text follows the question language', async () => {
    const exhausted = (question: string) =>
      run({
        question,
        config: { ...baseConfig, strategy: { ...baseConfig.strategy, maxIterations: 2 } },
        retrieval: retrieval({ read: async () => [] }).impl,
        scripts: {
          primary: { loop: [() => result('', [call('search', { queries: ['x'] })])], final: '' },
        },
      });

    expect(questionLanguage('Kva seier tildelingsbrevet om eit nytt oppdrag?')).toBe('nn');
    expect(questionLanguage('What does the allocation letter say?')).toBe('en');
    expect(questionLanguage('Har du tildelingsbrev for Digdir?')).toBe('nb');
    expect((await exhausted('Kva seier tildelingsbrevet til Digdir?')).text).toBe(
      exhaustionDefaults.nn,
    );
    expect((await exhausted('What does the allocation letter to Digdir say?')).text).toBe(
      exhaustionDefaults.en,
    );
    expect((await exhausted('Hva sier tildelingsbrevet til Digdir?')).text).toBe(
      exhaustionDefaults.nb,
    );
  });

  it('the honest miss follows the question language', async () => {
    const guarded = (question: string) =>
      run({
        question,
        config: {
          ...baseConfig,
          strategy: { ...baseConfig.strategy, noToolCallRetry: true },
        },
        scripts: {
          primary: {
            loop: [
              () => result('Brunost lages av myse.'),
              () => result('Brunost kokes lenge.'),
              () => result('Brunost er brun.'),
            ],
          },
        },
      });

    expect((await guarded('Kva er oppskrifta på tradisjonell brunost?')).text).toBe(
      honestMisses.nn,
    );
    expect((await guarded('What is the recipe for traditional brown cheese?')).text).toBe(
      honestMisses.en,
    );
  });

  const timed = (seconds?: number) => {
    let now = Date.parse('2026-10-06T10:00:00Z');
    const step = () => {
      now += 40_000;
      return result('', [call('search', { queries: ['x'] })]);
    };
    return run({
      now: () => new Date(now),
      config: {
        ...baseConfig,
        strategy: {
          maxIterations: 6,
          budget: { searches: 10, reads: 6, readChars: 12000, ...(seconds ? { seconds } : {}) },
        },
      },
      scripts: { primary: { loop: [step] } },
    });
  };

  it('a set time budget cuts the run to the answer turn', async () => {
    const out = await timed(100);

    expect(out.loops).toHaveLength(3);
    expect(out.notices).toContainEqual(expect.objectContaining({ stage: 'time-budget' }));
    expect(kinds(out)).toContain('final');
    expect(rawToolMessages(out.loops[1])[0]).toMatch(
      /seconds 60\/100\. When rounds or seconds reach 0, you answer without tools\.$/,
    );
  });

  it('an unset time budget means no time limit', async () => {
    const out = await timed();

    expect(out.loops).toHaveLength(5);
    expect(out.notices).not.toContainEqual(expect.objectContaining({ stage: 'time-budget' }));
    expect(rawToolMessages(out.loops[1])[0]).not.toContain('seconds');
  });

  it('takes a time budget of 10 to 600 seconds', () => {
    expect(agentLoopConfig.safeParse({ budget: { seconds: 90 } }).success).toBe(true);
    expect(agentLoopConfig.safeParse({ budget: { seconds: 5 } }).success).toBe(false);
    expect(agentLoopConfig.safeParse({ budget: { seconds: 3600 } }).success).toBe(false);
  });
});
