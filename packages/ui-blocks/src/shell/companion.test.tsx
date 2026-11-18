// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Shell, type ShellProps } from './Shell.js';

// A panel's companion column, the design's filter beside the threads (dev-filter-panel). jsdom does
// no layout: this holds the markup and the width the stylesheet draws from.

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
        size: { width: 660, minWidth: 660 },
        companion: {
          label: 'Filter for tråden',
          title: 'Filter',
          subtitle: 'Gjelder neste spørsmål',
          width: 440,
          children: <button type="button">Fjern alle filtre</button>,
        },
      }}
      frame="cards"
      mainSize={{ minWidth: 600 }}
      {...props}
    >
      <p>Samtalen</p>
    </Shell>,
  );

const primary = () => screen.getByRole('navigation', { name: 'Tråder og filter' });
const companion = () => screen.getByRole('region', { name: 'Filter for tråden' });

describe('a panel’s companion column', () => {
  it('stands in the panel’s card as a region with its own title and subtitle', () => {
    draw();
    expect(primary().contains(companion())).toBe(true);
    expect(within(companion()).getByRole('heading', { level: 2, name: 'Filter' })).toBeTruthy();
    expect(within(companion()).getByText('Gjelder neste spørsmål')).toBeTruthy();
    expect(within(primary()).getByRole('heading', { level: 2, name: 'Tråder' })).toBeTruthy();
  });

  it('leaves the panel’s own column its design width less the companion’s', () => {
    draw();
    const box = primary().querySelector('.uib-shell-box') as HTMLElement;
    expect(box.hasAttribute('data-companion')).toBe(true);
    expect(box.style.getPropertyValue('--uib-shell-lead-width')).toBe('220px');
  });

  it('keeps its own width when it asks to, so the panel’s own column takes every resize', () => {
    const narrow = {
      label: 'Tråder og filter',
      title: 'Tråder',
      children: <a href="/t/1">En tråd</a>,
      size: { width: 660, minWidth: 450 },
      companion: { label: 'Filter for tråden', width: 230, keepWidth: true },
    };
    draw({ primary: narrow });
    const box = () => primary().querySelector('.uib-shell-box') as HTMLElement;
    expect(box().style.getPropertyValue('--uib-shell-lead-width')).toBe('calc(100% - 230px)');
    const edge = screen.getByRole('separator', { name: 'Endre bredde på tråder og filter' });
    fireEvent.keyDown(edge, { key: 'ArrowLeft', shiftKey: true });
    expect(edge.getAttribute('aria-valuenow')).toBe('596');
    expect(box().style.getPropertyValue('--uib-shell-lead-width')).toBe('calc(100% - 230px)');
  });

  it('gives the panel’s own column a fixed width by default, so the companion takes every resize', () => {
    draw();
    const box = () => primary().querySelector('.uib-shell-box') as HTMLElement;
    const edge = screen.getByRole('separator', { name: 'Endre bredde på tråder og filter' });
    fireEvent.keyDown(edge, { key: 'ArrowRight', shiftKey: true });
    expect(edge.getAttribute('aria-valuenow')).toBe('724');
    expect(box().style.getPropertyValue('--uib-shell-lead-width')).toBe('220px');
  });

  it('takes the panel’s button onto its row, which folds both columns', () => {
    draw();
    const button = within(companion()).getByRole('button', { name: 'Skjul tråder og filter' });
    expect(button.getAttribute('aria-controls')?.split(' ')).toHaveLength(2);
    fireEvent.click(button);
    expect(screen.queryByRole('region', { name: 'Filter for tråden' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Vis tråder og filter' })).toBeTruthy();
  });

  it('changes nothing for a panel without one', () => {
    draw({ primary: { label: 'Tråder og filter', title: 'Tråder', children: <p>Tråder</p> } });
    expect(primary().querySelector('[data-companion]')).toBeNull();
    expect(primary().querySelector('.uib-shell-companion')).toBeNull();
  });
});
