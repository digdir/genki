// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { InLocale } from '@genai/i18n/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnswerActions } from './AnswerActions.js';
import { FEEDBACK_MAX_LENGTH } from './Feedback.js';
import type { AnswerFeedback, AnswerFeedbackStatus } from './types.js';

// The spinner on «Send» while the app sends synchronises its animation.
document.getAnimations ??= () => [];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draw = (status?: AnswerFeedbackStatus) => {
  const sent: AnswerFeedback[] = [];
  const view = render(
    <AnswerActions feedback onFeedback={(f) => sent.push(f)} feedbackStatus={status} />,
  );
  const redraw = (next?: AnswerFeedbackStatus) =>
    view.rerender(
      <AnswerActions feedback onFeedback={(f) => sent.push(f)} feedbackStatus={next} />,
    );
  return { sent, redraw, container: view.container };
};

const group = () => screen.getByRole('group', { name: 'Tilbakemelding på svaret' });
const button = (name: string) => within(group()).getByRole('button', { name });
const status = () => within(group()).getByRole('status');

describe('the feedback on an answer', () => {
  it('is not asked for unless the app asks, as kunnskapsassistenten took it out', () => {
    const { container } = render(<AnswerActions onFeedback={() => {}} />);
    expect(container.innerHTML).toBe('');
    cleanup();
    render(<AnswerActions onCopyAnswer={() => {}} onFeedback={() => {}} />);
    expect(screen.queryByRole('group', { name: 'Tilbakemelding på svaret' })).toBeNull();
    expect(screen.queryByText('Var svaret nyttig?')).toBeNull();
  });

  it('sends the rating on the click, before any reason or comment', () => {
    const { sent, redraw } = draw();
    const yes = button('Ja');
    expect(yes.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(yes);
    expect(yes.getAttribute('aria-pressed')).toBe('true');
    expect(sent).toEqual([{ rating: 'up', reasons: [], comment: '' }]);
    expect(within(group()).queryByRole('group', { name: 'Hva var galt? (valgfritt)' })).toBeNull();

    redraw('sending');
    redraw('sent');
    expect(status().textContent).toBe('Takk!');
    // The comment is optional and comes after.
    expect(within(group()).getByRole('textbox', { name: 'Kommentar (valgfritt)' })).toBeTruthy();
  });

  it('sends reasons and a comment afterwards with the rating again, for the service', () => {
    const { sent, redraw, container } = draw();
    fireEvent.click(button('Nei'));
    redraw('sending');
    redraw('sent');
    fireEvent.click(within(group()).getByRole('checkbox', { name: 'Mangler kilde' }));
    fireEvent.change(within(group()).getByRole('textbox', { name: 'Kommentar (valgfritt)' }), {
      target: { value: 'Mangler årstall' },
    });
    expect(
      within(group()).getByText('15 av 300 tegn. Ikke skriv personopplysninger.'),
    ).toBeTruthy();
    for (const element of container.querySelectorAll('[aria-describedby]'))
      expect(
        document.getElementById(element.getAttribute('aria-describedby') ?? ''),
      ).not.toBeNull();

    const send = button('Send');
    send.focus();
    fireEvent.click(send);
    expect(sent).toEqual([
      { rating: 'down', reasons: [], comment: '' },
      { rating: 'down', reasons: ['Mangler kilde'], comment: 'Mangler årstall' },
    ]);

    redraw('sending');
    redraw('sent');
    expect(status().textContent).toBe(
      'Takk! Tilbakemeldingen lagres for tjenesten, ikke for deg som person.',
    );
    expect(within(group()).queryByRole('textbox')).toBeNull();
    // «Send» is gone, so focus goes to the chosen thumb rather than the page.
    expect(document.activeElement).toBe(button('Nei'));
  });

  it('changes the rating with the other thumb, sending the details already sent with it', () => {
    const { sent, redraw } = draw();
    fireEvent.click(button('Nei'));
    redraw('sending');
    redraw('sent');
    fireEvent.click(within(group()).getByRole('checkbox', { name: 'Utdatert' }));
    fireEvent.change(within(group()).getByRole('textbox'), { target: { value: 'Gammel lov' } });
    fireEvent.click(button('Send'));
    redraw('sending');
    redraw('sent');

    fireEvent.click(button('Ja'));
    expect(button('Ja').getAttribute('aria-pressed')).toBe('true');
    expect(button('Nei').getAttribute('aria-pressed')).toBe('false');
    // The platform keeps the latest feedback, so the comment goes with the new rating; the
    // reasons are for a no.
    expect(sent.at(-1)).toEqual({ rating: 'up', reasons: [], comment: 'Gammel lov' });
    redraw('sending');
    redraw('sent');
    fireEvent.click(button('Nei'));
    expect(sent.at(-1)).toEqual({ rating: 'down', reasons: ['Utdatert'], comment: 'Gammel lov' });
  });

  it('sends nothing more when the chosen thumb is clicked again', () => {
    const { sent, redraw } = draw();
    fireEvent.click(button('Ja'));
    redraw('sending');
    redraw('sent');
    fireEvent.click(button('Ja'));
    expect(sent).toHaveLength(1);
    expect(button('Ja').getAttribute('aria-pressed')).toBe('true');
  });

  it('brings the form into sight once when the person opens it, above a docked question field', () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      draw();
      fireEvent.click(button('Nei'));
      expect(scrolled).toHaveLength(1);
      expect(within(scrolled[0] as HTMLElement).getByRole('button', { name: 'Send' })).toBeTruthy();
      fireEvent.click(button('Ja'));
      expect(scrolled).toHaveLength(1);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('closes the details without sending more when the person skips them', () => {
    const { sent, redraw } = draw();
    fireEvent.click(button('Ja'));
    redraw('sending');
    redraw('sent');
    const skip = button('Hopp over');
    skip.focus();
    fireEvent.click(skip);
    expect(sent).toEqual([{ rating: 'up', reasons: [], comment: '' }]);
    expect(within(group()).queryByRole('textbox')).toBeNull();
    expect(status().textContent).toBe('Takk!');
    expect(document.activeElement).toBe(button('Ja'));
  });

  it('says nothing is sent until the app says so', () => {
    const { sent } = draw();
    fireEvent.click(button('Ja'));
    fireEvent.click(button('Send'));
    expect(sent).toHaveLength(2);
    expect(status().textContent).toBe('');
    expect(within(group()).getByRole('textbox')).toBeTruthy();
  });

  it('tells the person when the app could not send it, and lets them try again', () => {
    const { sent, redraw } = draw();
    fireEvent.click(button('Ja'));
    redraw('sending');
    redraw('failed');
    expect(status().textContent).toBe('Tilbakemeldingen ble ikke sendt. Prøv igjen om litt.');
    // The same thumb again sends the rating again.
    fireEvent.click(button('Ja'));
    expect(sent).toEqual([
      { rating: 'up', reasons: [], comment: '' },
      { rating: 'up', reasons: [], comment: '' },
    ]);
    redraw('sent');

    fireEvent.change(within(group()).getByRole('textbox'), { target: { value: 'Bra' } });
    fireEvent.click(button('Send'));
    redraw('sending');
    redraw('failed');
    expect(status().textContent).toBe('Tilbakemeldingen ble ikke sendt. Prøv igjen om litt.');
    expect((within(group()).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Bra');
    fireEvent.click(button('Send'));
    expect(sent).toHaveLength(4);
    expect(sent.at(-1)).toEqual({ rating: 'up', reasons: [], comment: 'Bra' });
  });

  it('sends once while the app is sending', () => {
    const { sent, redraw } = draw();
    fireEvent.click(button('Nei'));
    redraw('sending');
    fireEvent.click(button('Ja'));
    fireEvent.click(button('Send'));
    expect(sent).toHaveLength(1);
    expect(button('Nei').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps a comment within the workspace’s limit', () => {
    draw();
    fireEvent.click(button('Ja'));
    expect(within(group()).getByRole('textbox').getAttribute('maxlength')).toBe(
      String(FEEDBACK_MAX_LENGTH),
    );
  });

  it('sends the reasons in bokmål whatever language the person reads', () => {
    const sent: AnswerFeedback[] = [];
    render(
      <InLocale locale="en">
        <AnswerActions feedback onFeedback={(f) => sent.push(f)} />
      </InLocale>,
    );
    const feedback = screen.getByRole('group', { name: 'Feedback on the answer' });
    fireEvent.click(within(feedback).getByRole('button', { name: 'No' }));
    fireEvent.click(within(feedback).getByRole('checkbox', { name: 'Missing source' }));
    fireEvent.click(within(feedback).getByRole('button', { name: 'Send' }));
    expect(sent.at(-1)).toEqual({ rating: 'down', reasons: ['Mangler kilde'], comment: '' });
  });

  it('never calls the platform itself', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { sent } = draw();
    fireEvent.click(button('Ja'));
    fireEvent.click(button('Send'));
    expect(sent).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
