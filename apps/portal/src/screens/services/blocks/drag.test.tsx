// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlocksFullscreen, BlocksStep, useBlocksState } from './BlocksStep';

document.getAnimations ??= () => [];

// jsdom has no pointer capture: these stand in for the browser's, one pointer at a time.
const captured = new Set<number>();
beforeEach(() => {
  captured.clear();
  HTMLElement.prototype.setPointerCapture = vi.fn((id: number) => void captured.add(id));
  HTMLElement.prototype.releasePointerCapture = vi.fn((id: number) => void captured.delete(id));
  HTMLElement.prototype.hasPointerCapture = vi.fn((id: number) => captured.has(id));
});
afterEach(cleanup);

const Split = () => (
  <BlocksStep
    state={useBlocksState()}
    narrow={false}
    collections={[]}
    run={undefined}
    address="ny-tjeneste.genki.no"
    onFullscreen={() => undefined}
  />
);

const Fullscreen = () => (
  <BlocksFullscreen
    state={useBlocksState()}
    run={undefined}
    address="ny-tjeneste.genki.no"
    backHref="#/services/new/blocks"
    onExit={() => undefined}
  />
);

const widthHandle = () =>
  screen.getByRole('separator', {
    name: 'Endre bredden på designelementene ved siden av forhåndsvisningen',
  });
const heightHandle = () =>
  screen.getByRole('separator', { name: 'Endre høyden på forhåndsvisningen' });
const now = (handle: HTMLElement) => Number(handle.getAttribute('aria-valuenow'));

describe('dragging the edge between the blocks and the preview', () => {
  it('starts no text selection, and keeps the pointer until it is let go', () => {
    render(<Split />);
    const handle = widthHandle();
    const notCancelled = fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 400 });
    expect(notCancelled).toBe(false);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    expect(handle.closest('.blocks-split')?.querySelector('[data-dragging]')).toBe(handle);
  });

  it('follows the pointer while the button is held, within its bounds', () => {
    render(<Split />);
    const handle = widthHandle();
    const from = now(handle);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 480 });
    expect(now(handle)).toBe(from + 80);
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 2000 });
    expect(now(handle)).toBe(640);
  });

  it.each([
    ['released', 'pointerUp'],
    ['cancelled by the browser', 'pointerCancel'],
    ['robbed of its capture', 'lostPointerCapture'],
  ] as const)('stops following the pointer once the drag is %s', (_, end) => {
    render(<Split />);
    const handle = widthHandle();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 440 });
    const held = now(handle);
    fireEvent[end](handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 520 });
    expect(now(handle)).toBe(held);
    expect(handle.hasAttribute('data-dragging')).toBe(false);
  });

  it('stops following a pointer whose release the page never saw', () => {
    render(<Split />);
    const handle = widthHandle();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientX: 440 });
    const held = now(handle);
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 0, clientX: 520 });
    expect(now(handle)).toBe(held);
    expect(handle.hasAttribute('data-dragging')).toBe(false);
  });

  it('leaves a right click to the menu', () => {
    render(<Split />);
    const handle = widthHandle();
    expect(fireEvent.pointerDown(handle, { button: 2, pointerId: 1, clientX: 400 })).toBe(true);
    expect(handle.setPointerCapture).not.toHaveBeenCalled();
  });
});

describe('dragging the bottom edge of the preview on its own page', () => {
  it('follows the pointer down and stops when let go', () => {
    render(<Fullscreen />);
    const handle = heightHandle();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 700 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientY: 800 });
    expect(now(handle)).toBe(820);
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, clientY: 900 });
    expect(now(handle)).toBe(820);
  });
});
