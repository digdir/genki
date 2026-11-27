import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { maxCostCapUsd, type Principal } from '@genai/contracts';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  appendVersion,
  platformScope,
  type ConfigEntry,
  type ConfigEntryStore,
} from './config-store.js';
import { isOperator } from './rights.js';

export const demoKind = 'demo';
export const recordingKind = 'demo-recording';
export const demoSeedActor = 'platform:seed';
export const recorderActor = 'recorder';

export const demoApps = ['portal', 'console'] as const;
export const demoAudiences = ['municipality', 'state-agency', 'internal'] as const;
export const recordingStatuses = ['queued', 'running', 'recorded', 'failed', 'cancelled'] as const;
export const settingsKind = 'demo-settings';
export const settingsId = 'default';

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

export const commandFlags = [
  '--name',
  '--exact',
  '--text',
  '--timeout',
  '--load',
  '--url',
] as const;

const flagsAllowed = (c: string[]) =>
  c.slice(1).every((p) => !p.startsWith('-') || (commandFlags as readonly string[]).includes(p));

export const demoIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const languageTag = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

const isHttps = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');
  } catch {
    return false;
  }
};

const command = z
  .array(z.string().max(500))
  .min(1)
  .max(20)
  .refine((c) => (browserCommands as readonly string[]).includes(c[0] ?? ''), {
    message: `a command starts with one of ${browserCommands.join(', ')}`,
  })
  .refine(flagsAllowed, {
    message: `a command takes only the flags ${commandFlags.join(', ')}`,
  })
  .refine((c) => c[0] !== 'open' || isHttps(c[1] ?? ''), {
    message: 'open needs an https or localhost URL',
  });

const focus = z
  .array(z.string().trim().min(1).max(200))
  .min(2)
  .max(3)
  .refine(
    ([kind, , name]) =>
      kind === 'role' || (['text', 'label', 'css'].includes(kind ?? '') && name === undefined),
    {
      message:
        'focus is [role, <role>, <name>], [text, <text>], [label, <label>] or [css, <selector>]',
    },
  );

export const demoCard = z.strictObject({
  title: z.string().trim().min(1).max(80),
  subtitle: z.string().trim().min(1).max(120).optional(),
  presenter: z.string().trim().min(1).max(120).optional(),
});

export const demoStep = z.strictObject({
  say: z.string().trim().min(1).max(1000),
  do: z.array(command).max(20).optional(),
  hold: z.number().min(0).max(10).optional(),
  chapter: z.string().trim().min(1).max(60).optional(),
  focus: focus.optional(),
});

export const demoSpec = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(1000).default(''),
  audience: z.array(z.enum(demoAudiences)).max(demoAudiences.length).default([]),
  language: z.string().regex(languageTag, 'language must be a tag like nb-NO'),
  voice: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/, 'voice must be a voice name like nb-NO-PernilleNeural'),
  viewport: z
    .tuple([z.number().int().min(320).max(3840), z.number().int().min(320).max(3840)])
    .optional(),
  app: z.enum(demoApps),
  path: z
    .string()
    .regex(/^\/\S*$/, 'path starts with / and has no spaces')
    .max(500),
  signedIn: z.boolean().optional(),
  ready: z.string().trim().min(1).max(200).optional(),
  intro: demoCard.optional(),
  outro: demoCard.optional(),
  steps: z.array(demoStep).min(1).max(50),
});

export type DemoSpec = z.infer<typeof demoSpec>;
export type DemoApp = (typeof demoApps)[number];

export const recordingFailure = z.strictObject({
  step: z.number().int().min(0),
  command: z.string().max(1000).optional(),
  message: z.string().max(2000),
});

export const recordingStart = z.strictObject({
  genkiVersion: z.string().trim().min(1).max(100),
  narrated: z.boolean(),
  recording: z.uuid().optional(),
});

export const recordingRequest = z
  .strictObject({
    upTo: z.number().int().min(1).max(50).optional(),
    editOf: z.uuid().optional(),
    instruction: z.string().trim().min(1).max(2000).optional(),
    costCapUsd: z.number().positive().max(maxCostCapUsd).optional(),
  })
  .refine((r) => (r.editOf === undefined) === (r.instruction === undefined), {
    message: 'editOf and instruction go together',
    path: ['instruction'],
  })
  .refine((r) => r.editOf === undefined || r.upTo === undefined, {
    message: 'an edit is of the whole film, without upTo',
    path: ['upTo'],
  })
  .refine((r) => r.editOf === undefined || r.costCapUsd !== undefined, {
    message: 'an edit calls the AI director and needs costCapUsd, the approved cost',
    path: ['costCapUsd'],
  })
  .refine((r) => r.upTo === undefined || r.costCapUsd === undefined, {
    message: 'a trial is silent and takes no costCapUsd',
    path: ['costCapUsd'],
  });

export const demoSettings = z.strictObject({
  voice: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/, 'voice must be a voice name like nb-NO-PernilleNeural'),
  viewport: z.tuple([z.number().int().min(320).max(3840), z.number().int().min(320).max(3840)]),
  tenant: z
    .string()
    .regex(/^\d{9}$/, 'the test organisation is a nine-digit org number')
    .nullable(),
  login: z.string().trim().min(1).max(200),
  retentionDays: z.number().int().min(7).max(365),
  writerDailyTokens: z.number().int().min(0).max(2_000_000),
});

export type DemoSettings = z.infer<typeof demoSettings>;

export const defaultDemoSettings: DemoSettings = {
  voice: 'nb-NO-PernilleNeural',
  viewport: [1920, 1080],
  tenant: null,
  login: 'recorder',
  retentionDays: 90,
  writerDailyTokens: 100_000,
};

export const recordingFinish = z.strictObject({
  status: z.enum(['recorded', 'failed']),
  seconds: z.number().min(0).max(3600).optional(),
  failure: recordingFailure.optional(),
  costUsd: z.number().min(0).max(1000).optional(),
});

export interface RecordingFile {
  name: string;
  size: number;
  contentType: string;
}

export interface RecordingSpec {
  demo: string;
  demoVersion: number;
  genkiVersion: string;
  status: (typeof recordingStatuses)[number];
  steps: number;
  narrated: boolean;
  voice?: string;
  startedAt: string;
  finishedAt?: string;
  seconds?: number;
  files: RecordingFile[];
  failure?: z.infer<typeof recordingFailure>;
  requestedBy?: string;
  upTo?: number;
  cancelledBy?: string;
  editOf?: string;
  instruction?: string;
  costCapUsd?: number;
  costUsd?: number;
}

export const recordingFileTypes: Record<string, { contentType: string; maxBytes: number }> = {
  'demo.mp4': { contentType: 'video/mp4', maxBytes: 100 * 1024 * 1024 },
  'demo.srt': { contentType: 'application/x-subrip', maxBytes: 256 * 1024 },
  'poster.jpg': { contentType: 'image/jpeg', maxBytes: 2 * 1024 * 1024 },
  'sample.mp3': { contentType: 'audio/mpeg', maxBytes: 1024 * 1024 },
  'capture.mp4': { contentType: 'video/mp4', maxBytes: 100 * 1024 * 1024 },
  'events.json': { contentType: 'application/json', maxBytes: 2 * 1024 * 1024 },
  'edl.json': { contentType: 'application/json', maxBytes: 2 * 1024 * 1024 },
};

export const editSources = ['capture.mp4', 'events.json', 'edl.json'] as const;

const screenshotFile = /^(failed-)?step-(\d{1,2})\.png$/;
const roundFile = /^(edl-round-[0-3]|review-round-[1-3]|voice-[0-9a-f]{16}\.words)\.json$/;
const voiceClip = /^voice-[0-9a-f]{16}\.mp3$/;

export const recordingFileType = (name: string) =>
  recordingFileTypes[name] ??
  (screenshotFile.test(name)
    ? { contentType: 'image/png', maxBytes: 5 * 1024 * 1024 }
    : roundFile.test(name)
      ? { contentType: 'application/json', maxBytes: 2 * 1024 * 1024 }
      : voiceClip.test(name)
        ? { contentType: 'audio/mpeg', maxBytes: 2 * 1024 * 1024 }
        : undefined);

export const isEditSource = (spec: Pick<RecordingSpec, 'status' | 'files' | 'upTo'>) =>
  spec.status === 'recorded' &&
  spec.upTo === undefined &&
  editSources.every((name) => spec.files.some((f) => f.name === name));

export const stepsDone = (spec: Pick<RecordingSpec, 'files'>) =>
  Math.max(
    0,
    ...spec.files.flatMap((f) => {
      const found = /^step-(\d{1,2})\.png$/.exec(f.name);
      return found ? [Number(found[1])] : [];
    }),
  );

export const isOpen = (spec: Pick<RecordingSpec, 'status'>) =>
  spec.status === 'queued' || spec.status === 'running';

export const recordingBlobPath = (recording: string, name: string) =>
  `demos/recordings/${recording}/${name}`;

export interface DemoProblem {
  path: string;
  message: string;
}

export const problemsOf = (error: z.ZodError): DemoProblem[] =>
  error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));

const appOfHost = (host: string): DemoApp | undefined =>
  demoApps.find((app) => host.split('.')[0] === app);

const fromStart = (raw: Record<string, unknown>) => {
  const { start, ...rest } = raw;
  if (start === undefined || 'app' in raw || 'path' in raw) return raw;
  if (typeof start !== 'string' || !isHttps(start)) return { ...rest, start };
  const url = new URL(start);
  const app = appOfHost(url.hostname);
  return app ? { ...rest, app, path: `${url.pathname}${url.search}${url.hash}` } : raw;
};

const withStringCommands = (raw: Record<string, unknown>) =>
  Array.isArray(raw.steps)
    ? {
        ...raw,
        steps: raw.steps.map((step: unknown) => {
          const s = step as Record<string, unknown> | null;
          return s && Array.isArray(s.do)
            ? {
                ...s,
                do: s.do.map((c: unknown) =>
                  Array.isArray(c)
                    ? c.map((p: unknown) => (typeof p === 'number' ? String(p) : p))
                    : c,
                ),
              }
            : s;
        }),
      }
    : raw;

export const readDemo = (
  text: string,
): { ok: true; spec: DemoSpec } | { ok: false; errors: DemoProblem[] } => {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return { ok: false, errors: [{ path: '', message: (error as Error).message }] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, errors: [{ path: '', message: 'a demo is a YAML mapping' }] };
  const parsed = demoSpec.safeParse(withStringCommands(fromStart(raw as Record<string, unknown>)));
  return parsed.success
    ? { ok: true, spec: parsed.data }
    : { ok: false, errors: problemsOf(parsed.error) };
};

export interface DemoSeed {
  id: string;
  spec: DemoSpec;
}

export const readDemoSeeds = (
  dir: string,
): { seeds: DemoSeed[]; unreadable: { file: string; errors: DemoProblem[] }[] } => {
  const seeds: DemoSeed[] = [];
  const unreadable: { file: string; errors: DemoProblem[] }[] = [];
  if (!existsSync(dir)) return { seeds, unreadable };
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()) {
    const id = basename(file, '.yaml');
    if (!demoIdPattern.test(id)) {
      unreadable.push({ file, errors: [{ path: 'id', message: 'not a lowercase slug' }] });
      continue;
    }
    const read = readDemo(readFileSync(join(dir, file), 'utf8'));
    if (read.ok) seeds.push({ id, spec: read.spec });
    else unreadable.push({ file, errors: read.errors });
  }
  return { seeds, unreadable };
};

export type DemoSeedOutcome = { id: string; state: 'created' | 'updated' | 'present' | 'kept' };

export const seedDemos = async (
  store: ConfigEntryStore,
  seeds: DemoSeed[],
  reason = 'demos/*.yaml in the repository',
): Promise<DemoSeedOutcome[]> => {
  const outcomes: DemoSeedOutcome[] = [];
  for (const seed of seeds) {
    const current = (await store.history(demoKind, platformScope, seed.id)).at(-1);
    if (current && !current.deleted && isDeepStrictEqual(current.spec, seed.spec)) {
      outcomes.push({ id: seed.id, state: 'present' });
      continue;
    }
    if (current && current.by !== demoSeedActor) {
      outcomes.push({ id: seed.id, state: 'kept' });
      continue;
    }
    await appendVersion(store, {
      kind: demoKind,
      scope: platformScope,
      id: seed.id,
      spec: seed.spec,
      deleted: false,
      by: demoSeedActor,
      reason,
      ...(current ? { ifVersion: current.version } : {}),
    });
    outcomes.push({ id: seed.id, state: current ? 'updated' : 'created' });
  }
  return outcomes;
};

export const mayViewDemos = (principal: Principal) => isOperator(principal);

export const mayEditDemos = (principal: Principal) => isOperator(principal);

export const recorderKeyDigest = (key: string) => createHash('sha256').update(key).digest('hex');

export const isRecorderKey = (presented: string | undefined, digest: string | undefined) => {
  if (!presented || !digest || !/^[0-9a-f]{64}$/.test(digest)) return false;
  return timingSafeEqual(
    Buffer.from(recorderKeyDigest(presented), 'hex'),
    Buffer.from(digest, 'hex'),
  );
};

export const recorderPrincipal = (tenant: string): Principal => ({
  kind: 'workload',
  issuer: 'platform',
  subject: recorderActor,
  tenant,
});

export const latestDemos = async (store: ConfigEntryStore) =>
  (await store.latest({ kind: demoKind, scope: platformScope })).filter(
    (e) => !e.deleted,
  ) as ConfigEntry<DemoSpec>[];

export const latestDemo = async (store: ConfigEntryStore, id: string) => {
  const found = (await store.history(demoKind, platformScope, id)).at(-1) as
    ConfigEntry<DemoSpec> | undefined;
  return found && !found.deleted ? found : undefined;
};

export const latestRecordings = async (store: ConfigEntryStore) =>
  (await store.latest({
    kind: recordingKind,
    scope: platformScope,
  })) as ConfigEntry<RecordingSpec>[];

export const latestSettings = async (store: ConfigEntryStore) => {
  const found = (await store.history(settingsKind, platformScope, settingsId)).at(-1) as
    ConfigEntry<DemoSettings> | undefined;
  return found && !found.deleted ? found : undefined;
};

export const settingsOf = async (store: ConfigEntryStore): Promise<DemoSettings> => ({
  ...defaultDemoSettings,
  ...(await latestSettings(store))?.spec,
});

export const latestRecording = async (store: ConfigEntryStore, id: string) =>
  (await store.history(recordingKind, platformScope, id)).at(-1) as
    ConfigEntry<RecordingSpec> | undefined;
