// The edit decision list: what the film shows when, decided from a capture and checked against a rubric.
import { z } from 'zod';
import { sentencesOf, type CaptureLog, type StepLog } from './demo-events.ts';
import type { Box } from './demo-pointer.ts';
import { wordsOf } from './demo-voice.ts';

const box = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

const anchor = z.strictObject({
  step: z.int().min(1),
  word: z.int().min(0).optional(),
  text: z.string().max(80).optional(),
  offset: z.number().min(-3).max(10).optional(),
});

const card = z.strictObject({ seconds: z.number().min(2).max(8) });

export const edlSchema = z.strictObject({
  version: z.literal(1),
  fps: z.union([z.literal(30), z.literal(60)]),
  captions: z.boolean(),
  intro: card.optional(),
  outro: card.optional(),
  steps: z
    .array(
      z.strictObject({
        step: z.int().min(1),
        showAction: z.boolean(),
        enter: z.enum(['cut', 'crossfade']),
        lead: z.number().min(0).max(1.5),
        tail: z.number().min(0.1).max(3),
        cursor: z.enum(['auto', 'hidden']),
      }),
    )
    .max(200),
  camera: z
    .array(
      z.strictObject({
        at: anchor,
        zoom: z.number().min(1).max(1.8),
        target: box.optional(),
        until: anchor.optional(),
        why: z.string().max(300).optional(),
      }),
    )
    .max(400),
  callouts: z
    .array(z.strictObject({ from: anchor, to: anchor, box, why: z.string().max(300).optional() }))
    .max(200),
  chapters: z.array(z.strictObject({ at: anchor, title: z.string().min(1).max(60) })).max(200),
});

export type Edl = z.infer<typeof edlSchema>;
export type Anchor = z.infer<typeof anchor>;

export const parseEdl = (value: unknown, log: CaptureLog): Edl => {
  const edl = edlSchema.parse(value);
  const problems = anchorProblems(edl, log);
  if (problems.length)
    throw new Error(`The edit list does not fit the capture:\n  ${problems.join('\n  ')}`);
  return edl;
};

const anchorsOf = (edl: Edl) => [
  ...edl.camera.map((c, i) => [`camera ${i + 1}`, c.at] as const),
  ...edl.callouts.flatMap((c, i) => [
    [`callout ${i + 1}`, c.from] as const,
    [`callout ${i + 1}`, c.to] as const,
  ]),
  ...edl.chapters.map((c, i) => [`chapter ${i + 1}`, c.at] as const),
];

const anchorProblems = (edl: Edl, log: CaptureLog) => {
  const problems: string[] = [];
  for (const [what, a] of anchorsOf(edl)) {
    const step = log.steps[a.step - 1];
    if (!step) problems.push(`${what} points at step ${a.step}, and there are ${log.steps.length}`);
    else if (a.text !== undefined && a.word === undefined && wordIndex(step, a) === undefined)
      problems.push(`${what} points at «${a.text}», which step ${a.step} does not say`);
    else if (a.word !== undefined && a.text === undefined && a.word >= step.words.length)
      problems.push(
        `${what} points at word ${a.word} of step ${a.step}, which has ${step.words.length}`,
      );
  }
  if (edl.steps.length !== log.steps.length)
    problems.push(`steps lists ${edl.steps.length} steps, and the capture has ${log.steps.length}`);
  edl.steps.forEach((s, i) => {
    if (s.step !== i + 1) problems.push(`steps[${i}] is step ${s.step}, not ${i + 1}`);
  });
  return problems;
};

export const wordIndex = (step: StepLog, a: Anchor) => {
  const wanted = a.text === undefined ? undefined : wordsOf(a.text)[0];
  if (wanted) {
    const hits = step.words
      .map((w, i) => (wordsOf(w.text)[0] === wanted ? i : -1))
      .filter((i) => i >= 0);
    const near = a.word ?? 0;
    const best = hits.sort((x, y) => Math.abs(x - near) - Math.abs(y - near))[0];
    if (best !== undefined) return best;
  }
  return a.word !== undefined && a.word < step.words.length ? a.word : undefined;
};

export const sourceTime = (log: CaptureLog, a: Anchor) => {
  const step = log.steps[a.step - 1] as StepLog;
  const i = wordIndex(step, a);
  const word = i === undefined ? undefined : step.words[i];
  return step.cue + (word?.at ?? 0) + (a.offset ?? 0);
};

const anchored = (a: Anchor) => a.word !== undefined || a.text !== undefined;

export interface Segment {
  step: number;
  from: number;
  to: number;
  transition: 'cut' | 'crossfade';
  at: number;
}

export const loadingWorthCutting = 0.6;

export const segmentsOf = (edl: Edl, log: CaptureLog): Segment[] => {
  const pieces: Omit<Segment, 'at'>[] = [];
  log.steps.forEach((step, i) => {
    const e = edl.steps[i] as Edl['steps'][number];
    const talkFrom = step.cue - e.lead;
    const talkTo = Math.min(step.end, step.cue + step.voice.seconds + e.tail);
    const acts = step.moves.length > 0 || step.clicks.length > 0 || step.scrolls.length > 0;
    const loading = step.navigateAt === undefined ? 0 : step.cue - step.navigateAt;
    if (step.navigateAt !== undefined && loading >= loadingWorthCutting) {
      if (e.showAction && acts)
        pieces.push({
          step: i + 1,
          from: step.start,
          to: step.navigateAt,
          transition: 'cut',
        });
      pieces.push({ step: i + 1, from: talkFrom, to: talkTo, transition: e.enter });
    } else {
      const from = e.showAction && acts ? step.start : talkFrom;
      pieces.push({
        step: i + 1,
        from,
        to: talkTo,
        transition: step.navigateAt === undefined ? 'cut' : e.enter,
      });
    }
  });
  let at = edl.intro?.seconds ?? 0;
  const segments: Segment[] = [];
  for (const p of pieces) {
    const last = segments.at(-1);
    const from = last ? Math.max(p.from, last.to) : p.from;
    if (p.to - from < 0.2) continue;
    segments.push({ ...p, from, at });
    at += p.to - from;
  }
  return segments;
};

export const filmLength = (edl: Edl, segments: Segment[]) => {
  const last = segments.at(-1);
  return (
    (last ? last.at + last.to - last.from : (edl.intro?.seconds ?? 0)) + (edl.outro?.seconds ?? 0)
  );
};

export const outputTime = (segments: Segment[], source: number) => {
  for (const s of segments) {
    if (source < s.from) return s.at;
    if (source <= s.to) return s.at + source - s.from;
  }
  const last = segments.at(-1);
  return last ? last.at + last.to - last.from : 0;
};

export const sourceAt = (segments: Segment[], output: number) => {
  let found = segments[0];
  for (const s of segments) if (s.at <= output) found = s;
  if (!found) return { segment: -1, source: 0 };
  return {
    segment: segments.indexOf(found),
    source: Math.min(found.to, Math.max(found.from, found.from + output - found.at)),
  };
};

export const voiceTimes = (log: CaptureLog, segments: Segment[]) =>
  log.steps.map((s) => outputTime(segments, s.cue));

export const moveLead = 0.55;

export interface Shot {
  at: number;
  zoom: number;
  target?: Box;
  entry?: boolean;
  back?: boolean;
}

export const lineEndPause = 0.15;

export const afterEntry = 0.9;

export const pageEntries = (log: CaptureLog, segments: Segment[]) =>
  segments.filter((s) => s.transition === 'crossfade').map((s) => s.at);

export const pageLeaves = (log: CaptureLog, segments: Segment[]) =>
  log.steps.flatMap((step, i) => {
    const first = segments.find((s) => s.step === i + 1);
    return step.navigateAt !== undefined && first ? [first.at - 0.05] : [];
  });

export const cameraShots = (edl: Edl, log: CaptureLog, segments: Segment[]): Shot[] => {
  const entries = [...pageEntries(log, segments), ...pageLeaves(log, segments)];
  const timeOf = (a: Anchor) => {
    let at = outputTime(segments, sourceTime(log, a)) - (anchored(a) ? moveLead : 0);
    const entry = entries.find((e) => at > e - 0.6 && at < e + afterEntry);
    if (entry !== undefined) at = entry + afterEntry;
    return at;
  };
  const shots: Shot[] = edl.camera.map((c) => ({
    at: timeOf(c.at),
    zoom: c.zoom,
    ...(c.target && c.zoom > 1 ? { target: c.target } : {}),
  }));
  const returns = edl.camera.flatMap((c, i) => {
    if (c.zoom <= 1) return [];
    const from = shots[i]?.at ?? 0;
    const step = log.steps[c.at.step - 1] as StepLog;
    const at = c.until
      ? timeOf(c.until)
      : outputTime(segments, step.cue + step.voice.seconds) + lineEndPause;
    const interrupted = shots.some((s, j) => j !== i && s.at > from && s.at <= at + 1.5);
    return interrupted || at <= from ? [] : [{ at, zoom: 1, back: true }];
  });
  shots.push(...returns);
  shots.push(...pageLeaves(log, segments).map((at) => ({ at, zoom: 1, entry: true })));
  return shots.sort((a, b) => a.at - b.at);
};

export const baselineEdl = (log: CaptureLog, fps: 30 | 60 = 60): Edl => {
  const camera: Edl['camera'] = [];
  log.steps.forEach((step, i) => {
    if (step.focus) {
      camera.push({
        at: { step: i + 1, word: 0 },
        zoom: zoomFor(step.focus, log.viewport),
        target: step.focus,
      });
    }
  });
  return {
    version: 1,
    fps,
    captions: true,
    ...(log.intro ? { intro: { seconds: 4.5 } } : {}),
    ...(log.outro ? { outro: { seconds: 4 } } : {}),
    steps: log.steps.map((s, i) => ({
      step: i + 1,
      showAction: s.clicks.length > 0 || s.moves.length > 0,
      enter: 'crossfade' as const,
      lead: 0.25,
      tail: Math.min(1.2, Math.max(0.35, s.hold ?? 0.5)),
      cursor: 'auto' as const,
    })),
    camera,
    callouts: [],
    chapters: log.steps.flatMap((s, i) =>
      s.chapter ? [{ at: { step: i + 1 }, title: s.chapter }] : [],
    ),
  };
};

export const frame: [number, number] = [1920, 1080];
export const contentWidth = 1700;
export const maxZoom = 1.8;

export const zoomFor = (target: Box, [w]: [number, number]) => {
  const onScreen = contentWidth / w;
  const fit = Math.min(
    (frame[0] * 0.9) / (target.width * onScreen),
    (frame[1] * 0.8) / (target.height * onScreen),
  );
  return Math.floor(Math.min(maxZoom, Math.max(1, fit)) * 100) / 100;
};

export interface Issue {
  rule: string;
  at: number;
  problem: string;
  fix: string;
}

export const rubric = {
  'lands-on-word': 'Every camera move is tied to the word it serves and lands on it.',
  'still-while-reading':
    'Nothing moves while text is being read: moves do not overlap, and none starts right next to a cut.',
  'no-dead-air': 'No dead air: the voice never pauses longer than 1.5 seconds between lines.',
  'no-jitter': 'No jitter: the camera does not move back and forth within a short time.',
  'legible-zoom':
    'Text is legible at the zoom: the target fits on screen, and a zoom is worth making.',
  'one-move-per-sentence': 'At most one camera move per sentence.',
  'consistent-transitions':
    'Transitions are consistent: every page change is entered the same way.',
} as const;

export type Rule = keyof typeof rubric;

export const lintEdl = (edl: Edl, log: CaptureLog): Issue[] => {
  const issues: Issue[] = [];
  const segments = segmentsOf(edl, log);
  const shots = cameraShots(edl, log, segments);
  const add = (rule: Rule, at: number, problem: string, fix: string) =>
    issues.push({ rule, at: Math.round(at * 10) / 10, problem, fix });
  edl.camera.forEach((c, i) => {
    const at = outputTime(segments, sourceTime(log, c.at));
    if (!anchored(c.at) && c.zoom > 1)
      add(
        'lands-on-word',
        at,
        `camera ${i + 1} zooms in without a word to land on`,
        'anchor it to the word it shows',
      );
    if (c.zoom > 1 && !c.target)
      add('legible-zoom', at, `camera ${i + 1} zooms without a target`, 'give it the box it shows');
    if (c.zoom > 1 && c.zoom < 1.12)
      add(
        'legible-zoom',
        at,
        `camera ${i + 1} zooms only ${c.zoom}x, which reads as a wobble`,
        'zoom at least 1.2x or not at all',
      );
    if (c.target && c.zoom > zoomFor(c.target, log.viewport) + 0.01)
      add(
        'legible-zoom',
        at,
        `camera ${i + 1} at ${c.zoom}x cuts off its target`,
        `zoom at most ${zoomFor(c.target, log.viewport)}x`,
      );
  });
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1] as Shot;
    const b = shots[i] as Shot;
    const apart = a.entry || b.entry ? 0.6 : 1.2;
    if (b.at - a.at < apart && (a.zoom !== b.zoom || a.target !== b.target))
      add(
        a.zoom > 1 && b.zoom > 1 ? 'no-jitter' : 'still-while-reading',
        b.at,
        `two camera moves ${(b.at - a.at).toFixed(1)} s apart`,
        'drop one or move it to the next sentence',
      );
  }
  log.steps.forEach((step, i) => {
    sentencesOf(step.words).forEach((sentence) => {
      const first = step.words.indexOf(sentence[0] as never);
      const moves = edl.camera.filter(
        (c) =>
          c.at.step === i + 1 &&
          anchored(c.at) &&
          (wordIndex(step, c.at) ?? -1) >= first &&
          (wordIndex(step, c.at) ?? -1) < first + sentence.length,
      );
      if (moves.length > 1)
        add(
          'one-move-per-sentence',
          outputTime(segments, step.cue + (sentence[0]?.at ?? 0)),
          `${moves.length} camera moves in one sentence of step ${i + 1}`,
          'keep the one that serves the sentence',
        );
    });
  });
  const voice = voiceTimes(log, segments);
  for (let i = 1; i < voice.length; i++) {
    const end = (voice[i - 1] as number) + (log.steps[i - 1] as StepLog).voice.seconds;
    const action = segments
      .filter((s) => s.step === i + 1 && s.to <= (log.steps[i] as StepLog).cue - 0.3)
      .reduce((sum, s) => sum + s.to - s.from, 0);
    const pointing = (log.steps[i] as StepLog).moves.reduce((sum, m) => sum + m.seconds, 0);
    const gap = (voice[i] as number) - end - Math.max(action, pointing);
    if (gap > 1.5)
      add(
        'no-dead-air',
        end,
        `${gap.toFixed(1)} s without voice before step ${i + 1}`,
        `shorten the tail of step ${i} or the action of step ${i + 1}`,
      );
  }
  const entries = new Set(
    segments
      .filter(
        (s, i) => i > 0 && (log.steps[s.step - 1]?.navigateAt ?? -1) >= 0 && s.transition !== 'cut',
      )
      .map((s) => s.transition),
  );
  const navEnters = log.steps.flatMap((s, i) =>
    s.navigateAt === undefined ? [] : [edl.steps[i]?.enter],
  );
  if (new Set(navEnters).size > 1 && entries.size >= 1)
    add(
      'consistent-transitions',
      0,
      'page changes are entered with both cuts and crossfades',
      'use one kind for every page change',
    );
  return issues;
};

export const holdZoom = 2.5;

export const tidyCamera = (edl: Edl, log: CaptureLog): Edl => {
  const segments = segmentsOf(edl, log);
  const fixed = [...pageEntries(log, segments), ...pageLeaves(log, segments)];
  const leaves = pageLeaves(log, segments);
  const timed = edl.camera
    .map((c) => {
      const step = log.steps[c.at.step - 1];
      const index = step ? wordIndex(step, c.at) : undefined;
      const sentence =
        step && index !== undefined
          ? sentencesOf(step.words).findIndex((s) => s.includes(step.words[index] as never))
          : -1;
      const shot = cameraShots({ ...edl, camera: [c] }, log, segments).find((s) => !s.entry);
      return { c, at: shot?.at ?? 0, sentence: `${c.at.step}:${sentence}` };
    })
    .sort((a, b) => a.at - b.at);
  const kept: typeof timed = [];
  for (const t of timed) {
    const { c } = t;
    if (c.zoom > 1 && !c.target) continue;
    const last = kept.at(-1);
    if (last && t.at - last.at < (last.c.zoom > 1 ? holdZoom : 1.2)) continue;
    if (fixed.some((f) => Math.abs(t.at - f) < 0.6)) continue;
    if (sentenceTaken(kept, t)) continue;
    if (c.zoom === 1 && (!last || last.c.zoom === 1)) continue;
    if (leaves.some((l) => l > t.at && l - t.at < holdZoom)) continue;
    const back = cameraShots({ ...edl, camera: [c] }, log, segments).find((s) => s.back);
    if (c.zoom > 1 && back && back.at - t.at < holdZoom) continue;
    const zoom = c.target ? Math.min(c.zoom, zoomFor(c.target, log.viewport)) : c.zoom;
    kept.push({ ...t, c: { ...c, zoom: Math.max(1, zoom) } });
  }
  return { ...edl, camera: kept.map((k) => k.c) };
};

const sentenceTaken = (kept: { sentence: string }[], t: { sentence: string }) =>
  !t.sentence.endsWith(':-1') && kept.some((k) => k.sentence === t.sentence);
