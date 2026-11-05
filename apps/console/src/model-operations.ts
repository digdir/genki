import type { PlainKey, T } from './i18n';
import type { ApiBindings, BuiltInOperation, ModelOperation } from './types';

export const operationLabel: Record<BuiltInOperation, PlainKey> = {
  chat: 'models.operationChat',
  decide: 'models.operationDecide',
};

const knownKindLabel: Record<string, PlainKey> = {
  ...operationLabel,
  classify: 'models.operationClassify',
  embed: 'models.operationEmbed',
  rerank: 'models.operationRerank',
  'generate-image': 'models.operationGenerateImage',
  'generate-speech': 'models.operationGenerateSpeech',
  'transcribe-audio': 'models.operationTranscribeAudio',
  'plain-language': 'models.operationPlainLanguage',
};

export const rebind = (bound: ApiBindings, kind: ModelOperation, api: string): ApiBindings => {
  const rest = Object.fromEntries(Object.entries(bound).filter(([k]) => k !== kind));
  return api ? { ...rest, [kind]: api } : rest;
};

export const operationName = (kind: ModelOperation, t: T): string => {
  const label = Object.hasOwn(knownKindLabel, kind) ? knownKindLabel[kind] : undefined;
  return label ? t(label) : kind;
};
