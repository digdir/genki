import type { PlainKey, T } from './i18n';
import type {
  ApiBindings,
  BuiltInOperation,
  ModelApi,
  ModelOperation,
  OperationKind,
  OperatorModel,
} from './types';

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
};

const builtIns = Object.keys(operationLabel) as BuiltInOperation[];

const isBuiltIn = (kind: ModelOperation): kind is BuiltInOperation =>
  (builtIns as string[]).includes(kind);

export interface KindChoice {
  kind: ModelOperation;
  apis: string[];
  bound?: string;
  maturity?: OperationKind['maturity'];
}

export const offeredOperations = (
  model: Pick<OperatorModel, 'operations' | 'apis'>,
): ModelOperation[] => {
  const kinds = model.operations ?? Object.keys(model.apis ?? {});
  return kinds.length > 0 ? kinds : ['chat'];
};

/** Per kind, the APIs a model may bind: those in a family its connection offers, plus the one it binds. */
export const kindChoices = (
  known: OperationKind[] | undefined,
  apis: ModelApi[] | undefined,
  bound: ApiBindings,
  families: string[] | undefined,
): KindChoice[] => {
  const choices = new Map<ModelOperation, KindChoice>();
  const choiceOf = (kind: ModelOperation) => {
    const found = choices.get(kind) ?? { kind, apis: [] };
    choices.set(kind, found);
    return found;
  };
  for (const api of apis ?? [])
    if (!families || families.includes(api.family)) choiceOf(api.kind).apis.push(api.id);
  for (const [kind, api] of Object.entries(bound)) {
    const choice = choiceOf(kind);
    choice.bound = api;
    if (!choice.apis.includes(api)) choice.apis.push(api);
  }
  for (const k of known ?? []) {
    const choice = choices.get(k.kind);
    if (choice && !isBuiltIn(k.kind)) choice.maturity = k.maturity;
  }
  const all = [...choices.values()].map((c) => ({ ...c, apis: [...c.apis].sort() }));
  return [
    ...builtIns.flatMap((b) => all.filter((c) => c.kind === b)),
    ...all.filter((c) => !isBuiltIn(c.kind)).sort((a, b) => a.kind.localeCompare(b.kind)),
  ];
};

export const rebind = (bound: ApiBindings, kind: ModelOperation, api: string): ApiBindings => {
  const rest = Object.fromEntries(Object.entries(bound).filter(([k]) => k !== kind));
  return api ? { ...rest, [kind]: api } : rest;
};

export const operationName = (kind: ModelOperation, t: T): string => {
  const label = Object.hasOwn(knownKindLabel, kind) ? knownKindLabel[kind] : undefined;
  return label ? t(label) : kind;
};
