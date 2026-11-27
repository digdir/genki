import { describe, expect, it } from 'vitest';
import {
  baselineEdl,
  cameraShots,
  contentWidth,
  edlSchema,
  lintEdl,
  moveLead,
  outputTime,
  parseEdl,
  segmentsOf,
  tidyCamera,
  sourceAt,
  voiceTimes,
  zoomFor,
  type Edl,
} from './demo-edl.ts';
import { estimatedWords, type CaptureLog, type StepLog } from './demo-events.ts';

const step = (over: Partial<StepLog> & Pick<StepLog, 'start' | 'cue' | 'end'>): StepLog => ({
  say: 'Her er tjenestene. De er mange.',
  voice: { file: 'a.mp3', seconds: 4 },
  words: estimatedWords('Her er tjenestene. De er mange.', 4),
  landmarks: [],
  moves: [],
  clicks: [],
  scrolls: [],
  ...over,
});

const capture = (): CaptureLog => ({
  viewport: [1920, 1080],
  scale: 1.5,
  seconds: 30,
  language: 'nb-NO',
  intro: { title: 'Genki' },
  steps: [
    step({ start: 0, cue: 0, end: 5 }),
    step({
      start: 5,
      navigateAt: 6,
      cue: 9,
      end: 14,
      moves: [{ at: 5, seconds: 0.8, from: { x: 0, y: 0 }, to: { x: 100, y: 100 } }],
      clicks: [{ at: 5.9, x: 100, y: 100 }],
      focus: { x: 100, y: 200, width: 600, height: 300 },
    }),
  ],
});

describe('edit decision list', () => {
  it('refuses an edit list with fields the schema does not know', () => {
    const edl = { ...baselineEdl(capture()), extra: true };
    expect(() => edlSchema.parse(edl)).toThrow();
  });

  it('refuses a camera move anchored to a word the line does not have', () => {
    const edl: Edl = {
      ...baselineEdl(capture()),
      camera: [{ at: { step: 2, word: 40 }, zoom: 1 }],
    };
    expect(() => parseEdl(edl, capture())).toThrow(/word 40 of step 2/);
  });

  it('cuts from the click straight to the loaded page, so no frame shows a half-loaded page', () => {
    const log = capture();
    const segments = segmentsOf(baselineEdl(log), log);
    const second = segments.filter((s) => s.step === 2);
    expect(second.map((s) => [s.from, s.to])).toEqual([
      [5, 6],
      [8.75, 13.5],
    ]);
    expect(second[1]?.transition).toBe('crossfade');
    expect(outputTime(segments, 7.5)).toBe(second[1]?.at);
  });

  it('starts every line after the title card, and keeps the voice where the page was ready', () => {
    const log = capture();
    const segments = segmentsOf(baselineEdl(log), log);
    const [first, second] = voiceTimes(log, segments);
    expect(first).toBeCloseTo(4.5 + 0.25);
    expect(sourceAt(segments, second as number).source).toBeCloseTo(9);
  });

  it('starts a camera move before its word, so it lands as the word is spoken', () => {
    const log = capture();
    const edl: Edl = {
      ...baselineEdl(log),
      camera: [
        {
          at: { step: 2, word: 3 },
          zoom: 1.4,
          target: { x: 100, y: 200, width: 600, height: 300 },
        },
      ],
    };
    const segments = segmentsOf(edl, log);
    const word = (log.steps[1] as StepLog).words[3]?.at as number;
    const shot = cameraShots(edl, log, segments).find((s) => s.zoom === 1.4);
    expect(shot?.at).toBeCloseTo(outputTime(segments, 9 + word) - moveLead);
  });

  it('returns the camera to the whole window as a step starts to leave the page', () => {
    const log = capture();
    const segments = segmentsOf(baselineEdl(log), log);
    const shots = cameraShots(baselineEdl(log), log, segments);
    const leaving = segments.find((s) => s.step === 2);
    expect(shots).toContainEqual({ at: (leaving?.at ?? 0) - 0.05, zoom: 1, entry: true });
  });

  it('ties a move to the word it names, even when its word number is off by one', () => {
    const log = capture();
    const target = { x: 100, y: 200, width: 600, height: 300 };
    const edl: Edl = {
      ...baselineEdl(log),
      camera: [{ at: { step: 2, word: 4, text: 'mange.' }, zoom: 1.4, target }],
    };
    const word = (log.steps[1] as StepLog).words[5]?.at as number;
    const segments = segmentsOf(edl, log);
    const shot = cameraShots(edl, log, segments).find((s) => s.zoom === 1.4);
    expect(shot?.at).toBeCloseTo(outputTime(segments, 9 + word) - moveLead);
  });

  it('refuses a move tied to a word the line does not say', () => {
    const edl: Edl = {
      ...baselineEdl(capture()),
      camera: [{ at: { step: 2, text: 'Statistikk' }, zoom: 1 }],
    };
    expect(() => parseEdl(edl, capture())).toThrow(/«Statistikk»/);
  });

  it('never zooms so far that the target is cut off', () => {
    expect(zoomFor({ x: 0, y: 0, width: 1920, height: 1080 }, [1920, 1080])).toBe(1);
    const small = zoomFor({ x: 0, y: 0, width: 400, height: 200 }, [1920, 1080]);
    expect(small).toBe(1.8);
    const wide = zoomFor({ x: 0, y: 0, width: 1500, height: 300 }, [1920, 1080]);
    expect(wide * 1500 * (contentWidth / 1920)).toBeLessThanOrEqual(1920 * 0.9);
  });

  it('flags two camera moves in one sentence and a zoom without a word to land on', () => {
    const log = capture();
    const target = { x: 100, y: 200, width: 600, height: 300 };
    const edl: Edl = {
      ...baselineEdl(log),
      camera: [
        { at: { step: 2, word: 0 }, zoom: 1.4, target },
        { at: { step: 2, word: 1 }, zoom: 1.6, target },
        { at: { step: 1 }, zoom: 1.5, target },
      ],
    };
    const rules = lintEdl(edl, log).map((i) => i.rule);
    expect(rules).toContain('one-move-per-sentence');
    expect(rules).toContain('lands-on-word');
    expect(rules).toContain('no-jitter');
  });

  it('flags dead air when a tail leaves the voice silent too long', () => {
    const log = capture();
    const edl = baselineEdl(log);
    (log.steps[0] as StepLog).end = 9;
    (edl.steps[0] as Edl['steps'][number]).tail = 3;
    expect(lintEdl(edl, log).map((i) => i.rule)).toContain('no-dead-air');
  });

  it('passes the plain edit list made from the capture', () => {
    const log = capture();
    expect(lintEdl(baselineEdl(log), log)).toEqual([]);
  });

  it('tidies a camera list to one move per sentence and holds a zoom before it moves again', () => {
    const log = capture();
    const target = { x: 100, y: 200, width: 600, height: 300 };
    const edl: Edl = {
      ...baselineEdl(log),
      camera: [
        { at: { step: 1, word: 0 }, zoom: 1.4, target },
        { at: { step: 1, word: 1 }, zoom: 1.6, target },
        { at: { step: 1, word: 3 }, zoom: 1 },
      ],
    };
    const tidy = tidyCamera(edl, log);
    expect(tidy.camera.map((c) => c.zoom)).toEqual([1.4]);
    expect(lintEdl(tidy, log)).toEqual([]);
  });

  it('drops a zoom out just before the page changes, since the camera returns by itself', () => {
    const log = capture();
    const target = { x: 100, y: 200, width: 600, height: 300 };
    const edl: Edl = {
      ...baselineEdl(log),
      camera: [
        { at: { step: 1, word: 0 }, zoom: 1.4, target },
        { at: { step: 1, word: 5 }, zoom: 1 },
      ],
    };
    expect(tidyCamera(edl, log).camera).toHaveLength(1);
  });

  it('returns the camera to the whole window by itself just after the zoomed line ends', () => {
    const log = capture();
    const target = { x: 100, y: 200, width: 600, height: 300 };
    const edl: Edl = {
      ...baselineEdl(log),
      camera: [{ at: { step: 1, word: 0 }, zoom: 1.4, target }],
    };
    const segments = segmentsOf(edl, log);
    const back = cameraShots(edl, log, segments).find((s) => s.back);
    expect(back?.at).toBeCloseTo(outputTime(segments, 0 + 4) + 0.15);
  });
});
