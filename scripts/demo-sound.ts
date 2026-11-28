// The film's sound: a generated music bed ducked under the voice, both mixed to loudness targets.
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeRunFile } from './demo-files.ts';

const maxStemBytes = 512 * 1024 * 1024;

export const musicBeds = ['pulse'] as const;
export type MusicBed = (typeof musicBeds)[number];

export const loudnessTargets = { voice: -15, music: -37, musicAlone: -23 };
export const duckDb = -9;
export const sampleRate = 48_000;

export interface Loudness {
  integrated: number;
  peak: number;
}

export interface SoundReport {
  voice?: number;
  music?: number;
  mix: number;
  peak: number;
}

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

const lowpass = (x: Float32Array, cutoff: number, rate = sampleRate) => {
  const w = (2 * Math.PI * cutoff) / rate;
  const alpha = Math.sin(w) / Math.SQRT2;
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i] ?? 0;
    const y0 = b0 * x0 + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
};

const place = (track: Float32Array, at: number, clip: Float32Array, gain: number) => {
  const from = Math.round(at * sampleRate);
  for (let i = 0; i < clip.length && from + i < track.length; i++)
    if (from + i >= 0) track[from + i] = (track[from + i] ?? 0) + (clip[i] ?? 0) * gain;
};

const tone = (frequency: number, seconds: number, harmonics: number, decay: number) => {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * frequency * h * t) / h;
    out[i] = v * Math.exp(-t * decay) * Math.min(1, t / 0.004);
  }
  return out;
};

const thump = (seconds: number, from: number, drop: number, fall: number, decay: number) => {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    phase += (2 * Math.PI * (from + drop * Math.exp(-t * fall))) / sampleRate;
    out[i] = Math.sin(phase) * Math.exp(-t * decay);
  }
  return out;
};

const noiseOf = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
};

export const pulseBed = (seconds: number, kickFrom: number, accents: readonly number[]) => {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const beat = 60 / 100;
  const chords = [
    [38, 62, 65, 69],
    [34, 58, 62, 65],
    [41, 60, 65, 69],
    [36, 60, 64, 67],
  ];
  const bass = new Float32Array(n);
  const arp = new Float32Array(n);
  const kick = new Float32Array(n);
  const hats = new Float32Array(n);
  const noise = noiseOf(7);
  const end = seconds - 2.5;
  for (let k = 0; (k * beat) / 4 < end; k++) {
    const at = (k * beat) / 4;
    const chord = chords[Math.floor(at / (beat * 8)) % chords.length] as number[];
    if (k % 2 === 0)
      place(bass, at, tone(midi(chord[0] ?? 38), beat * 0.45, 5, 9), k % 4 === 0 ? 0.5 : 0.36);
    const note = (chord[1 + (Math.floor((k * 5) / 3) % 3)] ?? 62) + (k % 8 === 6 ? 12 : 0);
    place(arp, at, tone(midi(note), 0.22, 3, 16), 0.09);
    if (k % 4 === 0 && at >= kickFrom) place(kick, at, thump(0.32, 44, 70, 28, 10), 0.8);
    if (k % 4 === 2 && at >= 1.2) {
      const m = Math.round(0.05 * sampleRate);
      const hat = new Float32Array(m);
      let last = noise();
      for (let i = 0; i < m; i++) {
        const next = noise();
        hat[i] = (next - last) * Math.exp((-i / sampleRate) * 70);
        last = next;
      }
      place(hats, at, hat, 0.05);
    }
  }
  for (const a of accents) place(kick, a, thump(2.2, 36, 30, 6, 2.2), 0.9);
  const lowBass = lowpass(bass, 520);
  const softArp = lowpass(arp, 2400);
  const lowKick = lowpass(kick, 180);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const pump = t >= kickFrom ? 1 - 0.45 * Math.exp(-((t - kickFrom) % beat) * 9) : 1;
    const env = Math.min(1, t / 1.2) * Math.min(1, Math.max(0, (seconds - t) / 2.5));
    const b = (lowBass[i] ?? 0) * pump;
    const a = (softArp[i] ?? 0) * pump;
    const k = lowKick[i] ?? 0;
    const h = hats[i] ?? 0;
    left[i] = (b + k + h * 0.8 + a * 1.15) * env;
    right[i] = (b + k + h * 1.2 + a * 0.85) * env;
  }
  return [left, right] as const;
};

const boxSmooth = (x: Float32Array, seconds: number) => {
  const k = Math.max(1, Math.round(seconds * sampleRate));
  const half = Math.floor(k / 2);
  const sums = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sums[i + 1] = (sums[i] ?? 0) + (x[i] ?? 0);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(x.length, i + half);
    out[i] = ((sums[hi] ?? 0) - (sums[lo] ?? 0)) / k;
  }
  return out;
};

export const duckGain = (talk: readonly [number, number][], seconds: number, db = duckDb) => {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const mask = new Float32Array(n);
  for (const [from, to] of talk)
    for (let i = Math.max(0, Math.round(from * sampleRate)); i < Math.min(n, to * sampleRate); i++)
      mask[i] = 1;
  const held = boxSmooth(boxSmooth(mask, 0.35), 0.35);
  return held.map((v) => 10 ** ((db * Math.min(1, v * 1.6)) / 20));
};

export const wavOf = (channels: readonly Float32Array[], rate = sampleRate) => {
  const n = channels[0]?.length ?? 0;
  const count = channels.length;
  const data = Buffer.alloc(n * count * 2);
  let peak = 0;
  for (const c of channels) for (const v of c) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0.5 ? 0.5 / peak : 1;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < count; c++) {
      const v = Math.max(-1, Math.min(1, (channels[c]?.[i] ?? 0) * scale));
      data.writeInt16LE(Math.round(v * 32767), (i * count + c) * 2);
    }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(count, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * count * 2, 28);
  head.writeUInt16LE(count * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
};

export const parseLoudness = (ffmpegLog: string): Loudness => {
  const summary = ffmpegLog.slice(ffmpegLog.lastIndexOf('Summary:'));
  const integrated = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1];
  const peak = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1];
  if (integrated === undefined) throw new Error('ffmpeg ebur128 printed no integrated loudness');
  const value = (s: string | undefined) =>
    s === undefined || s === '-inf' ? -Infinity : Number(s);
  return { integrated: value(integrated), peak: value(peak) };
};

export const reported = (db: number) => Math.max(-120, Math.round(db * 10) / 10);

export const loudnessArgs = (file: string) => [
  '-hide_banner',
  '-nostats',
  '-i',
  file,
  '-af',
  'ebur128=peak=true:framelog=verbose',
  '-f',
  'null',
  '-',
];

const measure = (file: string) => {
  const run = spawnSync('ffmpeg', loudnessArgs(file), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`ffmpeg could not measure ${file}`);
  return parseLoudness(run.stderr);
};

export const gainTo = (measured: number, target: number) =>
  Number.isFinite(measured) ? Math.max(-40, Math.min(40, target - measured)) : 0;

export interface VoiceClip {
  file: string;
  at: number;
  seconds: number;
}

export const voiceStemArgs = (clips: readonly VoiceClip[], length: number, out: string) => [
  '-y',
  '-loglevel',
  'error',
  ...clips.flatMap((c) => ['-i', c.file]),
  '-filter_complex',
  [
    ...clips.map(
      (c, i) =>
        `[${i}:a]aresample=${sampleRate},aformat=channel_layouts=mono,afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, c.seconds - 0.08).toFixed(3)}:d=0.08,adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`,
    ),
    `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,apad,atrim=0:${length.toFixed(3)},acompressor=threshold=-24dB:ratio=2.5:attack=8:release=120:makeup=1[voice]`,
  ].join(';'),
  '-map',
  '[voice]',
  '-ar',
  String(sampleRate),
  '-ac',
  '2',
  out,
];

export const mixArgs = (stems: { file: string; gainDb: number }[], length: number, out: string) => [
  '-y',
  '-loglevel',
  'error',
  ...stems.flatMap((s) => ['-i', s.file]),
  '-filter_complex',
  [
    ...stems.map((s, i) => `[${i}:a]volume=${s.gainDb.toFixed(2)}dB[s${i}]`),
    `${stems.map((_, i) => `[s${i}]`).join('')}amix=inputs=${stems.length}:normalize=0,atrim=0:${length.toFixed(3)},afade=t=out:st=${Math.max(0, length - 1.2).toFixed(3)}:d=1.2,alimiter=limit=0.89:attack=2:release=50:level=false[mix]`,
  ].join(';'),
  '-map',
  '[mix]',
  '-ar',
  String(sampleRate),
  '-ac',
  '2',
  out,
];

export interface SoundPlan {
  clips: VoiceClip[];
  talk: [number, number][];
  length: number;
  music?: MusicBed;
  kickFrom: number;
  accents: number[];
}

export const mixSound = (plan: SoundPlan, dir: string) => {
  const stems: { file: string; gainDb: number; kind: 'voice' | 'music' }[] = [];
  if (plan.clips.length) {
    const file = join(dir, 'voice-stem.wav');
    execFileSync('ffmpeg', voiceStemArgs(plan.clips, plan.length, file), { stdio: 'ignore' });
    stems.push({
      file,
      gainDb: gainTo(measure(file).integrated, loudnessTargets.voice),
      kind: 'voice',
    });
  }
  if (plan.music) {
    const [left, right] = pulseBed(plan.length, plan.kickFrom, plan.accents);
    const duck = plan.clips.length ? duckGain(plan.talk, plan.length) : undefined;
    if (duck)
      for (let i = 0; i < left.length; i++) {
        left[i] = (left[i] ?? 0) * (duck[i] ?? 1);
        right[i] = (right[i] ?? 0) * (duck[i] ?? 1);
      }
    const file = join(dir, 'music-stem.wav');
    writeRunFile(dir, 'music-stem.wav', wavOf([left, right]), maxStemBytes);
    const target = plan.clips.length ? loudnessTargets.music : loudnessTargets.musicAlone;
    stems.push({ file, gainDb: gainTo(measure(file).integrated, target), kind: 'music' });
  }
  if (!stems.length) return undefined;
  const file = join(dir, 'mix.wav');
  execFileSync('ffmpeg', mixArgs(stems, plan.length, file), { stdio: 'ignore' });
  const level = (kind: 'voice' | 'music') => {
    const stem = stems.find((s) => s.kind === kind);
    if (!stem) return undefined;
    const one = join(dir, `${kind}-level.wav`);
    execFileSync('ffmpeg', mixArgs([stem], plan.length, one), { stdio: 'ignore' });
    return reported(measure(one).integrated);
  };
  const mix = measure(file);
  const voice = level('voice');
  const music = level('music');
  const report: SoundReport = {
    ...(voice !== undefined ? { voice } : {}),
    ...(music !== undefined ? { music } : {}),
    mix: reported(mix.integrated),
    peak: reported(mix.peak),
  };
  return { file, report };
};
