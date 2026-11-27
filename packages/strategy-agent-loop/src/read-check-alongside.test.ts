import { describe, expect, it } from 'vitest';
import { ModelError } from '@genai/port-model';
import {
  allSupported,
  baseConfig,
  call,
  decision,
  readSignal,
  result,
  run,
  toolMessages,
} from './harness.test-utils.js';

const latch = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

// Waits for the latch for at most a second, so a loop that awaits the check cannot hang.
const until = (opened: Promise<void>) =>
  Promise.race([opened, new Promise((resolve) => setTimeout(resolve, 1000))]);

// A read check that answers only once the test opens its latch.
const heldCheck = (log: string[], status: string, held: Promise<void>) => async () => {
  log.push('check started');
  await until(held);
  log.push('check done');
  return readSignal(status);
};

const hintFor = (doc: string) => `came from doc_num="${doc}"`;

describe('the read check runs alongside the next turn', () => {
  it("starts the model's next turn before the read check of the turn before is done", async () => {
    const log: string[] = [];
    const next = latch();
    await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => {
              log.push('next turn');
              next.open();
              return result('', [call('search', { queries: ['y'] })]);
            },
            () => result('Ferdig.'),
          ],
          read: [heldCheck(log, 'support-found', next.opened)],
          sufficiency: [() => decision('insufficient', 're-search')],
        },
      },
    });

    expect(log.slice(0, 3)).toEqual(['check started', 'next turn', 'check done']);
  });

  it('a gap the read check finds still stops the answer written on the turn after', async () => {
    const log: string[] = [];
    const next = latch();
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => {
              next.open();
              return result('', [call('generate_response', { query: 'x' })]);
            },
            () => result('', [call('search', { queries: ['y'] })]),
            () => result('Ferdig.'),
          ],
          read: [heldCheck(log, 'gap-remaining', next.opened)],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Utkast [1].'],
        },
      },
    });

    const steps = out.notices.flatMap((n) =>
      n.stage === 'read-signal'
        ? [`check ${String(n.status)}`]
        : n.stage === 'tool' && n.tool === 'generate_response'
          ? ['answer written']
          : [],
    );
    expect(steps.slice(0, 2)).toEqual(['check gap-remaining', 'answer written']);
    expect(
      out.notices.find((n) => n.stage === 'gate' && n.status === 'sufficient'),
    ).toBeUndefined();
    expect(out.text).not.toBe('Utkast [1].');
  });

  it('an answer written in the turn that reads is judged on that read check', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () =>
              result('', [
                call('read_chunks', { chunk_ids: ['c1'] }),
                call('generate_response', { query: 'x' }),
              ]),
            () => result('Ferdig.'),
          ],
          // An answer check that rejects the draft if it is asked instead of the read check.
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Utkast [1].'],
        },
      },
    });

    expect(out.notices.filter((n) => n.stage === 'gate')).toEqual([
      expect.objectContaining({ source: 'shadow-read-signals', status: 'sufficient' }),
    ]);
    expect(out.text).toBe('Utkast [1].');
  });

  it('the turn that first reads a chunk gives no gate verdict before its check is in', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('search', { queries: ['y'] })]),
          ],
          sufficiency: [() => decision('sufficient', 'finalize')],
        },
      },
    });

    const gates = out.notices.filter((n) => n.stage === 'gate');
    expect(out.seen.filter((s) => s.kind === 'sufficiency')).toEqual([]);
    expect(gates).toEqual([
      expect.objectContaining({ source: 'shadow-read-signals', status: 'sufficient' }),
    ]);
    expect(out.loops).toHaveLength(3);
  });

  it('the sufficiency gate is not asked about reads whose check is still running', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c4', 'c5'] })]),
            () => result('', [call('search', { queries: ['y'] })]),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('gap-remaining')],
          sufficiency: [() => decision('sufficient', 'finalize')],
        },
      },
    });

    expect(out.notices.filter((n) => n.stage === 'gate')).not.toContainEqual(
      expect.objectContaining({ source: 'llm-sufficiency-gate', status: 'sufficient' }),
    );
  });

  it.each([
    ['one search and no reads', { searches: 2, reads: 1 }, [call('search', { queries: ['y'] })]],
    [
      'searches and reads',
      { searches: 2, reads: 2 },
      [call('search', { queries: ['y'] }), call('read_chunks', { chunk_ids: ['c2'] })],
    ],
    [
      'no searches and one read',
      { searches: 1, reads: 2 },
      [call('read_chunks', { chunk_ids: ['c2'] })],
    ],
  ])(
    'a sufficient read check still finalizes when the turn after spends %s',
    async (_left, budget, calls) => {
      const out = await run({
        config: { ...baseConfig, strategy: { budget: { ...budget, readChars: 12000 } } },
        scripts: {
          primary: {
            loop: [
              () => result('', [call('search', { queries: ['x'] })]),
              () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
              () => result('', calls),
              () => result('Ferdig fra modellen.'),
            ],
            synth: [() => 'Svar [1].'],
          },
        },
      });

      expect(out.text).toBe('Svar [1].');
    },
  );

  it("a forced answer does not wait for the check of its own turn's reads", async () => {
    const log: string[] = [];
    const answered = latch();
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c2'] })]),
          ],
          read: [allSupported, heldCheck(log, 'support-found', answered.opened)],
          synth: [
            () => {
              log.push('answer written');
              answered.open();
              return 'Svar [1].';
            },
          ],
        },
      },
    });

    expect(log).toEqual(['check started', 'answer written', 'check done']);
    expect(out.notices.filter((n) => n.stage === 'read-signal')).toHaveLength(2);
  });

  it('a read check still running when the model answers is applied before the run ends', async () => {
    const log: string[] = [];
    const next = latch();
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => {
              next.open();
              return result('Ferdig.');
            },
          ],
          read: [heldCheck(log, 'support-found', next.opened)],
        },
      },
    });

    expect(out.notices.filter((n) => n.stage === 'read-signal')).toHaveLength(1);
    expect(log).toEqual(['check started', 'check done']);
  });

  it('a rate limit on the read check does not fail the model turn running alongside it', async () => {
    const turn = latch();
    const checkFailed = latch();
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            async () => {
              turn.open();
              await checkFailed.opened;
              await new Promise((resolve) => setImmediate(resolve));
              throw new ModelError('rate_limited', 'slow down');
            },
          ],
          read: [
            async () => {
              await turn.opened;
              checkFailed.open();
              throw new ModelError('rate_limited', 'slow down');
            },
          ],
        },
        fallback: { loop: [() => result('Ferdig.')] },
      },
    });

    expect(out.task.status).toBe('completed');
    expect(out.text).toBe('Ferdig.');
  });
});

describe('the range-read hint after a read check', () => {
  it('names the read the check reported the gap on', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c2'] })]),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('gap-remaining'), () => readSignal('support-found')],
        },
      },
    });

    const hints = toolMessages(out.loops[3]).join('\n');
    expect(hints).toContain(hintFor('d1'));
    expect(hints).not.toContain(hintFor('d2'));
  });

  it('comes on the last result of the turn after when that turn read nothing', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () =>
              result('', [call('search', { queries: ['y'] }), call('search', { queries: ['z'] })]),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('gap-remaining')],
          sufficiency: [() => decision('insufficient', 're-search')],
        },
      },
    });

    const [, , first, last] = toolMessages(out.loops[3]);
    expect(first).not.toContain(hintFor('d1'));
    expect(last).toContain(hintFor('d1'));
  });

  it('never goes on a written answer', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('gap-remaining')],
          sufficiency: [() => decision('insufficient', 're-search')],
          synth: [() => 'Utkast [1].'],
        },
      },
    });

    expect(toolMessages(out.loops[3]).at(-1)).not.toContain(hintFor('d1'));
  });

  it('is left out when the turn after already range-read that document', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () =>
              result('', [call('read_chunks', { doc_num: 'd1', chunk_range: { from: 0, to: 4 } })]),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('gap-remaining')],
          sufficiency: [() => decision('insufficient', 're-search')],
        },
      },
    });

    expect(toolMessages(out.loops[3]).join('\n')).not.toContain(hintFor('d1'));
  });

  it('reaches a turn that answers without a tool call, which then gets one more turn', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('Svar uten mer.'),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('gap-remaining')],
        },
      },
    });

    expect(out.loops).toHaveLength(4);
    expect(out.loops[3]?.messages.map((m) => m.content).join('\n')).toContain(hintFor('d1'));
    expect(out.text).toBe('Ferdig.');
  });

  it('lets a turn that answers without a tool call end the run when the check found no gap', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('Svar uten mer.'),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('support-found')],
        },
      },
    });

    expect(out.loops).toHaveLength(3);
    expect(out.text).toBe('Svar uten mer.');
  });
});
