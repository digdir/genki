// Records a narrated demo of genki from demos/<name>.yaml. Run: node scripts/demo.ts demos/<name>.yaml
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export interface DemoStep {
  say: string;
  do?: string[][];
  hold?: number;
}

export interface Demo {
  title: string;
  language: string;
  voice: string;
  viewport?: [number, number];
  start: string;
  steps: DemoStep[];
}

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

const escapeXml = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c,
  );

export const ssml = (text: string, voice: string, language: string) =>
  `<speak version="1.0" xml:lang="${language}"><voice name="${voice}">${escapeXml(text)}</voice></speak>`;

export const mixArgs = (
  video: string,
  clips: { file: string; at: number }[],
  srt: string,
  out: string,
) => {
  const inputs = clips.flatMap((c) => ['-i', c.file]);
  const delays = clips.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`);
  const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0[voice]`;
  return [
    '-y',
    '-i',
    video,
    ...inputs,
    '-i',
    srt,
    '-filter_complex',
    [...delays, mix].join(';'),
    '-map',
    '0:v',
    '-map',
    '[voice]',
    '-map',
    `${clips.length + 1}:s`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-c:s',
    'mov_text',
    '-metadata:s:s:0',
    'language=nor',
    out,
  ];
};

export const languageScript = (language: string) => {
  const tag = /^([a-z]{2,3})(?:-[A-Z]{2})?$/.exec(language);
  if (!tag) throw new Error(`language must be a tag like nb-NO, not ${language}`);
  return `Object.defineProperty(navigator,'languages',{get:()=>['${tag[0]}','${tag[1]}']});Object.defineProperty(navigator,'language',{get:()=>'${tag[0]}'});`;
};

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' });

const speechEndpoint = () => {
  const {
    SPEECH_RESOURCE: name,
    SPEECH_RESOURCE_GROUP: group,
    SPEECH_SUBSCRIPTION: sub,
  } = process.env;
  if (!name || !group || !sub)
    throw new Error(
      'Set SPEECH_RESOURCE, SPEECH_RESOURCE_GROUP and SPEECH_SUBSCRIPTION (see demos/README.md)',
    );
  const endpoint = run('az', [
    'cognitiveservices',
    'account',
    'show',
    '-n',
    name,
    '-g',
    group,
    '--subscription',
    sub,
    '--query',
    'properties.endpoint',
    '-o',
    'tsv',
  ]).trim();
  const token = run('az', [
    'account',
    'get-access-token',
    '--resource',
    'https://cognitiveservices.azure.com',
    '--subscription',
    sub,
    '--query',
    'accessToken',
    '-o',
    'tsv',
  ]).trim();
  return { url: `${endpoint.replace(/\/$/, '')}/tts/cognitiveservices/v1`, token };
};

async function speak(
  text: string,
  demo: Demo,
  dir: string,
  speech: () => { url: string; token: string },
) {
  const file = join(
    dir,
    `${createHash('sha256').update(`${demo.voice}\n${text}`).digest('hex').slice(0, 16)}.mp3`,
  );
  if (!existsSync(file)) {
    const { url, token } = speech();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/ssml+xml',
        'x-microsoft-outputformat': 'audio-24khz-96kbitrate-mono-mp3',
        'user-agent': 'genki-demo',
      },
      body: ssml(text, demo.voice, demo.language),
    });
    if (!res.ok) throw new Error(`Speech answered ${res.status}: ${await res.text()}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const seconds = Number(
    run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]),
  );
  return { file, seconds };
}

const sleep = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));

async function main(path: string) {
  const demo = parse(readFileSync(path, 'utf8')) as Demo;
  const name = basename(path, '.yaml');
  const out = resolve('demos/out', name);
  const cache = resolve('demos/out/.voice');
  mkdirSync(out, { recursive: true });
  mkdirSync(cache, { recursive: true });

  let endpoint: { url: string; token: string } | undefined;
  const speech = () => (endpoint ??= speechEndpoint());
  const clips = [];
  for (const step of demo.steps) clips.push(await speak(step.say, demo, cache, speech));

  const init = join(out, 'language.js');
  writeFileSync(init, languageScript(demo.language));
  const session = `demo-${name}`;
  const ab = (...args: string[]) => run('agent-browser', ['--session', session, ...args]);
  const [w, h] = demo.viewport ?? [1280, 720];
  run('agent-browser', ['--session', session, '--init-script', init, 'open', demo.start]);
  ab('set', 'viewport', String(w), String(h));
  ab('wait', '--load', 'load');

  const raw = join(out, 'raw.webm');
  ab('record', 'start', raw, '--cursor');
  const t0 = Date.now();
  const lines: TimedLine[] = [];
  try {
    demo.steps.forEach((step, i) => {
      const at = (Date.now() - t0) / 1000;
      const clip = clips[i];
      lines.push({ at, seconds: clip.seconds, text: step.say });
      for (const command of step.do ?? []) ab(...command);
      const elapsed = (Date.now() - t0) / 1000 - at;
      sleep((clip.seconds + (step.hold ?? 0.6) - elapsed) * 1000);
    });
  } finally {
    ab('record', 'stop');
    ab('close');
  }

  const srt = join(out, `${name}.srt`);
  writeFileSync(srt, subtitles(lines));
  const mp4 = join(out, `${name}.mp4`);
  run(
    'ffmpeg',
    mixArgs(
      raw,
      clips.map((c, i) => ({ file: c.file, at: lines[i].at })),
      srt,
      mp4,
    ),
  );
  console.log(`${mp4}\n${srt}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: node scripts/demo.ts demos/<name>.yaml');
  await main(path);
}
