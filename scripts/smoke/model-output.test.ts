import { describe, expect, it } from 'vitest';
import { modelOutputOf } from './model-output.ts';

describe('model output', () => {
  it('takes the structured output and cost from the result message', () => {
    expect(
      modelOutputOf([
        { type: 'assistant' },
        { type: 'result', structured_output: { checks: [] }, total_cost_usd: 0.42 },
      ]),
    ).toEqual({ output: { checks: [] }, costUsd: 0.42 });
  });

  it('falls back to the result text when it is JSON', () => {
    expect(modelOutputOf([{ type: 'result', result: '{"findings":[]}' }])).toEqual({
      output: { findings: [] },
      costUsd: null,
    });
  });

  it('gives empty output for a run without a usable result', () => {
    expect(modelOutputOf([{ type: 'result', result: 'not json' }]).output).toEqual({});
    expect(modelOutputOf({ type: 'result' })).toEqual({ output: {}, costUsd: null });
  });
});
