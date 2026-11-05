import type { PlainKey, T } from './i18n';
import type { BuiltInOperation, ModelOperation, OperationKind, OperatorModel } from './types';

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

export interface OperationChoice {
  kind: ModelOperation;
  builtIn: boolean;
  maturity?: OperationKind['maturity'];
}

export const offeredOperations = (model: Pick<OperatorModel, 'operations'>): ModelOperation[] =>
  model.operations ?? ['chat'];

const speaks = (known: OperationKind | undefined, protocol: string | undefined) =>
  Boolean(protocol) && (known?.descriptors ?? []).some((d) => d.protocol === protocol);

/** The kinds a model may be given: built-in kinds, kinds it offers, and kinds with a descriptor for its protocol. */
export const operationChoices = (
  known: OperationKind[] | undefined,
  offered: ModelOperation[],
  protocol?: string,
): OperationChoice[] => {
  const choices = new Map<ModelOperation, OperationChoice>();
  for (const kind of builtIns) choices.set(kind, { kind, builtIn: true });
  for (const k of known ?? []) {
    if (isBuiltIn(k.kind)) continue;
    if (protocol !== undefined && !speaks(k, protocol) && !offered.includes(k.kind)) continue;
    choices.set(k.kind, { kind: k.kind, builtIn: false, maturity: k.maturity });
  }
  for (const kind of offered)
    if (!choices.has(kind)) choices.set(kind, { kind, builtIn: isBuiltIn(kind) });
  const all = [...choices.values()];
  return [
    ...builtIns.flatMap((b) => all.filter((c) => c.kind === b)),
    ...all.filter((c) => !isBuiltIn(c.kind)).sort((a, b) => a.kind.localeCompare(b.kind)),
  ];
};

export const toggleOperation = (
  offered: ModelOperation[],
  kind: ModelOperation,
  on: boolean,
): ModelOperation[] =>
  on ? (offered.includes(kind) ? offered : [...offered, kind]) : offered.filter((k) => k !== kind);

export const operationName = (kind: ModelOperation, t: T): string => {
  const label = Object.hasOwn(knownKindLabel, kind) ? knownKindLabel[kind] : undefined;
  return label ? t(label) : kind;
};
