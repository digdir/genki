// Film times from a capture's events.json and edl.json, as scripts/demo-edl.ts computes them.

export interface FilmWord {
  text: string;
  at: number;
  seconds: number;
}

export interface FilmStep {
  say: string;
  start: number;
  navigateAt?: number;
  cue: number;
  end: number;
  voice: { seconds: number };
  words: FilmWord[];
  title?: string;
  moves?: unknown[];
  clicks?: unknown[];
  scrolls?: unknown[];
}

export interface FilmEvents {
  steps: FilmStep[];
}

export interface FilmAnchor {
  step: number;
  word?: number;
  text?: string;
  offset?: number;
}

export interface FilmEdl {
  intro?: { seconds: number };
  outro?: { seconds: number };
  steps: {
    step: number;
    showAction: boolean;
    enter: 'cut' | 'crossfade';
    lead: number;
    tail: number;
  }[];
  camera: { at: FilmAnchor; zoom: number; why?: string }[];
}

interface Segment {
  step: number;
  from: number;
  to: number;
  at: number;
}

const loadingWorthCutting = 0.6;
const plainStep = { showAction: false, enter: 'cut' as const, lead: 0, tail: 0.5 };

const segmentsOf = (edl: FilmEdl, events: FilmEvents): Segment[] => {
  const pieces: Omit<Segment, 'at'>[] = [];
  events.steps.forEach((step, i) => {
    const e = edl.steps[i] ?? plainStep;
    const talkFrom = step.cue - e.lead;
    const talkTo = Math.min(step.end, step.cue + step.voice.seconds + e.tail);
    const acts = Boolean(step.moves?.length || step.clicks?.length || step.scrolls?.length);
    const loading = step.navigateAt === undefined ? 0 : step.cue - step.navigateAt;
    if (step.navigateAt !== undefined && loading >= loadingWorthCutting) {
      if (e.showAction && acts) pieces.push({ step: i + 1, from: step.start, to: step.navigateAt });
      pieces.push({ step: i + 1, from: talkFrom, to: talkTo });
    } else {
      pieces.push({ step: i + 1, from: e.showAction && acts ? step.start : talkFrom, to: talkTo });
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

const outputTime = (segments: Segment[], source: number) => {
  for (const s of segments) {
    if (source < s.from) return s.at;
    if (source <= s.to) return s.at + source - s.from;
  }
  const last = segments.at(-1);
  return last ? last.at + last.to - last.from : 0;
};

const firstWord = (text: string) => text.toLowerCase().match(/[a-zæøå0-9]+/)?.[0];

const wordIndex = (step: FilmStep, a: FilmAnchor) => {
  const wanted = a.text === undefined ? undefined : firstWord(a.text);
  if (wanted) {
    const near = a.word ?? 0;
    const hits = step.words
      .map((w, i) => (firstWord(w.text) === wanted ? i : -1))
      .filter((i) => i >= 0)
      .sort((x, y) => Math.abs(x - near) - Math.abs(y - near));
    if (hits[0] !== undefined) return hits[0];
  }
  return a.word !== undefined && a.word < step.words.length ? a.word : undefined;
};

export interface Timeline {
  length: number;
  shots: { step: number; at: number; page: boolean; say: string; title?: string }[];
  camera: { at: number; zoom: number; why?: string; step: number; word?: string }[];
  words: { at: number; step: number; text: string }[];
}

export const timelineOf = (edl: FilmEdl, events: FilmEvents): Timeline => {
  const segments = segmentsOf(edl, events);
  const last = segments.at(-1);
  const length =
    (last ? last.at + last.to - last.from : (edl.intro?.seconds ?? 0)) + (edl.outro?.seconds ?? 0);
  return {
    length,
    shots: events.steps.map((s, i) => ({
      step: i + 1,
      at: segments.find((g) => g.step === i + 1)?.at ?? outputTime(segments, s.cue),
      page: s.navigateAt !== undefined,
      say: s.say,
      ...(s.title ? { title: s.title } : {}),
    })),
    camera: edl.camera.flatMap((c) => {
      const step = events.steps[c.at.step - 1];
      if (!step) return [];
      const i = wordIndex(step, c.at);
      const word = i === undefined ? undefined : step.words[i];
      return [
        {
          at: outputTime(segments, step.cue + (word?.at ?? 0) + (c.at.offset ?? 0)),
          zoom: c.zoom,
          step: c.at.step,
          ...(c.why ? { why: c.why } : {}),
          ...(word ? { word: word.text } : {}),
        },
      ];
    }),
    words: events.steps.flatMap((s, i) =>
      s.words.map((w) => ({ at: outputTime(segments, s.cue + w.at), step: i + 1, text: w.text })),
    ),
  };
};
