import type { FlowStep, ServiceDefinition, StepFlowDefinition } from './schema.js';
import type { ValidationError } from './validate.js';

type StrategyRef = ServiceDefinition['spec']['strategy'];

export const missingDatasetProblems = (
  service: ServiceDefinition,
  needsDataset: (strategy: StrategyRef) => boolean,
): ValidationError[] => {
  if (service.spec.knowledge.datasets.length > 0) return [];
  const strategies = [
    { strategy: service.spec.strategy, path: 'spec.strategy' },
    ...service.spec.variants.flatMap((v, i) =>
      typeof v !== 'string' && v.strategy
        ? [{ strategy: v.strategy, path: `spec.variants[${i}].strategy` }]
        : [],
    ),
  ];
  return strategies
    .filter(({ strategy }) => needsDataset(strategy))
    .map(({ strategy, path }) => ({
      path,
      message: `${strategy.id} searches a dataset, and spec.knowledge.datasets is empty`,
    }));
};

const allSteps = (steps: FlowStep[]): FlowStep[] =>
  steps.flatMap((s) => [
    s,
    ...allSteps([
      ...(s.repeat?.steps ?? []),
      ...(s.forEach?.steps ?? []),
      ...(s.cases ?? []).flatMap((c) => c.steps),
      ...(s.else ?? []),
    ]),
  ]);

export const flowDatasetProblems = (
  service: ServiceDefinition,
  flow: StepFlowDefinition,
  ref: string,
  needsDataset: (block: string) => boolean,
): ValidationError[] => {
  if (service.spec.knowledge.datasets.length > 0) return [];
  return allSteps(flow.spec.steps)
    .filter((s) => s.block !== undefined && needsDataset(s.block))
    .map((s) => ({
      path: 'spec.knowledge.datasets',
      message: `the step flow ${ref} searches a dataset in step ${s.id} (${s.block}), and spec.knowledge.datasets is empty`,
    }));
};
