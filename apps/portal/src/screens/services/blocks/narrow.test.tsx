// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BlocksStep, useBlocksState } from './BlocksStep';

document.getAnimations ??= () => [];

const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
afterEach(() => {
  cleanup();
  if (own) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', own);
});

const Harness = ({ narrow }: { narrow: boolean }) => (
  <BlocksStep
    state={useBlocksState()}
    narrow={narrow}
    collections={[]}
    run={undefined}
    address="ny-tjeneste.genki.no"
    onFullscreen={() => undefined}
  />
);

const switcher = () => screen.getByRole('group', { name: 'Byggeklosser og maler' });
const wraps = '.blocks-left[data-narrow] .blocks-switcher';

describe('the Grensesnitt tab on a narrow screen', () => {
  it('lets the switcher wrap there only, not beside the preview', () => {
    const { rerender } = render(<Harness narrow />);
    expect(switcher().matches(wraps)).toBe(true);
    rerender(<Harness narrow={false} />);
    expect(switcher().matches(wraps)).toBe(false);
  });

  it('measures the switcher again when the screen widens, so the column fits it on one line', () => {
    // jsdom lays nothing out: the switcher is 250 px wide wrapped and 400 px on one line.
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.classList.contains('blocks-switcher')) return 0;
        return this.closest('[data-narrow]') ? 250 : 400;
      },
    });
    const { rerender } = render(<Harness narrow />);
    rerender(<Harness narrow={false} />);
    const handle = screen.getByRole('separator', {
      name: 'Endre bredden på klossene ved siden av forhåndsvisningen',
    });
    expect(handle.getAttribute('aria-valuemin')).toBe('400');
  });
});
