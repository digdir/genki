import { describe, expect, it } from 'vitest';
import { withoutTrailingSlashes } from './urls.js';

describe('withoutTrailingSlashes', () => {
  it('drops every trailing slash and keeps the rest', () => {
    expect(withoutTrailingSlashes('https://example.no/api///')).toBe('https://example.no/api');
    expect(withoutTrailingSlashes('https://example.no/api')).toBe('https://example.no/api');
    expect(withoutTrailingSlashes('///')).toBe('');
  });

  it('runs in linear time on long runs of slashes', () => {
    const input = `${'/'.repeat(200_000)}x`;
    const started = performance.now();
    expect(withoutTrailingSlashes(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
