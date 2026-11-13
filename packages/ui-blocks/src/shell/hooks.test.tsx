// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMedia } from './hooks.js';

const own = Object.getOwnPropertyDescriptor(window, 'matchMedia');
afterEach(() => {
  if (own) Object.defineProperty(window, 'matchMedia', own);
  else Reflect.deleteProperty(window, 'matchMedia');
});

describe('the shell’s media queries', () => {
  it('match nothing where the page has no matchMedia, as a host’s test DOM has none', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    const { result } = renderHook(() => useMedia('(max-width: 774px)'));
    expect(result.current).toBe(false);
  });

  it('follow matchMedia where the page has it', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (media: string) => ({
        media,
        matches: true,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    const { result } = renderHook(() => useMedia('(max-width: 774px)'));
    expect(result.current).toBe(true);
  });
});
