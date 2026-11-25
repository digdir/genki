// Records narrated demos of genki from demos/<name>.yaml; see demos/README.md.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { portalClientIdOf } from './smoke/run.ts';

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
  signedIn?: boolean;
  ready?: string;
  steps: DemoStep[];
}

export interface TimedLine {
  at: number;
  seconds: number;
  text: string;
}

export interface Clip {
  file?: string;
  seconds: number;
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

const languageTag = /^([a-z]{2,3})(?:-[A-Z]{2})?$/;

export const subtitleLanguage = (language: string) =>
  ({ nb: 'nob', nn: 'nno', no: 'nor', en: 'eng' })[languageTag.exec(language)?.[1] ?? ''] ?? 'und';

export const mixArgs = (
  video: string,
  clips: { file: string; at: number }[],
  srt: string,
  out: string,
  language = 'nb-NO',
) => {
  const encode = [
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:s',
    'mov_text',
    '-metadata:s:s:0',
    `language=${subtitleLanguage(language)}`,
    out,
  ];
  if (clips.length === 0)
    return [
      '-y',
      '-loglevel',
      'error',
      '-i',
      video,
      '-i',
      srt,
      '-map',
      '0:v',
      '-map',
      '1:s',
      ...encode,
    ];
  const inputs = clips.flatMap((c) => ['-i', c.file]);
  const delays = clips.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`);
  const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0[voice]`;
  return [
    '-y',
    '-loglevel',
    'error',
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
    '-c:a',
    'aac',
    ...encode,
  ];
};

export const posterArgs = (video: string, out: string, at = 2) => [
  '-y',
  '-loglevel',
  'error',
  '-ss',
  String(at),
  '-i',
  video,
  '-frames:v',
  '1',
  '-vf',
  'scale=640:-2',
  '-q:v',
  '4',
  out,
];

export const scriptLiteral = (value: unknown) =>
  JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

export const languageScript = (language: string) => {
  const tag = languageTag.exec(language);
  if (!tag) throw new Error(`language must be a tag like nb-NO, not ${language}`);
  return `Object.defineProperty(navigator,'languages',{get:()=>${scriptLiteral([tag[0], tag[1]])}});Object.defineProperty(navigator,'language',{get:()=>${scriptLiteral(tag[0])}});`;
};

const clientId = /^[\w.-]{1,128}$/;

export const demoSessions = (
  key: string,
  apps: { portal: string; console: string; portalClientId: string; tenant: string },
  now: number,
): Record<string, [string, string]> => {
  if (!clientId.test(apps.portalClientId))
    throw new Error('the portal config has a client id that is not a plain name');
  return {
    [new URL(apps.portal).origin]: [
      `${apps.portalClientId}.session`,
      JSON.stringify({
        name: 'Demo',
        organisations: [{ orgNumber: apps.tenant, name: 'Demo' }],
        token: key,
        expiresAt: now + 3_600_000,
      }),
    ],
    [new URL(apps.console).origin]: [
      'console.session',
      JSON.stringify({ name: 'Demo', roles: ['GenAI.Operator'], token: key }),
    ],
  };
};

export const sessionScript = (sessions: Record<string, [string, string]>) =>
  `(()=>{const s=${scriptLiteral(sessions)}[location.origin];if(s&&!sessionStorage.getItem(s[0]))sessionStorage.setItem(s[0],s[1]);})();`;

export const browserCommands = [
  'find',
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'keyboard',
  'hover',
  'focus',
  'select',
  'check',
  'uncheck',
  'scroll',
  'scrollintoview',
  'wait',
  'open',
  'back',
  'forward',
  'reload',
  'pushstate',
] as const;

export const commandFlags = ['--name', '--exact', '--text', '--timeout', '--load', '--url'];

const flagsAllowed = (command: string[]) =>
  command.slice(1).every((p) => !p.startsWith('-') || commandFlags.includes(p));

const retried = new Set([
  'find',
  'click',
  'dblclick',
  'fill',
  'type',
  'hover',
  'focus',
  'select',
  'check',
  'uncheck',
  'scrollintoview',
]);

const isHttps = (value: unknown) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');
  } catch {
    return false;
  }
};

export const parseDemo = (text: string, source = 'demo'): Demo => {
  const raw = parse(text) as Record<string, unknown> | null;
  const problems: string[] = [];
  const fail = (problem: string) => problems.push(problem);
  if (!raw || typeof raw !== 'object') throw new Error(`${source}: not a YAML mapping`);
  const known = ['title', 'language', 'voice', 'viewport', 'start', 'signedIn', 'ready', 'steps'];
  for (const key of Object.keys(raw)) if (!known.includes(key)) fail(`unknown field ${key}`);
  if (typeof raw.title !== 'string' || !raw.title.trim()) fail('title is missing');
  if (typeof raw.language !== 'string' || !languageTag.test(raw.language))
    fail('language must be a tag like nb-NO');
  if (typeof raw.voice !== 'string' || !/^[A-Za-z0-9-]+$/.test(raw.voice))
    fail('voice must be a voice name like nb-NO-PernilleNeural');
  if (
    raw.viewport !== undefined &&
    !(
      Array.isArray(raw.viewport) &&
      raw.viewport.length === 2 &&
      raw.viewport.every((n) => Number.isInteger(n) && n >= 320 && n <= 3840)
    )
  )
    fail('viewport must be [width, height] in pixels');
  if (!isHttps(raw.start)) fail('start must be an https or localhost URL');
  if (raw.signedIn !== undefined && typeof raw.signedIn !== 'boolean')
    fail('signedIn must be true or false');
  if (raw.ready !== undefined && (typeof raw.ready !== 'string' || !raw.ready.trim()))
    fail('ready must be a text on the start page');
  const steps = Array.isArray(raw.steps) ? (raw.steps as unknown[]) : [];
  if (steps.length === 0) fail('steps must list at least one step');
  steps.forEach((value, i) => {
    const at = `step ${i + 1}`;
    const step = (value ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(step))
      if (!['say', 'do', 'hold'].includes(key)) fail(`${at}: unknown field ${key}`);
    if (typeof step.say !== 'string' || !step.say.trim()) fail(`${at}: say is missing`);
    if (
      step.hold !== undefined &&
      !(typeof step.hold === 'number' && step.hold >= 0 && step.hold <= 10)
    )
      fail(`${at}: hold must be 0 to 10 seconds`);
    if (step.do === undefined) return;
    if (!Array.isArray(step.do)) return fail(`${at}: do must be a list of commands`);
    step.do.forEach((command: unknown, j) => {
      const where = `${at}, command ${j + 1}`;
      if (
        !Array.isArray(command) ||
        command.length === 0 ||
        !command.every((p) => typeof p === 'string' || typeof p === 'number')
      )
        return fail(`${where}: must be a list like [find, role, link, click, --name, Tjenester]`);
      const name = String(command[0]);
      if (!(browserCommands as readonly string[]).includes(name))
        return fail(`${where}: ${name} is not one of ${browserCommands.join(', ')}`);
      if (name === 'open' && !isHttps(command[1]))
        fail(`${where}: open needs an https or localhost URL`);
      command.forEach((p, k) => (command[k] = String(p)));
      if (!flagsAllowed(command as string[]))
        fail(`${where}: takes only the flags ${commandFlags.join(', ')}`);
    });
  });
  if (problems.length) throw new Error(`${source}:\n  ${problems.join('\n  ')}`);
  return raw as unknown as Demo;
};

export const estimateSeconds = (text: string) => Math.max(1, text.trim().split(/\s+/).length / 2.5);

export const estimateDemo = (demo: Demo) =>
  demo.steps.reduce(
    (sum, s) => sum + estimateSeconds(s.say) + (s.hold ?? 0.6) + (s.do?.length ?? 0) * 0.5,
    0,
  );

export const retrying = <T>(
  attempt: () => T,
  timeoutMs: number,
  now: () => number = Date.now,
  pause: (ms: number) => void = sleep,
) => {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      return attempt();
    } catch (error) {
      if (now() >= deadline) throw error;
      pause(500);
    }
  }
};

const firstLine = (error: unknown) =>
  (
    String((error as { stderr?: unknown }).stderr ?? '').trim() ||
    (error instanceof Error ? error.message : String(error))
  ).split('\n')[0];

export class StepFailure extends Error {
  readonly step: number;
  readonly command: string[] | undefined;
  readonly why: string;

  constructor(message: string, step: number, command?: string[], why = message) {
    super(message);
    this.step = step;
    this.command = command;
    this.why = why;
  }
}

export class Cancelled extends Error {}
export class RecordingOpen extends Error {}

export const stepFailure = (index: number, step: DemoStep, command: string[], error: unknown) =>
  new StepFailure(
    `Step ${index + 1} («${step.say.slice(0, 60)}») failed on: ${command.join(' ')}\n  ${firstLine(error)}`,
    index + 1,
    command,
    firstLine(error),
  );

export const readyFailure = (demo: Demo, error: unknown) =>
  new StepFailure(
    `The start page ${demo.start} never showed «${demo.ready ?? ''}»\n  ${firstLine(error)}`,
    0,
    ['wait', '--text', demo.ready ?? ''],
    firstLine(error),
  );

export interface DemoResult {
  name: string;
  outcome: 'recorded' | 'skipped' | 'failed';
  reason?: string;
}

export const runStep = (
  step: DemoStep,
  index: number,
  browser: (...args: string[]) => unknown,
  timeoutMs = 15_000,
  now: () => number = Date.now,
  pause: (ms: number) => void = sleep,
) => {
  for (const command of step.do ?? []) {
    if (
      !(browserCommands as readonly string[]).includes(command[0] ?? '') ||
      !flagsAllowed(command)
    )
      throw stepFailure(index, step, command, new Error('the command is not allowed'));
    try {
      if (retried.has(command[0] ?? '')) retrying(() => browser(...command), timeoutMs, now, pause);
      else browser(...command);
    } catch (error) {
      throw stepFailure(index, step, command, error);
    }
  }
};

export const pickDemos = (dir: string, only?: string, files: string[] = []) => {
  if (files.length) return files;
  if (only) {
    if (!/^[a-z0-9-]+$/.test(only)) throw new Error(`No demo called ${only}`);
    const file = join(dir, `${only}.yaml`);
    if (!readdirSync(dir).includes(`${only}.yaml`)) throw new Error(`No demo called ${only}`);
    return [file];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => join(dir, f));
};

const commandTimeoutMs = 180_000;

const run = (cmd: string, args: string[], timeout = commandTimeoutMs) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });

const speechConfigured = () =>
  Boolean(
    (process.env.SPEECH_ENDPOINT && process.env.IDENTITY_ENDPOINT) ||
    (process.env.SPEECH_RESOURCE &&
      process.env.SPEECH_RESOURCE_GROUP &&
      process.env.SPEECH_SUBSCRIPTION),
  );

export const managedIdentityTokenUrl = (endpoint: string) => {
  const url = new URL(endpoint);
  url.searchParams.set('resource', 'https://cognitiveservices.azure.com');
  url.searchParams.set('api-version', '2019-08-01');
  return url.toString();
};

const speechEndpoint = async () => {
  const {
    SPEECH_ENDPOINT: direct,
    IDENTITY_ENDPOINT: identity,
    IDENTITY_HEADER: secret,
  } = process.env;
  if (direct && identity) {
    const res = await fetch(managedIdentityTokenUrl(identity), {
      headers: { 'x-identity-header': secret ?? '' },
    });
    if (!res.ok) throw new Error(`The managed identity answered ${res.status}`);
    const { access_token: token } = (await res.json()) as { access_token: string };
    return { url: `${direct.replace(/\/$/, '')}/tts/cognitiveservices/v1`, token };
  }
  return speechFromCli();
};

const speechFromCli = () => {
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

export const cached = (file: string) => {
  try {
    return readFileSync(file).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

export const keep = (file: string, data: Buffer) => {
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, data);
  renameSync(part, file);
};

export const clipFile = (dir: string, voice: string, text: string) =>
  join(dir, `${createHash('sha256').update(`${voice}\n${text}`).digest('hex').slice(0, 16)}.mp3`);

type Speech = () => Promise<{ url: string; token: string }>;

async function speak(
  text: string,
  demo: Pick<Demo, 'voice' | 'language'>,
  dir: string,
  speech: Speech,
) {
  const file = clipFile(dir, demo.voice, text);
  if (!cached(file)) {
    const { url, token } = await speech();
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
    if (!res.ok) throw new Error(`Speech answered ${res.status}`);
    keep(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

const duration = (file: string) =>
  Number(
    run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]),
  );

export const narrationOf = (demo: Demo, dir: string, canSpeak: boolean) =>
  canSpeak || demo.steps.every((s) => cached(clipFile(dir, demo.voice, s.say)));

const sleep = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
};

const cacheDir = () => resolve('demos/out/.voice');

const speechOnce = (): Speech => {
  let endpoint: Promise<{ url: string; token: string }> | undefined;
  return () => (endpoint ??= speechEndpoint());
};

export const sampleLineOf = (language: string) =>
  language.startsWith('en-')
    ? 'Hi! This is the voice that reads the demos in genki.'
    : 'Hei! Det er denne stemmen som leser demoene i genki.';

async function voice(path: string) {
  const demo = parseDemo(readFileSync(path, 'utf8'), path);
  const cache = cacheDir();
  mkdirSync(cache, { recursive: true });
  const speech = speechOnce();
  for (const step of demo.steps) await speak(step.say, demo, cache, speech);
  await speak(sampleLineOf(demo.language), demo, cache, speech);
  console.log(`${basename(path)}: ${demo.steps.length} lines voiced`);
}

export interface QueuedNarration {
  id: string;
  demo: string;
  voice: string;
  language: string;
  lines: string[];
}

export const queuedFile = () => resolve('demos/out/queued.json');

const recordingId = /^[0-9a-f-]{36}$/;

export const queuedOf = async (
  api: string,
  key: string,
  send: typeof fetch = fetch,
): Promise<QueuedNarration[]> => {
  const base = api.replace(/\/$/, '');
  const headers = { 'x-recorder-key': key };
  const res = await send(`${base}/recorder/recordings?status=queued`, { headers });
  if (!res.ok) throw new Error(`The queued recordings answered ${res.status}`);
  const { data } = (await res.json()) as { data: { id: string }[] };
  const queued: QueuedNarration[] = [];
  for (const { id } of data.filter((r) => recordingId.test(r.id))) {
    const one = await send(`${base}/recorder/recordings/${id}`, { headers });
    if (!one.ok) {
      console.error(`The recording ${id} answered ${one.status}, so it is left for the next run`);
      continue;
    }
    const stored = (await one.json()) as StoredRecording & { status?: string };
    if (stored.status !== undefined && stored.status !== 'queued') continue;
    const demo = demoOfRecording(stored, {});
    queued.push({
      id,
      demo: stored.demo,
      voice: demo.voice,
      language: demo.language,
      lines: stored.upTo ? [] : demo.steps.map((s) => s.say),
    });
  }
  return queued;
};

const readQueued = () =>
  (JSON.parse(readFileSync(queuedFile(), 'utf8')) as QueuedNarration[]).filter((q) =>
    recordingId.test(q.id),
  );

async function voiceQueued() {
  const cache = cacheDir();
  mkdirSync(cache, { recursive: true });
  const speech = speechOnce();
  for (const queued of readQueued().filter((q) => q.lines.length > 0)) {
    for (const line of queued.lines) await speak(line, queued, cache, speech);
    await speak(sampleLineOf(queued.language), queued, cache, speech);
    console.log(`${queued.demo}: ${queued.lines.length} lines voiced`);
  }
}

export interface RecordingFinish {
  status: 'recorded' | 'failed';
  seconds?: number;
  failure?: { step: number; command?: string; message: string };
}

export interface Library {
  start(name: string, narrated: boolean, recording?: string): Promise<string>;
  upload(recording: string, name: string, file: string): Promise<void>;
  finish(recording: string, body: RecordingFinish): Promise<void>;
}

export const libraryOf = (
  api: string,
  key: string,
  send: typeof fetch = fetch,
  read: (file: string) => Buffer = readFileSync,
): Library => {
  const base = api.replace(/\/$/, '');
  let version: Promise<string> | undefined;
  const genkiVersion = () =>
    (version ??= send(`${base}/health`).then(async (res) =>
      res.ok ? ((await res.json()) as { version: string }).version : 'unknown',
    ));
  const call = async (method: string, path: string, body?: BodyInit, type?: string) => {
    const res = await send(`${base}${path}`, {
      method,
      headers: { 'x-recorder-key': key, ...(type ? { 'content-type': type } : {}) },
      ...(body === undefined ? {} : { body }),
    });
    if (res.status === 409) {
      const problem = (await res.json().catch(() => ({}))) as { type?: string };
      if (problem.type === 'urn:genai:problem:recording-open')
        throw new RecordingOpen(`${path} answered 409: another recording of the demo is open`);
      throw new Cancelled(`${path} answered 409: the recording has ended`);
    }
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
    return res;
  };
  return {
    start: async (name, narrated, recording) => {
      const res = await call(
        'POST',
        `/recorder/demos/${encodeURIComponent(name)}/recordings`,
        JSON.stringify({
          genkiVersion: await genkiVersion(),
          narrated,
          ...(recording ? { recording } : {}),
        }),
        'application/json',
      );
      return ((await res.json()) as { id: string }).id;
    },
    upload: async (recording, name, file) => {
      await call(
        'PUT',
        `/recorder/recordings/${encodeURIComponent(recording)}/files/${encodeURIComponent(name)}`,
        new Uint8Array(read(file)),
        'application/octet-stream',
      );
    },
    finish: async (recording, body) => {
      await call(
        'POST',
        `/recorder/recordings/${encodeURIComponent(recording)}/finish`,
        JSON.stringify(body),
        'application/json',
      );
    },
  };
};

const libraryFromEnv = (env: NodeJS.ProcessEnv) =>
  env.DEMO_RECORDER_KEY && env.DEMO_API_URL
    ? libraryOf(env.DEMO_API_URL, env.DEMO_RECORDER_KEY)
    : undefined;

export const appBases = (env: NodeJS.ProcessEnv) => ({
  portal: env.DEMO_PORTAL_URL || 'https://portal.genki-test.digdir.cloud',
  console: env.DEMO_CONSOLE_URL || 'https://console.genki-test.digdir.cloud',
  workspace: env.DEMO_WORKSPACE_URL || 'https://workspace.genki-test.digdir.cloud',
});

export interface StoredRecording {
  id: string;
  demo: string;
  upTo?: number;
  demoSpec: Omit<Demo, 'start'> & { app: 'portal' | 'console' | 'workspace'; path: string };
  settings: { viewport: [number, number]; tenant: string | null };
}

export const demoOfRecording = (stored: StoredRecording, env: NodeJS.ProcessEnv): Demo => {
  const { app, path, ...rest } = stored.demoSpec;
  const steps = stored.upTo ? rest.steps.slice(0, stored.upTo) : rest.steps;
  return {
    title: rest.title,
    language: rest.language,
    voice: rest.voice,
    viewport: rest.viewport ?? stored.settings.viewport,
    start: `${appBases(env)[app].replace(/\/$/, '')}${path}`,
    ...(rest.signedIn !== undefined ? { signedIn: rest.signedIn } : {}),
    ...(rest.ready !== undefined ? { ready: rest.ready } : {}),
    steps,
  };
};

export const failureOf = (error: unknown): RecordingFinish['failure'] =>
  error instanceof StepFailure
    ? {
        step: error.step,
        ...(error.command ? { command: JSON.stringify(error.command).slice(0, 1000) } : {}),
        message: error.why.slice(0, 2000),
      }
    : { step: 0, message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };

interface Reporting {
  library: Library;
  recording?: string;
  tenant?: string | null;
}

async function record(path: string, silent: boolean): Promise<DemoResult> {
  const demo = parseDemo(readFileSync(path, 'utf8'), path);
  const library = libraryFromEnv(process.env);
  return recordDemo(demo, basename(path, '.yaml'), silent, library ? { library } : undefined);
}

async function recordStored(id: string, silent: boolean): Promise<DemoResult> {
  const env = process.env;
  const library = libraryFromEnv(env);
  if (!library || !env.DEMO_API_URL || !env.DEMO_RECORDER_KEY)
    throw new Error('Set DEMO_API_URL and DEMO_RECORDER_KEY to record a queued recording');
  const res = await fetch(
    `${env.DEMO_API_URL.replace(/\/$/, '')}/recorder/recordings/${encodeURIComponent(id)}`,
    { headers: { 'x-recorder-key': env.DEMO_RECORDER_KEY } },
  );
  if (!res.ok) throw new Error(`The recording ${id} answered ${res.status}`);
  const stored = (await res.json()) as StoredRecording;
  return recordDemo(demoOfRecording(stored, env), stored.demo, silent || Boolean(stored.upTo), {
    library,
    recording: stored.id,
    tenant: stored.settings.tenant,
  });
}

export async function recordDemo(
  demo: Demo,
  name: string,
  silent: boolean,
  reporting?: Reporting,
): Promise<DemoResult> {
  const env = process.env;
  const key = env.DEMO_API_KEY || undefined;
  if (demo.signedIn && !key) {
    const why = 'needs DEMO_API_KEY to sign in';
    if (reporting?.recording) {
      const { library } = reporting;
      const started = await library.start(name, false, reporting.recording).catch(() => undefined);
      if (started)
        await library.finish(started, { status: 'failed', failure: { step: 0, message: why } });
      console.error(`${name}: failed, it ${why}`);
      return { name, outcome: 'failed', reason: why };
    }
    console.log(`${name}: skipped, it ${why}`);
    return { name, outcome: 'skipped', reason: why };
  }
  const out = resolve('demos/out', name);
  const cache = cacheDir();
  const narrate = !silent && narrationOf(demo, cache, speechConfigured());
  if (!narrate) console.log(`${name}: no voice, recording with subtitles only`);
  const library = reporting?.library;
  let recording: string | undefined;
  try {
    recording = library ? await library.start(name, narrate, reporting.recording) : undefined;
  } catch (error) {
    if (error instanceof RecordingOpen) {
      console.log(`${name}: skipped, another recording of it is open`);
      return { name, outcome: 'skipped', reason: 'another recording of it is open' };
    }
    if (error instanceof Cancelled) {
      console.log(`${name}: cancelled`);
      return { name, outcome: 'skipped', reason: 'cancelled' };
    }
    throw error;
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const upload = async (file: string, as: string) => {
    if (library && recording) await library.upload(recording, as, file);
  };
  const finished = async (seconds: number) => {
    if (library && recording)
      await library.finish(recording, {
        status: 'recorded',
        seconds: Math.round(seconds * 10) / 10,
      });
  };
  try {
    return await capture(demo, name, narrate, key, out, cache, upload, finished, reporting?.tenant);
  } catch (error) {
    if (error instanceof Cancelled) {
      console.log(`${name}: cancelled`);
      return { name, outcome: 'skipped', reason: 'cancelled' };
    }
    if (library && recording) {
      const failure = failureOf(error);
      const shot = join(out, `failed-step-${failure?.step ?? 0}.png`);
      if (cached(shot))
        await upload(shot, `failed-step-${failure?.step ?? 0}.png`).catch(() => undefined);
      await library
        .finish(recording, { status: 'failed', ...(failure ? { failure } : {}) })
        .catch(() => undefined);
    }
    throw error;
  }
}

async function capture(
  demo: Demo,
  name: string,
  narrate: boolean,
  key: string | undefined,
  out: string,
  cache: string,
  upload: (file: string, as: string) => Promise<void>,
  finished: (seconds: number) => Promise<void>,
  tenantOverride?: string | null,
): Promise<DemoResult> {
  const env = process.env;
  const speech = speechOnce();
  const clips: Clip[] = [];
  for (const step of demo.steps) {
    if (!narrate) {
      clips.push({ seconds: estimateSeconds(step.say) });
      continue;
    }
    const file = await speak(step.say, demo, cache, speech);
    clips.push({ file, seconds: duration(file) });
  }

  const scripts = mkdtempSync(join(tmpdir(), 'genki-demo-'));
  const session = `demo-${name}`;
  const ab = (...args: string[]) => run('agent-browser', ['--session', session, ...args]);
  const quietly = (...args: string[]) => {
    try {
      ab(...args);
    } catch {
      return;
    }
  };
  const lines: TimedLine[] = [];
  const raw = join(out, 'raw.webm');
  try {
    const init = [join(scripts, 'language.js')];
    writeFileSync(init[0], languageScript(demo.language), { mode: 0o600 });
    if (demo.signedIn && key) {
      const bases = appBases(env);
      const portal = bases.portal.replace(/\/$/, '');
      const config = await fetch(`${portal}/config.js`);
      if (!config.ok) throw new Error(`${portal}/config.js answered ${config.status}`);
      const tenant =
        tenantOverride ||
        env.DEMO_TENANT ||
        (JSON.parse(readFileSync(resolve('scripts/smoke/plan.json'), 'utf8')) as { tenant: string })
          .tenant;
      const file = join(scripts, 'session.js');
      writeFileSync(
        file,
        sessionScript(
          demoSessions(
            key,
            {
              portal,
              console: bases.console,
              portalClientId: portalClientIdOf(await config.text()),
              tenant,
            },
            Date.now(),
          ),
        ),
        { mode: 0o600 },
      );
      init.push(file);
    }

    quietly('close');
    run('agent-browser', [
      '--session',
      session,
      ...init.flatMap((f) => ['--init-script', f]),
      'open',
      demo.start,
    ]);
    const [w, h] = demo.viewport ?? [1280, 720];
    ab('set', 'viewport', String(w), String(h));
    try {
      ab('wait', '--load', 'load');
      if (demo.ready) ab('wait', '--text', demo.ready, '--timeout', '30000');
    } catch (error) {
      quietly('screenshot', join(out, 'failed-step-0.png'));
      throw readyFailure(demo, error);
    }

    ab('record', 'start', raw, '--cursor');
    const t0 = Date.now();
    try {
      for (const [i, step] of demo.steps.entries()) {
        const at = (Date.now() - t0) / 1000;
        const clip = clips[i] as Clip;
        lines.push({ at, seconds: clip.seconds, text: step.say });
        console.log(`${name}: step ${i + 1}/${demo.steps.length}`);
        try {
          runStep(step, i, ab);
        } catch (error) {
          quietly('screenshot', join(out, `failed-step-${i + 1}.png`));
          throw error;
        }
        const shot = join(out, `step-${i + 1}.png`);
        quietly('screenshot', shot);
        if (cached(shot)) await upload(shot, `step-${i + 1}.png`);
        const elapsed = (Date.now() - t0) / 1000 - at;
        sleep((clip.seconds + (step.hold ?? 0.6) - elapsed) * 1000);
      }
    } finally {
      quietly('record', 'stop');
    }
  } finally {
    quietly('close');
    rmSync(scripts, { recursive: true, force: true });
  }

  const srt = join(out, `${name}.srt`);
  writeFileSync(srt, subtitles(lines));
  const mp4 = join(out, `${name}.mp4`);
  const voiced = clips.flatMap((c, i) =>
    c.file ? [{ file: c.file, at: (lines[i] as TimedLine).at }] : [],
  );
  run('ffmpeg', mixArgs(raw, voiced, srt, mp4, demo.language), 600_000);
  rmSync(raw, { force: true });
  await upload(mp4, 'demo.mp4');
  await upload(srt, 'demo.srt');
  const poster = join(out, 'poster.jpg');
  try {
    run('ffmpeg', posterArgs(mp4, poster));
  } catch {
    console.log(`${name}: no still`);
  }
  if (cached(poster)) await upload(poster, 'poster.jpg');
  const sample = clipFile(cache, demo.voice, sampleLineOf(demo.language));
  if (narrate && cached(sample)) await upload(sample, 'sample.mp3');
  await finished(duration(mp4));
  console.log(`${name}: ${mp4}`);
  return { name, outcome: 'recorded' };
}

export const parseArgs = (argv: string[]) => {
  const [first, ...rest] = argv;
  const mode =
    first === 'check' ||
    first === 'voice' ||
    first === 'record' ||
    first === 'recording' ||
    first === 'queued'
      ? first
      : 'record';
  const args = mode === first ? rest : argv;
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
  const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--only');
  return {
    mode,
    silent: args.includes('--silent'),
    queued: args.includes('--queued'),
    only: only || undefined,
    files,
  };
};

async function main(argv: string[]) {
  const { mode, silent, queued, only, files } = parseArgs(argv);
  if (mode === 'queued') {
    const { DEMO_API_URL: api, DEMO_RECORDER_KEY: key } = process.env;
    if (!api || !key) throw new Error('Set DEMO_API_URL and DEMO_RECORDER_KEY to list the queue');
    const found = await queuedOf(api, key);
    mkdirSync(resolve('demos/out'), { recursive: true });
    writeFileSync(queuedFile(), JSON.stringify(found, null, 2));
    console.log(`${found.length} queued: ${found.map((q) => q.demo).join(', ') || 'none'}`);
    return;
  }
  if (mode === 'voice' && queued) return voiceQueued();
  if (mode === 'recording') {
    const ids = queued ? readQueued().map((q) => q.id) : files.slice(0, 1);
    if (!queued && !recordingId.test(ids[0] ?? ''))
      throw new Error('recording takes a recording id');
    for (const id of ids) {
      const result = await recordStored(id, silent).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        return { name: id, outcome: 'failed' as const };
      });
      if (result.outcome === 'failed') process.exitCode = 1;
    }
    return;
  }
  const demos = pickDemos(resolve('demos'), only, files);
  const results: DemoResult[] = [];
  let failed = false;
  for (const path of demos) {
    const name = basename(path, '.yaml');
    try {
      if (mode === 'check') {
        const demo = parseDemo(readFileSync(path, 'utf8'), path);
        console.log(
          `${name}: ${demo.steps.length} steps, about ${Math.round(estimateDemo(demo))} s`,
        );
      } else if (mode === 'voice') await voice(path);
      else results.push(await record(path, silent));
    } catch (error) {
      failed = true;
      const why = error instanceof Error ? error.message : String(error);
      console.error(`${name}: ${why}`);
      results.push({ name, outcome: 'failed', reason: why });
    }
  }
  const resultOf = (r: DemoResult) =>
    r.outcome === 'failed'
      ? `failed: ${(r.reason ?? '').split('\n').join(' ').replace(/\|/g, '/')}`
      : r.outcome;
  if (mode === 'record' && process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Demos\n\n| Demo | Result |\n| --- | --- |\n${results.map((r) => `| ${r.name} | ${resultOf(r)} |`).join('\n')}\n`,
    );
  if (failed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
