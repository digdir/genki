import { operationKindPattern } from './port.js';

export interface DiscoveredKind {
  kind: string;
  from: 'listing' | 'name';
  endpoints?: string[];
}

const endpointKinds: readonly (readonly [string, string])[] = [
  ['/chat/completions', 'chat'],
  ['/responses', 'chat'],
  ['/embeddings', 'embed'],
  ['/rerank', 'rerank'],
];

const endpointPath = /^\/[A-Za-z0-9._~/-]{0,199}$/;

/** The paths a listing says a model answers on, such as /v1/rerank. */
export const listedEndpoints = (entry: unknown): string[] => {
  if (typeof entry !== 'object' || entry === null) return [];
  const value = (entry as Record<string, unknown>).endpoints;
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((e): e is string => typeof e === 'string' && endpointPath.test(e))),
  ].slice(0, 20);
};

const kindOfEndpoints = (endpoints: string[]): string | undefined => {
  const kinds = new Set(
    endpoints.map((e) => endpointKinds.find(([suffix]) => e.endsWith(suffix))?.[1] ?? 'unknown'),
  );
  if (kinds.has('chat')) return 'chat';
  return kinds.size === 1 ? [...kinds][0] : kinds.size > 1 ? 'unknown' : undefined;
};

const listedKinds: Readonly<Record<string, string>> = {
  chat: 'chat',
  completion: 'chat',
  completions: 'chat',
  chat_completion: 'chat',
  chat_completions: 'chat',
  responses: 'chat',
  language: 'chat',
  embedding: 'embed',
  embeddings: 'embed',
  embed: 'embed',
  rerank: 'rerank',
  reranker: 'rerank',
  reranking: 'rerank',
  image: 'generate-image',
  image_generation: 'generate-image',
  audio_transcription: 'transcribe',
  transcription: 'transcribe',
  audio_speech: 'generate-speech',
  tts: 'generate-speech',
  moderation: 'moderation',
  moderations: 'moderation',
  realtime: 'realtime',
  decide: 'decide',
};

const namedKinds: Readonly<Record<string, string>> = {
  image: 'generate-image',
  dall: 'generate-image',
  sora: 'generate-video',
  realtime: 'realtime',
  live: 'realtime',
  transcribe: 'transcribe',
  whisper: 'transcribe',
  tts: 'generate-speech',
  embedding: 'embed',
  embed: 'embed',
  rerank: 'rerank',
  reranker: 'rerank',
  moderation: 'moderation',
};

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;

const keyOf = (mode: string) => mode.trim().toLowerCase().replaceAll('-', '_');

/** A `type` is only read when it names a known kind, since some providers put other words there. */
const listedField = (entry: Record<string, unknown>) => {
  const info = entry.model_info;
  const nested =
    typeof info === 'object' && info !== null ? (info as Record<string, unknown>).mode : undefined;
  const named = [entry.kind, entry.mode, nested].find(text);
  if (named) return named;
  return text(entry.type) && Object.hasOwn(listedKinds, keyOf(entry.type)) ? entry.type : undefined;
};

/** The kind a listed mode names: genki's name for it, or the mode itself when it is a valid kind name. */
const kindOfListed = (mode: string): string => {
  const key = keyOf(mode);
  if (Object.hasOwn(listedKinds, key)) return listedKinds[key] as string;
  const slug = key.replaceAll('_', '-');
  return operationKindPattern.test(slug) ? slug : 'unknown';
};

/** What kind of model a /models entry is: its listed mode, then its listed endpoints, then its name, else chat. */
export const discoveredKind = (entry: unknown, name: string): DiscoveredKind => {
  const listed =
    typeof entry === 'object' && entry !== null
      ? listedField(entry as Record<string, unknown>)
      : undefined;
  const endpoints = listedEndpoints(entry);
  const withEndpoints = endpoints.length > 0 ? { endpoints } : {};
  if (listed) return { kind: kindOfListed(listed), from: 'listing', ...withEndpoints };
  const served = kindOfEndpoints(endpoints);
  if (served) return { kind: served, from: 'listing', ...withEndpoints };
  const named = name
    .toLowerCase()
    .split(/[-_.:/\s]+/)
    .flatMap((part) => (Object.hasOwn(namedKinds, part) ? [namedKinds[part] as string] : []));
  return { kind: named[0] ?? 'chat', from: 'name' };
};
