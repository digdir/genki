// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Threads } from './Threads.js';
import type { ThreadItem } from './types.js';

document.getAnimations ??= () => [];

const thread: ThreadItem = {
  id: 'dss-regnskap',
  title:
    'Hva rapporteres om regnskap, kostnader og bevilgning i DSS sine årsrapporter for 2022 og 2023?',
  updatedAt: Date.now(),
};

/**
 * jsdom lays nothing out, so nothing is ever cut off. The tests about the cut say what a browser
 * would have measured, on the prototype, and put it back afterwards.
 */
const withWidths = (scrollWidth: number, clientWidth: number) => {
  for (const [name, value] of [
    ['scrollWidth', scrollWidth],
    ['clientWidth', clientWidth],
  ] as const)
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
};

afterEach(() => {
  cleanup();
  for (const name of ['scrollWidth', 'clientWidth'])
    Reflect.deleteProperty(HTMLElement.prototype, name);
  Reflect.deleteProperty(document, 'fonts');
});

const view = (currentId?: string) => (
  <Threads threads={[thread]} threadHref={(t) => `/threads/${t.id}`} currentId={currentId} />
);
const link = () => screen.getByRole('link', { name: thread.title });
const overlay = () => document.querySelector<HTMLElement>('.uib-threads-overlay');

describe('a row whose title is cut off', () => {
  it('has the whole title as its name, whatever is shown', () => {
    render(view());
    expect(link()).toBeTruthy();
  });

  it('gets no tooltip when the title fits', () => {
    render(view());
    expect(link().getAttribute('title')).toBeNull();
  });

  it('shows the whole row in a box when the title is cut, hidden from screen readers', () => {
    withWidths(420, 300);
    render(view());
    fireEvent.pointerEnter(link());
    expect(overlay()?.textContent).toContain(thread.title);
    expect(overlay()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('closes the box when the pointer leaves the row', () => {
    withWidths(420, 300);
    render(view());
    fireEvent.pointerEnter(link());
    fireEvent.pointerLeave(link());
    expect(overlay()).toBeNull();
  });

  it('puts the box inside the link, so a click on it opens the thread', () => {
    withWidths(420, 300);
    render(view());
    fireEvent.pointerEnter(link());
    expect(overlay()?.parentElement).toBe(link());
  });

  it('stays while the pointer moves from the row onto the box, and closes when it leaves the box', () => {
    withWidths(420, 300);
    render(view());
    fireEvent.pointerEnter(link());
    const box = overlay() as HTMLElement;
    fireEvent.pointerLeave(link(), { relatedTarget: box });
    expect(overlay()).toBeTruthy();
    fireEvent.pointerLeave(box, { relatedTarget: document.body });
    expect(overlay()).toBeNull();
  });

  it('opens the box on focus, and closes it with Escape', () => {
    withWidths(420, 300);
    render(view());
    fireEvent.focus(link());
    expect(overlay()).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(overlay()).toBeNull();
  });

  it('takes the first Escape for the box, so a dialog around the panel stays open', () => {
    withWidths(420, 300);
    render(view());
    fireEvent.focus(link());
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(false);
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
  });

  it('lets other keys through while the box is open', () => {
    withWidths(420, 300);
    render(view());
    fireEvent.focus(link());
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(true);
    expect(overlay()).toBeTruthy();
  });

  it('shows no box when the whole title fits', () => {
    withWidths(300, 300);
    render(view());
    fireEvent.pointerEnter(link());
    expect(overlay()).toBeNull();
  });

  it('does not count half a pixel as a cut', () => {
    withWidths(300.5, 300);
    render(view());
    fireEvent.pointerEnter(link());
    expect(overlay()).toBeNull();
  });

  it('measures again when the row becomes the open one, which draws the title bolder', () => {
    withWidths(300, 300);
    const { rerender } = render(view());
    fireEvent.pointerEnter(link());
    expect(overlay()).toBeNull();
    withWidths(420, 300);
    rerender(view(thread.id));
    fireEvent.pointerEnter(link());
    expect(overlay()).toBeTruthy();
  });

  it('measures again once the web font has loaded', async () => {
    let arrive = () => {};
    const ready = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });
    withWidths(300, 300);
    render(view());
    fireEvent.pointerEnter(link());
    expect(overlay()).toBeNull();
    withWidths(420, 300);
    await act(async () => {
      arrive();
      await ready;
    });
    fireEvent.pointerEnter(link());
    expect(overlay()).toBeTruthy();
  });
});
