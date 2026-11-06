// @vitest-environment jsdom
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { en, nb } from '../i18n.js';
import { Threads, type ThreadsProps } from './Threads.js';
import type { ThreadItem } from './types.js';

document.getAnimations ??= () => [];
// jsdom cannot follow a link the block left to the browser, and says so; the test only needs to
// know the block let it through.
const stayOnPage = (event: Event) => event.preventDefault();
document.addEventListener('click', stayOnPage);
/** Whether the block took each click from the browser, read before the guard above. */
const takenClicks = () => {
  const taken: boolean[] = [];
  const record = (event: Event) => taken.push(event.defaultPrevented);
  document.body.addEventListener('click', record);
  onTestFinished(() => document.body.removeEventListener('click', record));
  return taken;
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const now = Date.now();
const threads: ThreadItem[] = [
  { id: 'a', title: 'Måloppnåelse i Nkom', updatedAt: now },
  { id: 'b', title: 'Årsrapport for Digdir', updatedAt: now },
];
const href = (thread: ThreadItem) => `/threads/${encodeURIComponent(thread.id)}`;

const draw = (props: Partial<ThreadsProps> = {}) =>
  render(<Threads threads={threads} threadHref={href} newThreadHref="/" {...props} />);

const status = (container: HTMLElement) =>
  container.querySelector('output.uib-threads-search-status') as HTMLOutputElement;
const search = (text: string) =>
  fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i tråder' }), {
    target: { value: text },
  });

describe('the thread list', () => {
  it('groups the threads under headings by period, with a hidden heading over them', () => {
    vi.useFakeTimers({ now: new Date(2026, 8, 15, 14), toFake: ['Date'] });
    draw({
      threads: [
        { id: 'a', title: 'I dag', updatedAt: new Date(2026, 8, 15, 9) },
        { id: 'b', title: 'Forrige uke', updatedAt: new Date(2026, 8, 11, 9) },
        { id: 'c', title: 'I juli', updatedAt: new Date(2026, 6, 12, 9) },
      ],
    });
    expect(screen.getAllByRole('heading').map((h) => [h.tagName, h.textContent])).toEqual([
      ['H2', 'Tidligere tråder'],
      ['H3', 'I dag'],
      ['H3', 'Siste 7 dager'],
      ['H3', 'Juli'],
    ]);
    expect(screen.getByText('Tidligere tråder').className).toContain('uib-visually-hidden');
  });

  it('puts the headings at the level the host asks for, and the groups one below', () => {
    draw({ headingLevel: 3 });
    expect(screen.getByRole('heading', { name: 'Tidligere tråder' }).tagName).toBe('H3');
    expect(screen.getByRole('heading', { name: 'I dag' }).tagName).toBe('H4');
  });

  it('names each row by its title alone, and dates it under the title', () => {
    vi.useFakeTimers({ now: new Date(2026, 8, 15, 14), toFake: ['Date'] });
    draw({
      threads: [{ id: 'a', title: 'Måloppnåelse i Nkom', updatedAt: new Date(2026, 8, 14, 9) }],
    });
    const row = screen.getByRole('link', { name: 'Måloppnåelse i Nkom' });
    const time = row.querySelector('time') as HTMLTimeElement;
    expect(time.textContent).toBe('i går');
    expect(time.getAttribute('title')).toBe('14. september 2026 kl. 09:00');
  });

  it('links each row to the address the host gives, as given', () => {
    draw({ threads: [{ id: 'a/b?c#d e', title: 'Rar id', updatedAt: now }] });
    expect(screen.getByRole('link', { name: 'Rar id' }).getAttribute('href')).toBe(
      '/threads/a%2Fb%3Fc%23d%20e',
    );
  });

  it('reports a plain click on a row, and leaves a click for a new tab to the browser', () => {
    const opened: string[] = [];
    const taken = takenClicks();
    draw({ onOpenThread: (thread) => opened.push(thread.id) });
    const row = screen.getByRole('link', { name: 'Måloppnåelse i Nkom' });
    fireEvent.click(row, { metaKey: true });
    fireEvent.click(row, { ctrlKey: true });
    fireEvent.click(row, { shiftKey: true });
    fireEvent.click(row, { button: 1 });
    expect(opened).toEqual([]);
    fireEvent.click(row);
    expect(opened).toEqual(['a']);
    expect(taken).toEqual([false, false, false, false, true]);
  });

  it('marks the thread on screen, and only it', () => {
    draw({ currentId: 'b' });
    expect(
      screen.getByRole('link', { name: 'Årsrapport for Digdir' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(1);
  });

  it('names a thread without a title «Uten tittel»', () => {
    draw({ threads: [{ id: 'x', title: '', updatedAt: now }] });
    expect(screen.getByRole('link', { name: 'Uten tittel' })).toBeTruthy();
  });

  it('marks the list busy and says so while the threads load', () => {
    const { container } = draw({ threads: undefined });
    expect(container.querySelector('.uib-threads')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Henter tråder')).toBeTruthy();
  });

  it('keeps the loading region once the threads are there', () => {
    const { container } = draw();
    expect(container.querySelector('.uib-threads')?.getAttribute('aria-busy')).toBeNull();
    expect(container.querySelector('.uib-threads > output.uib-visually-hidden')).not.toBeNull();
  });

  it('says when the list could not be read, and reads it again on «Prøv igjen»', () => {
    const retry = vi.fn();
    draw({ threads: undefined, failed: true, onRetry: retry });
    expect(
      within(screen.getByRole('alert')).getByText('Klarte ikke å hente trådene.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(document.querySelector('.uib-threads')?.getAttribute('aria-busy')).toBeNull();
  });

  it('keeps the alert region in the DOM while there is nothing to say', () => {
    draw();
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('sets the colour family only when the host gives one', () => {
    const { container, rerender } = draw();
    expect(container.querySelector('.uib-threads')?.hasAttribute('data-color')).toBe(false);
    rerender(<Threads threads={threads} threadHref={href} color="brand1" />);
    expect(container.querySelector('.uib-threads')?.getAttribute('data-color')).toBe('brand1');
  });

  it('draws what the host puts after the list', () => {
    draw({ footer: <p>Innlogget som Kari</p> });
    expect(screen.getByText('Innlogget som Kari')).toBeTruthy();
  });
});

describe('the way to a new thread', () => {
  it('is the empty list’s only content, as «Start din første tråd»', () => {
    draw({ threads: [] });
    expect(screen.getByRole('link', { name: /Start din første tråd/ }).getAttribute('href')).toBe(
      '/',
    );
    expect(screen.queryByRole('link', { name: /Ny tråd/ })).toBeNull();
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Tidligere tråder']);
  });

  it('stays «Ny tråd» above the list while it loads, and when there are threads', () => {
    const { rerender } = draw({ threads: undefined });
    expect(screen.getByRole('link', { name: /Ny tråd/ })).toBeTruthy();
    rerender(<Threads threads={threads} threadHref={href} newThreadHref="/" />);
    expect(screen.getByRole('link', { name: /Ny tråd/ })).toBeTruthy();
  });

  it('is an action, not the current page', () => {
    draw();
    expect(screen.getByRole('link', { name: /Ny tråd/ }).getAttribute('aria-current')).toBeNull();
  });

  it('reports a plain click, and leaves a click for a new tab to the browser', () => {
    const onNewThread = vi.fn();
    const taken = takenClicks();
    draw({ onNewThread });
    const link = screen.getByRole('link', { name: /Ny tråd/ });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { shiftKey: true });
    fireEvent.click(link, { button: 1 });
    expect(onNewThread).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onNewThread).toHaveBeenCalledOnce();
    expect(taken).toEqual([false, false, false, false, true]);
  });

  it('is not drawn when the host gives no address for it', () => {
    draw({ newThreadHref: undefined });
    expect(screen.queryByRole('link', { name: /Ny tråd/ })).toBeNull();
  });
});

describe('the search', () => {
  it('is not drawn over a list known to be empty, but stays while it loads', () => {
    const { rerender } = draw({ threads: [] });
    expect(screen.queryByRole('search')).toBeNull();
    rerender(<Threads threads={undefined} threadHref={href} />);
    expect(screen.getByRole('searchbox', { name: 'Søk i tråder' })).toBeTruthy();
  });

  it('has its count region in the DOM before there is a count, and keeps the same node', () => {
    const { container, rerender } = draw();
    const before = status(container);
    expect(before.textContent).toBe('');
    rerender(<Threads threads={[threads[0] as ThreadItem]} threadHref={href} />);
    expect(status(container)).toBe(before);
  });

  it('filters by title as the person types, whatever the case, and counts what is left', () => {
    const { container } = draw();
    search('  NKOM ');
    expect(screen.getByRole('link', { name: 'Måloppnåelse i Nkom' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Årsrapport for Digdir' })).toBeNull();
    expect(status(container).textContent).toBe('1 tråd');
    search('o');
    expect(status(container).textContent).toBe('2 tråder');
  });

  it('says so when nothing matches', () => {
    draw();
    search('fiskesuppe');
    expect(screen.getByRole('heading', { name: 'Ingen treff' })).toBeTruthy();
    expect(screen.getByText('Ingen tråder passer til søket.')).toBeTruthy();
  });

  it('shows every thread again when the field is cleared', () => {
    const { container } = draw();
    search('nkom');
    // Designsystemet names the button by the page's language: «Fjern tekst», or «Clear input».
    fireEvent.click(screen.getByRole('button', { name: /Fjern tekst|Clear input/ }));
    expect(screen.getAllByRole('link', { name: /Nkom|Digdir/ })).toHaveLength(2);
    expect(status(container).textContent).toBe('');
  });
});

describe('the filter in the same panel', () => {
  it('is offered only when the host has one, and a press is reported', () => {
    const { rerender } = draw();
    expect(screen.queryByRole('button', { name: 'Filtrer dokumenter' })).toBeNull();
    const onShowFilters = vi.fn();
    rerender(<Threads threads={threads} threadHref={href} onShowFilters={onShowFilters} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filtrer dokumenter' }));
    expect(onShowFilters).toHaveBeenCalledOnce();
  });

  it('gets focus on mount only when the person just came from it', () => {
    const { unmount } = draw({ onShowFilters: () => {} });
    expect(document.activeElement).toBe(document.body);
    unmount();
    draw({ onShowFilters: () => {}, focusShowFilters: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Filtrer dokumenter' }));
  });
});

describe('the dataset on a row', () => {
  const mixed: ThreadItem[] = [
    { id: 'a', title: 'Måloppnåelse i Nkom', updatedAt: now, dataset: 'Kudos-pilot' },
    { id: 'b', title: 'Hva er en fjord?', updatedAt: now, dataset: 'Wikipedia (NorQuAD)' },
    { id: 'c', title: 'Eldre tråd uten korpus', updatedAt: now },
  ];

  it('says which dataset each thread was asked of', () => {
    draw({ threads: mixed });
    expect(screen.getByText('Kudos-pilot')).toBeTruthy();
    expect(screen.getByText('Wikipedia (NorQuAD)')).toBeTruthy();
  });

  it('leaves a thread without a dataset unmarked, rather than guess', () => {
    draw({ threads: mixed });
    const row = screen.getByRole('link', { name: 'Eldre tråd uten korpus' });
    expect(row.querySelector('.uib-threads-dataset')).toBeNull();
  });

  it('keeps the dataset out of the link’s name, but inside the row', () => {
    draw({ threads: mixed });
    const link = screen.getByRole('link', { name: 'Måloppnåelse i Nkom' });
    expect(link.textContent).toContain('Kudos-pilot');
    const labelledBy = link.getAttribute('aria-labelledby') as string;
    expect(document.getElementById(labelledBy)?.textContent).toBe('Måloppnåelse i Nkom');
  });
});

describe('the catalogue', () => {
  it('speaks English when the person does', async () => {
    render(
      <InLocale locale="en">
        <Threads threads={threads} threadHref={href} newThreadHref="/" onDelete={() => {}} />
      </InLocale>,
    );
    expect(screen.getByRole('link', { name: /New thread/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Today' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search threads' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'More options for Måloppnåelse i Nkom' }),
    ).toBeTruthy();
    await act(async () => {});
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });
});
