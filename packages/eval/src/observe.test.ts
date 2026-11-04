import { describe, expect, it } from 'vitest';
import { textPart, type Event } from '@genai/contracts';
import { defaultObserve } from './observe.js';

describe('observing a run', () => {
  it('records the decisions a run made next to its answer', () => {
    const notice = (data: unknown) =>
      ({ seq: 1, ts: '2026-11-03T12:00:00.000Z', type: 'kernel.notice', data }) as Event;
    const observed = defaultObserve(
      [textPart('Svar')],
      [
        notice({
          kind: 'decision',
          rule: 'purpose-check',
          operation: 'decide',
          question: 'within_purpose',
          answer: 'within',
          probability: 0.93,
          refusal: false,
          outcome: 'continue',
        }),
        notice({ kind: 'retrieval', hits: [] }),
      ],
    );
    expect(observed.decisions).toEqual([
      {
        rule: 'purpose-check',
        question: 'within_purpose',
        answer: 'within',
        probability: 0.93,
        refusal: false,
        outcome: 'continue',
      },
    ]);
    expect(defaultObserve([textPart('Svar')], [])).not.toHaveProperty('decisions');
  });
});
