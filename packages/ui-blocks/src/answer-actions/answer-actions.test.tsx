// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { nb as sharedNb } from '../i18n.js';
import { AnswerActions, RECEIPT_MS, type AnswerActionsProps } from './AnswerActions.js';
import { en, nb } from './i18n.js';

beforeAll(() => {
  // jsdom lays nothing out; the call that keeps the receipt in view has to go somewhere.
  Element.prototype.scrollIntoView = () => {};
  // jsdom has no popover; the menu opens and closes through this call.
  HTMLElement.prototype.togglePopover ??= () => false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const all = {
  onCopyAnswer: () => {},
  onCopyWithSources: () => {},
  onCopyLink: () => {},
} satisfies AnswerActionsProps;
const draw = (props: AnswerActionsProps = all) => render(<AnswerActions {...props} />);

const copy = () => screen.getByRole('button', { name: 'Kopier' });
// A choice by name. jsdom has no popover, so the menu's buttons count as hidden while it is open.
const choice = (name: string) => screen.getByRole('button', { name, hidden: true });
const choices = () =>
  [...document.querySelectorAll('.ds-dropdown button')].map(
    (b) => `${b.textContent}${(b as HTMLButtonElement).disabled ? ' (av)' : ''}`,
  );
const receipt = () => document.querySelector('[aria-live="polite"]') as HTMLElement;

describe('the answer actions', () => {
  it('show only what the app can carry out, and nothing when it can carry out nothing', () => {
    const { container, rerender } = draw({});
    expect(container.innerHTML).toBe('');

    rerender(<AnswerActions onCopyAnswer={() => {}} />);
    expect(copy().textContent).toBe('Kopier');
    expect(screen.queryByRole('group', { name: 'Var svaret nyttig?' })).toBeNull();
  });

  it('offer «Kun svaret», «Svaret med kildeliste» and «Lenke til tråden» in one «Kopier» menu', () => {
    draw();
    expect(choices()).toEqual(['Kun svaret', 'Svaret med kildeliste', 'Lenke til tråden']);
  });

  it('draw «Lenke til tråden» disabled when the app has no link to give', () => {
    draw({ onCopyAnswer: () => {}, onCopyWithSources: () => {} });
    expect(choices()).toEqual(['Kun svaret', 'Svaret med kildeliste', 'Lenke til tråden (av)']);
  });

  it('open the menu from «Kopier», which points at it', () => {
    draw();
    const menu = document.querySelector('.ds-dropdown') as HTMLElement;
    expect(menu.id).toBeTruthy();
    expect(copy().getAttribute('popovertarget')).toBe(menu.id);
  });

  it('raise an event for each choice, and copy nothing themselves', () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const asked: string[] = [];
    draw({
      onCopyAnswer: () => asked.push('answer'),
      onCopyWithSources: () => asked.push('sources'),
      onCopyLink: () => asked.push('link'),
    });

    fireEvent.click(choice('Kun svaret'));
    fireEvent.click(choice('Svaret med kildeliste'));
    fireEvent.click(choice('Lenke til tråden'));

    expect(asked).toEqual(['answer', 'sources', 'link']);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('close the menu when a choice is made', () => {
    const shown = new Map<Element, boolean>();
    vi.spyOn(HTMLElement.prototype, 'togglePopover').mockImplementation(function (
      this: HTMLElement,
      force?: boolean | TogglePopoverOptions,
    ) {
      shown.set(this, force === true);
      return force === true;
    });
    draw();
    const menu = document.querySelector('.ds-dropdown') as HTMLElement;
    fireEvent.click(copy());
    expect(shown.get(menu)).toBe(true);
    fireEvent.click(choice('Kun svaret'));
    expect(shown.get(menu)).toBe(false);
  });

  it('send focus back to «Kopier» after a choice, and keep it there when the receipt comes', () => {
    const { rerender } = draw();
    fireEvent.click(choice('Kun svaret'));
    expect(document.activeElement).toBe(copy());
    rerender(<AnswerActions {...all} copied={{ kind: 'answer' }} />);
    expect(document.activeElement).toBe(copy());
  });

  it('say what the app copied: the answer, and how many sources went with it', () => {
    const { rerender } = draw();
    rerender(<AnswerActions {...all} copied={{ kind: 'answer', sources: 3 }} />);
    expect(receipt().textContent).toBe('Svaret og 3 kilder er kopiert.');
    rerender(<AnswerActions {...all} copied={{ kind: 'answer', sources: 1 }} />);
    expect(receipt().textContent).toBe('Svaret og 1 kilde er kopiert.');
    rerender(<AnswerActions {...all} copied={{ kind: 'answer' }} />);
    expect(receipt().textContent).toBe('Svaret er kopiert.');
  });

  it('say so when the browser refused the copy', () => {
    draw({ ...all, copied: { kind: 'failed' } });
    expect(receipt().textContent).toBe('Kunne ikke kopiere. Nettleseren tillot det ikke.');
  });

  it('keep the receipt’s live region in the page while it is empty, so the first one is heard', () => {
    draw();
    expect(receipt().textContent).toBe('');
    expect(receipt().hidden).toBe(false);
    expect(receipt().closest('button')).toBeNull();
  });

  it('clear the receipt after four seconds, and start again on the next copy', () => {
    vi.useFakeTimers();
    const { rerender } = draw({ ...all, copied: { kind: 'answer' } });
    act(() => vi.advanceTimersByTime(RECEIPT_MS - 1000));
    rerender(<AnswerActions {...all} copied={{ kind: 'answer', sources: 2 }} />);
    act(() => vi.advanceTimersByTime(RECEIPT_MS - 1000));
    expect(receipt().textContent).toBe('Svaret og 2 kilder er kopiert.');
    act(() => vi.advanceTimersByTime(1000));
    expect(receipt().textContent).toBe('');
  });

  it('put the thumbs first, then «Kopier», then the app’s own actions, and its end outside every button', () => {
    const { container } = draw({
      ...all,
      feedback: true,
      onFeedback: () => {},
      actions: <button type="button">Søk i svaret</button>,
      end: <span>slutt</span>,
    });
    const row = container.querySelector('.uib-answer-actions-row') as HTMLElement;
    const order = [...row.querySelectorAll(':scope > * button, :scope > button')]
      .filter((b) => !b.closest('.ds-dropdown'))
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(order).toEqual(['Nyttig', 'Ikke nyttig', 'Kopier', 'Søk i svaret']);
    const end = screen.getByText('slutt');
    expect(end.closest('button')).toBeNull();
    expect(end.closest('.uib-answer-actions-end')).not.toBeNull();
  });

  it('are neutral unless the app names another colour family, as kunnskapsassistenten draws them', () => {
    const { container, rerender } = draw();
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('data-color')).toBe('neutral');
    expect(copy().hasAttribute('data-color')).toBe(false);
    rerender(<AnswerActions {...all} color="brand1" />);
    expect(root.getAttribute('data-color')).toBe('brand1');
  });

  it('speak English when the person does', () => {
    render(
      <InLocale locale="en">
        <AnswerActions {...all} copied={{ kind: 'link' }} />
      </InLocale>,
    );
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(choices()).toEqual([
      'Only the answer',
      'The answer with the source list',
      'Link to the thread',
    ]);
    expect(receipt().textContent).toBe('The link to the thread is copied.');
  });
});

// A thread's link carries no limit: sharing it within the organisation is #1045.
describe('the link to the thread', () => {
  it('says only that the link is copied, with no note under the choice or in the receipt', () => {
    draw({ ...all, copied: { kind: 'link' } });
    expect(choice('Lenke til tråden').hasAttribute('aria-describedby')).toBe(false);
    expect(document.body.textContent).not.toContain('Virker bare');
    expect(receipt().textContent).toBe('Lenken til tråden er kopiert.');
  });

  it('gives every control a name', () => {
    const { container } = draw({ ...all, feedback: true, onFeedback: () => {} });
    for (const button of within(container).getAllByRole('button', { hidden: true }))
      expect((button.getAttribute('aria-label') ?? button.textContent)?.trim()).not.toBe('');
  });
});

describe('the catalogue', () => {
  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });

  it("keeps the answer actions' words in their own catalogue, out of the shared one that Approach loads", () => {
    expect(Object.keys(nb)).toEqual(['answerActions']);
    expect(sharedNb).not.toHaveProperty('answerActions');
  });
});
