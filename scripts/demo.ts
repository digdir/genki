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
import { basename, dirname, join, resolve } from 'node:path';
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
  leftUsd,
  maxClipBytes,
  modelAudio,
  modelVoiceId,
  OverCap,
  refuseOverCap,
  speechLocale,
  spendOf,
  spokenText,
  transcriptionUrl,
  type Respellings,
  type Spend,
  type Spoken,
  type TakeScore,
} from './demo-voice.ts';
import {
  demoScrubbedWords,
  demoVoiceOf,
  demoVoiceProviders,
  elevenLabsCharacterCap,
  elevenLabsUsdPerCharacter,
  maxCostCapUsd,
  providerOf,
  silentVoice,
  takesOf,
  voiceCostUsd,
  voiceNeedsApproval,
  type DemoVoiceProvider,
} from '../packages/contracts/src/demo-voices.ts';
import { secretPathIn } from '../packages/contracts/src/demo-secrets.ts';
import {
  colorSchemes,
  pageProblem,
  sceneProblem,
  type ColorScheme,
  type DemoScene,
} from '../packages/contracts/src/demo-scenes.ts';
import { identityTokenUrl, recorderAuthOf, signInKeyOf, type RecorderAuth } from './demo-auth.ts';
import { elevenLabsKeyOf, elevenLabsRead } from './demo-elevenlabs.ts';
import { musicBeds, type MusicBed, type SoundReport } from './demo-sound.ts';
import {
  landmarkScript,
  type Card,
  type CaptureLog,
  type Landmark,
  type StepLog,
} from './demo-events.ts';
import { editFilm, hearClip, makeFilm } from './demo-film.ts';
import { writeRunFile, writeRunJson } from './demo-files.ts';
import { exampleExists } from './demo-scenes.ts';

export interface DemoStep {
  say: string;
  do?: string[][];
  hold?: number;
  chapter?: string;
  focus?: string[];
  spoken?: Spoken;
  scene?: DemoScene;
  page?: string;
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
  respell?: Respellings;
  music?: MusicBed;
  exampleData?: boolean;
  scrub?: string[];
  colorScheme?: ColorScheme;
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

export const lightScript =
  "(()=>{const light=()=>{const r=document.documentElement;if(r&&r.getAttribute('data-color-scheme')!=='light')r.setAttribute('data-color-scheme','light')};new MutationObserver(light).observe(document,{childList:true});new MutationObserver(light).observe(document,{subtree:true,attributes:true,attributeFilter:['data-color-scheme']});light()})();";

export const schemeScripts: Record<ColorScheme, string> = { dark: darkScript, light: lightScript };

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

export const scrubScript = (words: readonly string[]) =>
  `(()=>{const words=${scriptLiteral(words.filter((w) => w.trim()))};if(!words.length)return;const hide=()=>{const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const hits=[];while(walk.nextNode()){const n=walk.currentNode;if(words.some((w)=>(n.nodeValue||'').includes(w)))hits.push(n)}for(const n of hits){const p=n.parentElement;if(!p)continue;const el=p.closest('li li,.ds-tag,a,button,label,p,span,td,th,li,h1,h2,h3,h4');if(el)el.style.setProperty('display','none','important');else n.nodeValue=''}};let queued=false;const soon=()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;hide()})};const start=()=>{if(!document.body)return void setTimeout(start,20);hide();new MutationObserver(soon).observe(document.body,{childList:true,subtree:true,characterData:true})};start()})();`;

export const browserLaunch = (
  session: string,
  dir: string,
  language: string,
  signIn?: { key: string; apps: DemoApps },
  scrub: readonly string[] = demoScrubbedWords,
  scheme: ColorScheme = 'dark',
) => {
  const init = [join(dir, 'language.js'), join(dir, 'scheme.js'), join(dir, 'scrub.js')];
  writeFileSync(join(dir, 'language.js'), languageScript(language), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(dir, 'scheme.js'), schemeScripts[scheme], { flag: 'wx', mode: 0o600 });
  writeFileSync(join(dir, 'scrub.js'), scrubScript(scrub), { flag: 'wx', mode: 0o600 });
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
    scheme,
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
    'respell',
    'music',
    'exampleData',
    'scrub',
    'colorScheme',
    'steps',
  ];
  for (const key of Object.keys(raw)) if (!known.includes(key)) fail(`unknown field ${key}`);
  const secret = secretPathIn(raw);
  if (secret)
    fail(`${secret} looks like a key or token; keys belong in Key Vault, never in a demo`);
  if (raw.respell !== undefined && !respellingsOk(raw.respell))
    fail(
      `respell must map a voice provider (${providerIds.join(', ')}) to words and how to say them`,
    );
  if (raw.music !== undefined && !(musicBeds as readonly unknown[]).includes(raw.music))
    fail(`music must be one of ${musicBeds.join(', ')}`);
  if (raw.exampleData !== undefined && typeof raw.exampleData !== 'boolean')
    fail('exampleData must be true or false');
  if (
    raw.colorScheme !== undefined &&
    !(colorSchemes as readonly unknown[]).includes(raw.colorScheme)
  )
    fail(`colorScheme must be ${colorSchemes.join(' or ')}`);
  if (
    raw.scrub !== undefined &&
    !(
      Array.isArray(raw.scrub) &&
      raw.scrub.length <= 30 &&
      raw.scrub.every((w) => typeof w === 'string' && w.trim() && w.length <= 60)
    )
  )
    fail('scrub must be a list of at most 30 words to hide');
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
      if (!['say', 'do', 'hold', 'chapter', 'focus', 'spoken', 'scene', 'page'].includes(key))
        fail(`${at}: unknown field ${key}`);
    const scene = step.scene === undefined ? undefined : sceneProblem(step.scene);
    if (scene) fail(`${at}: ${scene}`);
    const code = step.scene as { template?: string; definition?: string } | undefined;
    if (code?.template === 'code' && !exampleExists(code.definition ?? ''))
      fail(`${at}: there is no example definition ${code.definition}`);
    const page = step.page === undefined ? undefined : pageProblem(step.page);
    if (page) fail(`${at}: ${page}`);
    if (step.spoken !== undefined && !spokenOk(step.spoken))
      fail(`${at}: spoken must map a voice provider to how the line is said`);
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

const providerIds = demoVoiceProviders.map((p) => p.id as string);

const isMap = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const spokenOk = (value: unknown) =>
  isMap(value) &&
  Object.entries(value).every(
    ([k, v]) => providerIds.includes(k) && typeof v === 'string' && v.trim() && v.length <= 1000,
  );

const respellingsOk = (value: unknown) =>
  isMap(value) &&
  Object.entries(value).every(
    ([k, words]) =>
      providerIds.includes(k) &&
      isMap(words) &&
      Object.keys(words).length <= 100 &&
      Object.entries(words).every(
        ([w, said]) =>
          w.trim() &&
          w.length <= 60 &&
          typeof said === 'string' &&
          said.trim() &&
          said.length <= 120,
      ),
  );

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
    (sum, s) =>
      sum +
      estimateSeconds(s.say) +
      (s.hold ?? 0.6) +
      ((s.do?.length ?? 0) + (s.page ? 2 : 0)) * 0.5,
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

export const pageUrl = (start: string, page: string) => {
  const origin = new URL(start).origin;
  const url = new URL(page, origin);
  if (pageProblem(page) || url.origin !== origin)
    throw new Error(`page ${page} is not a path on ${origin}`);
  return url.href;
};

export const withPage = (step: DemoStep, start: string): DemoStep =>
  step.page
    ? {
        ...step,
        do: [
          ['open', pageUrl(start, step.page)],
          ['wait', '--load', 'networkidle', '--timeout', '15000'],
          ...(step.do ?? []),
        ],
      }
    : step;

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

export const placeholderVoiceOf = (env: NodeJS.ProcessEnv) => {
  const voice = env.DEMO_PLACEHOLDER_VOICE;
  if (!voice) return undefined;
  if (!/^[A-Za-z]{2,20}$/.test(voice))
    throw new Error('DEMO_PLACEHOLDER_VOICE must be the name of a macOS voice, such as Nora');
  return voice;
};

export const speechConfigured = (voice: string, env: NodeJS.ProcessEnv = process.env) => {
  if (voice === silentVoice) return false;
  if (placeholderVoiceOf(env)) return true;
  const provider = providerOf(voice);
  return Boolean(
    ((env.SPEECH_ENDPOINT && env.IDENTITY_ENDPOINT) ||
      (env.SPEECH_RESOURCE && env.SPEECH_RESOURCE_GROUP && env.SPEECH_SUBSCRIPTION)) &&
    (provider !== 'azure-audio' || env.DEMO_AUDIO_ENDPOINT) &&
    (provider !== 'elevenlabs' || env.DEMO_ELEVENLABS_KEY_SECRET),
  );
};

export const canVoice = (voice: string, spend: Spend, env: NodeJS.ProcessEnv) =>
  speechConfigured(voice, env) &&
  (Boolean(placeholderVoiceOf(env)) || !voiceNeedsApproval(voice) || approved(spend));

export const managedIdentityTokenUrl = (endpoint: string, clientId?: string) =>
  identityTokenUrl(endpoint, 'https://cognitiveservices.azure.com', clientId).toString();

const speechEndpoint = async () => {
  const {
    SPEECH_ENDPOINT: direct,
    IDENTITY_ENDPOINT: identity,
    IDENTITY_HEADER: secret,
  } = process.env;
  if (direct && identity) {
    const res = await fetch(managedIdentityTokenUrl(identity, process.env.AZURE_CLIENT_ID), {
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
  const res = await fetch(transcriptionUrl(base, speechLocale(language)), {
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

export interface Line {
  say: string;
  spoken?: Spoken;
}

type Voicing = Pick<Demo, 'voice' | 'language' | 'respell'>;

const voiceKeyOf = (id: string) => {
  const voice = demoVoiceOf(id);
  return voice?.providerVoice || voice?.model
    ? [id, voice.providerVoice, voice.model].join(':')
    : id;
};

export const clipOf = (dir: string, demo: Voicing, line: Line, env = process.env) => {
  const placeholder = placeholderVoiceOf(env);
  return clipFile(
    dir,
    placeholder ? `placeholder:${placeholder}` : voiceKeyOf(demo.voice),
    spokenText(line, demo.voice, demo.language, demo.respell),
  );
};

const sayAloud = (text: string, voice: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'genki-say-'));
  try {
    writeFileSync(join(dir, 'line.txt'), text);
    run('say', ['-v', voice, '-f', join(dir, 'line.txt'), '-o', join(dir, 'line.aiff')]);
    run('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      join(dir, 'line.aiff'),
      join(dir, 'line.mp3'),
    ]);
    return readFileSync(join(dir, 'line.mp3'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const secondsOfAudio = (audio: Buffer) =>
  Number(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'pipe:0'],
      { input: audio, encoding: 'utf8', timeout: commandTimeoutMs },
    ).trim(),
  );

export const scoreFile = (clip: string) => clip.replace(/\.mp3$/, '.json');

export interface LineScore extends TakeScore {
  step: number;
  takes: number;
}

const words = (list: string[] | undefined) => (list ?? []).slice(0, 20).map((w) => w.slice(0, 80));

export const lineScoreOf = (clip: string, step: number): LineScore | undefined => {
  try {
    const kept = JSON.parse(readFileSync(scoreFile(clip), 'utf8')) as Partial<TakeScore> & {
      takes?: unknown[];
    };
    if (typeof kept.score !== 'number') return undefined;
    return {
      step,
      takes: kept.takes?.length ?? 1,
      score: kept.score,
      missing: words(kept.missing),
      extra: words(kept.extra),
      keyTermsMissing: words(kept.keyTermsMissing),
      ...(typeof kept.wordsPerSecond === 'number'
        ? { wordsPerSecond: Math.min(kept.wordsPerSecond, 20) }
        : {}),
    };
  } catch {
    return undefined;
  }
};

const elevenLabsKey = elevenLabsKeyOf(process.env);
const voicedCharacters = new WeakMap<Spend, number>();

export const elevenLabsCharacters = {
  of: (spend: Spend) => voicedCharacters.get(spend) ?? 0,
  add: (spend: Spend, count: number) =>
    voicedCharacters.set(spend, elevenLabsCharacters.of(spend) + count),
};

export const refuseOverCharacters = (
  voiced: number,
  text: string,
  takes = 1,
  cap = elevenLabsCharacterCap,
) => {
  if (voiced + text.length * takes > cap)
    throw new OverCap(
      `Reading «${text.slice(0, 40)}» would pass the ${cap} characters a film may voice with ElevenLabs`,
    );
};

async function speak(line: Line, demo: Voicing, dir: string, speech: Speech, spend: Spend) {
  const spoken = spokenText(line, demo.voice, demo.language, demo.respell);
  const file = clipOf(dir, demo, line);
  if (cached(file)) return file;
  const placeholder = placeholderVoiceOf(process.env);
  if (placeholder) {
    keep(file, sayAloud(spoken, placeholder));
    return file;
  }
  const provider = providerOf(demo.voice) ?? 'azure-speech';
  if (provider === 'azure-speech') {
    const { base, token } = await speech();
    const res = await fetch(`${base}/tts/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/ssml+xml',
        'x-microsoft-outputformat': 'audio-24khz-96kbitrate-mono-mp3',
        'user-agent': 'genki-demo',
      },
      body: ssml(spoken, demo.voice, demo.language),
    });
    if (!res.ok) throw new Error(`Speech answered ${res.status}`);
    const audio = Buffer.from(await res.arrayBuffer());
    const seconds = secondsOfAudio(audio);
    if (approved(spend) && hearingUsd(seconds) <= leftUsd(spend)) {
      spend.spentUsd += hearingUsd(seconds);
      const take = await bestTake(
        line.say,
        () => Promise.resolve(audio),
        (heard) => transcribe(heard, base, token, demo.language),
        1,
        () => seconds,
      ).catch(() => undefined);
      if (take)
        writeRunJson(dir, basename(scoreFile(file)), {
          text: line.say,
          spoken,
          ...take,
          audio: undefined,
        });
    }
    keep(file, audio);
    return file;
  }
  refuseOverCap(spend, voiceCostUsd([spoken], demo.voice), `Reading «${line.say.slice(0, 40)}»`);
  const voice = demoVoiceOf(demo.voice);
  if (!voice) throw new Error(`No voice called ${demo.voice}`);
  if (provider === 'elevenlabs')
    refuseOverCharacters(elevenLabsCharacters.of(spend), spoken, takesOf(demo.voice));
  const { base, token } = await speech();
  const before = { ...audioTokens };
  let heard = 0;
  let read = 0;
  const reader =
    provider === 'elevenlabs'
      ? () => {
          read++;
          elevenLabsCharacters.add(spend, spoken.length);
          return elevenLabsRead(spoken, voice, elevenLabsKey);
        }
      : () =>
          readAloud(
            spoken,
            { voice: modelVoiceId(demo.voice), language: speechLocale(demo.language) },
            token,
          );
  const take = await bestTake(
    line.say,
    reader,
    (audio) => {
      heard++;
      return transcribe(audio, base, token, demo.language);
    },
    takesOf(demo.voice),
    secondsOfAudio,
  ).finally(() => {
    spend.spentUsd +=
      audioUsd(audioTokens.text - before.text, audioTokens.audio - before.audio) +
      read * spoken.length * elevenLabsUsdPerCharacter +
      heard * hearingUsd(estimateSeconds(spoken));
  });
  writeRunJson(dir, basename(scoreFile(file)), {
    text: line.say,
    spoken,
    ...take,
    audio: undefined,
  });
  keep(file, take.audio);
  console.log(
    `${take.takes.length} ${take.takes.length === 1 ? 'take' : 'takes'}, score ${take.score} (missing ${take.missing.join(' ') || 'none'}, extra ${take.extra.join(' ') || 'none'}${take.wordsPerSecond ? `, ${take.wordsPerSecond} words a second` : ''}): ${line.say.slice(0, 50)}`,
  );
  return file;
}

const duration = (file: string) =>
  Number(
    run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]),
  );

export const narrationOf = (demo: Demo, dir: string, canSpeak: boolean) =>
  demo.voice !== silentVoice && (canSpeak || demo.steps.every((s) => cached(clipOf(dir, demo, s))));

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
  for (const step of demo.steps) await voiceLine(step, demo, cache, speech, spend);
  await speak({ say: sampleLineOf(demo.language) }, demo, cache, speech, spend);
  console.log(`${basename(path)}: ${demo.steps.length} lines voiced`);
  reportSpend(spend);
}

export const spendFromEnv = (env: NodeJS.ProcessEnv) =>
  spendOf(env.DEMO_COST_CAP_USD ? Number(env.DEMO_COST_CAP_USD) : undefined);

const voiceLine = async (
  line: Line,
  demo: Voicing,
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
  respell?: Respellings;
  lines: Line[];
  costCapUsd?: number;
}

export const queuedFile = () => resolve('demos/out/queued.json');

const recordingId = /^[0-9a-f-]{36}$/;

export const queuedOf = async (
  api: string,
  auth: RecorderAuth,
  send: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<QueuedNarration[]> => {
  const base = api.replace(/\/$/, '');
  const res = await send(`${base}/recorder/recordings?status=queued`, { headers: await auth() });
  if (!res.ok) throw new Error(`The queued recordings answered ${res.status}`);
  const { data } = (await res.json()) as { data: { id: string }[] };
  const queued: QueuedNarration[] = [];
  for (const { id } of data.filter((r) => recordingId.test(r.id))) {
    const one = await send(`${base}/recorder/recordings/${id}`, { headers: await auth() });
    if (!one.ok) {
      console.error(`The recording ${id} answered ${one.status}, so it is left for the next run`);
      continue;
    }
    const stored = (await one.json()) as StoredRecording & { status?: string };
    if (stored.status !== undefined && stored.status !== 'queued') continue;
    const problem = storedProblem(stored, env);
    if (problem) {
      console.error(`The recording ${id} is not voiced: ${problem}`);
      const { voice, language } = stored.demoSpec;
      queued.push({ id, demo: stored.demo, voice, language, lines: [] });
      continue;
    }
    const demo = demoOfRecording(stored, {});
    queued.push({
      id,
      demo: stored.demo,
      voice: demo.voice,
      language: demo.language,
      ...(demo.respell ? { respell: demo.respell } : {}),
      lines:
        stored.upTo || stored.editOf || demo.voice === silentVoice
          ? []
          : demo.steps.map((s) => ({ say: s.say, ...(s.spoken ? { spoken: s.spoken } : {}) })),
      ...(stored.costCapUsd !== undefined ? { costCapUsd: stored.costCapUsd } : {}),
    });
  }
  return queued;
};

const queuedProvider = z.enum(
  demoVoiceProviders.map((p) => p.id) as [DemoVoiceProvider, ...DemoVoiceProvider[]],
);

const queuedSchema = z.array(
  z.object({
    id: z.string().regex(recordingId),
    demo: z.string().min(1).max(200),
    voice: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
    language: z.string().regex(languageTag),
    respell: z
      .partialRecord(
        queuedProvider,
        z
          .record(z.string().max(60), z.string().max(120))
          .refine((g) => Object.keys(g).length <= 100),
      )
      .optional(),
    lines: z
      .array(
        z.strictObject({
          say: z.string().max(1000),
          spoken: z.partialRecord(queuedProvider, z.string().max(1000)).optional(),
        }),
      )
      .max(50),
    costCapUsd: z.number().min(0).max(maxCostCapUsd).optional(),
  }),
);

export const parseQueued = (text: string): QueuedNarration[] =>
  queuedSchema.parse(JSON.parse(text)).map(({ costCapUsd, respell, lines, ...q }) => ({
    ...q,
    lines: lines.map(({ say, spoken }) => (spoken ? { say, spoken } : { say })),
    ...(respell ? { respell: respell as Respellings } : {}),
    ...(costCapUsd !== undefined ? { costCapUsd } : {}),
  }));

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
      await speak({ say: sampleLineOf(queued.language) }, queued, cache, speech, spend);
    } catch (error) {
      if (!(error instanceof OverCap)) failed = true;
      console.log(
        `${queued.demo}: stopped voicing, ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      spent[queued.id] = spend.spentUsd;
      writeRunJson(cache, basename(spentFile(cache)), spent);
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
  lines?: LineScore[];
  sound?: SoundReport;
}

export interface Library {
  start(name: string, narrated: boolean, recording?: string): Promise<string>;
  upload(recording: string, name: string, file: string): Promise<void>;
  finish(recording: string, body: RecordingFinish): Promise<void>;
}

export const libraryOf = (
  api: string,
  auth: RecorderAuth,
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
      headers: { ...(await auth()), ...(type ? { 'content-type': type } : {}) },
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

const recorderAuth = recorderAuthOf(process.env);

const libraryFromEnv = (env: NodeJS.ProcessEnv) =>
  recorderAuth && env.DEMO_API_URL ? libraryOf(env.DEMO_API_URL, recorderAuth) : undefined;

const signInKey = signInKeyOf(process.env);

export const exampleBases = (env: NodeJS.ProcessEnv) => ({
  portal: env.DEMO_EXAMPLE_PORTAL_URL || 'http://portal.localhost:5173',
  console: env.DEMO_EXAMPLE_CONSOLE_URL || 'http://console.localhost:5174',
});

const appNames = ['portal', 'console'] as const;

export const onTarget = (url: string, bases: Record<(typeof appNames)[number], string>) => {
  const parsed = new URL(url);
  const app = appNames.find((a) => parsed.hostname.split('.')[0] === a);
  return app
    ? `${bases[app].replace(/\/$/, '')}${parsed.pathname}${parsed.search}${parsed.hash}`
    : url;
};

export const withExampleData = (demo: Demo, env: NodeJS.ProcessEnv): Demo => {
  if (!demo.exampleData) return demo;
  const bases = exampleBases(env);
  return {
    ...demo,
    start: onTarget(demo.start, bases),
    steps: demo.steps.map((step) =>
      step.do
        ? {
            ...step,
            do: step.do.map((c) =>
              c[0] === 'open' && c[1] ? ['open', onTarget(c[1], bases), ...c.slice(2)] : c,
            ),
          }
        : step,
    ),
  };
};

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

export const storedProblem = (stored: StoredRecording, env: NodeJS.ProcessEnv) => {
  const spec = stored.demoSpec;
  if (!Object.hasOwn(appBases(env), spec.app)) return `genki has no app ${String(spec.app)}`;
  const secret = secretPathIn(spec);
  if (secret)
    return `${secret} looks like a key or token; keys belong in Key Vault, never in a demo`;
  if (spec.exampleData && env.CI === 'true' && !env.DEMO_EXAMPLE_PORTAL_URL)
    return 'example data is recorded against the mock apps, which this run does not start';
  for (const [i, step] of spec.steps.entries()) {
    const scene = step.scene === undefined ? undefined : sceneProblem(step.scene);
    if (scene) return `step ${i + 1}: ${scene}`;
    if (step.scene?.template === 'code' && !exampleExists(step.scene.definition))
      return `step ${i + 1}: there is no example definition ${step.scene.definition}`;
    const page = step.page === undefined ? undefined : pageProblem(step.page);
    if (page) return `step ${i + 1}: ${page}`;
  }
  return undefined;
};

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
    ...(rest.respell ? { respell: rest.respell } : {}),
    ...(rest.music ? { music: rest.music } : {}),
    ...(rest.exampleData ? { exampleData: true } : {}),
    ...(rest.scrub ? { scrub: rest.scrub } : {}),
    ...(rest.colorScheme ? { colorScheme: rest.colorScheme } : {}),
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

export const handRunSkip = (demo: Demo, mode: string, env: NodeJS.ProcessEnv) => {
  if (
    mode === 'voice' &&
    voiceNeedsApproval(demo.voice) &&
    !placeholderVoiceOf(env) &&
    !approved(spendFromEnv(env))
  )
    return 'its voice needs an approved cost cap (DEMO_COST_CAP_USD)';
  if (mode === 'record' && demo.exampleData && env.CI === 'true' && !env.DEMO_EXAMPLE_PORTAL_URL)
    return 'example data is recorded against the mock apps, which this run does not start';
  return undefined;
};

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
  if (!library || !env.DEMO_API_URL || !recorderAuth)
    throw new Error(
      'Set DEMO_API_URL and DEMO_RECORDER_KEY or DEMO_RECORDER_AUDIENCE to record a queued recording',
    );
  const res = await fetch(
    `${env.DEMO_API_URL.replace(/\/$/, '')}/recorder/recordings/${encodeURIComponent(id)}`,
    { headers: await recorderAuth() },
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
      { api: env.DEMO_API_URL, auth: recorderAuth },
      spend,
    );
  const problem = storedProblem(stored, env);
  if (problem) {
    const started = await library.start(stored.demo, false, stored.id);
    await library.finish(started, { status: 'failed', failure: { step: 0, message: problem } });
    console.error(`${stored.demo}: failed, ${problem}`);
    return { name: stored.demo, outcome: 'failed', reason: problem };
  }
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
  auth: RecorderAuth,
  source: string,
  out: string,
  voices: string,
  send: typeof fetch = fetch,
) => {
  const base = `${api.replace(/\/$/, '')}/recorder/recordings/${encodeURIComponent(source)}`;
  const res = await send(base, { headers: await auth() });
  if (!res.ok) throw new Error(`The recording ${source} answered ${res.status}`);
  const names =
    ((await res.json()) as StoredRecording).files
      ?.map((f) => f.name)
      .filter((name) => editSource.test(name)) ?? [];
  const missing = ['capture.mp4', 'events.json', 'edl.json'].filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`The recording ${source} has no ${missing.join(', ')}`);
  for (const name of names) {
    const file = await send(`${base}/files/${encodeURIComponent(name)}`, {
      headers: await auth(),
    });
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
  from: { api: string; auth: RecorderAuth },
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
    const downloaded = await downloadEditSource(from.api, from.auth, source, out, cache);
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
      ...(film.sound ? { sound: film.sound } : {}),
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
  const needsKey = Boolean(demo.signedIn && !demo.exampleData);
  const read = needsKey
    ? await signInKey().then(
        (found) => ({ key: found || undefined, why: 'needs DEMO_API_KEY to sign in' }),
        (error: unknown) => ({
          key: undefined,
          why: `could not read its sign-in key: ${error instanceof Error ? error.message : String(error)}`,
        }),
      )
    : { key: undefined, why: '' };
  const key = read.key;
  if (needsKey && !key) {
    const why = read.why;
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
  const narrate = !silent && narrationOf(demo, cache, canVoice(demo.voice, spend, process.env));
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
  const finished = async (seconds: number, heard: Pick<RecordingFinish, 'lines' | 'sound'>) => {
    if (library && recording)
      await library.finish(recording, {
        status: 'recorded',
        seconds: Math.round(seconds * 10) / 10,
        ...(approved(spend) ? { costUsd: spentUsd(spend) } : {}),
        ...(heard.lines?.length ? { lines: heard.lines } : {}),
        ...(heard.sound ? { sound: heard.sound } : {}),
      });
  };
  try {
    return await capture(
      withExampleData(demo, env),
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

export const exampleSignInNames = ['Logg inn', 'Sign in'];

export const exampleSignIn = (
  ab: (...args: string[]) => string,
  quietly: (...args: string[]) => void,
) => {
  const clicked = exampleSignInNames.some((name) => {
    try {
      ab('find', 'role', 'button', 'click', '--name', name, '--exact');
      return true;
    } catch {
      return false;
    }
  });
  if (!clicked) throw new Error('The example data apps show no mock «Logg inn» button');
  sleep(2500);
  quietly('wait', '--load', 'networkidle', '--timeout', '5000');
};

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
  finished: (seconds: number, heard: Pick<RecordingFinish, 'lines' | 'sound'>) => Promise<void>,
  spend: Spend,
  tenantOverride?: string | null,
): Promise<DemoResult> {
  const env = process.env;
  const speech = speechOnce();
  const clips: Clip[] = [];
  const lines: LineScore[] = [];
  for (const [i, step] of demo.steps.entries()) {
    if (!narrate) {
      clips.push({ seconds: estimateSeconds(step.say) });
      continue;
    }
    const file = await speak(step, demo, cache, speech, spend);
    clips.push({ file, seconds: duration(file) });
    const score = lineScoreOf(file, i + 1);
    if (score) lines.push(score);
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
      demo.signedIn && key && !demo.exampleData
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
    run(
      'agent-browser',
      browserLaunch(
        session,
        scripts,
        demo.language,
        signIn,
        [...demoScrubbedWords, ...(demo.scrub ?? [])],
        demo.colorScheme,
      ),
    );
    if (signIn) signInBrowser(signIn.apps, Date.now(), ab);
    ab('open', demo.start);
    ab('set', 'viewport', String(w), String(h), String(captureScale));
    if (demo.exampleData && demo.signedIn) exampleSignIn(ab, quietly);
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
          runStep(withPage(step, demo.start), i, ab, undefined, undefined, undefined, {
            point: pointer.glide,
            navigate: () => {
              leftAt = clock();
            },
            cue: () => {
              if (step.do?.length || step.page) pointer.settle();
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
          ...(step.scene ? { scene: step.scene } : {}),
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
    ...(demo.music ? { music: demo.music } : {}),
    ...(demo.exampleData ? { exampleData: true } : {}),
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
  const sample = clipOf(cache, demo, { say: sampleLineOf(demo.language) });
  if (narrate && cached(sample)) await upload(sample, 'sample.mp3');
  await finished(duration(film.mp4), { lines, ...(film.sound ? { sound: film.sound } : {}) });
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
    const api = process.env.DEMO_API_URL;
    if (!api || !recorderAuth)
      throw new Error(
        'Set DEMO_API_URL and DEMO_RECORDER_KEY or DEMO_RECORDER_AUDIENCE to list the queue',
      );
    const found = await queuedOf(api, recorderAuth);
    mkdirSync(resolve('demos/out'), { recursive: true });
    writeRunJson(dirname(queuedFile()), basename(queuedFile()), found);
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
        continue;
      }
      const skip = handRunSkip(parseDemo(readFileSync(path, 'utf8'), path), mode, process.env);
      if (skip) {
        console.log(`${name}: skipped, ${skip}`);
        results.push({ name, outcome: 'skipped', reason: skip });
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
