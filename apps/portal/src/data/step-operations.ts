import type { PlainKey } from '../i18n';
import type { Residency } from '../types';
import type { BlockStep } from './stepflows';

export const callOperation = 'call-operation';

export type OperationFieldType = 'text' | 'number' | 'boolean' | 'choice' | 'list' | 'object';

export interface OperationField {
  name: string;
  type: OperationFieldType;
  required: boolean;
  values?: string[];
}

export interface OperationModel {
  id: string;
  name: string;
  residency: Residency;
  processorRecord: boolean;
}

export interface StepOperation {
  id: string;
  operation: string;
  summary: string;
  status: 'described' | 'typed';
  input: OperationField[];
  media: string[];
  models: OperationModel[];
}

export interface OperationContext {
  operations: StepOperation[] | undefined;
  masking?: boolean | undefined;
}

export const fieldTypeKey: Record<OperationFieldType, PlainKey> = {
  text: 'stepflows.typeText',
  number: 'stepflows.typeNumber',
  boolean: 'stepflows.typeBoolean',
  choice: 'stepflows.typeChoice',
  list: 'stepflows.typeList',
  object: 'stepflows.typeObject',
};

export const operationKindOf = (descriptor: string) => /^[^/]+\/([^@]+)@/.exec(descriptor)?.[1];

export const kindName = (kind: string) => {
  const words = kind.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : kind;
};

const stringParam = (step: BlockStep, name: string) =>
  typeof step.p[name] === 'string' ? (step.p[name] as string) : '';

export const descriptorOf = (step: BlockStep) => stringParam(step, 'descriptor');
export const stepModelOf = (step: BlockStep) => stringParam(step, 'model');

export const isOperationStep = (step: { kind: string; block?: string }) =>
  step.kind === 'block' && step.block === callOperation;

export type CheckState = 'ok' | 'missing' | 'unknown';

export interface OperationCheck {
  id: 'approved' | 'production' | 'masking' | 'processor';
  state: CheckState;
}

export const operationChecks = (step: BlockStep, ctx: OperationContext): OperationCheck[] => {
  const id = descriptorOf(step);
  const found = ctx.operations?.find((o) => o.id === id);
  const listed: CheckState = !id
    ? 'missing'
    : !ctx.operations
      ? 'unknown'
      : found
        ? 'ok'
        : 'missing';
  const model = found?.models.find((m) => m.id === stepModelOf(step));
  const processor: CheckState = !found
    ? listed === 'unknown'
      ? 'unknown'
      : 'missing'
    : model
      ? model.processorRecord
        ? 'ok'
        : 'missing'
      : stepModelOf(step)
        ? 'missing'
        : found.models.some((m) => m.processorRecord)
          ? 'unknown'
          : 'missing';
  return [
    { id: 'approved', state: listed },
    { id: 'production', state: listed },
    {
      id: 'masking',
      state: ctx.masking === undefined ? 'unknown' : ctx.masking ? 'ok' : 'missing',
    },
    { id: 'processor', state: processor },
  ];
};

export const checkText: Record<OperationCheck['id'], PlainKey> = {
  approved: 'stepflows.checkApproved',
  production: 'stepflows.checkProduction',
  masking: 'stepflows.checkMasking',
  processor: 'stepflows.checkProcessor',
};

const descriptorsIn = (definition: unknown): string[] => {
  const found: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const step = value as Record<string, unknown>;
      if (typeof step.block === 'string' && step.block.startsWith(`${callOperation}@`)) {
        const params = step.params as Record<string, unknown> | undefined;
        found.push(typeof params?.descriptor === 'string' ? params.descriptor : '');
      }
      Object.values(step).forEach(visit);
    }
  };
  visit((definition as { spec?: { steps?: unknown } } | undefined)?.spec?.steps);
  return found;
};

export const hasOperationSteps = (definition: unknown) => descriptorsIn(definition).length > 0;

export const operationKindsIn = (definition: unknown): string[] =>
  [
    ...new Set(
      descriptorsIn(definition).flatMap((d) => {
        const kind = operationKindOf(d);
        return kind ? [kind] : [];
      }),
    ),
  ].sort();
