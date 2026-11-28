import type { DemoScene, DemoTemplate } from '@genai/contracts';

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
  chapter?: string;
  scene?: DemoScene;
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
export const chapterCardSeconds = 2.6;
const plainStep = { showAction: false, enter: 'cut' as const, lead: 0, tail: 0.5 };

const segmentsOf = (edl: FilmEdl, events: FilmEvents): Segment[] => {
  const pieces: Omit<Segment, 'at'>[] = [];
  const film = events.steps.some((s) => s.scene);
  events.steps.forEach((step, i) => {
    const e = edl.steps[i] ?? plainStep;
    const talkFrom = step.cue - e.lead;
    const talkTo = Math.min(step.end, step.cue + step.voice.seconds + e.tail);
    const acts =
      !film && Boolean(step.moves?.length || step.clicks?.length || step.scrolls?.length);
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
    if (film && events.steps[p.step - 1]?.chapter && last?.step !== p.step)
      at += chapterCardSeconds;
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
  intro: number;
  outro: number;
  shots: { step: number; at: number; page: boolean; say: string; title?: string }[];
  camera: { at: number; zoom: number; why?: string; step: number; word?: string }[];
  words: { at: number; to: number; step: number; text: string }[];
  lines: FilmSpan[];
  looks: SceneStep[];
}

export interface FilmSpan {
  step: number;
  from: number;
  to: number;
}

export interface Cue {
  from: number;
  to: number;
  text: string;
}

export const timelineOf = (edl: FilmEdl, events: FilmEvents): Timeline => {
  const segments = segmentsOf(edl, events);
  const last = segments.at(-1);
  const length =
    (last ? last.at + last.to - last.from : (edl.intro?.seconds ?? 0)) + (edl.outro?.seconds ?? 0);
  const words = events.steps.flatMap((s, i) =>
    s.words.map((w) => ({
      at: outputTime(segments, s.cue + w.at),
      to: outputTime(segments, s.cue + w.at + w.seconds),
      step: i + 1,
      text: w.text,
    })),
  );
  return {
    length,
    intro: edl.intro?.seconds ?? 0,
    outro: edl.outro?.seconds ?? 0,
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
    words,
    looks: events.steps.map((s) => ({
      ...(s.scene ? { scene: s.scene } : {}),
      ...(s.chapter ? { chapter: s.chapter } : {}),
    })),
    lines: events.steps.flatMap((s, i) => {
      const own = words.filter((w) => w.step === i + 1);
      const first = own[0];
      const last = own.at(-1);
      if (first && last) return [{ step: i + 1, from: first.at, to: last.to }];
      const at = outputTime(segments, s.cue);
      return [{ step: i + 1, from: at, to: outputTime(segments, s.cue + s.voice.seconds) }];
    }),
  };
};

const cuePattern = /(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/;

const secondsOf = (h = '0', m = '0', s = '0', ms = '0') =>
  Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;

export const cuesOf = (srt: string): Cue[] =>
  srt
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .flatMap((block) => {
      const lines = block.split('\n');
      const at = lines.findIndex((line) => cuePattern.test(line));
      const found = at >= 0 ? cuePattern.exec(lines[at] ?? '') : null;
      if (!found) return [];
      const [, h1, m1, s1, ms1, h2, m2, s2, ms2] = found;
      return [
        {
          from: secondsOf(h1, m1, s1, ms1),
          to: secondsOf(h2, m2, s2, ms2),
          text: lines
            .slice(at + 1)
            .join(' ')
            .trim(),
        },
      ];
    });

export const timelineOfCues = (cues: Cue[], says: string[], seconds: number): Timeline => ({
  length: Math.max(seconds, cues.at(-1)?.to ?? 0),
  intro: 0,
  outro: 0,
  shots: says.map((say, i) => ({ step: i + 1, at: cues[i]?.from ?? 0, page: false, say })),
  camera: [],
  words: [],
  lines: says.map((_, i) => ({ step: i + 1, from: cues[i]?.from ?? 0, to: cues[i]?.to ?? 0 })),
  looks: [],
});

export interface Chapter {
  n: number;
  name: string;
  from: number;
  to: number;
  steps: number[];
}

export const chaptersOf = (chapterOfStep: (string | undefined)[], timeline: Timeline, card = 0) => {
  const chapters: Chapter[] = [];
  chapterOfStep.forEach((name, i) => {
    const line = timeline.lines[i];
    if (!line) return;
    const last = chapters.at(-1);
    if (name && (!last || last.name !== name)) {
      const from = i === 0 ? 0 : Math.max(0, (timeline.shots[i]?.at ?? line.from) - card);
      if (last) last.to = from;
      chapters.push({
        n: chapters.length + 1,
        name,
        from,
        to: timeline.length,
        steps: [i + 1],
      });
    } else last?.steps.push(i + 1);
  });
  return chapters;
};

export type SceneKind = DemoTemplate | 'chapter';

export interface Scene {
  n: number;
  kind: SceneKind;
  name: string;
  from: number;
  to: number;
  steps: number[];
  scene?: DemoScene;
}

export interface SceneStep {
  scene?: DemoScene | undefined;
  chapter?: string | undefined;
}

export const sceneName = (scene: DemoScene | undefined) => {
  if (!scene) return '';
  if (scene.template === 'close') return scene.question ?? scene.address;
  return scene.title ?? '';
};

const windowScenes = (timeline: Timeline, current: SceneStep[]) => {
  const scenes: Omit<Scene, 'n'>[] = [];
  timeline.shots.forEach((shot, i) => {
    const last = scenes.at(-1);
    if (i === 0 || shot.page || !last || last.kind !== 'screen') {
      if (last) last.to = shot.at;
      scenes.push({
        kind: 'screen',
        name: shot.title ?? '',
        from: shot.at,
        to: timeline.length - timeline.outro,
        steps: [shot.step],
        ...(current[i]?.scene ? { scene: current[i].scene } : {}),
      });
    } else last.steps.push(shot.step);
  });
  return scenes;
};

const filmScenes = (timeline: Timeline, current: SceneStep[]) => {
  const scenes: Omit<Scene, 'n'>[] = [];
  let carried: DemoScene | undefined;
  timeline.shots.forEach((shot, i) => {
    const step = timeline.looks[i] ?? {};
    const last = scenes.at(-1);
    if (last && !step.scene && !step.chapter) {
      last.steps.push(shot.step);
      return;
    }
    const card = step.chapter ? Math.min(chapterCardSeconds, shot.at) : 0;
    if (last) last.to = shot.at - card;
    if (step.chapter)
      scenes.push({
        kind: 'chapter',
        name: step.chapter,
        from: shot.at - card,
        to: shot.at,
        steps: [],
      });
    carried = step.scene ?? carried;
    const shown = current[i]?.scene ?? carried;
    scenes.push({
      kind: shown?.template ?? 'screen',
      name: sceneName(shown) || (shot.title ?? ''),
      from: shot.at,
      to: timeline.length - timeline.outro,
      steps: [shot.step],
      ...(shown ? { scene: shown } : {}),
    });
  });
  return scenes;
};

export const isFilmLook = (timeline: Timeline) => timeline.looks.some((s) => s.scene);

export const scenesOf = (
  timeline: Timeline,
  titles: { intro?: string; outro?: string },
  current: SceneStep[] = [],
) => {
  const scenes: Omit<Scene, 'n'>[] = [];
  if (timeline.intro > 0)
    scenes.push({
      kind: 'title',
      name: titles.intro ?? '',
      from: 0,
      to: timeline.intro,
      steps: [],
    });
  scenes.push(
    ...(isFilmLook(timeline) ? filmScenes(timeline, current) : windowScenes(timeline, current)),
  );
  if (timeline.outro > 0)
    scenes.push({
      kind: 'close',
      name: titles.outro ?? '',
      from: timeline.length - timeline.outro,
      to: timeline.length,
      steps: [],
    });
  return scenes.map((scene, i) => ({ ...scene, n: i + 1 }));
};
