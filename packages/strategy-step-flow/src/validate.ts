import type { FlowStep, StepFlowDefinition } from '@genai/definitions';
import type { BlockRegistry } from './blocks.js';
import { leftOfComparison, referencedSteps, stepsIn } from './expressions.js';

export interface FlowProblem {
  path: string;
  message: string;
}

const templated = (value: unknown): boolean =>
  typeof value === 'string'
    ? value.includes('{{')
    : Array.isArray(value)
      ? value.some(templated)
      : typeof value === 'object' && value !== null
        ? Object.values(value).some(templated)
        : false;

export const checkFlow = (flow: StepFlowDefinition, blocks: BlockRegistry): FlowProblem[] => {
  const problems: FlowProblem[] = [];
  const known = new Set<string>();

  const unknownRefs = (refs: string[], vars: Set<string>, path: string, what: string) => {
    for (const ref of refs) {
      if (!known.has(ref) && !vars.has(ref) && ref !== 'loop')
        problems.push({ path, message: `${what} refers to ${ref}, which is not an earlier step` });
    }
  };

  const visit = (steps: FlowStep[], base: string, vars: Set<string>) => {
    steps.forEach((step, i) => {
      const path = `${base}[${i}]`;
      unknownRefs(referencedSteps(step.input ?? {}), vars, `${path}.input`, 'input');
      unknownRefs(referencedSteps(step.params ?? {}), vars, `${path}.params`, 'params');
      if (step.block) {
        const block = blocks.get(step.block);
        if (!block)
          problems.push({ path: `${path}.block`, message: `unknown building block ${step.block}` });
        else if (step.params && !templated(step.params)) {
          const parsed = block.params.safeParse(step.params);
          if (!parsed.success)
            for (const issue of parsed.error.issues)
              problems.push({
                path: `${path}.params.${issue.path.join('.')}`,
                message: issue.message,
              });
        }
      }
      if (step.switchOn) unknownRefs(stepsIn(step.switchOn), vars, `${path}.switchOn`, 'switchOn');
      if (step.forEach) {
        unknownRefs(stepsIn(step.forEach.in), vars, `${path}.forEach.in`, 'forEach');
        visit(step.forEach.steps, `${path}.forEach.steps`, new Set([...vars, step.forEach.as]));
      }
      if (step.repeat) {
        visit(step.repeat.steps, `${path}.repeat.steps`, vars);
        unknownRefs(
          stepsIn(leftOfComparison(step.repeat.until.replace(/^!/, ''))),
          vars,
          `${path}.repeat.until`,
          'until',
        );
      }
      step.cases?.forEach((c, j) => visit(c.steps, `${path}.cases[${j}].steps`, vars));
      if (step.else) visit(step.else, `${path}.else`, vars);
      known.add(step.id);
    });
  };

  visit(flow.spec.steps, 'spec.steps', new Set());
  return problems;
};
