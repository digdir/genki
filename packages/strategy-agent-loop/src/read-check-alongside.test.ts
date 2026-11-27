import { describe, expect, it } from 'vitest';
import { call, decision, readSignal, result, run } from './harness.test-utils.js';

// A read check that answers only after the test has seen the given number of model turns.
const slowCheck = (log: string[], status: string) => async () => {
  log.push('check started');
  await new Promise((resolve) => setTimeout(resolve, 20));
  log.push('check done');
  return readSignal(status);
};

describe('the read check runs alongside the next turn', () => {
  it("starts the model's next turn before the read check of the turn before is done", async () => {
    const log: string[] = [];
    await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => {
              log.push('next turn');
              return result('', [call('search', { queries: ['y'] })]);
            },
            () => result('Ferdig.'),
          ],
          read: [slowCheck(log, 'support-found')],
          sufficiency: [() => decision('insufficient', 're-search')],
        },
      },
    });

    expect(log.slice(0, 3)).toEqual(['check started', 'next turn', 'check done']);
  });

  it('a gap the read check finds still stops the answer written on the turn after', async () => {
    const log: string[] = [];
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('', [call('search', { queries: ['y'] })]),
            () => result('Ferdig.'),
          ],
          read: [slowCheck(log, 'gap-remaining')],
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

  it('a read check still running when the model answers is applied before the run ends', async () => {
    const log: string[] = [];
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('Ferdig.'),
          ],
          read: [slowCheck(log, 'support-found')],
        },
      },
    });

    expect(out.notices.filter((n) => n.stage === 'read-signal')).toHaveLength(1);
    expect(log).toEqual(['check started', 'check done']);
  });
});
