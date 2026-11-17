import { describe, expect, it } from 'vitest';
import { byPath } from './blob.js';

describe('blob listings', () => {
  it('are in code-point order on every machine, where a Norwegian locale would put aa after b', () => {
    const paths = ['3fbbbb', '3faaaa', '40aaaa', '3fa'].map((path) => ({ path }));
    expect(paths.sort(byPath).map((p) => p.path)).toEqual(['3fa', '3faaaa', '3fbbbb', '40aaaa']);
  });
});
