import type { PlainKey, T } from './i18n';
import type { BuiltInOperation, ModelOperation, OperationKind, OperatorModel } from './types';

export const operationLabel: Record<BuiltInOperation, PlainKey> = {
  chat: 'models.operationChat',
  decide: 'models.operationDecide',
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

export const operationChoices = (
  known: OperationKind[] | undefined,
  offered: ModelOperation[],
): OperationChoice[] => {
  const choices = new Map<ModelOperation, OperationChoice>();
  for (const kind of builtIns) choices.set(kind, { kind, builtIn: true });
  for (const k of known ?? [])
    choices.set(
      k.kind,
      isBuiltIn(k.kind)
        ? { kind: k.kind, builtIn: true }
        : { kind: k.kind, builtIn: false, maturity: k.maturity },
    );
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

export const operationName = (kind: ModelOperation, t: T): string =>
  isBuiltIn(kind) ? t(operationLabel[kind]) : kind;
