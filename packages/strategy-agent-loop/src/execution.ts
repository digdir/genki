import type { Workspace } from './workspace.js';

export interface StepTiming {
  'step-id': string;
  'skill-id': string;
  stage: string;
  'duration-ms': number;
  status: 'ok';
  'loop?'?: true;
}

export interface ExecutionMetadata {
  'total-duration-ms': number;
  'steps-executed': number;
  'step-timings': Record<string, StepTiming>;
  'stage-timings': StepTiming[];
}

const step = (id: string, skill: string, ms: number, loop = false): StepTiming => ({
  'step-id': id,
  'skill-id': skill,
  stage: skill.slice(skill.indexOf('/') + 1),
  'duration-ms': ms,
  status: 'ok',
  ...(loop ? { 'loop?': true as const } : {}),
});

export const executionMetadata = (ms: {
  setup: number;
  react: number;
  finalize: number;
}): ExecutionMetadata => {
  const steps = [
    step('setup', 'builtin/agent-setup', ms.setup),
    step('react', 'builtin/agent-iteration-bundled', ms.react, true),
    step('finalize', 'builtin/agent-finalize', ms.finalize),
  ];
  return {
    'total-duration-ms': ms.setup + ms.react + ms.finalize,
    'steps-executed': steps.length,
    'step-timings': Object.fromEntries(steps.map((s) => [s['step-id'], s])),
    'stage-timings': steps,
  };
};

export const judgedInsufficient = (workspace: Workspace) =>
  [workspace.sufficiencyDecisions.at(-1), workspace.responseValidations.at(-1)].some(
    (d) => d !== undefined && d.status !== 'sufficient',
  );
