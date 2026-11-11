// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Shell, type ShellProps } from './Shell.js';

// The cards frame of the design's dev-navbar board. jsdom does no layout: the sums are in
// layout.test.ts, and this holds the markup the stylesheet draws from.

beforeEach(() => {
  window.matchMedia = ((media: string) => ({
    media,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    get: () => 1720,
  });
});
afterEach(cleanup);

const draw = (props: Partial<ShellProps> = {}) =>
  render(
    <Shell
      primary={{
        label: 'Tråder og filter',
        title: 'Tråder',
        children: <a href="/t/1">En tråd</a>,
        foot: <button type="button">Simen Strøm Braaten</button>,
        footPinned: true,
        railFoot: <button type="button">SB</button>,
      }}
      secondary={{ label: 'Kilder', title: 'Verktøy', children: <a href="#k">Kilde 1</a> }}
      frame="cards"
      mainTitle="Hindre for KI i staten"
      {...props}
    >
      <p>Samtalen</p>
    </Shell>,
  );

const shell = () => document.querySelector('.uib-shell');
const primary = () => screen.getByRole('navigation', { name: 'Tråder og filter' });

describe('the cards frame', () => {
  it('is marked for the stylesheet only when asked for, and the flush frame stays the default', () => {
    draw();
    expect(shell()?.getAttribute('data-frame')).toBe('cards');
    cleanup();
    draw({ frame: undefined });
    expect(shell()?.hasAttribute('data-frame')).toBe(false);
  });

  it('titles each panel with an h2 on its head row, and the main column with the page’s one h1', () => {
    draw({ secondary: { label: 'Kilder', title: 'Verktøy', defaultCollapsed: false } });
    expect(within(primary()).getByRole('heading', { level: 2, name: 'Tråder' })).toBeTruthy();
    const tools = screen.getByRole('complementary', { name: 'Kilder' });
    expect(within(tools).getByRole('heading', { level: 2, name: 'Verktøy' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
      'Hindre for KI i staten',
    ]);
    // One look for every title, so they stand alike and on one line.
    for (const title of document.querySelectorAll('h1, h2'))
      expect(title.classList.contains('uib-shell-title')).toBe(true);
  });

  it('pins the main column’s title over the whole card, outside the reading width, first in the region', () => {
    draw();
    const main = screen.getByRole('main');
    const head = main.firstElementChild;
    expect(head?.classList.contains('uib-shell-pinned')).toBe(true);
    expect(head?.querySelector('h1')?.textContent).toBe('Hindre for KI i staten');
    expect(main.querySelector('.uib-shell-column h1')).toBeNull();
  });

  it('keeps the main column’s title in the reading width in the flush frame', () => {
    draw({ frame: 'flush' });
    expect(screen.getByRole('main').querySelector('.uib-shell-column h1')?.textContent).toBe(
      'Hindre for KI i staten',
    );
  });

  it('draws the panel’s button as an icon in a card, named as before, where the flush frame shows «Skjul»', () => {
    draw();
    const hide = screen.getByRole('button', { name: 'Skjul tråder og filter' });
    expect(hide.textContent).toBe('');
    expect(hide.getAttribute('data-size')).toBe('md');
    cleanup();
    draw({ frame: 'flush' });
    expect(screen.getByRole('button', { name: 'Skjul tråder og filter' }).textContent).toBe(
      'Skjul',
    );
  });

  it('keeps the pinned foot under what scrolls, so a focused row is never under it (WCAG 2.4.11)', () => {
    draw();
    const foot = primary().querySelector('.uib-shell-box > .uib-shell-foot');
    expect(foot?.textContent).toBe('Simen Strøm Braaten');
    expect(primary().querySelector('.uib-shell-content .uib-shell-foot')).toBeNull();
  });

  it('shows only the buttons at the top and the rail foot at the bottom when folded', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Skjul tråder og filter' }));
    expect(within(primary()).queryByRole('heading', { name: 'Tråder' })).toBeNull();
    expect(within(primary()).queryByText('Simen Strøm Braaten')).toBeNull();
    const railFoot = primary().querySelector('.uib-shell-rail-foot');
    expect(railFoot?.textContent).toBe('SB');
    expect(railFoot?.parentElement?.lastElementChild).toBe(railFoot);
  });

  it('draws no rail foot on an open panel', () => {
    draw();
    expect(document.querySelector('.uib-shell-rail-foot')).toBeNull();
  });
});
