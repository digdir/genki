import { describe, expect, it } from 'vitest';
import { parseInstructionChange } from './improvement.js';

describe('instruction proposals on adversarial input', () => {
  it('finds the JSON object in a reply in linear time', () => {
    const started = performance.now();
    parseInstructionChange('{{'.repeat(100_000), '');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
