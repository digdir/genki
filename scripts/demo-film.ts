// Turns a capture into a film: word timings, an edit list from the AI director, review rounds and the render.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { direct, estimateReviseUsd, estimateUsd, revise, type Ai } from './demo-director.ts';
import { baselineEdl, parseEdl, type Edl } from './demo-edl.ts';
import {
  alignWords,
  estimatedWords,
  fastTranscriptionUrl,
  heardWords,
  heardWordsSchema,
  parseCaptureLog,
  type CaptureLog,
  type Heard,
} from './demo-events.ts';
import { readJsonIfThere, writeRunJson } from './demo-files.ts';
import { renderFilm } from './demo-render.ts';
import { approved, hearingUsd, leftUsd, OverCap, refuseOverCap, type Spend } from './demo-voice.ts';

export const aiToken = async (env: NodeJS.ProcessEnv = process.env) => {
  if (env.IDENTITY_ENDPOINT) {
    const url = new URL(env.IDENTITY_ENDPOINT);
    url.searchParams.set('resource', 'https://cognitiveservices.azure.com');
    url.searchParams.set('api-version', '2019-08-01');
    const res = await fetch(url, { headers: { 'x-identity-header': env.IDENTITY_HEADER ?? '' } });
    if (!res.ok) throw new Error(`The managed identity answered ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }
  return execFileSync(
    'az',
    [
      'account',
      'get-access-token',
      '--resource',
      'https://cognitiveservices.azure.com',
      '--query',
      'accessToken',
      '-o',
      'tsv',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
};

export const tokenOnce = () => {
  let token: Promise<string> | undefined;
  return () => (token ??= aiToken());
};

const hearWords = async (file: string, endpoint: string, token: string, language: string) => {
  const form = new FormData();
  form.append(
    'audio',
    new Blob([new Uint8Array(readFileSync(file))], { type: 'audio/mpeg' }),
    'line.mp3',
  );
  form.append('definition', JSON.stringify({ locales: [language] }));
  const res = await fetch(fastTranscriptionUrl(endpoint), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Speech to text answered ${res.status}`);
  return heardWords(await res.json());
};

export const wordsFile = (clip: string) => clip.replace(/\.mp3$/, '.words.json');

export const hearClip = async (
  clip: string,
  language: string,
  token: () => Promise<string>,
  spend: Spend,
  seconds: number,
): Promise<Heard[] | undefined> => {
  const known = readJsonIfThere(wordsFile(clip));
  if (known !== undefined) return heardWordsSchema.parse(known);
  const endpoint = process.env.DEMO_AUDIO_ENDPOINT;
  const cost = hearingUsd(seconds);
  if (!endpoint || !approved(spend) || cost > leftUsd(spend)) return undefined;
  spend.spentUsd += cost;
  try {
    const words = await hearWords(clip, endpoint, await token(), language);
    writeRunJson(dirname(clip), basename(wordsFile(clip)), words);
    return words;
  } catch (error) {
    console.log(
      `word timings: ${error instanceof Error ? error.message : String(error)}, estimating`,
    );
    return undefined;
  }
};

export const timeWords = async (
  log: CaptureLog,
  voices: string,
  token: () => Promise<string>,
  spend: Spend,
) => {
  for (const step of log.steps) {
    if (!step.voice.file) {
      step.words = estimatedWords(step.say, step.voice.seconds);
      continue;
    }
    const clip = join(voices, step.voice.file);
    const heard = (await hearClip(clip, log.language, token, spend, step.voice.seconds)) ?? [];
    step.words = alignWords(step.say, heard, step.voice.seconds);
  }
  return log;
};

export const aiFromEnv = (
  env: NodeJS.ProcessEnv,
  token: () => Promise<string>,
  spend: Spend,
): Ai | undefined =>
  env.DEMO_AUDIO_ENDPOINT && env.DEMO_DIRECTOR !== 'off' && approved(spend)
    ? {
        endpoint: env.DEMO_AUDIO_ENDPOINT,
        deployment: env.DEMO_DIRECTOR_MODEL || 'gpt-5.5',
        token,
        budgetUsd: leftUsd(spend),
        charge: (usd) => {
          spend.spentUsd += usd;
        },
      }
    : undefined;

const clipName = /^[0-9a-f]{16}\.mp3$/;

export const keepVoices = (log: CaptureLog, out: string, voices: string) =>
  [...new Set(log.steps.flatMap((s) => (s.voice.file ? [s.voice.file] : [])))]
    .filter((file) => clipName.test(file) && existsSync(join(voices, file)))
    .flatMap((file) => {
      const clip = `voice-${file}`;
      copyFileSync(join(voices, file), join(out, clip));
      const words = wordsFile(file);
      if (!existsSync(join(voices, words))) return [clip];
      copyFileSync(join(voices, words), join(out, `voice-${words}`));
      return [clip, `voice-${words}`];
    });

export const makeFilm = async (out: string, name: string, voices: string, spend: Spend) => {
  const token = tokenOnce();
  const log = await timeWords(
    parseCaptureLog(JSON.parse(readFileSync(join(out, 'events.json'), 'utf8'))),
    voices,
    token,
    spend,
  );
  writeRunJson(out, 'events.json', log);
  const kept = readJsonIfThere(join(out, 'edl.json'));
  const extras = ['events.json', 'edl.json', 'capture.mp4', ...keepVoices(log, out, voices)];
  let edl: Edl;
  if (kept !== undefined) edl = parseEdl(kept, log);
  else {
    const ai = aiFromEnv(process.env, token, spend);
    const estimate = ai ? estimateUsd(log, ai.deployment) : 0;
    const result =
      ai && estimate <= ai.budgetUsd
        ? await direct(log, out, ai).catch((error: unknown) => {
            if (!(error instanceof OverCap)) throw error;
            console.log(`director: stopped, ${error.message}; a plain edit instead`);
            return undefined;
          })
        : undefined;
    if (result) {
      edl = result.edl;
      extras.push(...result.files);
      console.log(
        `director: ${result.rounds} rounds, ${result.passed ? 'passed' : 'not passed'}, ${result.costUsd.toFixed(2)} USD`,
      );
    } else {
      if (ai && estimate > ai.budgetUsd)
        console.log(
          `director: skipped, about ${estimate.toFixed(2)} USD is more than the ${ai.budgetUsd.toFixed(2)} USD left of the approved cap; a plain edit instead`,
        );
      edl = baselineEdl(log);
    }
    writeRunJson(out, 'edl.json', edl);
  }
  const mp4 = join(out, `${name}.mp4`);
  const srt = join(out, `${name}.srt`);
  await renderFilm({ log, edl, capture: join(out, 'capture.mp4'), voices }, mp4, srt, log.language);
  return { mp4, srt, extras, posterAt: (edl.intro?.seconds ?? 0) + 2 };
};

export const editFilm = async (
  out: string,
  name: string,
  voices: string,
  instruction: string,
  spend: Spend,
) => {
  const token = tokenOnce();
  const log = parseCaptureLog(JSON.parse(readFileSync(join(out, 'events.json'), 'utf8')));
  const before = parseEdl(JSON.parse(readFileSync(join(out, 'edl.json'), 'utf8')), log);
  const ai = aiFromEnv(process.env, token, spend);
  refuseOverCap(spend, ai ? estimateReviseUsd(log, before, ai.deployment) : 0, 'The edit');
  if (!ai) throw new Error('Set DEMO_AUDIO_ENDPOINT, with DEMO_DIRECTOR not off, to edit a film');
  const { edl, costUsd } = await revise(log, before, instruction, ai);
  writeRunJson(out, 'edl.json', edl);
  console.log(`director: edited for ${costUsd.toFixed(2)} USD`);
  return makeFilm(out, name, voices, spend);
};
