// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Threads, type ThreadsProps } from './Threads.js';
import type { ThreadItem } from './types.js';

document.getAnimations ??= () => [];

// A fixed clock, with one thread from today and one from last week, so the rows fall in two groups.
beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 10, 11, 14), toFake: ['Date'] });
});
const threads: ThreadItem[] = [
  { id: 'a', title: 'Hindre for KI i staten', updatedAt: new Date(2026, 10, 11, 9) },
  {
    id: 'b',
    title: 'Retningslinjer for generativ KI',
    updatedAt: new Date(2026, 10, 8, 9),
    dataset: 'Kudos',
  },
];

const draw = (props: Partial<ThreadsProps> = {}) =>
  render(
    <Threads
      threads={threads}
      threadHref={(thread) => `/threads/${thread.id}`}
      newThreadHref="/"
      onRename={() => {}}
      onDelete={() => {}}
      {...props}
    />,
  );
const root = () => document.querySelector<HTMLElement>('.uib-threads');
const newThread = () => screen.getByRole('link', { name: 'Ny tråd' });
const row = (title: string) => screen.getByRole('link', { name: title });

/** jsdom lays nothing out, so these tests set what a browser would have measured. */
const withSizes = (
  sizes: Record<'scrollWidth' | 'clientWidth' | 'scrollHeight' | 'clientHeight', number>,
) => {
  for (const [name, value] of Object.entries(sizes))
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const name of ['scrollWidth', 'clientWidth', 'scrollHeight', 'clientHeight'])
    Reflect.deleteProperty(HTMLElement.prototype, name);
});

describe('kunnskapsassistenten’s list, the default', () => {
  it('keeps the search, a time under each title, the pencil on «Ny tråd» and small links', () => {
    draw();
    expect(screen.getByRole('searchbox', { name: 'Søk i tråder' })).toBeTruthy();
    expect(document.querySelectorAll('.uib-threads time')).toHaveLength(2);
    expect(newThread().querySelector('svg')).toBeTruthy();
    expect(row('Hindre for KI i staten').getAttribute('data-size')).toBe('sm');
    expect(root()?.hasAttribute('data-variant')).toBe(false);
    expect(document.querySelector('.uib-threads-groups')).toBeNull();
  });

  it('counts only a title cut at its end, not one taller than its line', () => {
    withSizes({ scrollWidth: 300, clientWidth: 300, scrollHeight: 60, clientHeight: 24 });
    draw();
    fireEvent.pointerEnter(row('Hindre for KI i staten'));
    expect(document.querySelector('.uib-threads-overlay')).toBeNull();
  });
});

describe('the list without its search, `search={false}`', () => {
  it('draws no «Søk i tråder» and no count of matches', () => {
    draw({ search: false });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(document.querySelector('.uib-threads-search-status')).toBeNull();
    expect(row('Hindre for KI i staten')).toBeTruthy();
  });
});

describe('the design’s list, `variant="nav"`', () => {
  it('draws no time under a title, and the collection only when the host names one', () => {
    draw({ variant: 'nav' });
    expect(document.querySelector('.uib-threads time, .uib-threads-time')).toBeNull();
    expect(row('Hindre for KI i staten').querySelector('.uib-threads-meta')).toBeNull();
    expect(row('Retningslinjer for generativ KI').textContent).toContain('Kudos');
  });

  it('names each row by its title alone, as before', () => {
    draw({ variant: 'nav' });
    expect(row('Retningslinjer for generativ KI').getAttribute('aria-labelledby')).toBeTruthy();
  });

  it('draws «Ny tråd» as its words alone, with no icon', () => {
    draw({ variant: 'nav' });
    expect(newThread().textContent).toBe('Ny tråd');
    expect(newThread().querySelector('svg')).toBeNull();
  });

  it('keeps «Ny tråd» in a row of its own above the list, which the list scrolls under', () => {
    draw({ variant: 'nav' });
    expect(newThread().parentElement?.className).toBe('uib-threads-top');
    expect(newThread().parentElement?.parentElement).toBe(root());
    cleanup();
    draw();
    expect(newThread().parentElement).toBe(root());
  });

  it('holds the groups in one list, in order, each with its heading over its rows', () => {
    draw({ variant: 'nav' });
    expect(root()?.getAttribute('data-variant')).toBe('nav');
    const list = document.querySelector<HTMLElement>('.uib-threads-groups') as HTMLElement;
    expect(
      within(list)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['I dag', 'Siste 7 dager']);
  });

  it('keeps the rows at the panel’s size, not a small link’s, so the spacing is the panel’s', () => {
    draw({ variant: 'nav' });
    expect(row('Hindre for KI i staten').hasAttribute('data-size')).toBe(false);
  });

  it('keeps each row’s «…» menu, by its title, for the keyboard and screen readers', () => {
    draw({ variant: 'nav' });
    expect(
      screen.getByRole('button', { name: 'Flere valg for Hindre for KI i staten' }),
    ).toBeTruthy();
  });

  it('marks the open row as the page, as before', () => {
    draw({ variant: 'nav', currentId: 'a' });
    expect(row('Hindre for KI i staten').getAttribute('aria-current')).toBe('page');
  });

  it('shows the whole title in a box the row’s width when its lines cut it off', () => {
    withSizes({ scrollWidth: 172, clientWidth: 172, scrollHeight: 72, clientHeight: 48 });
    draw({ variant: 'nav' });
    const link = row('Hindre for KI i staten');
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(new DOMRect(28, 222, 196, 56));
    fireEvent.pointerEnter(link);
    const box = document.querySelector<HTMLElement>('.uib-threads-overlay');
    expect(box?.textContent).toContain('Hindre for KI i staten');
    expect(box?.style.inlineSize).toBe('196px');
    expect(box?.style.maxInlineSize).toBe('');
    expect(box?.hasAttribute('data-size')).toBe(false);
  });

  it('keeps the box inside the list’s scrolling region, up from a row at its end, so it never covers what is pinned under the list', () => {
    withSizes({ scrollWidth: 172, clientWidth: 172, scrollHeight: 120, clientHeight: 48 });
    // The list scrolls in the panel above its pinned foot, as the shell's primary panel draws it.
    render(
      <div className="scroller" style={{ overflowY: 'auto' }}>
        <Threads
          threads={threads}
          threadHref={(thread) => `/threads/${thread.id}`}
          newThreadHref="/"
          variant="nav"
        />
      </div>,
    );
    const scroller = document.querySelector('.scroller') as HTMLElement;
    const link = row('Retningslinjer for generativ KI');
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    rect.mockImplementation(function (this: HTMLElement) {
      if (this === scroller) return new DOMRect(16, 112, 220, 973);
      if (this === link) return new DOMRect(28, 970, 196, 74);
      // The whole title on six lines, taller than its row.
      if (this.classList.contains('uib-threads-overlay')) return new DOMRect(28, 970, 196, 146);
      return new DOMRect();
    });
    try {
      fireEvent.pointerEnter(link);
      const box = document.querySelector<HTMLElement>('.uib-threads-overlay');
      // Its bottom on the region's, 1085: from 970, it would cover the line over the foot at 1101.
      expect(box?.style.insetBlockStart).toBe(`${1085 - 146}px`);
    } finally {
      rect.mockRestore();
    }
  });

  it('shows no box when the title fits in its lines', () => {
    withSizes({ scrollWidth: 172, clientWidth: 172, scrollHeight: 48, clientHeight: 48 });
    draw({ variant: 'nav' });
    fireEvent.pointerEnter(row('Hindre for KI i staten'));
    expect(document.querySelector('.uib-threads-overlay')).toBeNull();
  });

  it('keeps the search when the host asks for both', () => {
    draw({ variant: 'nav', search: true });
    expect(screen.getByRole('searchbox', { name: 'Søk i tråder' })).toBeTruthy();
  });
});
