import { describe, expect, it } from 'vitest';
import { kernelOwnedEventTypes, strategyEventTypes, textPart } from './index.js';

describe('contracts', () => {
  it('builds a tagged plain text part', () => {
    expect(textPart('hei')).toEqual({ mime: 'text/plain', body: { kind: 'text', text: 'hei' } });
  });

  it('keeps every core event type in the kernel namespace', () => {
    expect(
      [...strategyEventTypes, ...kernelOwnedEventTypes].every((t) => t.startsWith('kernel.')),
    ).toBe(true);
  });

  it('never lets a strategy emit an event the kernel owns', () => {
    const owned = new Set<string>(kernelOwnedEventTypes);
    expect(strategyEventTypes.some((t) => owned.has(t))).toBe(false);
  });
});
