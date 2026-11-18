// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchStatus, SearchSteps } from './SearchSteps.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

const texts = {
  min: (n: number) => `min ${n}`,
  none: 'none',
  count: (n: number, total: number) => `${n}/${total}`,
};

describe('the search parts shared by Sources and the conversation', () => {
  it('say nothing before the reader types, then too few, none, or which of how many, in the block’s words', () => {
    expect(searchStatus(texts, '', 0, 0)).toBe('');
    expect(searchStatus(texts, ' a ', 0, 0)).toBe('min 2');
    expect(searchStatus(texts, 'nkom', 0, 0)).toBe('none');
    expect(searchStatus(texts, 'nkom', 5, 1)).toBe('2/5');
  });

  it('draw no steps before a match, and keep focus on a step at an end', () => {
    const onStep = vi.fn();
    const steps = (hitCount: number, currentHitIndex: number) => (
      <SearchSteps
        hitCount={hitCount}
        currentHitIndex={currentHitIndex}
        onStep={onStep}
        previous="Forrige"
        next="Neste"
        previousName="Forrige treff"
        nextName="Neste treff"
      />
    );
    const { rerender } = render(steps(0, 0));
    expect(screen.queryByRole('button')).toBeNull();
    rerender(steps(2, 0));
    const previous = screen.getByRole('button', { name: 'Forrige treff' });
    expect(previous.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(previous);
    fireEvent.click(screen.getByRole('button', { name: 'Neste treff' }));
    expect(onStep.mock.calls).toEqual([[1]]);
  });
});
