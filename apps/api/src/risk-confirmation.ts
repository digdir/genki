import type { Definition, ServiceDefinition, ValidationError } from '@genai/definitions';

type RiskClass = ServiceDefinition['spec']['riskClass'];

export const confirmedClasses: readonly RiskClass[] = ['limited', 'high'];

export const isService = (definition: unknown): definition is ServiceDefinition =>
  typeof definition === 'object' &&
  definition !== null &&
  (definition as { kind?: unknown }).kind === 'Service';

export const needsRiskConfirmation = (definition: unknown): definition is ServiceDefinition =>
  isService(definition) && confirmedClasses.includes(definition.spec.riskClass);

export const riskConfirmationProblems = (definition: Definition): ValidationError[] => {
  if (!needsRiskConfirmation(definition)) return [];
  const { riskClass, riskConfirmation } = definition.spec;
  if (!riskConfirmation)
    return [
      {
        path: 'spec.riskConfirmation',
        message: `risk class ${riskClass} must be confirmed by a person with the publish right before publishing`,
      },
    ];
  if (riskConfirmation.riskClass !== undefined && riskConfirmation.riskClass !== riskClass)
    return [
      {
        path: 'spec.riskConfirmation',
        message: `the confirmation is for risk class ${riskConfirmation.riskClass}, but the service is ${riskClass}; confirm the risk class again`,
      },
    ];
  return [];
};

const recordsUnmaskedInput = (definition: Definition): definition is ServiceDefinition =>
  isService(definition) && (definition.spec.riskConfirmation?.unmaskedInput?.length ?? 0) > 0;

export const confirmedAs = (definition: Definition, actor: string, now: Date): Definition => {
  if (!needsRiskConfirmation(definition) && !recordsUnmaskedInput(definition)) return definition;
  const confirmation = definition.spec.riskConfirmation;
  if (!confirmation) return definition;
  return {
    ...definition,
    spec: {
      ...definition.spec,
      riskConfirmation: {
        reasons: confirmation.reasons,
        riskClass: definition.spec.riskClass,
        ...(confirmation.unmaskedInput?.length
          ? { unmaskedInput: confirmation.unmaskedInput }
          : {}),
        by: actor,
        at: now.toISOString(),
      },
    },
  };
};
