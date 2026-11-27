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
import { z } from 'zod';
import {
  centre,
  focusArea,
  focusTarget,
  glideMs,
  navigates,
  refOf,
  scrollBy,
  smoothScrollScript,
  targetOf,
  voiceCue,
  type Box,
  type Point,
  type Target,
} from './demo-pointer.ts';
import {
  approved,
  audioRequest,
  audioUrl,
  audioUsd,
  bestTake,
  hearingUsd,
  isModelVoice,
  maxClipBytes,
  modelAudio,
  modelVoiceId,
  OverCap,
  refuseOverCap,
  speechLocale,
  spendOf,
  transcriptionUrl,
  type Spend,
} from './demo-voice.ts';
import { maxCostCapUsd, voiceCostUsd } from '../packages/contracts/src/demo-voices.ts';
import {
  landmarkScript,
  type Card,
  type CaptureLog,
  type Landmark,
  type StepLog,
} from './demo-events.ts';
import { editFilm, hearClip, makeFilm } from './demo-film.ts';
import { writeRunFile, writeRunJson } from './demo-files.ts';

export interface DemoStep {
  say: string;
  do?: string[][];
  hold?: number;
  chapter?: string;
  focus?: string[];
}

export interface Demo {
  title: string;
  language: string;
  voice: string;
  viewport?: [number, number];
  start: string;
  signedIn?: boolean;
  ready?: string;
  intro?: Card;
  outro?: Card;
  steps: DemoStep[];
}

export type { TimedLine } from './demo-events.ts';

export interface Clip {
  file?: string;
  seconds: number;
}

export { srtTime, subtitles } from './demo-events.ts';

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

export const darkScript =
  "(()=>{const dark=()=>{const r=document.documentElement;if(r&&r.getAttribute('data-color-scheme')!=='dark')r.setAttribute('data-color-scheme','dark')};new MutationObserver(dark).observe(document,{childList:true});new MutationObserver(dark).observe(document,{subtree:true,attributes:true,attributeFilter:['data-color-scheme']});dark()})();";

export interface DemoApps {
  portal: string;
  console: string;
  tenant: string;
}

const appOriginsOf = (apps: DemoApps) =>
  [
    [new URL(apps.portal).origin, false],
    [new URL(apps.console).origin, true],
  ] as const;

export const demoSignIn = (apps: DemoApps, now: number) => {
  const signedIn = (operator: boolean) =>
    JSON.stringify({
      name: 'Demo',
      organisation: apps.tenant,
      organisations: [{ orgNumber: apps.tenant, name: 'Demo' }],
      expiresAt: new Date(now + 3_600_000).toISOString(),
      ...(operator ? { operator: true } : {}),
    });
  return appOriginsOf(apps).map(([origin, operator]) => [
    'network',
    'route',
    `${origin}/auth/me`,
    '--body',
    signedIn(operator),
  ]);
};

const headerToken = /^[A-Za-z0-9._~+/=-]{1,512}$/;

export const apiKeyScript = (key: string, apps: DemoApps) => {
  if (!headerToken.test(key))
    throw new Error('DEMO_API_KEY must be a bearer token of letters, digits and ._~+/=-');
  return `(()=>{const key=${scriptLiteral(key)};const origins=${scriptLiteral(appOriginsOf(apps).map(([o]) => o))};const send=window.fetch.bind(window);window.fetch=(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input),location.href);if(!origins.includes(url.origin)||!url.pathname.startsWith('/api/'))return send(input,init);const headers=new Headers(input instanceof Request?input.headers:undefined);new Headers(init&&init.headers).forEach((v,k)=>headers.set(k,v));headers.set('authorization','Bearer '+key);return send(input,{...init,headers});};})();`;
};

export const browserLaunch = (
  session: string,
  dir: string,
  language: string,
  signIn?: { key: string; apps: DemoApps },
) => {
  const init = [join(dir, 'language.js'), join(dir, 'dark.js')];
  writeFileSync(join(dir, 'language.js'), languageScript(language), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(dir, 'dark.js'), darkScript, { flag: 'wx', mode: 0o600 });
  if (signIn) {
    const script = apiKeyScript(signIn.key, signIn.apps);
    init.push(join(dir, 'api-key.js'));
    writeFileSync(join(dir, 'api-key.js'), script, { flag: 'wx', mode: 0o600 });
  }
  return [
    '--session',
    session,
    ...init.flatMap((f) => ['--init-script', f]),
    '--color-scheme',
    'dark',
    'open',
  ];
};

export const signInBrowser = (apps: DemoApps, now: number, ab: (...args: string[]) => unknown) => {
  for (const command of demoSignIn(apps, now))
    try {
      ab(...command);
    } catch {
      throw new Error(`agent-browser could not sign in to ${new URL(command[2] ?? '').origin}`);
    }
};

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
  const known = [
    'title',
    'language',
    'voice',
    'viewport',
    'start',
    'signedIn',
    'ready',
    'intro',
    'outro',
    'steps',
  ];
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
  for (const key of ['intro', 'outro'] as const) {
    const problem = cardProblem(raw[key]);
    if (problem) fail(`${key} ${problem}`);
  }
  const steps = Array.isArray(raw.steps) ? (raw.steps as unknown[]) : [];
  if (steps.length === 0) fail('steps must list at least one step');
  steps.forEach((value, i) => {
    const at = `step ${i + 1}`;
    const step = (value ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(step))
      if (!['say', 'do', 'hold', 'chapter', 'focus'].includes(key))
        fail(`${at}: unknown field ${key}`);
    if (
      step.chapter !== undefined &&
      !(typeof step.chapter === 'string' && step.chapter.trim() && step.chapter.length <= 60)
    )
      fail(`${at}: chapter must be a short text`);
    if (
      step.focus !== undefined &&
      !(
        Array.isArray(step.focus) &&
        step.focus.every((p) => typeof p === 'string') &&
        focusTarget(step.focus as string[])
      )
    )
      fail(`${at}: focus must be like [role, table], [text, Hvor data behandles] or [css, main]`);
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

const cardProblem = (value: unknown) => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must have a title';
  const card = value as Record<string, unknown>;
  if (Object.keys(card).some((k) => !['title', 'subtitle', 'presenter'].includes(k)))
    return 'takes only title, subtitle and presenter';
  if (typeof card.title !== 'string' || !card.title.trim() || card.title.length > 80)
    return 'must have a title of at most 80 characters';
  for (const k of ['subtitle', 'presenter'])
    if (card[k] !== undefined && (typeof card[k] !== 'string' || (card[k] as string).length > 120))
      return `${k} must be a text of at most 120 characters`;
  return undefined;
};

export const estimateSeconds = (text: string) => Math.max(1, text.trim().split(/\s+/).length / 2.5);

export const introSeconds = 4;
export const outroSeconds = 3.5;

export const estimateDemo = (demo: Demo) =>
  demo.steps.reduce(
    (sum, s) => sum + estimateSeconds(s.say) + (s.hold ?? 0.6) + (s.do?.length ?? 0) * 0.5,
    (demo.intro ? introSeconds : 0) + (demo.outro ? outroSeconds : 0),
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

export interface StepHooks {
  point?: (command: string[]) => void;
  navigate?: () => void;
  cue?: () => void;
}

export const runStep = (
  step: DemoStep,
  index: number,
  browser: (...args: string[]) => unknown,
  timeoutMs = 15_000,
  now: () => number = Date.now,
  pause: (ms: number) => void = sleep,
  hooks: StepHooks = {},
) => {
  const commands = step.do ?? [];
  for (const command of commands)
    if (
      !(browserCommands as readonly string[]).includes(command[0] ?? '') ||
      !flagsAllowed(command)
    )
      throw stepFailure(index, step, command, new Error('the command is not allowed'));
  const cue = voiceCue(commands);
  const leave = commands.findIndex(navigates);
  if (cue < 0) hooks.cue?.();
  for (const [i, command] of commands.entries()) {
    try {
      hooks.point?.(command);
      if (i === leave) hooks.navigate?.();
      if (retried.has(command[0] ?? '')) retrying(() => browser(...command), timeoutMs, now, pause);
      else browser(...command);
    } catch (error) {
      throw stepFailure(index, step, command, error);
    }
    if (i === cue) hooks.cue?.();
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

const speechConfigured = (voice: string) =>
  Boolean(
    ((process.env.SPEECH_ENDPOINT && process.env.IDENTITY_ENDPOINT) ||
      (process.env.SPEECH_RESOURCE &&
        process.env.SPEECH_RESOURCE_GROUP &&
        process.env.SPEECH_SUBSCRIPTION)) &&
    (!isModelVoice(voice) || process.env.DEMO_AUDIO_ENDPOINT),
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
    return { base: direct.replace(/\/$/, ''), token };
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
  return { base: endpoint.replace(/\/$/, ''), token };
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

type Speech = () => Promise<{ base: string; token: string }>;

export const audioTokens = { text: 0, audio: 0 };

const readAloud = async (text: string, demo: Pick<Demo, 'voice' | 'language'>, token: string) => {
  const res = await fetch(audioUrl(process.env.DEMO_AUDIO_ENDPOINT ?? ''), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(audioRequest(text, demo.voice, demo.language)),
    signal: AbortSignal.timeout(commandTimeoutMs),
  });
  if (!res.ok) throw new Error(`The audio model answered ${res.status}`);
  const body = (await res.json()) as {
    choices: { message: { audio?: { data: string } } }[];
    usage?: { prompt_tokens?: number; completion_tokens_details?: { audio_tokens?: number } };
  };
  const audio = body.choices[0]?.message.audio?.data;
  if (!audio) throw new Error('The audio model answered without audio');
  audioTokens.text += body.usage?.prompt_tokens ?? 0;
  audioTokens.audio += body.usage?.completion_tokens_details?.audio_tokens ?? 0;
  return modelAudio(audio);
};

export const wavOf = (pcm: Buffer, rate = 16000) => {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
};

const transcribe = async (audio: Buffer, base: string, token: string, language: string) => {
  const pcm = execFileSync(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-f',
      'mp3',
      '-i',
      'pipe:0',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      's16le',
      'pipe:1',
    ],
    { input: audio, maxBuffer: 64 * 1024 * 1024, timeout: commandTimeoutMs },
  );
  const res = await fetch(transcriptionUrl(base, language), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
    },
    body: new Uint8Array(wavOf(pcm)),
    signal: AbortSignal.timeout(commandTimeoutMs),
  });
  if (!res.ok) throw new Error(`Speech to text answered ${res.status}`);
  return ((await res.json()) as { DisplayText?: string }).DisplayText ?? '';
};

async function speak(
  text: string,
  demo: Pick<Demo, 'voice' | 'language'>,
  dir: string,
  speech: Speech,
  spend: Spend,
) {
  const file = clipFile(dir, demo.voice, text);
  if (!cached(file) && isModelVoice(demo.voice)) {
    const model = { voice: modelVoiceId(demo.voice), language: speechLocale(demo.language) };
    refuseOverCap(spend, voiceCostUsd([text], model.voice), `Reading «${text.slice(0, 40)}»`);
    const { base, token } = await speech();
    const before = { ...audioTokens };
    let heard = 0;
    const take = await bestTake(
      text,
      () => readAloud(text, model, token),
      (audio) => {
        heard++;
        return transcribe(audio, base, token, model.language);
      },
    ).finally(() => {
      spend.spentUsd +=
        audioUsd(audioTokens.text - before.text, audioTokens.audio - before.audio) +
        heard * hearingUsd(estimateSeconds(text));
    });
    writeRunJson(dir, basename(file).replace(/\.mp3$/, '.json'), {
      text,
      ...take,
      audio: undefined,
    });
    keep(file, take.audio);
    console.log(
      `${take.takes.length} ${take.takes.length === 1 ? 'take' : 'takes'}, ${take.distance} of ${take.words} words heard differently: ${text.slice(0, 50)}`,
    );
  } else if (!cached(file)) {
    const { base, token } = await speech();
    const res = await fetch(`${base}/tts/cognitiveservices/v1`, {
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
  let endpoint: Promise<{ base: string; token: string }> | undefined;
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
  const spend = spendFromEnv(process.env);
  for (const step of demo.steps) await voiceLine(step.say, demo, cache, speech, spend);
  await speak(sampleLineOf(demo.language), demo, cache, speech, spend);
  console.log(`${basename(path)}: ${demo.steps.length} lines voiced`);
  reportSpend(spend);
}

export const spendFromEnv = (env: NodeJS.ProcessEnv) =>
  spendOf(env.DEMO_COST_CAP_USD ? Number(env.DEMO_COST_CAP_USD) : undefined);

const voiceLine = async (
  line: string,
  demo: Pick<Demo, 'voice' | 'language'>,
  cache: string,
  speech: Speech,
  spend: Spend,
) => {
  const clip = await speak(line, demo, cache, speech, spend);
  await hearClip(clip, demo.language, async () => (await speech()).token, spend, duration(clip));
  return clip;
};

const reportSpend = (spend: Spend) => {
  if (audioTokens.audio)
    console.log(
      `audio model: ${audioTokens.text} text tokens in, ${audioTokens.audio} audio tokens out`,
    );
  if (approved(spend))
    console.log(`models: ${spend.spentUsd.toFixed(2)} of ${spend.capUsd} USD approved`);
};

export interface QueuedNarration {
  id: string;
  demo: string;
  voice: string;
  language: string;
  lines: string[];
  costCapUsd?: number;
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
      lines: stored.upTo || stored.editOf ? [] : demo.steps.map((s) => s.say),
      ...(stored.costCapUsd !== undefined ? { costCapUsd: stored.costCapUsd } : {}),
    });
  }
  return queued;
};

const queuedSchema = z.array(
  z.object({
    id: z.string().regex(recordingId),
    demo: z.string().min(1).max(200),
    voice: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
    language: z.string().regex(languageTag),
    lines: z.array(z.string().max(1000)).max(50),
    costCapUsd: z.number().min(0).max(maxCostCapUsd).optional(),
  }),
);

export const parseQueued = (text: string): QueuedNarration[] =>
  queuedSchema
    .parse(JSON.parse(text))
    .map(({ costCapUsd, ...q }) => ({ ...q, ...(costCapUsd !== undefined ? { costCapUsd } : {}) }));

const readQueued = () => parseQueued(readFileSync(queuedFile(), 'utf8'));

async function voiceQueued() {
  const cache = cacheDir();
  mkdirSync(cache, { recursive: true });
  const speech = speechOnce();
  const spent: Record<string, number> = {};
  let failed = false;
  for (const queued of readQueued().filter((q) => q.lines.length > 0)) {
    const spend = spendOf(queued.costCapUsd);
    try {
      for (const line of queued.lines) await voiceLine(line, queued, cache, speech, spend);
      console.log(`${queued.demo}: ${queued.lines.length} lines voiced`);
      await speak(sampleLineOf(queued.language), queued, cache, speech, spend);
    } catch (error) {
      if (!(error instanceof OverCap)) failed = true;
      console.log(
        `${queued.demo}: stopped voicing, ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      spent[queued.id] = spend.spentUsd;
      writeFileSync(spentFile(cache), JSON.stringify(spent));
      reportSpend(spend);
    }
  }
  if (failed) process.exitCode = 1;
}

export const spentFile = (cache: string) => join(cache, 'spent.json');

export const voiceSpentOf = (cache: string, recording: string) => {
  try {
    const spent = JSON.parse(readFileSync(spentFile(cache), 'utf8')) as Record<string, unknown>;
    const usd = spent[recording];
    return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : 0;
  } catch {
    return 0;
  }
};

export interface RecordingFinish {
  status: 'recorded' | 'failed';
  seconds?: number;
  failure?: { step: number; command?: string; message: string };
  costUsd?: number;
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
  portal: env.DEMO_PORTAL_URL || 'https://portal.genki.digdir.cloud',
  console: env.DEMO_CONSOLE_URL || 'https://console.genki.digdir.cloud',
});

export interface StoredRecording {
  id: string;
  demo: string;
  upTo?: number;
  narrated?: boolean;
  editOf?: string;
  instruction?: string;
  costCapUsd?: number;
  files?: { name: string }[];
  demoSpec: Omit<Demo, 'start'> & { app: 'portal' | 'console'; path: string };
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
    ...(rest.intro ? { intro: rest.intro } : {}),
    ...(rest.outro ? { outro: rest.outro } : {}),
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
  return recordDemo(
    demo,
    basename(path, '.yaml'),
    silent,
    library ? { library } : undefined,
    spendFromEnv(process.env),
  );
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
  const spend = spendOf(stored.costCapUsd, voiceSpentOf(cacheDir(), stored.id));
  if (stored.editOf && stored.instruction)
    return editStored(
      stored,
      stored.editOf,
      stored.instruction,
      library,
      { api: env.DEMO_API_URL, key: env.DEMO_RECORDER_KEY },
      spend,
    );
  return recordDemo(
    demoOfRecording(stored, env),
    stored.demo,
    silent || Boolean(stored.upTo),
    { library, recording: stored.id, tenant: stored.settings.tenant },
    spend,
  );
}

const editSource =
  /^(capture\.mp4|events\.json|edl\.json|step-\d{1,2}\.png|voice-[0-9a-f]{16}\.(mp3|words\.json))$/;

const editSourceMaxBytes = (name: string) =>
  name === 'capture.mp4'
    ? 100 * 1024 * 1024
    : name.endsWith('.png')
      ? 5 * 1024 * 1024
      : maxClipBytes;

export const downloadEditSource = async (
  api: string,
  key: string,
  source: string,
  out: string,
  voices: string,
  send: typeof fetch = fetch,
) => {
  const base = `${api.replace(/\/$/, '')}/recorder/recordings/${encodeURIComponent(source)}`;
  const headers = { 'x-recorder-key': key };
  const res = await send(base, { headers });
  if (!res.ok) throw new Error(`The recording ${source} answered ${res.status}`);
  const names =
    ((await res.json()) as StoredRecording).files
      ?.map((f) => f.name)
      .filter((name) => editSource.test(name)) ?? [];
  const missing = ['capture.mp4', 'events.json', 'edl.json'].filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`The recording ${source} has no ${missing.join(', ')}`);
  for (const name of names) {
    const file = await send(`${base}/files/${encodeURIComponent(name)}`, { headers });
    if (!file.ok) throw new Error(`${name} of ${source} answered ${file.status}`);
    const max = editSourceMaxBytes(name);
    if (Number(file.headers.get('content-length') ?? 0) > max)
      throw new Error(`${name} of ${source} is more than ${max} bytes`);
    const data = new Uint8Array(await file.arrayBuffer());
    const voice = name.startsWith('voice-');
    writeRunFile(voice ? voices : out, voice ? name.slice('voice-'.length) : name, data, max);
  }
  return names;
};

async function editStored(
  stored: StoredRecording,
  source: string,
  instruction: string,
  library: Library,
  from: { api: string; key: string },
  spend: Spend,
): Promise<DemoResult> {
  const name = stored.demo;
  const narrate = stored.narrated !== false;
  let recording: string;
  try {
    recording = await library.start(name, narrate, stored.id);
  } catch (error) {
    if (error instanceof RecordingOpen || error instanceof Cancelled) {
      console.log(`${name}: skipped, ${error.message}`);
      return { name, outcome: 'skipped', reason: error.message };
    }
    throw error;
  }
  const out = resolve('demos/out', name);
  const cache = cacheDir();
  try {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    mkdirSync(cache, { recursive: true });
    const downloaded = await downloadEditSource(from.api, from.key, source, out, cache);
    const film = await editFilm(out, name, cache, instruction, spend);
    await library.upload(recording, 'demo.mp4', film.mp4);
    await library.upload(recording, 'demo.srt', film.srt);
    for (const file of film.extras) await library.upload(recording, file, join(out, file));
    for (const still of downloaded.filter((n) => /^step-\d{1,2}\.png$/.test(n)))
      await library.upload(recording, still, join(out, still));
    const poster = join(out, 'poster.jpg');
    try {
      run('ffmpeg', posterArgs(film.mp4, poster, film.posterAt));
    } catch {
      console.log(`${name}: no still`);
    }
    if (cached(poster)) await library.upload(recording, 'poster.jpg', poster);
    const seconds = duration(film.mp4);
    await library.finish(recording, {
      status: 'recorded',
      seconds: Math.round(seconds * 10) / 10,
      costUsd: spentUsd(spend),
    });
    console.log(`${name}: edited, ${film.mp4}`);
    return { name, outcome: 'recorded' };
  } catch (error) {
    if (error instanceof Cancelled) {
      console.log(`${name}: cancelled`);
      return { name, outcome: 'skipped', reason: 'cancelled' };
    }
    const failure = failureOf(error);
    await library
      .finish(recording, {
        status: 'failed',
        ...(failure ? { failure } : {}),
        costUsd: spentUsd(spend),
      })
      .catch(() => undefined);
    throw error;
  }
}

const spentUsd = (spend: Spend) => Math.round(spend.spentUsd * 100) / 100;

export async function recordDemo(
  demo: Demo,
  name: string,
  silent: boolean,
  reporting?: Reporting,
  spend: Spend = spendOf(),
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
  const narrate =
    !silent &&
    narrationOf(
      demo,
      cache,
      speechConfigured(demo.voice) && (!isModelVoice(demo.voice) || approved(spend)),
    );
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
        ...(approved(spend) ? { costUsd: spentUsd(spend) } : {}),
      });
  };
  try {
    return await capture(
      demo,
      name,
      narrate,
      key,
      out,
      cache,
      upload,
      finished,
      spend,
      reporting?.tenant,
    );
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
        .finish(recording, {
          status: 'failed',
          ...(failure ? { failure } : {}),
          ...(approved(spend) ? { costUsd: spentUsd(spend) } : {}),
        })
        .catch(() => undefined);
    }
    throw error;
  }
}

export const defaultViewport: [number, number] = [1920, 1080];

const boxOf = (output: string) => {
  const { data } = JSON.parse(output) as { data?: Partial<Box> };
  return data && [data.x, data.y, data.width, data.height].every(Number.isFinite)
    ? (data as Box)
    : undefined;
};

export const emptyJournal = (): Journal => ({ moves: [], clicks: [], scrolls: [] });

type Journal = Pick<StepLog, 'moves' | 'clicks' | 'scrolls'>;

const pointerOf = (
  ab: (...args: string[]) => string,
  quietly: (...args: string[]) => void,
  [w, h]: [number, number],
  clock: () => number,
) => {
  let at: Point = { x: Math.round(w * 0.6), y: Math.round(h * 0.55) };
  let journal = emptyJournal();
  quietly('mouse', 'move', String(at.x), String(at.y));
  const locate = (target: Target | undefined, attempts = 5) => {
    if (!target) return undefined;
    for (let tries = 0; tries < attempts; tries++) {
      try {
        const ref = refOf(target.by === 'selector' ? '' : ab('snapshot'), target);
        const box = ref ? boxOf(ab('--json', 'get', 'box', ref)) : undefined;
        if (ref && box && box.width > 0) return { ref, box };
      } catch {
        // the element is not there yet; the command itself waits for it
      }
      sleep(300);
    }
    return undefined;
  };
  return {
    glide: (command: string[]) => {
      const found = locate(targetOf(command));
      if (!found) return;
      let { box } = found;
      const delta = scrollBy(box, h);
      if (delta) {
        const seconds = Math.min(1200, 400 + Math.abs(delta) * 0.5);
        journal.scrolls.push({ at: clock(), seconds: seconds / 1000 });
        quietly('eval', smoothScrollScript(delta));
        sleep(seconds);
        try {
          box = boxOf(ab('--json', 'get', 'box', found.ref)) ?? box;
        } catch {
          return;
        }
      }
      if (command[0] === 'scrollintoview') return;
      const to = centre(box);
      const ms = glideMs(at, to);
      journal.moves.push({ at: clock(), seconds: ms / 1000, from: at, to });
      quietly('mouse', 'move', String(to.x), String(to.y), '--duration', String(ms), '--human');
      at = to;
      sleep(command[0] === 'find' && command[3] === 'hover' ? 150 : 300);
      if (clicks(command)) journal.clicks.push({ at: clock(), ...to });
    },
    journal: () => {
      const done = journal;
      journal = emptyJournal();
      return done;
    },
    area: (focus: string[]) => {
      const found = locate(focusTarget(focus), 2);
      return found ? focusArea(found.box, [w, h]) : undefined;
    },
    settle: () => {
      quietly('wait', '--load', 'networkidle', '--timeout', '2500');
      sleep(400);
      quietly('mouse', 'move', String(at.x), String(at.y));
    },
  };
};

export const captureScale = 1.5;

const clicks = (command: string[]) =>
  command[0] === 'click' ||
  command[0] === 'dblclick' ||
  (command[0] === 'find' && !['hover', 'fill', 'text'].includes(command[3] ?? 'click'));

const pageOf = (ab: (...args: string[]) => string) => {
  try {
    const { data } = JSON.parse(ab('--json', 'eval', landmarkScript)) as {
      data?: { result?: string };
    };
    const page = JSON.parse(data?.result ?? '{}') as { title?: string; landmarks?: Landmark[] };
    return { title: page.title, landmarks: page.landmarks ?? [] };
  } catch {
    return { landmarks: [] };
  }
};

async function capture(
  demo: Demo,
  name: string,
  narrate: boolean,
  key: string | undefined,
  out: string,
  cache: string,
  upload: (file: string, as: string) => Promise<void>,
  finished: (seconds: number) => Promise<void>,
  spend: Spend,
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
    const file = await speak(step.say, demo, cache, speech, spend);
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
  const raw = join(out, 'capture.mp4');
  const [w, h] = demo.viewport ?? defaultViewport;
  const steps: StepLog[] = [];
  try {
    const signIn =
      demo.signedIn && key
        ? {
            key,
            apps: {
              ...appBases(env),
              tenant:
                tenantOverride ||
                env.DEMO_TENANT ||
                (
                  JSON.parse(readFileSync(resolve('scripts/smoke/plan.json'), 'utf8')) as {
                    tenant: string;
                  }
                ).tenant,
            },
          }
        : undefined;
    quietly('close');
    run('agent-browser', browserLaunch(session, scripts, demo.language, signIn));
    if (signIn) signInBrowser(signIn.apps, Date.now(), ab);
    ab('open', demo.start);
    ab('set', 'viewport', String(w), String(h), String(captureScale));
    try {
      ab('wait', '--load', 'load');
      if (demo.ready) ab('wait', '--text', demo.ready, '--timeout', '30000');
    } catch (error) {
      quietly('screenshot', join(out, 'failed-step-0.png'));
      throw readyFailure(demo, error);
    }

    ab('record', 'start', raw);
    const t0 = Date.now();
    const clock = () => (Date.now() - t0) / 1000;
    const pointer = pointerOf(ab, quietly, [w, h], clock);
    try {
      for (const [i, step] of demo.steps.entries()) {
        const clip = clips[i] as Clip;
        const start = clock();
        let at = start;
        let leftAt: number | undefined;
        let area: Box | undefined;
        const seen: { page: ReturnType<typeof pageOf> } = { page: { landmarks: [] } };
        console.log(`${name}: step ${i + 1}/${demo.steps.length}`);
        try {
          runStep(step, i, ab, undefined, undefined, undefined, {
            point: pointer.glide,
            navigate: () => {
              leftAt = clock();
            },
            cue: () => {
              if (step.do?.length) pointer.settle();
              if (step.focus) area = pointer.area(step.focus);
              seen.page = pageOf(ab);
              at = clock();
            },
          });
        } catch (error) {
          quietly('screenshot', join(out, `failed-step-${i + 1}.png`));
          throw error;
        }
        const shot = join(out, `step-${i + 1}.png`);
        quietly('screenshot', shot);
        if (cached(shot)) await upload(shot, `step-${i + 1}.png`);
        const elapsed = clock() - at;
        sleep((clip.seconds + (step.hold ?? 0.6) - elapsed) * 1000);
        steps.push({
          say: step.say,
          start,
          ...(leftAt !== undefined ? { navigateAt: leftAt } : {}),
          cue: at,
          end: clock(),
          voice: { ...(clip.file ? { file: basename(clip.file) } : {}), seconds: clip.seconds },
          words: [],
          ...(seen.page.title ? { title: seen.page.title } : {}),
          ...(area ? { focus: area } : {}),
          landmarks: seen.page.landmarks,
          ...pointer.journal(),
          ...(step.chapter ? { chapter: step.chapter } : {}),
          ...(step.hold !== undefined ? { hold: step.hold } : {}),
        });
      }
    } finally {
      quietly('record', 'stop');
    }
  } finally {
    quietly('close');
    rmSync(scripts, { recursive: true, force: true });
  }

  const log: CaptureLog = {
    viewport: [w, h],
    scale: captureScale,
    seconds: duration(raw),
    language: demo.language,
    ...(demo.intro ? { intro: demo.intro } : {}),
    ...(demo.outro ? { outro: demo.outro } : {}),
    steps,
  };
  writeRunJson(out, 'events.json', log);
  const film = await makeFilm(out, name, cache, spend);
  await upload(film.mp4, 'demo.mp4');
  await upload(film.srt, 'demo.srt');
  for (const file of film.extras) await upload(join(out, file), file);
  const poster = join(out, 'poster.jpg');
  try {
    run('ffmpeg', posterArgs(film.mp4, poster, film.posterAt));
  } catch {
    console.log(`${name}: no still`);
  }
  if (cached(poster)) await upload(poster, 'poster.jpg');
  const sample = clipFile(cache, demo.voice, sampleLineOf(demo.language));
  if (narrate && cached(sample)) await upload(sample, 'sample.mp3');
  await finished(duration(film.mp4));
  console.log(`${name}: ${film.mp4}`);
  return { name, outcome: 'recorded' };
}

export const parseArgs = (argv: string[]) => {
  const [first, ...rest] = argv;
  const mode =
    first === 'check' ||
    first === 'voice' ||
    first === 'record' ||
    first === 'recording' ||
    first === 'queued' ||
    first === 'film'
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
  if (mode === 'film') {
    const dir = resolve(files[0] ?? '');
    const film = await makeFilm(dir, basename(dir), cacheDir(), spendFromEnv(process.env));
    console.log(film.mp4);
    return;
  }
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
