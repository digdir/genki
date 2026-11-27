import { createFormat } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { parseAmount } from './parts';

describe('amounts typed by an operator', () => {
  it('reads a decimal comma and spaces in bokmål', () => {
    expect(parseAmount('62,5', createFormat('nb'))).toBe(62.5);
    expect(parseAmount('200 000', createFormat('nb'))).toBe(200_000);
  });

  it('reads commas as thousands separators in English', () => {
    expect(parseAmount('1,500', createFormat('en'))).toBe(1500);
    expect(parseAmount('62.5', createFormat('en'))).toBe(62.5);
  });

  it('refuses text, signs and ambiguous separators', () => {
    expect(parseAmount('', createFormat('nb'))).toBeUndefined();
    expect(parseAmount('-5', createFormat('nb'))).toBeUndefined();
    expect(parseAmount('1,5', createFormat('en'))).toBeUndefined();
    expect(parseAmount('ti', createFormat('nb'))).toBeUndefined();
  });

  it('answers in linear time on a long adversarial string', () => {
    const started = performance.now();
    parseAmount(`${'1,'.repeat(50_000)}x`, createFormat('en'));
    expect(performance.now() - started).toBeLessThan(200);
  });
});
