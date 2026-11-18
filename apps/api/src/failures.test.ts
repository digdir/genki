import { describe, expect, it } from 'vitest';
import type { Event } from '@genai/contracts';
import { failureFromError, failureOf, failureReason } from './failures.js';

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

  it('names a model missing from the catalogue as the cause, not a generic failure', () => {
    const missing = failureFromError(
      new Error('step svar failed: no model foundry-openai/gpt-5.6-terra in the catalog', {
        cause: new ModelError('no model foundry-openai/gpt-5.6-terra in the catalog'),
      }),
    );

    expect(missing).toMatchObject({ code: 'model_unavailable', step: 'svar' });
    expect(failureReason(missing)).toBe('Modellen tjenesten bruker, er ikke tilgjengelig nå.');
  });

  it('reads the cause from a kernel error recorded as a generic failure', () => {
    const failure = failureOf([
      {
        type: 'kernel.error',
        audience: 'audit',
        data: { code: 'strategy_error', message: 'no model foundry-openai/x in the catalog' },
      } as Event,
    ]);

    expect(failure?.code).toBe('model_unavailable');
  });
});
