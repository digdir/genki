import { describe, expect, it } from 'vitest';
import { evaluateCondition, leftOfComparison, render, type Scope } from './expressions.js';

const scope = (input: Record<string, unknown> = {}): Scope => ({
  input,
  config: {},
  vars: {},
  steps: {},
});

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('step-flow expressions on adversarial input', () => {
  it('evaluates a condition in linear time', () => {
    expect(
      quickly(() => evaluateCondition(`input.a${'\t'.repeat(100_000)}x`, scope())),
    ).toBeLessThan(1000);
    expect(evaluateCondition('input.n >= 2', scope({ n: 3 }))).toBe(true);
    expect(evaluateCondition('input.n != 3', scope({ n: 3 }))).toBe(false);
  });

  it('renders templates in linear time', () => {
    expect(quickly(() => render(`{{{{${'\t'.repeat(100_000)}`, scope()))).toBeLessThan(1000);
    expect(render('Hei {{ input.name }}!', scope({ name: 'Kari' }))).toBe('Hei Kari!');
  });

  it('finds the left side of a comparison in linear time', () => {
    expect(quickly(() => leftOfComparison(`a${'\t'.repeat(100_000)}`))).toBeLessThan(1000);
    expect(leftOfComparison('steps.check.done == true')).toBe('steps.check.done');
  });
});
