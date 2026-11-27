import { describe, expect, it } from 'vitest';
import { baselineEdl, segmentsOf } from './demo-edl.ts';
import { estimatedWords, type CaptureLog } from './demo-events.ts';
import {
  audioArgs,
  captionsOf,
  dipOf,
  encoderArgs,
  maxFontBytes,
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

  it('places each voice line where its shot starts talking, with gentle fades', () => {
    const segments = segmentsOf(baselineEdl(log), log);
    const audio = audioArgs({ log, voices: '/voices' }, { segments, length: 15 }, 2);
    expect(audio.inputs).toEqual(['-i', '/voices/a.mp3']);
    expect(audio.filter[0]).toContain('afade=t=in');
    expect(audio.filter[0]).toContain(`adelay=${Math.round((4.5 + 0.25) * 1000)}`);
    expect(audio.filter.at(-1)).toContain('afade=t=out');
  });

  it('encodes 60 frames a second at full HD with H.264, ready to stream', () => {
    const args = encoderArgs(60, 'x.srt', { inputs: [], filter: [], map: [] }, 'out.mp4', 'nb-NO');
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
    expect(() =>
      audioArgs({ log: outside, voices: '/voices' }, { segments, length: 20 }, 2),
    ).toThrow(/not a plain clip name/);
  });

  it('takes a font only when it is a woff2 file of at most 1 MiB', () => {
    const font = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(100)]);
    expect(woff2Font(font)).toBe(font);
    expect(() => woff2Font(Buffer.from('<html>not a font</html>'))).toThrow(/not a woff2/);
    expect(() => woff2Font(Buffer.concat([font, Buffer.alloc(maxFontBytes)]))).toThrow(/more than/);
  });
});
