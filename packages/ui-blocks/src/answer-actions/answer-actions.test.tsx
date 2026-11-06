// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { InLocale } from '@genai/i18n/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnswerActions, RECEIPT_MS, type AnswerActionsProps } from './AnswerActions.js';

beforeAll(() => {
  // jsdom lays nothing out; the call that keeps the receipt in view has to go somewhere.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const both = { onCopyAnswer: () => {}, onCopyLink: () => {} } satisfies AnswerActionsProps;
const draw = (props: AnswerActionsProps = both) => render(<AnswerActions {...props} />);

const copyAnswer = () => screen.getByRole('button', { name: 'Kopier svaret' });
const copyLink = () => screen.getByRole('button', { name: 'Kopier lenke til tråden' });
const receipt = () => document.querySelector('[aria-live="polite"]') as HTMLElement;

describe('the answer actions', () => {
  it('show only what the app can carry out, and nothing when it can carry out nothing', () => {
    const { container, rerender } = draw({});
    expect(container.innerHTML).toBe('');

    rerender(<AnswerActions onCopyAnswer={() => {}} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Kopier svaret']);
    expect(screen.queryByRole('group', { name: 'Tilbakemelding på svaret' })).toBeNull();
  });

  it('raise an event to copy the answer or the link, and copy nothing themselves', () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const asked: string[] = [];
    draw({ onCopyAnswer: () => asked.push('answer'), onCopyLink: () => asked.push('link') });

    fireEvent.click(copyAnswer());
    fireEvent.click(copyLink());

    expect(asked).toEqual(['answer', 'link']);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('say what the app copied: the answer, and how many sources went with it', () => {
    const { rerender } = draw();
    rerender(<AnswerActions {...both} copied={{ kind: 'answer', sources: 3 }} />);
    expect(receipt().textContent).toBe('Svaret og 3 kilder er kopiert.');
    rerender(<AnswerActions {...both} copied={{ kind: 'answer', sources: 1 }} />);
    expect(receipt().textContent).toBe('Svaret og 1 kilde er kopiert.');
    rerender(<AnswerActions {...both} copied={{ kind: 'answer' }} />);
    expect(receipt().textContent).toBe('Svaret er kopiert.');
  });

  it('say so when the browser refused the copy', () => {
    draw({ ...both, copied: { kind: 'failed' } });
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
    const { rerender } = draw({ ...both, copied: { kind: 'answer' } });
    act(() => vi.advanceTimersByTime(RECEIPT_MS - 1000));
    rerender(<AnswerActions {...both} copied={{ kind: 'answer', sources: 2 }} />);
    act(() => vi.advanceTimersByTime(RECEIPT_MS - 1000));
    expect(receipt().textContent).toBe('Svaret og 2 kilder er kopiert.');
    act(() => vi.advanceTimersByTime(1000));
    expect(receipt().textContent).toBe('');
  });

  it('keep focus on the button that copied', () => {
    const { rerender } = draw();
    copyAnswer().focus();
    fireEvent.click(copyAnswer());
    rerender(<AnswerActions {...both} copied={{ kind: 'answer' }} />);
    expect(document.activeElement).toBe(copyAnswer());
  });

  it('put the app’s own actions after the copy buttons, and its end outside every button', () => {
    draw({
      ...both,
      actions: <button type="button">Søk i svaret</button>,
      end: <time dateTime="2026-11-06T14:32:00Z">14:32</time>,
    });
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Kopier svaret',
      'Kopier lenke til tråden',
      'Søk i svaret',
    ]);
    const time = screen.getByText('14:32');
    expect(time.closest('button')).toBeNull();
    expect(time.closest('.uib-answer-actions-end')).not.toBeNull();
  });

  it('follow the host’s colour family unless the app names one', () => {
    const { container, rerender } = draw();
    const root = container.firstElementChild as HTMLElement;
    expect(root.hasAttribute('data-color')).toBe(false);
    for (const button of screen.getAllByRole('button'))
      expect(button.hasAttribute('data-color')).toBe(false);
    rerender(<AnswerActions {...both} color="neutral" />);
    expect(root.getAttribute('data-color')).toBe('neutral');
  });

  it('speak English when the person does', () => {
    render(
      <InLocale locale="en">
        <AnswerActions {...both} linkOnlyHere copied={{ kind: 'link' }} />
      </InLocale>,
    );
    expect(screen.getByRole('button', { name: 'Copy the answer' })).toBeTruthy();
    expect(receipt().textContent).toBe(
      'The link to the thread is copied. Works only for you, in this browser.',
    );
  });
});

/**
 * digdir/kunnskapsassistenten#119: in kunnskapsassistenten, a thread's address opens the
 * thread only in the browser it was made in. The limit is a description and not part of
 * the name, and the same sentence stands in three places.
 */
describe('the link that works only here', () => {
  it('is named by what the button does, with the limit as its description', () => {
    draw({ ...both, linkOnlyHere: true });
    const describedBy = copyLink().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const note = document.getElementById(describedBy ?? '');
    expect(note?.textContent).toBe('Virker bare for deg, i denne nettleseren.');
    // `hidden`: the description reaches the button, but is not a stop of its own in the row.
    expect(note?.hidden).toBe(true);
  });

  it('says the same in the tooltip, the visible half', () => {
    draw({ ...both, linkOnlyHere: true });
    expect(copyLink().getAttribute('data-tooltip')).toBe(
      'Virker bare for deg, i denne nettleseren',
    );
  });

  it('says both halves in the receipt, where it is read aloud', () => {
    draw({ ...both, linkOnlyHere: true, copied: { kind: 'link' } });
    expect(receipt().textContent).toBe(
      'Lenken til tråden er kopiert. Virker bare for deg, i denne nettleseren.',
    );
  });

  it('is not claimed when the app has not said the link is limited', () => {
    draw({ ...both, copied: { kind: 'link' } });
    expect(copyLink().hasAttribute('aria-describedby')).toBe(false);
    expect(copyLink().hasAttribute('data-tooltip')).toBe(false);
    expect(receipt().textContent).toBe('Lenken til tråden er kopiert.');
  });

  it('gives every control a name and points only at what exists', () => {
    const { container } = draw({ ...both, linkOnlyHere: true });
    for (const button of within(container).getAllByRole('button'))
      expect(button.textContent?.trim()).not.toBe('');
    for (const element of container.querySelectorAll('[aria-describedby]'))
      expect(
        document.getElementById(element.getAttribute('aria-describedby') ?? ''),
      ).not.toBeNull();
  });
});
