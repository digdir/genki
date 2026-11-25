import { describe, expect, it } from 'vitest';
import { addUsage } from './usage-sum.js';

describe('addUsage', () => {
  it('adds cache writes like the other counted usage', () => {
    expect(
      addUsage(
        { inputTokens: 2000, cachedInputTokens: 500, cacheWriteTokens: 1200 },
        { inputTokens: 400, cacheWriteTokens: 300 },
      ),
    ).toEqual({ inputTokens: 2400, cachedInputTokens: 500, cacheWriteTokens: 1500 });
  });
});
