import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  duckDb,
  duckGain,
  gainTo,
  loudnessTargets,
  mixArgs,
  mixSound,
  parseLoudness,
  reported,
  pulseBed,
  sampleRate,
  voiceStemArgs,
  wavOf,
} from './demo-sound.ts';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const ebur128Log = `[Parsed_ebur128_0 @ 0x1] t: 1.2 TARGET:-23 LUFS M: -20.1
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -15.3 LUFS
    Threshold: -25.4 LUFS

  Loudness range:
    LRA:         4.1 LU

  True peak:
    Peak:       -1.6 dBFS
`;

const at = (seconds: number) => Math.round(seconds * sampleRate);

describe('the film sound', () => {
  it('reads the integrated loudness and the true peak from ffmpeg ebur128', () => {
    expect(parseLoudness(ebur128Log)).toEqual({ integrated: -15.3, peak: -1.6 });
    expect(parseLoudness('Summary:\n I: -inf LUFS\n Peak: -inf dBFS')).toEqual({
      integrated: -Infinity,
      peak: -Infinity,
    });
    expect(() => parseLoudness('nothing measured')).toThrow(/no integrated loudness/);
  });

  it('reports silence as -120, the lowest level a recording keeps', () => {
    expect(reported(-Infinity)).toBe(-120);
    expect(reported(-15.34)).toBe(-15.3);
  });

  it('aims the voice at -15 LUFS and the music at -37 LUFS, and louder music when there is no voice', () => {
    expect(loudnessTargets).toEqual({ voice: -15, music: -37, musicAlone: -23 });
    expect(gainTo(-21, loudnessTargets.voice)).toBe(6);
    expect(gainTo(-Infinity, loudnessTargets.music)).toBe(0);
    expect(gainTo(-200, 0)).toBe(40);
  });

  it('ducks the music by about 9 dB while the voice speaks and leaves it whole in the gaps', () => {
    const gain = duckGain([[2, 5]], 8);
    const db = (i: number) => 20 * Math.log10(gain[i] ?? 1);
    expect(db(at(3.5))).toBeCloseTo(duckDb, 1);
    expect(db(at(0.5))).toBeCloseTo(0, 3);
    expect(db(at(7.5))).toBeCloseTo(0, 3);
    expect(db(at(1.9))).toBeLessThan(0);
    expect(db(at(1.9))).toBeGreaterThan(duckDb);
  });

  it('generates the same music bed every time, so a film sounds the same when rendered again', () => {
    const [a] = pulseBed(6, 1, [2]);
    const [b] = pulseBed(6, 1, [2]);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    expect(a.some((v) => Math.abs(v) > 0.01)).toBe(true);
    expect(Math.abs(a[0] ?? 1)).toBeLessThan(1e-3);
  });

  it('writes the bed as 16-bit stereo PCM with headroom', () => {
    const wav = wavOf([new Float32Array([0, 2, -2]), new Float32Array([0, 1, -1])]);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(sampleRate);
    expect(wav.readInt16LE(44 + 4)).toBe(Math.round(0.5 * 32767));
  });

  it('places each voice clip at its time and hands ffmpeg only the files it was given', () => {
    const args = voiceStemArgs([{ file: '/voices/a.mp3', at: 4.75, seconds: 9 }], 15, 'v.wav');
    expect(args.filter((a, i) => args[i - 1] === '-i')).toEqual(['/voices/a.mp3']);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('adelay=4750:all=1');
    expect(graph).toContain('afade=t=in');
    expect(mixArgs([{ file: 'v.wav', gainDb: 6 }], 15, 'm.wav').join(' ')).toContain(
      'volume=6.00dB',
    );
  });

  it.skipIf(!hasFfmpeg)(
    'mixes the voice to about -15 LUFS and the ducked music to about -37 LUFS, measured with ebur128',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'genki-sound-'));
      const voice = join(dir, 'line.wav');
      execFileSync('ffmpeg', [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:sample_rate=48000:duration=4',
        '-af',
        'volume=-30dB',
        voice,
      ]);
      const sound = mixSound(
        {
          clips: [{ file: voice, at: 2, seconds: 4 }],
          talk: [[2, 6]],
          length: 10,
          music: 'pulse',
          kickFrom: 0,
          accents: [0],
        },
        dir,
      );
      expect(sound?.report.voice).toBeGreaterThan(-16.5);
      expect(sound?.report.voice).toBeLessThan(-13.5);
      expect(sound?.report.music).toBeGreaterThan(-38.5);
      expect(sound?.report.music).toBeLessThan(-35.5);
      expect(sound?.report.peak).toBeLessThan(0);
      expect(readFileSync(sound?.file ?? '').length).toBeGreaterThan(44);
    },
    30_000,
  );
});
