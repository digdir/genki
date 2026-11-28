// Renders a film from a capture and its edit list: app in a floating window, spring camera, drawn pointer, type.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import {
  createCanvas,
  GlobalFonts,
  ImageData,
  loadImage,
  Path2D,
  type Canvas,
  type Image,
  type SKRSContext2D,
} from '@napi-rs/canvas';
import {
  cameraPath,
  content,
  onScreen,
  placeOf,
  pointerAt,
  restOf,
  speedOf,
  type View,
} from './demo-camera.ts';
import {
  cameraShots,
  filmLength,
  frame,
  isFilmLook,
  outputTime,
  segmentsOf,
  sourceAt,
  sourceTime,
  stageOf,
  tidyCamera,
  voiceTimes,
  type Edl,
  type Segment,
  type Shot,
  type Stage,
} from './demo-edl.ts';
import type { DemoScene } from '../packages/contracts/src/demo-scenes.ts';
import {
  backdropOf,
  definitionExcerpt,
  filmLayout,
  frameEntrance,
  paintBackdrop,
  paintCaption,
  paintChapterCard,
  paintEyebrow,
  paintFrameShell,
  paintNarrator,
  paintQuestion,
  paintRing,
  paintScene,
  paintSceneTitle,
  paintTag,
  sectionLabel,
  type Assets,
  type TimedWord,
} from './demo-scenes.ts';
import {
  subtitles,
  voiceFileName,
  type Card,
  type CaptureLog,
  type Click,
  type Move,
  type Word,
} from './demo-events.ts';
import { mixSound, type SoundPlan, type VoiceClip } from './demo-sound.ts';

const [W, H] = frame;
const substeps = 4;
const ink = '#e9eef4';
const muted = '#9fb0c2';
const blue = '#1e98f5';
const chapterSeconds = 3.4;

const fontFiles = {
  Inter: ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold', 'Inter-Bold'],
  InterDisplay: ['InterDisplay-Medium', 'InterDisplay-SemiBold'],
};

export const maxFontBytes = 1024 * 1024;

export const woff2Font = (data: Buffer) => {
  if (data.byteLength > maxFontBytes)
    throw new Error(`The Inter font is ${data.byteLength} bytes, more than ${maxFontBytes}`);
  if (data.subarray(0, 4).toString('latin1') !== 'wOF2')
    throw new Error('The Inter font is not a woff2 file');
  return data;
};

const fetchFont = async (name: string) => {
  const res = await fetch(`https://altinncdn.no/fonts/inter/v4.1/${name}.woff2`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`The Inter font answered ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > maxFontBytes)
    throw new Error(`The Inter font is more than ${maxFontBytes} bytes`);
  return woff2Font(Buffer.from(await res.arrayBuffer()));
};

let fontsLoaded: Promise<void> | undefined;

export const loadFonts = () =>
  (fontsLoaded ??= (async () => {
    for (const [family, files] of Object.entries(fontFiles))
      for (const name of files) GlobalFonts.register(await fetchFont(name), family);
  })().catch((error: unknown) => {
    fontsLoaded = undefined;
    throw error;
  }));

export interface Caption {
  from: number;
  to: number;
  text: string;
}

export const captionLength = 46;

export const phrasesOf = (words: Word[]) => {
  const clauses: Word[][] = [[]];
  for (const w of words) {
    (clauses.at(-1) as Word[]).push(w);
    if (/[.,!?;:]["»)]?$/.test(w.text)) clauses.push([]);
  }
  return clauses
    .filter((c) => c.length)
    .flatMap((clause) => {
      const length = clause.map((w) => w.text).join(' ').length;
      const parts = Math.ceil(length / captionLength);
      const out: Word[][] = [[]];
      let run = 0;
      for (const w of clause) {
        const middle = run + w.text.length / 2;
        if (out.length < parts && middle > (length / parts) * out.length) out.push([]);
        (out.at(-1) as Word[]).push(w);
        run += w.text.length + 1;
      }
      return out.filter((p) => p.length);
    });
};

export const captionsOf = (log: CaptureLog, segments: Segment[]): Caption[] => {
  const voice = voiceTimes(log, segments);
  const captions: Caption[] = [];
  log.steps.forEach((step, i) => {
    const start = voice[i] as number;
    for (const chunk of phrasesOf(step.words)) {
      const first = chunk[0] as Word;
      const last = chunk.at(-1) as Word;
      captions.push({
        from: start + first.at - 0.08,
        to: start + last.at + last.seconds + 0.25,
        text: chunk.map((w) => w.text).join(' '),
      });
    }
  });
  for (let i = 1; i < captions.length; i++) {
    const before = captions[i - 1] as Caption;
    const now = captions[i] as Caption;
    if (before.to > now.from) before.to = now.from;
  }
  return captions;
};

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const ease = (t: number) => 1 - Math.pow(1 - clamp01(t), 4);
const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

async function* rawFrames(stream: Readable, bytes: number) {
  let frame = Buffer.alloc(bytes);
  let filled = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let offset = 0;
    while (offset < chunk.length) {
      const n = Math.min(bytes - filled, chunk.length - offset);
      chunk.copy(frame, filled, offset, offset + n);
      filled += n;
      offset += n;
      if (filled === bytes) {
        yield frame;
        frame = Buffer.alloc(bytes);
        filled = 0;
      }
    }
  }
}

class SourceFrames {
  private readonly frames: AsyncGenerator<Buffer>;
  private readonly proc: ChildProcess;
  index = -1;
  constructor(file: string, size: [number, number], fps: number) {
    const proc = spawn(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-i',
        file,
        '-vf',
        `fps=${fps}`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        'pipe:1',
      ],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    this.proc = proc;
    this.frames = rawFrames(proc.stdout, size[0] * size[1] * 4);
  }
  close() {
    this.proc.stdout?.destroy();
    this.proc.kill();
  }
  async upTo(index: number) {
    let last: Buffer | undefined;
    while (this.index < index) {
      const next = await this.frames.next();
      if (next.done) break;
      last = next.value;
      this.index++;
    }
    return last;
  }
}

const probeSize = (file: string): [number, number] => {
  const [w, h] = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split(',')
    .map(Number);
  return [w as number, h as number];
};

const roundRect = (ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
};

const titleBar = 26;
const dip = '#10161d';

export const dipOf = (p: number) => ({
  cover: smooth(2 - 2 * p),
  held: p < 0.5 ? 1 - smooth(2 * p) : 0,
});
const radius = 14;

const layer = () => {
  const c = createCanvas(W * 2, H * 2);
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);
  return { c, ctx };
};

const backdrop = () => {
  const { c, ctx } = layer();
  const base = ctx.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, '#0d1a28');
  base.addColorStop(1, '#08111b');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);
  for (const [x, y, r, color] of [
    [W * 0.18, H * 0.1, 900, 'rgba(0,98,186,0.42)'],
    [W * 0.92, H * 0.95, 800, 'rgba(30,152,245,0.18)'],
    [W * 0.6, H * 0.45, 1100, 'rgba(10,40,70,0.35)'],
  ] as const) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  return c;
};

const chrome = () => {
  const { c, ctx } = layer();
  const win = {
    x: content.x,
    y: content.y - titleBar,
    w: content.width,
    h: content.height + titleBar,
  };
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 90;
  ctx.shadowOffsetY = 36;
  roundRect(ctx, win.x, win.y, win.w, win.h, radius);
  ctx.fillStyle = '#10161d';
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(ctx, win.x, win.y, win.w, win.h, radius);
  ctx.clip();
  ctx.fillStyle = '#1a222c';
  ctx.fillRect(win.x, win.y, win.w, titleBar);
  ctx.fillStyle = '#0b1118';
  ctx.fillRect(win.x, win.y + titleBar - 1, win.w, 1);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((color, i) => {
    ctx.beginPath();
    ctx.arc(win.x + 20 + i * 20, win.y + titleBar / 2, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
  ctx.restore();
  ctx.save();
  roundRect(ctx, win.x - 0.5, win.y - 0.5, win.w + 1, win.h + 1, radius + 0.5);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
  return c;
};

const cursorPath = () => {
  const p = new Path2D();
  p.moveTo(0, 0);
  p.lineTo(0, 21);
  p.lineTo(5.2, 16.3);
  p.lineTo(8.6, 24.2);
  p.lineTo(12.2, 22.7);
  p.lineTo(8.9, 15);
  p.lineTo(15.6, 15);
  p.closePath();
  return p;
};

interface Plan {
  log: CaptureLog;
  edl: Edl;
  segments: Segment[];
  length: number;
  filmFrom: number;
  filmTo: number;
  views: View[];
  captions: Caption[];
  chapters: { at: number; title: string; index: number }[];
  callouts: {
    from: number;
    to: number;
    box: { x: number; y: number; width: number; height: number };
  }[];
  moves: Move[];
  clicks: Click[];
  hidden: { from: number; to: number }[];
  titles: { from: number; title: string }[];
  fps: number;
  look: 'window' | 'film';
  stage: Stage;
  shots: Shot[];
  spans: SceneSpan[];
  cards: ChapterGap[];
  chapterTitles: string[];
  voice: number[];
}

export interface SceneSpan {
  scene?: DemoScene;
  first: number;
  last: number;
  start: number;
  end: number;
  chapter?: number;
}

export interface ChapterGap {
  from: number;
  to: number;
  chapter: number;
}

export const chapterTitlesOf = (log: CaptureLog) =>
  log.steps.flatMap((s) => (s.chapter ? [s.chapter] : []));

const chapterAt = (log: CaptureLog, step: number) => {
  let n = 0;
  for (let i = 0; i <= step; i++) if (log.steps[i]?.chapter) n++;
  return n || undefined;
};

export const sceneSpans = (log: CaptureLog, segments: Segment[], filmTo: number): SceneSpan[] => {
  const startOf = (step: number) => segments.find((s) => s.step === step + 1)?.at;
  const spans: SceneSpan[] = [];
  log.steps.forEach((step, i) => {
    const open = spans.at(-1);
    if (open && ((!step.scene && !step.chapter) || startOf(i) === undefined)) {
      open.last = i;
      return;
    }
    const scene = step.scene ?? open?.scene;
    const chapter = chapterAt(log, i);
    spans.push({
      ...(scene ? { scene } : {}),
      first: i,
      last: i,
      start: startOf(i) ?? open?.end ?? 0,
      end: filmTo,
      ...(chapter ? { chapter } : {}),
    });
  });
  spans.forEach((span, k) => {
    const next = spans[k + 1];
    if (!next) return;
    const card = segments.find((s) => s.step === next.first + 1)?.card ?? 0;
    span.end = next.start - card;
  });
  return spans;
};

export const frameStartOf = (span: SceneSpan, segments: Segment[]) => {
  const question = span.scene?.template === 'screen' && span.scene.question;
  if (!question) return span.start;
  if (span.last === span.first) return span.end;
  return segments.find((s) => s.step === span.first + 2)?.at ?? span.end;
};

export const chapterGaps = (log: CaptureLog, segments: Segment[]): ChapterGap[] =>
  segments.flatMap((s) =>
    s.card ? [{ from: s.at - s.card, to: s.at, chapter: chapterAt(log, s.step - 1) ?? 1 }] : [],
  );

export const planOf = (log: CaptureLog, given: Edl, fps = given.fps): Plan => {
  const edl = tidyCamera(given, log);
  const segments = segmentsOf(edl, log);
  const length = filmLength(edl, segments);
  const filmFrom = edl.intro?.seconds ?? 0;
  const filmTo = length - (edl.outro?.seconds ?? 0);
  const shots = cameraShots(edl, log, segments);
  const film = isFilmLook(log);
  const stage = stageOf(log);
  const clicks = log.steps.flatMap((s, i) => (edl.steps[i]?.cursor === 'hidden' ? [] : s.clicks));
  const outClicks = clicks.map((c) => ({ ...c, at: outputTime(segments, c.at) }));
  const views = cameraPath(shots, outClicks, length, fps, log.viewport, substeps, stage);
  return {
    look: film ? 'film' : 'window',
    stage,
    shots,
    spans: film ? sceneSpans(log, segments, filmTo) : [],
    cards: film ? chapterGaps(log, segments) : [],
    chapterTitles: chapterTitlesOf(log),
    voice: voiceTimes(log, segments),
    log,
    edl,
    segments,
    length,
    filmFrom,
    filmTo,
    views,
    captions: edl.captions ? captionsOf(log, segments) : [],
    chapters: edl.chapters.map((c, i) => ({
      at: outputTime(segments, sourceTime(log, c.at)),
      title: c.title,
      index: i + 1,
    })),
    callouts: edl.callouts.map((c) => ({
      from: outputTime(segments, sourceTime(log, c.from)),
      to: outputTime(segments, sourceTime(log, c.to)),
      box: c.box,
    })),
    moves: log.steps.flatMap((s) => s.moves),
    clicks,
    hidden: log.steps.flatMap((s, i) =>
      edl.steps[i]?.cursor === 'hidden' ? [{ from: s.start, to: s.end }] : [],
    ),
    titles: log.steps.flatMap((s) => (s.title ? [{ from: s.start, title: s.title }] : [])),
    fps,
  };
};

class Painter {
  readonly canvas: Canvas;
  readonly ctx: SKRSContext2D;
  private readonly backdrop = backdrop();
  private readonly chrome = chrome();
  private readonly source: Canvas;
  private readonly held: Canvas;
  private readonly cursor = cursorPath();
  readonly plan: Plan;
  readonly sourceSize: [number, number];
  readonly logo: Image;
  readonly scale: number;
  readonly assets: Assets;
  sequential = false;
  private previous: Canvas | undefined;
  private lastUnit: string | undefined;
  private switchAt = -Infinity;
  private readonly excerpts = new Map<string, string[]>();
  constructor(
    plan: Plan,
    sourceSize: [number, number],
    assets: Assets & { logo: Image },
    scale = 1,
  ) {
    this.plan = plan;
    this.sourceSize = sourceSize;
    this.logo = assets.logo;
    this.assets = assets;
    this.scale = scale;
    this.canvas = createCanvas(Math.round(W * scale), Math.round(H * scale));
    this.ctx = this.canvas.getContext('2d');
    this.source = createCanvas(sourceSize[0], sourceSize[1]);
    this.held = createCanvas(sourceSize[0], sourceSize[1]);
  }

  load(pixels: Buffer) {
    const data = new ImageData(
      new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length),
      this.sourceSize[0],
      this.sourceSize[1],
    );
    this.source.getContext('2d').putImageData(data, 0, 0);
    this.fresh = true;
  }

  private fresh = true;
  private shellCanvas: Canvas | undefined;
  private smallCanvas: Canvas | undefined;

  private shell() {
    if (!this.shellCanvas) {
      this.shellCanvas = createCanvas(this.canvas.width, this.canvas.height);
      const ctx = this.shellCanvas.getContext('2d');
      ctx.scale(this.scale, this.scale);
      ctx.drawImage(this.backdrop, 0, 0, W, H);
      ctx.drawImage(this.chrome, 0, 0, W, H);
    }
    return this.shellCanvas;
  }

  private small() {
    const w = Math.round(content.width * this.scale);
    const h = Math.round(content.height * this.scale);
    this.smallCanvas ??= createCanvas(w, h);
    if (this.fresh) {
      const ctx = this.smallCanvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.source, 0, 0, w, h);
      this.fresh = false;
    }
    return this.smallCanvas;
  }

  hold() {
    const ctx = this.held.getContext('2d');
    ctx.clearRect(0, 0, this.held.width, this.held.height);
    ctx.drawImage(this.source, 0, 0);
  }

  private viewAt(t: number, k = 0): View {
    const { views, fps } = this.plan;
    const i = Math.round(t * fps * substeps) - k;
    return views[Math.min(views.length - 1, Math.max(0, i))] as View;
  }

  paint(t: number) {
    const { ctx, plan } = this;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.globalAlpha = 1;
    if (t < plan.filmFrom || t >= plan.filmTo) {
      ctx.drawImage(this.backdrop, 0, 0, W, H);
      return t < plan.filmFrom ? this.intro(t) : this.outro(t);
    }
    if (plan.look === 'film') return this.paintFilm(t);
    const view = this.viewAt(t);
    const before = this.viewAt(t, substeps);
    const speed = speedOf(before, view);
    const samples = speed > 3 ? Math.min(6, Math.ceil(speed / 3)) : 1;
    for (let k = 0; k < samples; k++) {
      const v = this.viewAt(t, Math.round((k * substeps) / 2 / samples));
      ctx.globalAlpha = 1 / (k + 1);
      this.composition(t, v);
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.chapter(t);
    this.caption(t);
    if (plan.log.exampleData) this.exampleTag(plan.log.language);
  }

  private unitAt(t: number) {
    const card = this.plan.cards.findIndex((c) => t >= c.from && t < c.to);
    if (card >= 0) return `card:${card}`;
    return `span:${Math.max(
      0,
      this.plan.spans.findLastIndex((s) => s.start <= t),
    )}`;
  }

  private wordsOf(span: SceneSpan): TimedWord[] {
    const { log, voice } = this.plan;
    const words: TimedWord[] = [];
    for (let i = span.first; i <= span.last; i++)
      for (const w of log.steps[i]?.words ?? [])
        words.push({ text: w.text, at: (voice[i] ?? 0) + w.at });
    return words;
  }

  private excerptOf(scene: DemoScene) {
    if (scene.template !== 'code') return [];
    const key = `${scene.definition}:${scene.lines ?? 13}`;
    let excerpt = this.excerpts.get(key);
    if (!excerpt) {
      excerpt = definitionExcerpt(scene.definition, scene.lines);
      this.excerpts.set(key, excerpt);
    }
    return excerpt;
  }

  private narratorShown(t: number) {
    const { spans } = this.plan;
    const narrated = (s: SceneSpan | undefined) =>
      Boolean(s) && ['screen', 'board', 'code'].includes(s?.scene?.template ?? 'screen');
    const k = spans.findLastIndex((s) => s.start <= t);
    if (k < 0 || !narrated(spans[k]) || this.plan.cards.some((c) => t >= c.from && t < c.to))
      return 0;
    let first = k;
    while (first > 0 && narrated(spans[first - 1]) && spans[first - 1]?.end === spans[first]?.start)
      first--;
    let last = k;
    while (narrated(spans[last + 1]) && spans[last]?.end === spans[last + 1]?.start) last++;
    const from = (spans[first] as SceneSpan).start;
    const to = (spans[last] as SceneSpan).end;
    return clamp01((t - from + 0.2) / 0.55) * (1 - clamp01((t - (to - 0.5)) / 0.4));
  }

  private paintFilm(t: number) {
    const { ctx, plan } = this;
    const unit = this.unitAt(t);
    if (this.sequential && this.lastUnit !== undefined && unit !== this.lastUnit) {
      this.previous ??= createCanvas(this.canvas.width, this.canvas.height);
      const keep = this.previous.getContext('2d');
      keep.clearRect(0, 0, this.previous.width, this.previous.height);
      keep.drawImage(this.canvas, 0, 0);
      this.switchAt = t;
    }
    this.lastUnit = unit;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.globalAlpha = 1;
    const draw = { ctx, assets: this.assets, language: plan.log.language };
    const card = plan.cards.find((c) => t >= c.from && t < c.to);
    if (card) {
      paintBackdrop(ctx, 'dark');
      paintChapterCard(
        draw,
        { chapters: plan.chapterTitles, current: card.chapter },
        t - card.from,
        card.to - card.from,
      );
    } else {
      const span =
        plan.spans[
          Math.max(
            0,
            plan.spans.findLastIndex((s) => s.start <= t),
          )
        ];
      const scene = span?.scene;
      const template = scene?.template ?? 'screen';
      paintBackdrop(ctx, backdropOf(template));
      if (span && template === 'screen')
        this.paintScreen(t, span, scene?.template === 'screen' ? scene : undefined);
      else if (span && scene) {
        if (span.chapter && (template === 'board' || template === 'code'))
          paintEyebrow(draw, this.section(span.chapter), t - span.start, template === 'code');
        paintScene(
          draw,
          scene,
          { t, start: span.start, end: span.end, words: this.wordsOf(span) },
          this.excerptOf(scene),
        );
      }
    }
    paintNarrator(draw, this.narratorShown(t));
    this.caption(t);
    const fade = (t - this.switchAt) / 0.35;
    if (this.previous && fade >= 0 && fade < 1) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1 - smooth(fade);
      ctx.drawImage(this.previous, 0, 0);
      ctx.restore();
    }
  }

  private section(chapter: number) {
    const { chapterTitles, log } = this.plan;
    return sectionLabel(chapter, chapterTitles[chapter - 1] ?? '', log.language);
  }

  private paintScreen(
    t: number,
    span: SceneSpan,
    scene: { title: string; question?: string } | undefined,
  ) {
    const { ctx, plan } = this;
    const draw = { ctx, assets: this.assets, language: plan.log.language };
    if (span.chapter) paintEyebrow(draw, this.section(span.chapter), t - span.start);
    const frameAt = frameStartOf(span, plan.segments);
    if (scene?.question)
      paintQuestion(
        draw,
        scene.question,
        t,
        span.start + 0.05,
        span.last > span.first ? frameAt : span.end + 1,
      );
    if (t < frameAt) return;
    if (scene?.title) paintSceneTitle(draw, scene.title, t, frameAt);
    const rect = filmLayout.frame;
    const e = frameEntrance(t, frameAt + 0.1);
    paintFrameShell(ctx, rect, e.alpha, e.dy);
    const view = this.viewAt(t);
    const centre = restOf(plan.stage);
    const { page } = plan.stage;
    ctx.save();
    ctx.globalAlpha *= e.alpha;
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y + e.dy, rect.width, rect.height, 12);
    ctx.clip();
    ctx.save();
    ctx.translate(centre.x, centre.y + e.dy);
    ctx.scale(view.zoom, view.zoom);
    ctx.translate(-view.x, -view.y);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.source, page.x, page.y, page.width, page.height);
    const at = sourceAt(plan.segments, Math.min(plan.filmTo - 0.001, Math.max(plan.filmFrom, t)));
    const segment = plan.segments[at.segment];
    if (
      segment &&
      segment.transition === 'crossfade' &&
      at.segment > 0 &&
      segment.step - 1 > span.first
    ) {
      const p = (t - segment.at) / 0.45;
      if (p < 1) {
        const alpha = ctx.globalAlpha;
        const { cover, held } = dipOf(p);
        ctx.globalAlpha = alpha * cover;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(page.x, page.y, page.width, page.height);
        if (held > 0) {
          ctx.globalAlpha = alpha * held;
          ctx.drawImage(this.held, page.x, page.y, page.width, page.height);
        }
        ctx.globalAlpha = alpha;
      }
    }
    ctx.restore();
    const shot = plan.shots.findLast((s) => s.at <= t);
    if (shot?.target && shot.zoom > 1 && shot.at >= frameAt) {
      const a = onScreen({ x: shot.target.x, y: shot.target.y }, plan.log.viewport, plan.stage);
      const b = onScreen(
        { x: shot.target.x + shot.target.width, y: shot.target.y + shot.target.height },
        plan.log.viewport,
        plan.stage,
      );
      const p = placeOf(a, view, plan.stage);
      const q = placeOf(b, view, plan.stage);
      paintRing(
        ctx,
        { x: p.x, y: p.y + e.dy, width: q.x - p.x, height: q.y - p.y },
        smooth((t - shot.at - 1) / 0.4),
      );
    }
    ctx.restore();
    if (plan.log.exampleData) paintTag(ctx, exampleDataLabel(plan.log.language), rect, e.dy);
  }

  private exampleTag(language: string) {
    const { ctx } = this;
    const label = exampleDataLabel(language);
    ctx.save();
    ctx.font = '600 22px Inter';
    const w = ctx.measureText(label).width + 36;
    const x = W - w - 48;
    const y = 40;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = 'rgba(10,22,38,0.82)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, 44, 22);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 18, y + 23);
    ctx.restore();
  }

  private composition(t: number, v: View, outer = { zoom: 1, lift: 0 }) {
    const { ctx, plan } = this;
    const s = this.scale;
    const z = v.zoom * outer.zoom;
    const still =
      Math.abs(z - 1) < 1e-4 &&
      Math.abs(v.x - W / 2) < 0.01 &&
      Math.abs(v.y - H / 2) < 0.01 &&
      outer.lift === 0;
    if (still) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.shell(), 0, 0);
      ctx.setTransform(s, 0, 0, s, 0, 0);
    } else {
      ctx.setTransform(
        z * s,
        0,
        0,
        z * s,
        (W / 2 - v.x * z) * s,
        (H / 2 - v.y * z + outer.lift) * s,
      );
      if (outer.zoom === 1) ctx.drawImage(this.backdrop, 0, 0, W, H);
      ctx.drawImage(this.chrome, 0, 0, W, H);
    }
    ctx.save();
    roundRect(
      ctx,
      content.x,
      content.y - titleBar,
      content.width,
      content.height + titleBar,
      radius,
    );
    ctx.clip();
    const at = sourceAt(plan.segments, Math.min(plan.filmTo - 0.001, Math.max(plan.filmFrom, t)));
    const title = plan.titles.findLast((x) => x.from <= at.source)?.title;
    if (title) {
      ctx.font = '500 13px Inter';
      ctx.fillStyle = '#8b98a6';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(title, content.x + content.width / 2, content.y - titleBar / 2);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (still) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.small(), Math.round(content.x * s), Math.round(content.y * s));
      ctx.setTransform(s, 0, 0, s, 0, 0);
    } else ctx.drawImage(this.source, content.x, content.y, content.width, content.height);
    const segment = plan.segments[at.segment];
    if (segment && segment.transition === 'crossfade' && at.segment > 0) {
      const p = (t - segment.at) / 0.45;
      if (p < 1) {
        const alpha = ctx.globalAlpha;
        const { cover, held } = dipOf(p);
        ctx.globalAlpha = alpha * cover;
        ctx.fillStyle = dip;
        ctx.fillRect(content.x, content.y, content.width, content.height);
        if (held > 0) {
          ctx.globalAlpha = alpha * held;
          ctx.drawImage(this.held, content.x, content.y, content.width, content.height);
        }
        ctx.globalAlpha = alpha;
      }
    }
    ctx.restore();
    this.callout(t);
    this.pointer(at.source);
  }

  private callout(t: number) {
    const { ctx, plan } = this;
    const k = content.width / plan.log.viewport[0];
    for (const c of plan.callouts) {
      const a = Math.min(smooth((t - c.from) / 0.3), smooth((c.to - t) / 0.3));
      if (a <= 0) continue;
      const p = onScreen(c.box, plan.log.viewport);
      ctx.save();
      ctx.globalAlpha *= a;
      ctx.shadowColor = 'rgba(30,152,245,0.6)';
      ctx.shadowBlur = 18;
      roundRect(ctx, p.x - 6, p.y - 6, c.box.width * k + 12, c.box.height * k + 12, 10);
      ctx.strokeStyle = blue;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
  }

  private pointer(source: number) {
    const { ctx, plan } = this;
    if (plan.hidden.some((h) => source >= h.from && source <= h.to)) return;
    const first = plan.moves[0]?.from ?? { x: 0, y: 0 };
    const p = pointerAt(plan.moves, plan.clicks, source, first);
    if (p.opacity <= 0) return;
    const at = onScreen(p.at, plan.log.viewport);
    ctx.save();
    if (p.ripple !== undefined) {
      const r = 8 + 26 * ease(p.ripple);
      ctx.globalAlpha *= (1 - p.ripple) * 0.9 * p.opacity;
      ctx.beginPath();
      ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(30,152,245,0.18)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(30,152,245,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha /= (1 - p.ripple) * 0.9 * p.opacity || 1;
    }
    ctx.globalAlpha *= p.opacity;
    ctx.translate(at.x - 1, at.y - 1);
    const press = p.ripple !== undefined && p.ripple < 0.3 ? 0.88 : 1;
    ctx.scale(1.05 * press, 1.05 * press);
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#111';
    ctx.fill(this.cursor);
    ctx.shadowColor = 'transparent';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#fff';
    ctx.stroke(this.cursor);
    ctx.restore();
  }

  private caption(t: number) {
    const { ctx, plan } = this;
    const c = plan.captions.find((x) => t >= x.from && t < x.to);
    if (!c) return;
    const a = Math.min(smooth((t - c.from) / 0.12), smooth((c.to - t) / 0.12));
    if (plan.look === 'film') return paintCaption(ctx, c.text, a);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = '500 30px Inter';
    const width = ctx.measureText(c.text).width;
    const y = 982 + (1 - ease((t - c.from) / 0.25)) * 6;
    roundRect(ctx, W / 2 - width / 2 - 22, y - 26, width + 44, 52, 14);
    ctx.fillStyle = 'rgba(8,14,22,0.82)';
    ctx.fill();
    ctx.fillStyle = '#f4f7fa';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.text, W / 2, y + 1);
    ctx.restore();
  }

  private chapter(t: number) {
    const { ctx, plan } = this;
    const c = plan.chapters.findLast((x) => t >= x.at && t < x.at + chapterSeconds);
    if (!c) return;
    const local = t - c.at;
    const open = ease(local / 0.8);
    const fade = Math.min(smooth(local / 0.35), smooth((chapterSeconds - local) / 0.5));
    ctx.save();
    ctx.font = '600 28px InterDisplay';
    const title = ctx.measureText(c.title).width;
    ctx.font = '600 16px Inter';
    const label = String(c.index).padStart(2, '0');
    const labelWidth = ctx.measureText(label).width;
    const w = 28 + labelWidth + 34 + title + 30;
    const h = 60;
    const x = W / 2 - (w * (0.6 + 0.4 * open)) / 2;
    const y = 122 - (1 - open) * 14;
    ctx.globalAlpha = fade;
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 10;
    roundRect(ctx, x, y, w * (0.6 + 0.4 * open), h, h / 2);
    ctx.fillStyle = '#0c141d';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.clip();
    const text = smooth((local - 0.2) / 0.45);
    const left = W / 2 - w / 2 + 28 - (1 - text) * 10;
    ctx.globalAlpha = fade * text;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = blue;
    ctx.fillText(label, left, y + h / 2 + 1);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(left + labelWidth + 16, y + 18, 1.5, h - 36);
    ctx.font = '600 28px InterDisplay';
    ctx.fillStyle = ink;
    ctx.fillText(c.title, left + labelWidth + 34, y + h / 2 + 1);
    ctx.restore();
  }

  private card(card: Card, t: number, alpha: number, lift: number) {
    const { ctx } = this;
    const x = 200;
    const appear = (delay: number) => ({
      a: smooth((t - delay) / 0.6) * alpha,
      y: (1 - ease((t - delay) / 0.9)) * 36 - lift,
    });
    let e = appear(0.15);
    ctx.save();
    ctx.globalAlpha = e.a;
    ctx.drawImage(this.logo, x, 300 + e.y, 84, 84);
    ctx.font = '600 150px InterDisplay';
    ctx.textBaseline = 'alphabetic';
    let cx = x;
    card.title.split(' ').forEach((word, i) => {
      e = appear(0.35 + i * 0.09);
      ctx.globalAlpha = e.a;
      ctx.fillStyle = ink;
      ctx.fillText(word, cx, 560 + e.y);
      cx += ctx.measureText(`${word} `).width;
    });
    if (card.subtitle) {
      e = appear(0.75);
      ctx.globalAlpha = e.a;
      ctx.font = '500 46px Inter';
      ctx.fillStyle = muted;
      ctx.fillText(card.subtitle, x, 640 + e.y);
    }
    if (card.presenter) {
      e = appear(1.15);
      ctx.globalAlpha = e.a;
      ctx.fillStyle = blue;
      ctx.fillRect(x, 812 + e.y, 40, 3);
      ctx.font = '500 30px Inter';
      ctx.fillStyle = ink;
      ctx.fillText(card.presenter, x, 870 + e.y);
    }
    ctx.restore();
  }

  private intro(t: number) {
    const card = this.plan.log.intro;
    const end = this.plan.filmFrom;
    const leave = smooth((t - (end - 1.5)) / 0.6);
    if (card && leave < 1) this.card(card, t, 1 - leave, leave * 30);
    const enter = ease((t - (end - 1.0)) / 1.0);
    if (enter > 0) this.windowAt(enter, this.plan.filmFrom);
  }

  private outro(t: number) {
    const card = this.plan.log.outro;
    const local = t - this.plan.filmTo;
    const leave = 1 - smooth(local / 0.8);
    if (leave > 0) this.windowAt(leave, this.plan.filmTo - 0.001);
    if (card) this.card(card, local - 0.4, 1, 0);
  }

  private windowAt(p: number, t: number) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = p;
    this.composition(
      t,
      { zoom: 1, x: W / 2, y: H / 2 },
      { zoom: 0.9 + 0.1 * p, lift: (1 - p) * 110 },
    );
    ctx.restore();
  }
}

const sourceFps = 30;

export const exampleDataLabel = (language: string) =>
  language.startsWith('en') ? 'Example data' : 'Eksempeldata';

const emblemSvg = () =>
  readFileSync(new URL('../apps/portal/public/emblem-felleslosning.svg', import.meta.url));

export const whiteEmblem = (svg: Buffer) =>
  Buffer.from(svg.toString('utf8').replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="#ffffff"'));

const loadLogo = async () => {
  const [logo, emblem, lockupDark] = await Promise.all([
    loadImage(emblemSvg()),
    loadImage(whiteEmblem(emblemSvg())),
    loadImage(readFileSync(new URL('../docs/images/genki-dark.png', import.meta.url))),
  ]);
  return { logo, emblem, lockupDark };
};

export interface RenderInput {
  log: CaptureLog;
  edl: Edl;
  capture: string;
  voices: string;
}

export const voiceClipsOf = (
  input: Pick<RenderInput, 'log' | 'voices'>,
  plan: Pick<Plan, 'segments'>,
): VoiceClip[] => {
  const voice = voiceTimes(input.log, plan.segments);
  return input.log.steps.flatMap((s, i) => {
    if (s.voice.file && !voiceFileName.test(s.voice.file))
      throw new Error(`step ${i + 1} has a voice file that is not a plain clip name`);
    return s.voice.file
      ? [
          {
            file: join(input.voices, s.voice.file),
            at: voice[i] as number,
            seconds: s.voice.seconds,
          },
        ]
      : [];
  });
};

export const soundPlanOf = (
  input: Pick<RenderInput, 'log' | 'voices'>,
  plan: Pick<Plan, 'segments' | 'length' | 'filmFrom' | 'filmTo' | 'chapters' | 'cards'>,
): SoundPlan => {
  const clips = voiceClipsOf(input, plan);
  return {
    clips,
    talk: clips.map((c) => [c.at, c.at + c.seconds]),
    length: plan.length,
    ...(input.log.music ? { music: input.log.music } : {}),
    kickFrom: plan.filmFrom,
    accents: [
      plan.filmFrom,
      ...plan.chapters.map((c) => c.at),
      ...plan.cards.map((c) => c.from),
      plan.filmTo,
    ],
  };
};

export interface Audio {
  inputs: string[];
  map: string[];
}

export const audioOf = (mix: string | undefined): Audio =>
  mix
    ? { inputs: ['-i', mix], map: ['-map', '2:a', '-c:a', 'aac', '-b:a', '192k'] }
    : { inputs: [], map: [] };

export const encoderArgs = (
  fps: number,
  srt: string,
  audio: Audio,
  out: string,
  language: string,
) => [
  '-y',
  '-loglevel',
  'error',
  '-f',
  'rawvideo',
  '-pix_fmt',
  'rgba',
  '-s',
  `${W}x${H}`,
  '-r',
  String(fps),
  '-i',
  'pipe:0',
  '-i',
  srt,
  ...audio.inputs,
  '-map',
  '0:v',
  ...audio.map,
  '-map',
  '1:s',
  '-c:v',
  'libx264',
  '-preset',
  'medium',
  '-crf',
  '19',
  '-maxrate',
  '10M',
  '-bufsize',
  '20M',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  '-c:s',
  'mov_text',
  '-metadata:s:s:0',
  `language=${language.startsWith('en') ? 'eng' : 'nob'}`,
  out,
];

export const srtOf = (plan: Plan) =>
  subtitles(plan.captions.map((c) => ({ at: c.from, seconds: c.to - c.from, text: c.text })));

export const renderFilm = async (
  input: RenderInput,
  out: string,
  srt: string,
  language: string,
) => {
  await loadFonts();
  const plan = planOf(input.log, input.edl);
  writeFileSync(srt, srtOf(plan));
  const size = probeSize(input.capture);
  const painter = new Painter(plan, size, await loadLogo());
  painter.sequential = true;
  const frames = new SourceFrames(input.capture, size, sourceFps);
  const sound = mixSound(soundPlanOf(input, plan), dirname(out));
  const audio = audioOf(sound?.file);
  const encoder = spawn('ffmpeg', encoderArgs(plan.fps, srt, audio, out, language), {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const sink = encoder.stdin as Writable;
  const total = Math.round(plan.length * plan.fps);
  const started = Date.now();
  let segment = -1;
  try {
    for (let f = 0; f < total; f++) {
      const t = f / plan.fps;
      const film = Math.min(plan.filmTo - 0.001, Math.max(plan.filmFrom, t));
      const at = sourceAt(plan.segments, film);
      if (at.segment !== segment) {
        if (segment >= 0) painter.hold();
        segment = at.segment;
      }
      const pixels = await frames.upTo(Math.floor(at.source * sourceFps));
      if (pixels) painter.load(pixels);
      painter.paint(t);
      const data = painter.ctx.getImageData(0, 0, W, H).data;
      if (!sink.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength)))
        await once(sink, 'drain');
      if (f % (plan.fps * 10) === 0)
        console.log(
          `render: ${Math.round(t)} of ${Math.round(plan.length)} s, ${((Date.now() - started) / 1000 / Math.max(1, t)).toFixed(2)} s per film second`,
        );
    }
  } finally {
    frames.close();
  }
  sink.end();
  const [code] = (await once(encoder, 'close')) as [number];
  if (code !== 0) throw new Error(`ffmpeg ended with ${code}`);
  return { plan, sound: sound?.report };
};

const grab = (capture: string, at: number, size: [number, number]) =>
  execFileSync(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-ss',
      at.toFixed(3),
      '-i',
      capture,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ],
    {
      maxBuffer: size[0] * size[1] * 4 + 1024,
    },
  );

export const renderStills = async (
  input: RenderInput,
  times: number[],
  dir: string,
  scale = 0.5,
) => {
  await loadFonts();
  mkdirSync(dir, { recursive: true });
  const plan = planOf(input.log, input.edl, 30);
  const size = probeSize(input.capture);
  const painter = new Painter(plan, size, await loadLogo(), scale);
  const files: string[] = [];
  for (const t of times) {
    const film = Math.min(plan.filmTo - 0.001, Math.max(plan.filmFrom, t));
    const at = sourceAt(plan.segments, film);
    const segment = plan.segments[at.segment];
    if (segment && at.segment > 0 && film - segment.at < 0.45) {
      const before = plan.segments[at.segment - 1] as Segment;
      painter.load(grab(input.capture, before.to - 0.02, size));
      painter.hold();
    }
    painter.load(grab(input.capture, at.source, size));
    painter.paint(t);
    const file = join(dir, `${t.toFixed(2).padStart(7, '0')}.jpg`);
    writeFileSync(file, painter.canvas.toBuffer('image/jpeg', 85));
    files.push(file);
  }
  return { plan, files };
};
