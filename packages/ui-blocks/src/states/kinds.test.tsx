// @vitest-environment jsdom
import { InLocale } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorKindFromStatus, errorKinds, isErrorKind, isRetryable } from './errorKinds.js';
import { ErrorState, useErrorText } from './States.js';

afterEach(cleanup);

const alertText = () => screen.getByRole('alert').textContent ?? '';

describe('the error kinds', () => {
  it('tell the model, the search, a timeout and a refused key apart, each with its own heading', () => {
    const headings = ['model-unavailable', 'retrieval-unavailable', 'timeout', 'unauthorized'].map(
      (kind) => {
        render(<ErrorState kind={kind as (typeof errorKinds)[number]} />);
        const heading = screen.getByRole('heading', { level: 3 }).textContent;
        cleanup();
        return heading;
      },
    );
    expect(headings).toEqual([
      'Assistenten svarte ikke',
      'Søket i dokumentene svarte ikke',
      'Svaret tok for lang tid',
      'Ingen tilgang',
    ]);
  });

  it('say what happened and what the reader can do, in two sentences', () => {
    render(<ErrorState kind="timeout" />);
    expect(alertText()).toContain(
      'Spørsmålet ble avbrutt fordi svaret brukte for lang tid. Et mer avgrenset spørsmål går som regel raskere.',
    );
  });

  it('give advice that names no panel, list or button one service has, in both languages', () => {
    const Advice = ({ kind }: { kind: (typeof errorKinds)[number] }) => (
      <p>{useErrorText()(kind).advice}</p>
    );
    for (const locale of ['nb', 'en'] as const)
      for (const kind of errorKinds) {
        const { container } = render(
          <InLocale locale={locale}>
            <Advice kind={kind} />
          </InLocale>,
        );
        expect(container.textContent).not.toMatch(
          /panel|lista|list\b|«|“|dokumentene|documents|smalere filter|narrower filter/i,
        );
        cleanup();
      }
  });

  it('take the host’s own advice in place of the kind’s', () => {
    render(<ErrorState kind="thread-not-found" advice="Velg «Ny tråd» øverst i lista." />);
    expect(alertText()).toContain(
      'Tråden finnes ikke lenger, kanskje fordi den er slettet et annet sted. Velg «Ny tråd» øverst i lista.',
    );
    expect(alertText()).not.toContain('Start en ny tråd');
  });

  it('name the assistant where a sentence needs a subject, «Assistenten» when the app gives none', () => {
    render(<ErrorState kind="retrieval-unavailable" assistantName="Kunnskapsassistenten" />);
    expect(alertText()).toContain('Kunnskapsassistenten fikk ikke søkt i dokumentene');
    cleanup();
    render(<ErrorState kind="retrieval-unavailable" />);
    expect(alertText()).toContain('Assistenten fikk ikke søkt i dokumentene');
  });

  it('take the app’s message for what happened, and keep the kind’s advice', () => {
    render(<ErrorState kind="unknown" message="Kunnskapsassistenten svarte med feil (502)." />);
    expect(alertText()).toContain(
      'Kunnskapsassistenten svarte med feil (502). Tjenesten sa ikke hva',
    );
    expect(alertText()).not.toContain('Noe gikk galt da svaret skulle hentes.');
  });

  it('keep the app’s own heading when it gives one', () => {
    render(<ErrorState kind="timeout" title="Tidsavbrudd" />);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Tidsavbrudd');
  });

  it('offer «Prøv igjen» only where it can help, not for a refused key', () => {
    const onRetry = vi.fn();
    render(<ErrorState kind="model-unavailable" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(onRetry).toHaveBeenCalledOnce();
    cleanup();

    for (const kind of [
      'unauthorized',
      'question-too-long',
      'filter-refused',
      'thread-not-found',
    ] as const) {
      render(<ErrorState kind={kind} onRetry={onRetry} />);
      expect(screen.queryByRole('button', { name: 'Prøv igjen' })).toBeNull();
      expect(isRetryable(kind)).toBe(false);
      cleanup();
    }
  });

  it('have a heading and two sentences for every kind, in both languages', () => {
    for (const locale of ['nb', 'en'] as const)
      for (const kind of errorKinds) {
        render(
          <InLocale locale={locale}>
            <ErrorState kind={kind} />
          </InLocale>,
        );
        expect(screen.getByRole('heading', { level: 3 }).textContent).not.toMatch(/states\./);
        expect(alertText()).not.toMatch(/states\.|\{name\}/);
        cleanup();
      }
  });

  it('read an HTTP status for only what it establishes', () => {
    expect([401, 403, 408, 504, 413, 429, 500, 502].map(errorKindFromStatus)).toEqual([
      'unauthorized',
      'unauthorized',
      'timeout',
      'timeout',
      'question-too-long',
      'rate-limited',
      'unknown',
      'unknown',
    ]);
  });

  it('know their own names, and nothing else', () => {
    for (const kind of errorKinds) expect(isErrorKind(kind)).toBe(true);
    for (const value of ['aborted', 'no-hits', '', null, undefined])
      expect(isErrorKind(value)).toBe(false);
  });

  it('show nothing while there is neither a kind nor a message', () => {
    render(<ErrorState assistantName="Kunnskapsassistenten" />);
    expect(alertText()).toBe('');
  });
  it('give any block the texts the error state shows, as one set, in the reader’s language', () => {
    const Card = ({ kind }: { kind: (typeof errorKinds)[number] }) => {
      const text = useErrorText()(kind, 'Kunnskapsassistenten');
      return <p>{[text.title, text.what, text.advice].join(' ')}</p>;
    };
    for (const kind of errorKinds) {
      const { container } = render(<Card kind={kind} />);
      const shared = container.textContent;
      cleanup();
      render(<ErrorState kind={kind} assistantName="Kunnskapsassistenten" />);
      const heading = screen.getByRole('heading', { level: 3 }).textContent ?? '';
      expect(shared).toBe(`${heading} ${alertText().slice(heading.length)}`);
      cleanup();
    }
    render(
      <InLocale locale="en">
        <Card kind="model-unavailable" />
      </InLocale>,
    );
    expect(screen.getByText(/^The assistant/)).toBeTruthy();
  });

  it('put the heading at the level the host gives it', () => {
    render(<ErrorState kind="timeout" headingLevel={4} />);
    expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('Svaret tok for lang tid');
  });
});
