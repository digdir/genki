// The model voice for demos: gpt-audio reads each line, and Azure Speech hears it back until it matches.
import {
  audioModelPrices,
  demoKeyTerms,
  demoRespellings,
  demoVoices,
  providerOf,
  speechToTextUsdPerHour,
  type DemoVoice,
  type DemoVoiceProvider,
} from '../packages/contracts/src/demo-voices.ts';

export const isModelVoice = (voice: string) => providerOf(voice) === 'azure-audio';

export const modelVoiceId = (voice: string) => {
  const known = demoVoices.find((v) => v.id === voice && v.provider === 'azure-audio');
  if (!known) throw new Error(`${voice} is not a model voice`);
  return known.id;
};

export const speechLocale = (language: string) => {
  const known = demoVoices.find((v) => v.language === language);
  if (!known)
    throw new Error(
      `Speech to text hears ${[...new Set(demoVoices.map((v) => v.language))].join(', ')}, not ${language}`,
    );
  return known.language;
};

export const maxClipBytes = 2 * 1024 * 1024;

export const mp3Clip = (audio: Buffer, from: string) => {
  if (audio.byteLength > maxClipBytes)
    throw new Error(`${from} answered with more than ${maxClipBytes} bytes`);
  const id3 = audio.subarray(0, 3).toString('latin1') === 'ID3';
  const frame = audio[0] === 0xff && ((audio[1] ?? 0) & 0xe0) === 0xe0;
  if (!id3 && !frame) throw new Error(`${from} answered with something other than mp3`);
  return audio;
};

export const modelAudio = (base64: string) => {
  if (base64.length > Math.ceil(maxClipBytes / 3) * 4)
    throw new Error(`The audio model answered with more than ${maxClipBytes} bytes`);
  return mp3Clip(Buffer.from(base64, 'base64'), 'The audio model');
};

export interface Spend {
  capUsd?: number;
  spentUsd: number;
}

export const spendOf = (capUsd?: number, spentUsd = 0): Spend => ({
  ...(capUsd !== undefined && capUsd > 0 ? { capUsd } : {}),
  spentUsd,
});

export const approved = (spend: Spend) => spend.capUsd !== undefined;

export const leftUsd = (spend: Spend) => Math.max(0, (spend.capUsd ?? 0) - spend.spentUsd);

export const audioUsd = (textTokens: number, audioTokens: number) =>
  (textTokens * audioModelPrices.textInput + audioTokens * audioModelPrices.audioOutput) /
  1_000_000;

export const hearingUsd = (seconds: number) => (seconds / 3600) * speechToTextUsdPerHour;

export class OverCap extends Error {}

export const refuseOverCap = (spend: Spend, usd: number, what: string) => {
  if (!approved(spend))
    throw new OverCap(`${what} calls a model, and nobody has approved a cost cap for it`);
  if (usd > leftUsd(spend))
    throw new OverCap(
      `${what} could cost ${usd.toFixed(2)} USD, more than the ${leftUsd(spend).toFixed(2)} USD left of the approved ${spend.capUsd} USD`,
    );
};

export const audioDeployment = 'gpt-audio-1.5';

export const readerInstruction = (language: string) =>
  language.startsWith('nb')
    ? 'Du er en opplesningsstemme. Les teksten brukeren gir deg nøyaktig ordrett, uten noe ekstra før eller etter. Snakk naturlig norsk bokmål med østlandsk uttale, varm og engasjert fortellerstemme.'
    : `You are a narrator. Read the text the user gives you exactly word for word, with nothing before or after. Speak natural ${language === 'en-GB' ? 'British' : 'American'} English in a warm, engaged voice.`;

export const audioRequest = (text: string, voice: string, language: string) => ({
  modalities: ['text', 'audio'],
  audio: { voice, format: 'mp3' },
  messages: [
    { role: 'system', content: readerInstruction(language) },
    { role: 'user', content: `${language.startsWith('nb') ? 'Les opp' : 'Read aloud'}:\n${text}` },
  ],
});

export const audioUrl = (endpoint: string, deployment = audioDeployment) => {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    !/\.(cognitiveservices|openai)\.azure\.com$/.test(url.hostname) ||
    !/^[\w.-]{1,64}$/.test(deployment)
  )
    throw new Error('DEMO_AUDIO_ENDPOINT must be an https Azure AI endpoint');
  return `${url.origin}/openai/deployments/${deployment}/chat/completions?api-version=2025-04-01-preview`;
};

export const transcriptionUrl = (speechBase: string, language: string) =>
  `${speechBase.replace(/\/$/, '')}/stt/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}&format=detailed`;

const spokenNumbers: Record<string, string> = {
  én: '1',
  en: '1',
  ett: '1',
  to: '2',
  tre: '3',
  fire: '4',
  fem: '5',
  seks: '6',
  sju: '7',
  syv: '7',
  åtte: '8',
  ni: '9',
  ti: '10',
};

const heardAs: Record<string, string> = { kå: 'ka', kåi: 'ki', jenki: 'genki', gjenki: 'genki' };

export const wordsOf = (text: string) =>
  (text.toLowerCase().match(/[a-zæøå0-9]+/g) ?? []).map((w) => heardAs[w] ?? spokenNumbers[w] ?? w);

const commonLength = (a: string, b: string) => {
  let row = new Array<number>(b.length + 1).fill(0);
  for (const ca of a) {
    const next = [0];
    for (let j = 1; j <= b.length; j++)
      next[j] = ca === b[j - 1] ? (row[j - 1] ?? 0) + 1 : Math.max(row[j] ?? 0, next[j - 1] ?? 0);
    row = next;
  }
  return row[b.length] ?? 0;
};

export const sameWord = (a: string, b: string) =>
  a === b || (2 * commonLength(a, b)) / (a.length + b.length) >= 0.6;

export const wordDistance = (said: string[], heard: string[]) => {
  let row = Array.from({ length: heard.length + 1 }, (_, j) => j);
  said.forEach((word, i) => {
    const next = [i + 1];
    heard.forEach((h, j) => {
      next[j + 1] = Math.min(
        (row[j + 1] ?? 0) + 1,
        (next[j] ?? 0) + 1,
        (row[j] ?? 0) + (sameWord(word, h) ? 0 : 1),
      );
    });
    row = next;
  });
  return row[heard.length] ?? 0;
};

const stopWords = new Set(
  'og i på en et er det som med for av til den de dere du å om når men fra har kan blir ble hva hvor her alt seg sine sin egne egen eget the a an and of to in is it on for with'.split(
    ' ',
  ),
);

export const paceWordsPerSecond: [number, number] = [1.6, 3.2];
export const paceFromWords = 8;

const keyTerms = new Set(demoKeyTerms);

const contentWords = (words: string[]) =>
  words.filter((w) => !stopWords.has(w) && (w.length >= 4 || keyTerms.has(w)));

const near = (a: string, b: string) =>
  a === b || (2 * commonLength(a, b)) / (a.length + b.length) >= 0.85;

export interface TakeScore {
  score: number;
  missing: string[];
  extra: string[];
  keyTermsMissing: string[];
  wordsPerSecond?: number;
}

export const scoreTake = (text: string, heard: string, seconds?: number): TakeScore => {
  const said = wordsOf(text);
  const ears = wordsOf(heard);
  const missing = contentWords(said).filter((w) => !ears.some((h) => near(w, h)));
  const extra = ears.filter(
    (h) => !stopWords.has(h) && h.length >= 4 && !said.some((w) => near(h, w)),
  );
  const keyTermsMissing = missing.filter((w) => keyTerms.has(w));
  const wordsPerSecond =
    seconds && seconds > 0 ? Math.round((said.length / seconds) * 100) / 100 : undefined;
  const offPace =
    wordsPerSecond !== undefined &&
    said.length >= paceFromWords &&
    (wordsPerSecond < paceWordsPerSecond[0] || wordsPerSecond > paceWordsPerSecond[1]);
  return {
    score: 2 * missing.length + keyTermsMissing.length + extra.length + (offPace ? 2 : 0),
    missing,
    extra,
    keyTermsMissing,
    ...(wordsPerSecond !== undefined ? { wordsPerSecond } : {}),
  };
};

export interface Take extends TakeScore {
  audio: Buffer;
  heard: string;
  distance: number;
}

export const bestTake = async (
  text: string,
  read: () => Promise<Buffer>,
  hear: (audio: Buffer) => Promise<string>,
  tries = 4,
  secondsOf?: (audio: Buffer) => number,
) => {
  const said = wordsOf(text);
  let best: Take | undefined;
  const takes: Omit<Take, 'audio'>[] = [];
  for (let i = 0; i < tries; i++) {
    let audio: Buffer;
    let heard: string;
    try {
      audio = await read();
      heard = await hear(audio);
    } catch (error) {
      if (best) break;
      throw error;
    }
    const distance = wordDistance(said, wordsOf(heard));
    const take = { heard, distance, ...scoreTake(text, heard, secondsOf?.(audio)) };
    takes.push(take);
    if (!best || take.score < best.score || (take.score === best.score && distance < best.distance))
      best = { audio, ...take };
    if (take.score === 0) break;
  }
  return { ...(best as Take), takes, words: said.length };
};

export const respell = (text: string, glossary: Readonly<Record<string, string>>) => {
  const keys = Object.keys(glossary)
    .filter((k) => k.length > 0)
    .sort((a, b) => b.length - a.length);
  if (!keys.length) return text;
  const wordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  let out = '';
  for (let i = 0; i < text.length;) {
    const hit = wordChar(text[i - 1])
      ? undefined
      : keys.find((k) => text.startsWith(k, i) && !wordChar(text[i + k.length]));
    if (hit) {
      out += glossary[hit];
      i += hit.length;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
};

export type Spoken = Partial<Record<DemoVoiceProvider, string>>;
export type Respellings = Partial<Record<DemoVoiceProvider, Record<string, string>>>;

export const spokenText = (
  line: { say: string; spoken?: Spoken },
  voice: string,
  language: string,
  respellings: Respellings = {},
) => {
  const provider = providerOf(voice);
  if (!provider) return line.say;
  const own = line.spoken?.[provider];
  if (own) return own;
  const platform = demoRespellings[language as DemoVoice['language']]?.[provider] ?? {};
  return respell(line.say, { ...platform, ...(respellings[provider] ?? {}) });
};
