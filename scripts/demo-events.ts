// What the recorder saw: the event log of a capture and the spoken words with their timings.
import { z } from 'zod';
import { sameWord, wordsOf } from './demo-voice.ts';
import type { Box, Point } from './demo-pointer.ts';

export interface Card {
  title: string;
  subtitle?: string;
  presenter?: string;
}

export interface Move {
  at: number;
  seconds: number;
  from: Point;
  to: Point;
}

export interface Click {
  at: number;
  x: number;
  y: number;
}

export interface Landmark {
  kind: string;
  text: string;
  box: Box;
}

export interface Word {
  text: string;
  at: number;
  seconds: number;
}

export interface StepLog {
  say: string;
  start: number;
  navigateAt?: number;
  cue: number;
  end: number;
  voice: { file?: string; seconds: number };
  words: Word[];
  title?: string;
  focus?: Box;
  landmarks: Landmark[];
  moves: Move[];
  clicks: Click[];
  scrolls: { at: number; seconds: number }[];
  chapter?: string;
  hold?: number;
}

export interface CaptureLog {
  viewport: [number, number];
  scale: number;
  seconds: number;
  language: string;
  intro?: Card;
  outro?: Card;
  steps: StepLog[];
}

const time = z.number().finite().min(0).max(36_000);
const coordinate = z.number().finite().min(-100_000).max(100_000);
const text = (max: number) => z.string().max(max);
const point = z.strictObject({ x: coordinate, y: coordinate });
const box = z.strictObject({
  x: coordinate,
  y: coordinate,
  width: coordinate,
  height: coordinate,
});
const card = z.strictObject({
  title: text(200),
  subtitle: text(200).optional(),
  presenter: text(200).optional(),
});

export const voiceFileName = /^[\w-]{1,64}\.mp3$/;

const stepLogSchema = z.strictObject({
  say: text(2000),
  start: time,
  navigateAt: time.optional(),
  cue: time,
  end: time,
  voice: z.strictObject({ file: z.string().regex(voiceFileName).optional(), seconds: time }),
  words: z.array(z.strictObject({ text: text(200), at: time, seconds: time })).max(1000),
  title: text(500).optional(),
  focus: box.optional(),
  landmarks: z.array(z.strictObject({ kind: text(40), text: text(200), box })).max(100),
  moves: z.array(z.strictObject({ at: time, seconds: time, from: point, to: point })).max(1000),
  clicks: z.array(z.strictObject({ at: time, x: coordinate, y: coordinate })).max(1000),
  scrolls: z.array(z.strictObject({ at: time, seconds: time })).max(1000),
  chapter: text(200).optional(),
  hold: time.optional(),
});

export const captureLogSchema = z.strictObject({
  viewport: z.tuple([z.number().int().min(320).max(7680), z.number().int().min(240).max(4320)]),
  scale: z.number().min(1).max(4),
  seconds: time,
  language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/),
  intro: card.optional(),
  outro: card.optional(),
  steps: z.array(stepLogSchema).min(1).max(200),
});

export const parseCaptureLog = (value: unknown) => captureLogSchema.parse(value) as CaptureLog;

export const landmarkScript = `(()=>{const out=[];for(const el of document.querySelectorAll('h1,h2,h3,table,[role=table],[role=grid],section,article,[role=region],form,nav,main,dl,[role=tablist]')){const r=el.getBoundingClientRect();if(r.width<60||r.height<18||r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth)continue;const text=(el.getAttribute('aria-label')||el.innerText||'').trim().replace(/\\s+/g,' ').slice(0,70);out.push({kind:el.tagName.toLowerCase(),text,box:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}});if(out.length>=30)break}return JSON.stringify({title:document.title,landmarks:out})})()`;

export interface Heard {
  text: string;
  offsetMilliseconds: number;
  durationMilliseconds: number;
}

const heardWord = z.object({
  text: z.string().max(200),
  offsetMilliseconds: z.number().min(0).max(3_600_000),
  durationMilliseconds: z.number().min(0).max(3_600_000),
});

export const heardWordsSchema = z.array(heardWord).max(2000);

const transcription = z.object({
  phrases: z
    .array(z.object({ words: z.array(heardWord).max(2000).default([]) }))
    .max(1000)
    .default([]),
});

export const heardWords = (body: unknown): Heard[] =>
  heardWordsSchema.parse(transcription.parse(body).phrases.flatMap((p) => p.words));

export const estimatedWords = (text: string, seconds: number): Word[] => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const weights = words.map((w) => w.length + 2);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  return words.map((w, i) => {
    const length = ((weights[i] ?? 0) / total) * seconds;
    const word = { text: w, at: round(at), seconds: round(length) };
    at += length;
    return word;
  });
};

const round = (n: number) => Math.round(n * 1000) / 1000;

export const alignWords = (text: string, heard: Heard[], seconds: number): Word[] => {
  const written = text.trim().split(/\s+/).filter(Boolean);
  if (!heard.length) return estimatedWords(text, seconds);
  const plain = written.map((w) => wordsOf(w)[0] ?? '');
  const ears = heard.map((h) => wordsOf(h.text)[0] ?? '');
  const n = plain.length;
  const m = ears.length;
  const cost = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) (cost[i] as number[])[0] = i;
  for (let j = 0; j <= m; j++) (cost[0] as number[])[j] = j;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const same = sameWord(plain[i - 1] ?? '', ears[j - 1] ?? '') ? 0 : 1;
      (cost[i] as number[])[j] = Math.min(
        ((cost[i - 1] as number[])[j] ?? 0) + 1,
        ((cost[i] as number[])[j - 1] ?? 0) + 1,
        ((cost[i - 1] as number[])[j - 1] ?? 0) + same,
      );
    }
  const pair = new Array<number | undefined>(n).fill(undefined);
  for (let i = n, j = m; i > 0 && j > 0;) {
    const here = (cost[i] as number[])[j] ?? 0;
    const same = sameWord(plain[i - 1] ?? '', ears[j - 1] ?? '') ? 0 : 1;
    if (here === ((cost[i - 1] as number[])[j - 1] ?? 0) + same) {
      pair[i - 1] = j - 1;
      i--;
      j--;
    } else if (here === ((cost[i - 1] as number[])[j] ?? 0) + 1) i--;
    else j--;
  }
  const words: Word[] = written.map((w, i) => {
    const h = pair[i] === undefined ? undefined : heard[pair[i]];
    return h
      ? { text: w, at: h.offsetMilliseconds / 1000, seconds: h.durationMilliseconds / 1000 }
      : { text: w, at: Number.NaN, seconds: 0 };
  });
  for (let i = 0; i < words.length;) {
    if (!Number.isNaN((words[i] as Word).at)) {
      i++;
      continue;
    }
    const next = words.findIndex((w, k) => k > i && !Number.isNaN(w.at));
    const end = next < 0 ? words.length : next;
    const before = words[i - 1];
    const from = before ? before.at + before.seconds : 0;
    const to = next < 0 ? seconds : (words[next] as Word).at;
    const length = Math.max(0.05, (to - from) / (end - i));
    for (let k = i; k < end; k++)
      Object.assign(words[k] as Word, { at: from + (k - i) * length, seconds: length });
    i = end;
  }
  return words.map((w) => ({ text: w.text, at: round(w.at), seconds: round(w.seconds) }));
};

export const fastTranscriptionUrl = (endpoint: string) => {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    !/\.(cognitiveservices\.azure\.com|openai\.azure\.com)$/.test(url.hostname)
  )
    throw new Error('DEMO_AUDIO_ENDPOINT must be an https Azure AI endpoint');
  return `${url.origin}/speechtotext/transcriptions:transcribe?api-version=2024-11-15`;
};

export const sentencesOf = (words: Word[]) => {
  const sentences: Word[][] = [[]];
  for (const w of words) {
    (sentences.at(-1) as Word[]).push(w);
    if (/[.!?]["»)]?$/.test(w.text)) sentences.push([]);
  }
  return sentences.filter((s) => s.length);
};

export interface TimedLine {
  at: number;
  seconds: number;
  text: string;
}

const pad = (n: number, width = 2) => String(Math.floor(n)).padStart(width, '0');

export const srtTime = (seconds: number) => {
  const ms = Math.round(seconds * 1000);
  return `${pad(ms / 3_600_000)}:${pad((ms / 60_000) % 60)}:${pad((ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

export const subtitles = (lines: TimedLine[]) =>
  lines
    .map((l, i) => `${i + 1}\n${srtTime(l.at)} --> ${srtTime(l.at + l.seconds)}\n${l.text}\n`)
    .join('\n');
