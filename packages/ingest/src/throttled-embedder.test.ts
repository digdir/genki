import { describe, expect, it } from 'vitest';
import { EmbeddingError, type EmbeddingPort } from '@genai/port-embedding';
import { EmbeddingPauses, throttledEmbedder } from './throttled-embedder.js';

const minute = 60_000;

/** A clock that only moves when the code under test sleeps, and a log of each sleep. */
const fakeClock = () => {
  let at = 0;
  const slept: number[] = [];
  return {
    now: () => at,
    slept,
    sleep: (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) return Promise.reject(signal.reason as Error);
      slept.push(ms);
      at += ms;
      return Promise.resolve();
    },
  };
};

/** An embedder that answers each call from a script: an error to throw, or vectors. */
const scripted = (id: string, script: (Error | 'ok')[]) => {
  const calls: number[] = [];
  let clock = () => 0;
  const port: EmbeddingPort = {
    info: () => ({ id, residency: 'eu', dimensions: 2 }),
    embed: (texts) => {
      calls.push(clock());
      const next = script.shift() ?? 'ok';
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ vectors: texts.map(() => [1, 0]), usage: { inputTokens: 1 } });
    },
  };
  return { port, calls, useClock: (now: () => number) => (clock = now) };
};

const throttled = (retryAfterMs?: number) =>
  new EmbeddingError(
    'rate_limited',
    'the embedder is rate limited',
    retryAfterMs === undefined ? {} : { retryAfterMs },
  );

describe('throttledEmbedder', () => {
  it('an embedding call the provider throttles is tried again after the wait it asked for', async () => {
    const clock = fakeClock();
    const model = scripted('te3', [throttled(7000), 'ok']);
    model.useClock(clock.now);
    const embedder = throttledEmbedder(model.port, { pauses: new EmbeddingPauses(), ...clock });

    const result = await embedder.embed(['a']);

    expect(result.vectors).toEqual([[1, 0]]);
    expect(model.calls).toEqual([0, 7000]);
  });

  it('waits 1 s, doubling to at most 60 s, when a 429 names no wait', async () => {
    const clock = fakeClock();
    const model = scripted('te3', [...Array.from({ length: 8 }, () => throttled()), 'ok']);
    const embedder = throttledEmbedder(model.port, {
      pauses: new EmbeddingPauses(),
      ...clock,
      random: () => 0.5,
    });

    await embedder.embed(['a']);

    expect(clock.slept).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it("one throttled call pauses every job's calls to that model until the wait is over", async () => {
    const clock = fakeClock();
    const pauses = new EmbeddingPauses();
    const first = scripted('te3', [throttled(30_000), 'ok']);
    const second = scripted('te3', ['ok']);
    const other = scripted('other-model', ['ok']);
    for (const m of [first, second, other]) m.useClock(clock.now);
    const jobA = throttledEmbedder(first.port, { pauses, ...clock });
    const jobB = throttledEmbedder(second.port, { pauses, ...clock });
    const jobC = throttledEmbedder(other.port, { pauses, ...clock });

    await jobA.embed(['a']);
    // Job A's wait moved the clock to 30 s; a job that starts during the pause waits for its end.
    pauses.pause('te3', clock.now() + 10_000);
    await jobB.embed(['b']);
    await jobC.embed(['c']);

    expect(second.calls).toEqual([40_000]);
    expect(other.calls).toEqual([40_000]);
  });

  it('a throttled call still refused after 20 minutes fails as other errors do', async () => {
    const clock = fakeClock();
    const model = scripted(
      'te3',
      Array.from({ length: 100 }, () => throttled(minute)),
    );
    const embedder = throttledEmbedder(model.port, { pauses: new EmbeddingPauses(), ...clock });

    const error = await embedder.embed(['a']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as EmbeddingError).code).toBe('rate_limited');
    expect(clock.now()).toBeLessThanOrEqual(20 * minute);
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(19 * minute);
  });

  it('other embedding errors are not waited for', async () => {
    const clock = fakeClock();
    const model = scripted('te3', [new EmbeddingError('bad_request', 'too long'), 'ok']);
    const embedder = throttledEmbedder(model.port, { pauses: new EmbeddingPauses(), ...clock });

    await expect(embedder.embed(['a'])).rejects.toMatchObject({ code: 'bad_request' });
    expect(clock.slept).toEqual([]);
    expect(model.calls).toHaveLength(1);
  });

  it('an unavailable embedder is tried 3 more times, as the SDK did, and never pauses the others', async () => {
    const clock = fakeClock();
    const pauses = new EmbeddingPauses();
    const down = () => new EmbeddingError('unavailable', 'down');
    const model = scripted('te3', [down(), down(), down(), down(), 'ok']);
    const embedder = throttledEmbedder(model.port, { pauses, ...clock });

    await expect(embedder.embed(['a'])).rejects.toMatchObject({ code: 'unavailable' });
    expect(model.calls).toHaveLength(4);
    expect(clock.slept).toEqual([500, 1000, 2000]);
    expect(pauses.until('te3')).toBe(0);
  });

  it("a cancelled run stops a throttled call's wait", async () => {
    const controller = new AbortController();
    const model = scripted('te3', [throttled(10 * minute), 'ok']);
    const embedder = throttledEmbedder(model.port, {
      pauses: new EmbeddingPauses(),
      signal: controller.signal,
    });

    const pending = embedder.embed(['a']);
    setTimeout(() => controller.abort(new Error('run cancelled')), 20);

    await expect(pending).rejects.toThrow('run cancelled');
    expect(model.calls).toHaveLength(1);
  });
});
