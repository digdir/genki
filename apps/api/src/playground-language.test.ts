import { describe, expect, it } from 'vitest';
import { withAnswerLanguage } from './playground.js';

describe('playground answer language', () => {
  it('forces the chosen answer language through the language guardrail of the draft', () => {
    const definition = { spec: { purpose: 'x', guardrails: { 'require-sources': true } } };
    expect(withAnswerLanguage(definition, 'en')).toEqual({
      spec: {
        purpose: 'x',
        guardrails: { 'require-sources': true, language: { mode: 'en', rewrite: false } },
      },
    });
    expect(withAnswerLanguage(definition, undefined)).toBe(definition);
  });
});
