import { describe, expect, it } from 'vitest';
import { findPii } from './pii.js';

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('PII search on adversarial input', () => {
  it('finds e-mail addresses in linear time on long runs of address characters', () => {
    expect(quickly(() => findPii('%'.repeat(100_000), ['email']))).toBeLessThan(1000);
    expect(findPii('Skriv til ola.nordmann@example.no i dag', ['email'])[0]?.value).toBe(
      'ola.nordmann@example.no',
    );
  });
});
