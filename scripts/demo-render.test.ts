import { timelineOf } from '../apps/console/src/screens/demos/film.ts';
import { describe, expect, it } from 'vitest';
import { baselineEdl, chapterCardSeconds, filmStage, segmentsOf, zoomFor } from './demo-edl.ts';
import { estimatedWords, type CaptureLog } from './demo-events.ts';
import {
  audioOf,
  captionsOf,
  dipOf,
  encoderArgs,
  exampleDataLabel,
  maxFontBytes,
  frameStartOf,
  planOf,
  soundPlanOf,
  voiceClipsOf,
  whiteEmblem,
  woff2Font,
} from './demo-render.ts';

const say =
  'Dette er Genki, Digdirs felles plattform for generativ KI i offentlig sektor. Her lager virksomhetene sine egne tjenester.';

const log: CaptureLog = {
  viewport: [1920, 1080],
  scale: 1.5,
  seconds: 20,
  language: 'nb-NO',
  intro: { title: 'Genki' },
  steps: [
    {
      say,
      start: 0,
      cue: 0,
      end: 10,
      voice: { file: 'a.mp3', seconds: 9 },
      words: estimatedWords(say, 9),
      landmarks: [],
      moves: [],
      clicks: [],
      scrolls: [],
    },
  ],
};

describe('film render', () => {
  it('shows captions as short phrases that follow the spoken words and never overlap', () => {
    const segments = segmentsOf(baselineEdl(log), log);
    const captions = captionsOf(log, segments);
    expect(captions.map((c) => c.text)).toEqual([
      'Dette er Genki,',
      'Digdirs felles plattform for',
      'generativ KI i offentlig sektor.',
      'Her lager virksomhetene sine egne tjenester.',
    ]);
    for (let i = 1; i < captions.length; i++)
      expect(captions[i]?.from).toBeGreaterThanOrEqual(captions[i - 1]?.to ?? 0);
    expect(captions[0]?.from).toBeGreaterThan(4.5);
  });

  it('places each voice line where its shot starts talking', () => {
    const segments = segmentsOf(baselineEdl(log), log);
    expect(voiceClipsOf({ log, voices: '/voices' }, { segments })).toEqual([
      { file: '/voices/a.mp3', at: 4.5 + 0.25, seconds: 9 },
    ]);
  });

  it('lays music under the film only when the demo asks for it, ducked where the voice talks, with accents on the chapters', () => {
    const plan = planOf(log, baselineEdl(log));
    const plain = soundPlanOf({ log, voices: '/voices' }, plan);
    expect(plain.music).toBeUndefined();
    const scored = soundPlanOf({ log: { ...log, music: 'pulse' }, voices: '/voices' }, plan);
    expect(scored.music).toBe('pulse');
    expect(scored.talk).toEqual([[4.75, 13.75]]);
    expect(scored.accents[0]).toBe(plan.filmFrom);
    expect(scored.length).toBe(plan.length);
  });

  it('muxes the mixed sound as AAC, and no audio when there is none', () => {
    expect(audioOf('mix.wav')).toEqual({
      inputs: ['-i', 'mix.wav'],
      map: ['-map', '2:a', '-c:a', 'aac', '-b:a', '192k'],
    });
    expect(audioOf(undefined)).toEqual({ inputs: [], map: [] });
  });

  it('tags a film of example data in the language of the demo', () => {
    expect(exampleDataLabel('nb-NO')).toBe('Eksempeldata');
    expect(exampleDataLabel('en-GB')).toBe('Example data');
  });

  it('encodes 60 frames a second at full HD with H.264, ready to stream', () => {
    const args = encoderArgs(60, 'x.srt', audioOf(undefined), 'out.mp4', 'nb-NO');
    expect(args.join(' ')).toContain('-s 1920x1080 -r 60 -i pipe:0');
    expect(args).toContain('libx264');
    expect(args).toContain('+faststart');
    expect(args).toContain('language=nob');
  });

  it('changes page through the backdrop so no frame shows two pages at once', () => {
    for (let i = 0; i <= 100; i++) {
      const { cover, held } = dipOf(i / 100);
      const fresh = (1 - cover) * (1 - held);
      expect(Math.min(fresh, held)).toBe(0);
    }
    expect(dipOf(0).held).toBe(1);
    expect(dipOf(1)).toEqual({ cover: 0, held: 0 });
  });

  it('never hands ffmpeg a voice file outside the voice folder', () => {
    const step = log.steps[0] as CaptureLog['steps'][number];
    const outside = {
      ...log,
      steps: [{ ...step, voice: { file: '../../etc/passwd', seconds: 9 } }],
    };
    const segments = segmentsOf(baselineEdl(outside), outside);
    expect(() => voiceClipsOf({ log: outside, voices: '/voices' }, { segments })).toThrow(
      /not a plain clip name/,
    );
  });

  it('takes a font only when it is a woff2 file of at most 1 MiB', () => {
    const font = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(100)]);
    expect(woff2Font(font)).toBe(font);
    expect(() => woff2Font(Buffer.from('<html>not a font</html>'))).toThrow(/not a woff2/);
    expect(() => woff2Font(Buffer.concat([font, Buffer.alloc(maxFontBytes)]))).toThrow(/more than/);
  });

  it('paints the Digdir emblem white for the dark close', () => {
    const svg = Buffer.from('<svg><path fill="#0062B8" d="M0"/></svg>');
    expect(whiteEmblem(svg).toString()).toBe('<svg><path fill="#ffffff" d="M0"/></svg>');
  });
});

const line = (text: string, start: number, extra: Partial<CaptureLog['steps'][number]> = {}) => ({
  say: text,
  start,
  cue: start + 0.2,
  end: start + 4,
  voice: { seconds: 3 },
  words: estimatedWords(text, 3),
  landmarks: [],
  moves: [{ at: start, seconds: 0.4, from: { x: 0, y: 0 }, to: { x: 700, y: 300 } }],
  clicks: [{ at: start + 0.1, x: 700, y: 300 }],
  scrolls: [],
  ...extra,
});

const film: CaptureLog = {
  viewport: [1440, 674],
  scale: 1.5,
  seconds: 20,
  language: 'nb-NO',
  steps: [
    line('Hver virksomhet bygger det samme.', 0, {
      scene: { template: 'title', title: 'Hver KI-tjeneste trenger det samme' },
    }),
    line('I portalen ser virksomheten tjenestene.', 4, {
      chapter: 'Plattformen i sin helhet',
      scene: { template: 'screen', title: 'Tjenestene på ett sted' },
      navigateAt: 4.1,
    }),
    line('Vi følger Rapportassistenten.', 8, {
      focus: { x: 100, y: 100, width: 400, height: 200 },
    }),
    line('Grunnmuren er bygget og testet.', 12, {
      chapter: 'Hvor langt vi har kommet',
      scene: {
        template: 'board',
        title: 'Hvor langt vi har kommet',
        columns: [{ title: 'Bygget og testet', mark: 'done', items: ['API'] }],
      },
    }),
    line('Genki er i test nå.', 16),
  ],
};

describe('the film look', () => {
  it('films a demo with scenes in the film look, and one without in the window look', () => {
    expect(planOf(film, baselineEdl(film)).look).toBe('film');
    expect(planOf(log, baselineEdl(log)).look).toBe('window');
  });

  it("carries a step's scene on until a step names another scene or a chapter", () => {
    const plan = planOf(film, baselineEdl(film));
    expect(plan.spans.map((s) => [s.scene?.template, s.first, s.last, s.chapter])).toEqual([
      ['title', 0, 0, undefined],
      ['screen', 1, 2, 1],
      ['board', 3, 4, 2],
    ]);
    expect(plan.spans.slice(0, -1).map((s) => s.end)).toEqual(plan.cards.map((c) => c.from));
  });

  it('gives each chapter a full-screen card before its first line, and the pill over the app only in the window look', () => {
    const plan = planOf(film, baselineEdl(film));
    expect(plan.cards.map((c) => [c.chapter, +(c.to - c.from).toFixed(2)])).toEqual([
      [1, chapterCardSeconds],
      [2, chapterCardSeconds],
    ]);
    expect(plan.edl.chapters).toEqual([]);
    const screen = plan.spans[1];
    expect(plan.cards[0]?.to).toBeCloseTo(screen?.start ?? 0, 5);
    const windowed = { ...film, steps: film.steps.map(({ scene: _scene, ...step }) => step) };
    expect(planOf(windowed, baselineEdl(windowed)).edl.chapters).toHaveLength(2);
  });

  it('cuts the clicks out of the film look and hides the pointer, so a line shows its shot and not the way there', () => {
    const edl = baselineEdl(film);
    expect(edl.steps.every((s) => !s.showAction && s.cursor === 'hidden')).toBe(true);
    const plan = planOf(film, edl);
    const before = plan.views[Math.round((plan.segments[1]?.at ?? 0) * 60 * 4)];
    const centre = filmStage(film.viewport).window;
    expect(before?.zoom).toBeCloseTo(1, 3);
    expect(before?.x).toBeCloseTo(centre.x + centre.width / 2, 1);
  });

  it('keeps the film look when an edit list asks for the pointer, the way there or chapter pills', () => {
    const base = baselineEdl(film);
    const asked = {
      ...base,
      chapters: [{ at: { step: 2, word: 0 }, title: 'Plattformen i sin helhet' }],
      steps: base.steps.map((s) => ({ ...s, showAction: true, cursor: 'auto' as const })),
    };
    const plan = planOf(film, asked as typeof base);
    expect(plan.edl.chapters).toEqual([]);
    expect(plan.edl.steps.every((s) => !s.showAction && s.cursor === 'hidden')).toBe(true);
    expect(plan.segments.map((s) => s.from)).toEqual(
      planOf(film, base).segments.map((s) => s.from),
    );
  });

  it("times the studio's timeline as the film is cut, chapter cards included", () => {
    const plan = planOf(film, baselineEdl(film));
    const timeline = timelineOf(plan.edl as Parameters<typeof timelineOf>[0], film);
    expect(timeline.length).toBeCloseTo(plan.length, 5);
    expect(timeline.shots.map((s) => s.at)).toEqual(plan.segments.map((s) => s.at));
  });

  it('accents the music on each chapter card', () => {
    const plan = planOf(film, baselineEdl(film));
    const sound = soundPlanOf({ log: { ...film, music: 'pulse' }, voices: '/voices' }, plan);
    for (const card of plan.cards) expect(sound.accents).toContain(card.from);
  });

  it('brings the frame in with the second line of a screen with a question, and never on a screen of one line', () => {
    const asked = (steps: CaptureLog['steps']) => ({ ...film, steps });
    const question = {
      template: 'screen' as const,
      title: 'Tjenestene på ett sted',
      question: 'Hvor er tjenestene?',
    };
    const two = asked(film.steps.map((s, i) => (i === 1 ? { ...s, scene: question } : s)));
    const plan = planOf(two, baselineEdl(two));
    const span = plan.spans[1] as (typeof plan.spans)[number];
    expect(frameStartOf(span, plan.segments)).toBe(plan.segments.find((s) => s.step === 3)?.at);
    const one = { ...span, last: span.first };
    expect(frameStartOf(one, plan.segments)).toBe(one.end);
    expect(
      frameStartOf({ ...span, scene: { template: 'screen', title: 'X' } }, plan.segments),
    ).toBe(span.start);
  });

  it('keeps a step the cut leaves out in the scene before it', () => {
    const skipped = {
      ...film,
      steps: film.steps.map((s, i) => (i === 3 ? { ...s, end: s.start, cue: s.start + 0.2 } : s)),
    };
    const plan = planOf(skipped, baselineEdl(skipped));
    expect(plan.spans.map((s) => [s.scene?.template, s.first, s.last])).toEqual([
      ['title', 0, 0],
      ['screen', 1, 4],
    ]);
  });

  it('zooms less in the frame than in the window when a tall region has to fit', () => {
    const tall = { x: 600, y: 0, width: 200, height: 600 };
    const inFrame = zoomFor(tall, film.viewport, filmStage(film.viewport));
    expect(inFrame).toBeLessThan(zoomFor(tall, film.viewport));
    expect(inFrame * 600 * (filmStage(film.viewport).page.height / 674)).toBeLessThanOrEqual(730);
  });

  it('fits a screen of another shape inside the frame', () => {
    const { page, window } = filmStage([1920, 1080]);
    expect(page.height).toBeCloseTo(window.height, 5);
    expect(page.x).toBeGreaterThanOrEqual(window.x);
    expect(page.x + page.width).toBeLessThanOrEqual(window.x + window.width);
    expect(filmStage([1440, 674]).page.width).toBeCloseTo(window.width, 0);
  });

  it("zooms to a line's focus inside the frame, so the page always fills it", () => {
    const plan = planOf(film, baselineEdl(film));
    const zoomed = plan.views.filter((v) => v.zoom > 1.05);
    expect(zoomed.length).toBeGreaterThan(0);
    const { page, window } = filmStage(film.viewport);
    for (const v of zoomed) {
      expect(v.x - window.width / 2 / v.zoom).toBeGreaterThanOrEqual(page.x - 1);
      expect(v.x + window.width / 2 / v.zoom).toBeLessThanOrEqual(page.x + page.width + 1);
    }
  });
});
