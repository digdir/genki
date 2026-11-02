import { describe, expect, it } from 'vitest';
import { definitionSubject } from './definition-subject.js';

const spec = { riskClass: 'limited', model: { primary: 'foundry-openai/gpt-5.6-terra' } };

describe('the subject a test run and a publish share', () => {
  it('ignores who confirmed the risk class and when, which publishing rewrites', () => {
    const draft = {
      ...spec,
      riskConfirmation: { reasons: ['Svarer ansatte'], riskClass: 'limited' },
    };
    const published = {
      ...spec,
      riskConfirmation: {
        reasons: ['Svarer ansatte'],
        riskClass: 'limited',
        by: 'nikolai',
        at: '2026-11-02T15:30:00.000Z',
      },
    };

    expect(definitionSubject(published)).toBe(definitionSubject(draft));
    expect(definitionSubject(published)).toBe(definitionSubject(spec));
  });

  it('changes when anything the service does changes', () => {
    expect(
      definitionSubject({ ...spec, model: { primary: 'foundry-openai/gpt-5.4-mini' } }),
    ).not.toBe(definitionSubject(spec));
  });
});
