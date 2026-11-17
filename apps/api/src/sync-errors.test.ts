import { describe, expect, it } from 'vitest';
import { redactSecrets } from './sync-errors.js';

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('sync error redaction', () => {
  it('replaces every copy of the connection secret', () => {
    expect(redactSecrets('key abc123 refused, abc123 again', ['abc123'])).toBe(
      'key [redacted] refused, [redacted] again',
    );
  });

  it('replaces a bearer token even when the secret is unknown', () => {
    expect(redactSecrets('sent Authorization: Bearer xyz.987; refused', [])).toBe(
      'sent Authorization: Bearer [redacted]; refused',
    );
  });

  it('replaces long token-shaped strings and keeps ordinary text', () => {
    expect(
      redactSecrets('the tool server answered HTTP 503 for eyJhbGciOiJIUzI1NiJ9abcdefghijkl', []),
    ).toBe('the tool server answered HTTP 503 for [redacted]');
  });

  it('runs in linear time on long runs of token characters and spaces', () => {
    expect(
      quickly(() => redactSecrets('a'.repeat(31) + ' '.repeat(1) + 'a'.repeat(100_000), [])),
    ).toBeLessThan(1000);
    expect(quickly(() => redactSecrets('Bearer' + ' '.repeat(100_000), []))).toBeLessThan(1000);
    expect(quickly(() => redactSecrets('a!'.repeat(100_000), []))).toBeLessThan(1000);
  });
});
