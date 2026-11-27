export type DemoVoiceProvider = 'azure-speech' | 'azure-audio' | 'elevenlabs';

export interface DemoVoice {
  id: string;
  name: string;
  language: 'nb-NO' | 'en-GB' | 'en-US';
  gender: 'female' | 'male';
  provider: DemoVoiceProvider;
}

export interface DemoVoiceProviderInfo {
  id: DemoVoiceProvider;
  name: string;
  available: boolean;
  needsApproval: boolean;
}

export const demoVoiceProviders: readonly DemoVoiceProviderInfo[] = [
  { id: 'azure-speech', name: 'Azure Speech', available: true, needsApproval: false },
  { id: 'azure-audio', name: 'Azure OpenAI gpt-audio', available: true, needsApproval: true },
  { id: 'elevenlabs', name: 'ElevenLabs', available: false, needsApproval: true },
];

export const demoVoices: readonly DemoVoice[] = [
  {
    id: 'nb-NO-PernilleNeural',
    name: 'Pernille',
    language: 'nb-NO',
    gender: 'female',
    provider: 'azure-speech',
  },
  {
    id: 'nb-NO-IselinNeural',
    name: 'Iselin',
    language: 'nb-NO',
    gender: 'female',
    provider: 'azure-speech',
  },
  {
    id: 'nb-NO-FinnNeural',
    name: 'Finn',
    language: 'nb-NO',
    gender: 'male',
    provider: 'azure-speech',
  },
  { id: 'cedar', name: 'Cedar', language: 'nb-NO', gender: 'male', provider: 'azure-audio' },
  {
    id: 'en-GB-SoniaNeural',
    name: 'Sonia',
    language: 'en-GB',
    gender: 'female',
    provider: 'azure-speech',
  },
  {
    id: 'en-GB-RyanNeural',
    name: 'Ryan',
    language: 'en-GB',
    gender: 'male',
    provider: 'azure-speech',
  },
  {
    id: 'en-US-AvaNeural',
    name: 'Ava',
    language: 'en-US',
    gender: 'female',
    provider: 'azure-speech',
  },
  {
    id: 'en-US-JennyNeural',
    name: 'Jenny',
    language: 'en-US',
    gender: 'female',
    provider: 'azure-speech',
  },
  {
    id: 'en-US-AndrewNeural',
    name: 'Andrew',
    language: 'en-US',
    gender: 'male',
    provider: 'azure-speech',
  },
  {
    id: 'en-US-GuyNeural',
    name: 'Guy',
    language: 'en-US',
    gender: 'male',
    provider: 'azure-speech',
  },
];

export const demoVoiceOf = (id: string) => demoVoices.find((v) => v.id === id);

export const voiceNeedsApproval = (id: string) => {
  const provider = demoVoiceOf(id)?.provider;
  return demoVoiceProviders.some((p) => p.id === provider && p.needsApproval);
};

export const maxCostCapUsd = 25;

export const audioModelPrices = { textInput: 2.5, audioOutput: 64 };
export const audioTokensPerSecond = 25;
export const speechToTextUsdPerHour = 1;
export const directorPrices = { input: 5, output: 30 };
export const modelVoiceTakes = 4;
export const directorRounds = 3;

const spokenSeconds = (line: string) => Math.max(1, line.trim().split(/\s+/).length / 2.5);

const perMillion = (tokens: number, usd: number) => (tokens * usd) / 1_000_000;

export const voiceCostUsd = (lines: readonly string[], voice: string) => {
  const seconds = lines.reduce((sum, line) => sum + spokenSeconds(line), 0);
  const hearing = (seconds / 3600) * speechToTextUsdPerHour;
  if (!voiceNeedsApproval(voice)) return hearing;
  const reading =
    perMillion(seconds * audioTokensPerSecond, audioModelPrices.audioOutput) +
    perMillion(lines.length * 200, audioModelPrices.textInput);
  return modelVoiceTakes * (reading + hearing) + hearing;
};

const directorStepTokens = 1700;
const proofTokens = 36 * 765;

export const directorCostUsd = (steps: number) => {
  const text = steps * directorStepTokens + 6000;
  const input = text + steps * 765 + directorRounds * (3000 + proofTokens + text + 4000);
  const output = 16_000 * (directorRounds + 1);
  return perMillion(input, directorPrices.input) + perMillion(output, directorPrices.output);
};

export const editCostUsd = (steps: number) =>
  perMillion(steps * directorStepTokens * 2 + 8000, directorPrices.input) +
  perMillion(16_000, directorPrices.output);

export const approvalUsd = (usd: number) => Math.min(maxCostCapUsd, Math.max(1, Math.ceil(usd)));

export const filmCostUsd = (lines: readonly string[], voice: string) =>
  voiceCostUsd(lines, voice) + directorCostUsd(lines.length);
