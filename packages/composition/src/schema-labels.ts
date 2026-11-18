import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  'input-token': { label: 'Kroner per token inn' },
  'output-token': { label: 'Kroner per token ut' },
  'cached-input-token': { label: 'Kroner per bufret token inn' },
  'audio-second': { label: 'Kroner per sekund lyd' },
  image: { label: 'Kroner per bilde' },
  'video-second': { label: 'Kroner per sekund video' },
  character: { label: 'Kroner per tegn' },
  request: { label: 'Kroner per kall' },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  'input-token': { label: 'Kroner per input token' },
  'output-token': { label: 'Kroner per output token' },
  'cached-input-token': { label: 'Kroner per cached input token' },
  'audio-second': { label: 'Kroner per second of audio' },
  image: { label: 'Kroner per image' },
  'video-second': { label: 'Kroner per second of video' },
  character: { label: 'Kroner per character' },
  request: { label: 'Kroner per call' },
};

export const priceSchemaLabels: SchemaLabels = { nb, en };
