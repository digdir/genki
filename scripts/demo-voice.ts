// The model voice for demos: gpt-audio reads each line, and Azure Speech hears it back until it matches.
import {
  audioModelPrices,
  demoVoiceOf,
  demoVoices,
  speechToTextUsdPerHour,
} from '../packages/contracts/src/demo-voices.ts';

export const isModelVoice = (voice: string) => demoVoiceOf(voice)?.provider === 'azure-audio';

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

export const modelAudio = (base64: string) => {
  if (base64.length > Math.ceil(maxClipBytes / 3) * 4)
    throw new Error(`The audio model answered with more than ${maxClipBytes} bytes`);
  const audio = Buffer.from(base64, 'base64');
  const id3 = audio.subarray(0, 3).toString('latin1') === 'ID3';
  const frame = audio[0] === 0xff && ((audio[1] ?? 0) & 0xe0) === 0xe0;
  if (!id3 && !frame) throw new Error('The audio model answered with something other than mp3');
  return audio;
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

export const goodEnough = (distance: number, words: number) =>
  distance <= Math.max(2, Math.floor(words * 0.05));

export interface Take {
  audio: Buffer;
  heard: string;
  distance: number;
}

export const bestTake = async (
  text: string,
  read: () => Promise<Buffer>,
  hear: (audio: Buffer) => Promise<string>,
  tries = 4,
) => {
  const said = wordsOf(text);
  let best: Take | undefined;
  const takes: Omit<Take, 'audio'>[] = [];
  for (let i = 0; i < tries; i++) {
    const audio = await read();
    const heard = await hear(audio);
    const distance = wordDistance(said, wordsOf(heard));
    takes.push({ heard, distance });
    if (!best || distance < best.distance) best = { audio, heard, distance };
    if (goodEnough(distance, said.length)) break;
  }
  return { ...(best as Take), takes, words: said.length };
};
