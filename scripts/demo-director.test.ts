import { describe, expect, it, vi } from 'vitest';
import {
  callUsd,
  estimateReviseUsd,
  estimateUsd,
  revise,
  imageTokens,
  parseReview,
  proofTimes,
  summaryOf,
  usd,
} from './demo-director.ts';
import { baselineEdl } from './demo-edl.ts';
import { estimatedWords, type CaptureLog } from './demo-events.ts';
import { directorCostUsd, editCostUsd } from '../packages/contracts/src/demo-voices.ts';

const log: CaptureLog = {
  viewport: [1920, 1080],
  scale: 1.5,
  seconds: 20,
  language: 'nb-NO',
  steps: [0, 1, 2].map((i) => ({
    say: 'Her er tjenestene.',
    start: i * 6,
    ...(i ? { navigateAt: i * 6 + 0.5 } : {}),
    cue: i * 6 + (i ? 2 : 0),
    end: i * 6 + 6,
    voice: { file: 'a.mp3', seconds: 3 },
    words: estimatedWords('Her er tjenestene.', 3),
    landmarks: [{ kind: 'h1', text: 'Tjenester', box: { x: 0, y: 0, width: 300, height: 40 } }],
    moves: [],
    clicks: [],
    scrolls: [],
    ...(i === 1 ? { focus: { x: 100, y: 100, width: 500, height: 300 } } : {}),
  })),
};

describe('AI director', () => {
  it('reads a review that follows the rubric', () => {
    const review = parseReview(
      'Here it is: {"pass": false, "score": 6, "issues": [{"rule": "lands-on-word", "at": 12.4, "problem": "late", "fix": "anchor to word 3"}]}',
    );
    expect(review.issues[0]?.rule).toBe('lands-on-word');
  });

  it('refuses a review that names a rule outside the rubric', () => {
    expect(() =>
      parseReview(
        '{"pass": true, "score": 9, "issues": [{"rule": "vibes", "at": 1, "problem": "x", "fix": "y"}]}',
      ),
    ).toThrow();
    expect(() => parseReview('no json here')).toThrow();
  });

  it('estimates the edit of a 19-line film well under the 5 dollar budget', () => {
    const long: CaptureLog = {
      ...log,
      steps: Array.from({ length: 19 }, () => log.steps[1] as CaptureLog['steps'][number]),
    };
    expect(estimateUsd(long, 'gpt-5.5')).toBeLessThan(5);
    expect(usd('gpt-5.5', 1_000_000, 0)).toBe(5);
    expect(imageTokens([960, 540])).toBe(765);
  });

  it('never estimates the director or an edit above the price the console asks a person to approve, for a busy page', () => {
    const say = Array.from({ length: 30 }, (_, i) => `ordet${i}`).join(' ');
    const busy = (steps: number): CaptureLog => ({
      ...log,
      steps: Array.from({ length: steps }, (_, i) => ({
        ...(log.steps[1] as CaptureLog['steps'][number]),
        say,
        words: estimatedWords(say, 12),
        landmarks: Array.from({ length: 24 }, (_, j) => ({
          kind: 'section',
          text: `Seksjon ${j} med en lang overskrift om datasett og modeller ${i}`,
          box: { x: 1000, y: 1000, width: 1000, height: 1000 },
        })),
      })),
    });
    for (const steps of [1, 5, 19, 50]) {
      const film = busy(steps);
      expect(estimateUsd(film, 'gpt-5.5')).toBeLessThanOrEqual(directorCostUsd(steps));
      expect(estimateReviseUsd(film, baselineEdl(film), 'gpt-5.5')).toBeLessThanOrEqual(
        editCostUsd(steps),
      );
    }
  });

  it('samples proof frames around every camera move and every cut, and never too many', () => {
    const times = proofTimes(baselineEdl(log), log);
    expect(times.length).toBeGreaterThan(3);
    expect(times.length).toBeLessThanOrEqual(36);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('shows the model the words with their index and time, so moves can be tied to a word', () => {
    expect(summaryOf(log).steps[0]?.words).toMatch(/^0:Her@0\.00 1:er@/);
  });

  it('charges each director call to the film as it answers, at the price of its tokens', async () => {
    const charged: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify(baselineEdl(log)) } }],
          usage: { prompt_tokens: 10_000, completion_tokens: 2_000 },
        }),
      ),
    );
    const ai = {
      endpoint: 'https://example.openai.azure.com',
      deployment: 'gpt-5.5',
      token: () => Promise.resolve('token'),
      budgetUsd: 5,
      charge: (usd: number) => void charged.push(usd),
    };

    await revise(log, baselineEdl(log), 'hold longer', ai);
    vi.unstubAllGlobals();

    expect(charged).toEqual([usd('gpt-5.5', 10_000, 2_000)]);
  });

  it('prices the next director call at its prompt, its images and a full answer, before it is made', () => {
    const image = {
      type: 'image_url' as const,
      image_url: { url: 'data:', detail: 'high' as const },
    };

    expect(
      callUsd('gpt-5.5', 'x'.repeat(3500), [{ type: 'text', text: 'y'.repeat(3500) }, image]),
    ).toBeCloseTo(usd('gpt-5.5', 2000 + imageTokens([1024, 576]), 16_000), 10);
  });

  it('refuses an edit request that would cost more than the edit budget, before calling the model', async () => {
    let asked = false;
    const ai = {
      endpoint: 'https://example.openai.azure.com',
      deployment: 'gpt-5.5',
      token: () => {
        asked = true;
        return Promise.resolve('token');
      },
      budgetUsd: 0.01,
    };
    const edl = baselineEdl(log);
    expect(estimateReviseUsd(log, edl, 'gpt-5.5')).toBeGreaterThan(0.01);
    await expect(revise(log, edl, 'hold longer', ai)).rejects.toThrow(/over the budget of 0.01/);
    expect(asked).toBe(false);
  });
});
