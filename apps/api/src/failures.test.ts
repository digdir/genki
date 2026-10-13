import { describe, expect, it } from 'vitest';
import { failureFromError, failureReason } from './failures.js';

class ModelError extends Error {
  override name = 'ModelError';
}

describe('why a run failed', () => {
  it('tells a model that did not answer apart from a step that failed before any model call', () => {
    const model = failureFromError(
      new Error('step skriv failed: 503 from the provider', { cause: new ModelError('503') }),
    );
    const step = failureFromError(new Error('step finn failed: input.aar is required'));

    expect(model).toMatchObject({ code: 'model_error', step: 'skriv' });
    expect(failureReason(model)).toBe('Vi fikk ikke svar fra modellen.');
    expect(step).toEqual({
      code: 'strategy_error',
      step: 'finn',
      message: 'step finn failed: input.aar is required',
    });
    expect(failureReason(step)).toBe('Steget «finn» feilet. Tjenesten feilet underveis.');
  });
});
