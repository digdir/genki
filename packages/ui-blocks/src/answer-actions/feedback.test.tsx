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
  const view = render(<AnswerActions onFeedback={(f) => sent.push(f)} feedbackStatus={status} />);
  const redraw = (next?: AnswerFeedbackStatus) =>
    view.rerender(<AnswerActions onFeedback={(f) => sent.push(f)} feedbackStatus={next} />);
  return { sent, redraw, container: view.container };
};

const group = () => screen.getByRole('group', { name: 'Tilbakemelding på svaret' });
const button = (name: string) => within(group()).getByRole('button', { name });
const status = () => within(group()).getByRole('status');

describe('the feedback on an answer', () => {
  it('records a thumbs down with reasons and a comment for the service, not the person', () => {
    const { sent, redraw, container } = draw();
    const yes = button('Ja');
    const no = button('Nei');
    expect(yes.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(yes);
    expect(yes.getAttribute('aria-pressed')).toBe('true');
    expect(within(group()).queryByRole('group', { name: 'Hva var galt? (valgfritt)' })).toBeNull();

    fireEvent.click(no);
    expect(no.getAttribute('aria-pressed')).toBe('true');
    expect(yes.getAttribute('aria-pressed')).toBe('false');
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

    fireEvent.click(button('Send'));
    expect(sent).toEqual([
      { rating: 'down', reasons: ['Mangler kilde'], comment: 'Mangler årstall' },
    ]);

    redraw('sent');
    expect(status().textContent).toBe(
      'Takk! Tilbakemeldingen lagres for tjenesten, ikke for deg som person.',
    );
    expect(no.getAttribute('aria-disabled')).toBe('true');
    expect(within(group()).queryByRole('textbox')).toBeNull();
  });

  it('sends only the rating when the person skips the details', () => {
    const { sent, redraw } = draw();
    fireEvent.click(button('Ja'));
    fireEvent.click(button('Hopp over'));
    expect(sent).toEqual([{ rating: 'up', reasons: [], comment: '' }]);
    redraw('sent');
    expect(status().textContent).toBe('Takk!');
  });

  it('says nothing is sent until the app says so', () => {
    const { sent } = draw();
    fireEvent.click(button('Ja'));
    fireEvent.click(button('Send'));
    expect(sent).toHaveLength(1);
    expect(status().textContent).toBe('');
    expect(within(group()).getByRole('textbox')).toBeTruthy();
  });

  it('tells the person when the app could not send it, and keeps the form for another try', () => {
    const { sent, redraw } = draw();
    fireEvent.click(button('Ja'));
    fireEvent.change(within(group()).getByRole('textbox'), { target: { value: 'Bra' } });
    fireEvent.click(button('Send'));
    redraw('sending');
    redraw('failed');
    expect(status().textContent).toBe('Tilbakemeldingen ble ikke sendt. Prøv igjen om litt.');
    expect((within(group()).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Bra');

    fireEvent.click(button('Send'));
    expect(sent).toHaveLength(2);
    fireEvent.click(button('Nei'));
    expect(status().textContent).toBe('');
  });

  it('sends once while the app is sending', () => {
    const { sent, redraw } = draw();
    fireEvent.click(button('Nei'));
    fireEvent.click(button('Send'));
    redraw('sending');
    fireEvent.click(button('Send'));
    fireEvent.click(button('Hopp over'));
    expect(sent).toHaveLength(1);
  });

  it('cannot be changed once sent', () => {
    const { redraw } = draw();
    fireEvent.click(button('Ja'));
    fireEvent.click(button('Hopp over'));
    redraw('sent');
    fireEvent.click(button('Nei'));
    expect(button('Nei').getAttribute('aria-pressed')).toBe('false');
    expect(button('Ja').getAttribute('aria-pressed')).toBe('true');
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
        <AnswerActions onFeedback={(f) => sent.push(f)} />
      </InLocale>,
    );
    const feedback = screen.getByRole('group', { name: 'Feedback on the answer' });
    fireEvent.click(within(feedback).getByRole('button', { name: 'No' }));
    fireEvent.click(within(feedback).getByRole('checkbox', { name: 'Missing source' }));
    fireEvent.click(within(feedback).getByRole('button', { name: 'Send' }));
    expect(sent).toEqual([{ rating: 'down', reasons: ['Mangler kilde'], comment: '' }]);
  });

  it('never calls the platform itself', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { sent } = draw();
    fireEvent.click(button('Ja'));
    fireEvent.click(button('Send'));
    expect(sent).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
