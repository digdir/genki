import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from './ranges.js';

describe('address ranges on adversarial input', () => {
  it('reads an IPv6 address with an IPv4 tail in linear time', () => {
    const started = performance.now();
    isPrivateAddress(`::${'0'.repeat(100_000)}`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
  });
});
