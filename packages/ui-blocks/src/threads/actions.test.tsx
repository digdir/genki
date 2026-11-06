// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Threads, type ThreadsProps } from './Threads.js';
import type { ThreadItem } from './types.js';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};
afterEach(cleanup);

const now = Date.now();
const nkom: ThreadItem = { id: 'a', title: 'Måloppnåelse i Nkom', updatedAt: now };
const digdir: ThreadItem = { id: 'b', title: 'Årsrapport for Digdir', updatedAt: now - 1 };
const threads = [nkom, digdir];
const href = (thread: ThreadItem) => `/threads/${thread.id}`;

/** A promise the test settles by hand. */
const held = () => {
  let settle!: { resolve: () => void; reject: (error: Error) => void };
  const promise = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
};

const draw = (props: Partial<ThreadsProps> = {}) => {
  const view = (more: Partial<ThreadsProps> = {}) => (
    <Threads threads={threads} threadHref={href} newThreadHref="/" {...props} {...more} />
  );
  const drawn = render(view());
  return { ...drawn, again: (more: Partial<ThreadsProps>) => drawn.rerender(view(more)) };
};

const menu = (title: string) => screen.getByRole('button', { name: `Flere valg for ${title}` });

/** Opens a row's menu and presses one of its buttons, looked for in that row. */
const choose = (title: string, action: 'Endre navn' | 'Slett') => {
  const trigger = menu(title);
  fireEvent.click(trigger);
  const row = trigger.closest('li') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: action, hidden: true }));
};

const renameTo = (from: string, to: string) => {
  choose(from, 'Endre navn');
  fireEvent.change(screen.getByLabelText('Nytt navn på tråden'), { target: { value: to } });
  fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
};

const announced = (container: HTMLElement) =>
  container.querySelector('.uib-threads > output.uib-visually-hidden')?.textContent;

describe('the thread menu', () => {
  it('has one per row, named after the thread', () => {
    draw({ onRename: () => {}, onDelete: () => {} });
    expect(menu('Måloppnåelse i Nkom')).toBeTruthy();
    expect(menu('Årsrapport for Digdir')).toBeTruthy();
  });

  it('is not there when the host can neither rename nor delete', () => {
    draw();
    expect(screen.queryByRole('button', { name: /^Flere valg for/ })).toBeNull();
  });

  it('offers only what the host can do', () => {
    draw({ onDelete: () => {} });
    fireEvent.click(menu('Måloppnåelse i Nkom'));
    const row = menu('Måloppnåelse i Nkom').closest('li') as HTMLElement;
    expect(within(row).queryByRole('button', { name: 'Endre navn', hidden: true })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Slett', hidden: true })).toBeTruthy();
  });
});

describe('renaming a thread', () => {
  it('opens a field in the row, holding the old name, with focus in it', () => {
    draw({ onRename: () => {} });
    choose('Måloppnåelse i Nkom', 'Endre navn');
    const field = screen.getByLabelText('Nytt navn på tråden') as HTMLInputElement;
    expect(field.value).toBe('Måloppnåelse i Nkom');
    expect(document.activeElement).toBe(field);
  });

  it('shows the new name at once, hands the host its own thread and the trimmed name, and says so', () => {
    const onRename = vi.fn(() => new Promise<void>(() => {}));
    const { container } = draw({ onRename });
    renameTo('Måloppnåelse i Nkom', '  Nkom 2024  ');
    expect(onRename).toHaveBeenCalledWith(nkom, 'Nkom 2024');
    expect(onRename.mock.calls[0]?.[0]).toBe(nkom);
    expect(menu('Nkom 2024')).toBeTruthy();
    expect(announced(container)).toBe('Tråden heter nå «Nkom 2024».');
  });

  it('gives focus back to the row’s menu when it is saved', () => {
    draw({ onRename: () => {} });
    renameTo('Måloppnåelse i Nkom', 'Nkom 2024');
    expect(document.activeElement).toBe(menu('Nkom 2024'));
  });

  it('puts the old name back, and says why, when the host’s promise rejects', async () => {
    const call = held();
    draw({ onRename: () => call.promise });
    renameTo('Måloppnåelse i Nkom', 'Nkom 2024');
    await act(async () => call.reject(new Error('502')));
    expect(menu('Måloppnåelse i Nkom')).toBeTruthy();
    expect(
      within(screen.getByRole('alert')).getByText(
        'Klarte ikke å endre navnet. Tråden heter fortsatt «Måloppnåelse i Nkom».',
      ),
    ).toBeTruthy();
  });

  it('takes the row away and says so when the host finds the thread already gone', async () => {
    let gone!: (value: 'gone') => void;
    draw({ onRename: () => new Promise<'gone'>((resolve) => (gone = resolve)) });
    renameTo('Måloppnåelse i Nkom', 'Nkom 2024');
    await act(async () => gone('gone'));
    expect(
      screen.queryByRole('button', { name: /Flere valg for (Nkom 2024|Måloppnåelse)/ }),
    ).toBeNull();
    expect(
      within(screen.getByRole('alert')).getByText(
        '«Måloppnåelse i Nkom» finnes ikke lenger. Den kan være slettet et annet sted.',
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(menu('Årsrapport for Digdir'));
  });

  it('counts a delete as done when the host resolves it, also for a thread already gone', async () => {
    let gone!: (value: 'gone') => void;
    draw({ onDelete: () => new Promise<'gone'>((resolve) => (gone = resolve)) });
    choose('Måloppnåelse i Nkom', 'Slett');
    fireEvent.click(screen.getByRole('button', { name: 'Slett tråden' }));
    await act(async () => gone('gone'));
    expect(screen.queryByRole('button', { name: 'Flere valg for Måloppnåelse i Nkom' })).toBeNull();
    expect(screen.queryByRole('alert')?.textContent ?? '').not.toMatch(/Klarte ikke/);
  });

  it('leaves it as it was on Escape, with focus on the menu', () => {
    const onRename = vi.fn();
    draw({ onRename });
    choose('Måloppnåelse i Nkom', 'Endre navn');
    fireEvent.keyDown(screen.getByLabelText('Nytt navn på tråden'), { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(menu('Måloppnåelse i Nkom'));
  });

  it('will not save an empty name', () => {
    const onRename = vi.fn();
    draw({ onRename });
    renameTo('Måloppnåelse i Nkom', '   ');
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText('Tråden må ha et navn.')).toBeTruthy();
  });

  it('reports nothing when the name did not change', () => {
    const onRename = vi.fn();
    draw({ onRename });
    choose('Måloppnåelse i Nkom', 'Endre navn');
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    expect(onRename).not.toHaveBeenCalled();
  });

  it('keeps the new name when a read that was already out answers with the old one', async () => {
    const { again } = draw({ onRename: () => Promise.resolve() });
    renameTo('Måloppnåelse i Nkom', 'Nkom 2024');
    await act(async () => {});
    again({ threads: [{ ...nkom }, digdir] });
    expect(menu('Nkom 2024')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Flere valg for Måloppnåelse i Nkom' })).toBeNull();
  });

  it('follows the host once its list has moved past the rename', async () => {
    const { again } = draw({ onRename: () => Promise.resolve() });
    renameTo('Måloppnåelse i Nkom', 'Nkom 2024');
    await act(async () => {});
    again({ threads: [{ ...nkom, title: 'Nkom, endret et annet sted' }, digdir] });
    expect(menu('Nkom, endret et annet sted')).toBeTruthy();
  });

  it('does not go back to the oldest name when the first of two renames fails', async () => {
    const first = held();
    const second = held();
    const calls = [first, second];
    const { again } = draw({ onRename: () => calls.shift()?.promise ?? Promise.resolve() });
    renameTo('Måloppnåelse i Nkom', 'Nkom B');
    renameTo('Nkom B', 'Nkom C');
    await act(async () => second.resolve());
    await act(async () => first.reject(new Error('502')));
    expect(menu('Nkom C')).toBeTruthy();
    expect(screen.queryByText(/Klarte ikke å endre navnet/)).toBeNull();
    again({ threads: [{ ...nkom, title: 'Nkom C' }, digdir] });
    expect(menu('Nkom C')).toBeTruthy();
  });
});

describe('two renames in a row where the second fails', () => {
  it('goes back to the first name, and follows the host once its list moves on', async () => {
    const first = held();
    const second = held();
    const calls = [first.promise, second.promise];
    const { again } = draw({ onRename: () => calls.shift() });
    renameTo('Måloppnåelse i Nkom', 'Nkom B');
    renameTo('Nkom B', 'Nkom C');
    await act(async () => first.resolve());
    await act(async () => second.reject(new Error('502')));
    expect(menu('Nkom B')).toBeTruthy();
    expect(screen.getByText(/Tråden heter fortsatt «Nkom B»/)).toBeTruthy();
    again({ threads: [{ ...nkom, title: 'Nkom B' }, digdir] });
    again({ threads: [{ ...nkom, title: 'Nkom B, endret et annet sted' }, digdir] });
    expect(menu('Nkom B, endret et annet sted')).toBeTruthy();
  });

  it('goes back past a first name that failed too, to the host’s own', async () => {
    const first = held();
    const second = held();
    const calls = [first.promise, second.promise];
    draw({ onRename: () => calls.shift() });
    renameTo('Måloppnåelse i Nkom', 'Nkom B');
    renameTo('Nkom B', 'Nkom C');
    await act(async () => first.reject(new Error('502')));
    expect(menu('Nkom C')).toBeTruthy();
    await act(async () => second.reject(new Error('502')));
    expect(menu('Måloppnåelse i Nkom')).toBeTruthy();
  });
});

describe('deleting a thread', () => {
  it('asks first, and nothing happens on «Avbryt»', () => {
    const onDelete = vi.fn();
    draw({ onDelete });
    choose('Måloppnåelse i Nkom', 'Slett');
    expect(screen.getByRole('heading', { name: 'Slette tråden?' })).toBeTruthy();
    expect(
      screen.getByText(
        '«Måloppnåelse i Nkom» blir borte for godt, med alle spørsmålene og svarene i den. Det kan ikke angres.',
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Avbryt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Avbryt' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(menu('Måloppnåelse i Nkom'));
  });

  it('takes the row away at once, with focus on the next one, and says so', () => {
    const onDelete = vi.fn(() => new Promise<void>(() => {}));
    const { container } = draw({ onDelete });
    choose('Måloppnåelse i Nkom', 'Slett');
    fireEvent.click(screen.getByRole('button', { name: 'Slett tråden' }));
    expect(onDelete).toHaveBeenCalledWith(nkom);
    expect(screen.queryByRole('link', { name: 'Måloppnåelse i Nkom' })).toBeNull();
    expect(document.activeElement).toBe(menu('Årsrapport for Digdir'));
    expect(announced(container)).toBe('«Måloppnåelse i Nkom» er slettet.');
  });

  it('puts focus on «Start din første tråd» when the last one is deleted', () => {
    draw({ onDelete: () => new Promise<void>(() => {}) });
    const newThread = screen.getByRole('link', { name: /Ny tråd/ });
    choose('Måloppnåelse i Nkom', 'Slett');
    fireEvent.click(screen.getByRole('button', { name: 'Slett tråden' }));
    choose('Årsrapport for Digdir', 'Slett');
    fireEvent.click(screen.getByRole('button', { name: 'Slett tråden' }));
    const start = screen.getByRole('link', { name: /Start din første tråd/ });
    expect(start).toBe(newThread);
    expect(document.activeElement).toBe(start);
  });

  it('puts the row back, and says so, when the host’s promise rejects', async () => {
    const call = held();
    draw({ onDelete: () => call.promise });
    choose('Måloppnåelse i Nkom', 'Slett');
    fireEvent.click(screen.getByRole('button', { name: 'Slett tråden' }));
    await act(async () => call.reject(new Error('502')));
    expect(menu('Måloppnåelse i Nkom')).toBeTruthy();
    expect(
      screen.getByText('Klarte ikke å slette «Måloppnåelse i Nkom». Tråden er fortsatt her.'),
    ).toBeTruthy();
  });

  it('keeps the row away when a read that was already out still lists it', async () => {
    const { again } = draw({ onDelete: () => Promise.resolve() });
    choose('Måloppnåelse i Nkom', 'Slett');
    fireEvent.click(screen.getByRole('button', { name: 'Slett tråden' }));
    await act(async () => {});
    again({ threads: [{ ...nkom }, digdir] });
    expect(screen.queryByRole('link', { name: 'Måloppnåelse i Nkom' })).toBeNull();
    again({ threads: [digdir] });
    again({ threads: [{ ...nkom }, digdir] });
    expect(screen.getByRole('link', { name: 'Måloppnåelse i Nkom' })).toBeTruthy();
  });

  it('clears an earlier error when the person starts another change', async () => {
    const call = held();
    draw({ onDelete: () => call.promise, onRename: () => {} });
    choose('Måloppnåelse i Nkom', 'Slett');
    fireEvent.click(screen.getByRole('button', { name: 'Slett tråden' }));
    await act(async () => call.reject(new Error('502')));
    expect(screen.getByRole('alert').textContent).not.toBe('');
    choose('Årsrapport for Digdir', 'Endre navn');
    expect(screen.getByRole('alert').textContent).toBe('');
  });
});
