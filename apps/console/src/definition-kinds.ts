import type { PlainKey } from './i18n';

export type DefinitionKind = 'Service' | 'StepFlow' | 'Skill' | 'Block';

export const definitionKindParams: Record<DefinitionKind, string> = {
  Service: 'service',
  StepFlow: 'step-flow',
  Skill: 'skill',
  Block: 'block',
};

export const definitionKindSegments: Record<DefinitionKind, string> = {
  Service: 'services',
  StepFlow: 'step-flows',
  Skill: 'skills',
  Block: 'blocks',
};

export const definitionKindOfParam = (param: string | null): DefinitionKind =>
  (Object.keys(definitionKindParams) as DefinitionKind[]).find(
    (kind) => definitionKindParams[kind] === param,
  ) ?? 'Service';

export const definitionKindLabels: Record<DefinitionKind, PlainKey> = {
  Service: 'tenantServices.kindService',
  StepFlow: 'tenantServices.kindStepFlow',
  Skill: 'tenantServices.kindSkill',
  Block: 'tenantServices.kindBlock',
};
