// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlocksFullscreen, useBlocksState } from './BlocksStep';

document.getAnimations ??= () => [];

afterEach(cleanup);

const onExit = vi.fn();

const Harness = () => (
  <BlocksFullscreen
    state={useBlocksState()}
    chat={null}
    address="ny-tjeneste.genki.no"
    backHref="#/services/new/blocks"
    onExit={onExit}
  />
);

const frame = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('.service-preview-frame');

describe('the preview on its own page', () => {
  it('starts 720 px tall and changes height with the arrow keys within 480 to 1400 px', () => {
    const { container } = render(<Harness />);
    const handle = screen.getByRole('separator', { name: 'Endre høyden på forhåndsvisningen' });
    expect(frame(container)?.style.height).toBe('720px');
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(frame(container)?.style.height).toBe('760px');
    for (let i = 0; i < 20; i++) fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(frame(container)?.style.height).toBe('480px');
    for (let i = 0; i < 40; i++) fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(handle.getAttribute('aria-valuenow')).toBe('1400');
  });

  it('has a button that leaves the larger view', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Vis mindre' }));
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('links back to the builder', () => {
    render(<Harness />);
    expect(screen.getByRole('link', { name: 'Tilbake til byggeren' }).getAttribute('href')).toBe(
      '#/services/new/blocks',
    );
  });
});
