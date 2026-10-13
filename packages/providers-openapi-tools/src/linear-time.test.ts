import { describe, expect, it } from 'vitest';
import { operationSlug } from './document.js';

describe('operation slugs on adversarial input', () => {
  it('makes a slug in linear time from a path full of separators', () => {
    const started = performance.now();
    operationSlug('get', `/${'_'.repeat(100_000)}x`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(operationSlug('get', '/users/{id}/')).toBe('get_users_id');
  });
});
