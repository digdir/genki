// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en, nb } from '../i18n.js';
import { EmptyState, ErrorState, NotFoundState } from './States.js';

afterEach(cleanup);

describe('the error state', () => {
  it('keeps the alert region in the page while there is no error, so the error is announced', () => {
    render(<ErrorState />);
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('shows the message, and offers to try again only when the app can', () => {
    const { rerender } = render(<ErrorState title="Svaret feilet" message="Prøv igjen om litt." />);
    expect(screen.getByRole('alert').textContent).toContain('Prøv igjen om litt.');
    expect(screen.getByRole('heading', { name: 'Svaret feilet', level: 3 })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();

    const retry = vi.fn();
    rerender(<ErrorState title="Svaret feilet" message="Prøv igjen om litt." onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('moves focus to the given target when the retry clears the error', () => {
    const target = createRef<HTMLButtonElement>();
    const Host = () => {
      const [failed, setFailed] = useState(true);
      return (
        <>
          <button type="button" ref={target}>
            Lista som kom
          </button>
          <ErrorState
            message={failed ? 'Klarte ikke å hente.' : undefined}
            onRetry={() => setFailed(false)}
            focusAfterRetry={target}
          />
        </>
      );
    };
    render(<Host />);
    const retry = screen.getByRole('button', { name: 'Prøv igjen' });
    retry.focus();
    fireEvent.click(retry);
    expect(screen.queryByRole('button', { name: 'Prøv igjen' })).toBeNull();
    expect(document.activeElement).toBe(target.current);
  });

  it('falls back to the alert region, so focus never drops to the page', () => {
    const Host = () => {
      const [failed, setFailed] = useState(true);
      return (
        <ErrorState
          message={failed ? 'Klarte ikke å hente.' : undefined}
          onRetry={() => setFailed(false)}
        />
      );
    };
    render(<Host />);
    const retry = screen.getByRole('button', { name: 'Prøv igjen' });
    retry.focus();
    fireEvent.click(retry);
    expect(document.activeElement).toBe(screen.getByRole('alert'));
  });

  it('leaves focus alone when the error clears on its own', () => {
    const elsewhere = createRef<HTMLButtonElement>();
    const Host = ({ failed }: { failed: boolean }) => (
      <>
        <button type="button" ref={elsewhere}>
          Et annet sted
        </button>
        <ErrorState message={failed ? 'Klarte ikke å hente.' : undefined} onRetry={() => {}} />
      </>
    );
    const { rerender } = render(<Host failed />);
    elsewhere.current?.focus();
    rerender(<Host failed={false} />);
    expect(document.activeElement).toBe(elsewhere.current);
  });

  it('leaves focus where the app put it when the retry moved it on purpose', () => {
    const field = createRef<HTMLInputElement>();
    const Host = () => {
      const [failed, setFailed] = useState(true);
      return (
        <>
          <input aria-label="Spørsmål" ref={field} />
          <ErrorState
            message={failed ? 'Klarte ikke å hente.' : undefined}
            onRetry={() => {
              setFailed(false);
              field.current?.focus();
            }}
          />
        </>
      );
    };
    render(<Host />);
    const retry = screen.getByRole('button', { name: 'Prøv igjen' });
    retry.focus();
    fireEvent.click(retry);
    expect(document.activeElement).toBe(field.current);
  });

  it('hands the app its retry button, so the app can focus it', () => {
    const retryRef = createRef<HTMLButtonElement>();
    render(<ErrorState message="Klarte ikke å hente." onRetry={() => {}} retryRef={retryRef} />);
    expect(retryRef.current).toBe(screen.getByRole('button', { name: 'Prøv igjen' }));
  });
});

describe('the empty state', () => {
  it('is not an alert: nothing missing is an error', () => {
    render(<EmptyState title="Ingen kilder ennå" description="Still et spørsmål først." />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Ingen kilder ennå', level: 3 })).toBeTruthy();
    expect(screen.getByText('Still et spørsmål først.')).toBeTruthy();
  });

  it('is drawn small inside a panel, where what is missing is part of it', () => {
    render(<EmptyState title="Ingen treff" />);
    expect(screen.getByRole('heading', { name: 'Ingen treff' }).getAttribute('data-size')).toBe(
      '2xs',
    );
  });

  it('reads its size off the level, so the two cannot disagree', () => {
    const { rerender } = render(<EmptyState level={3} title="Ingenting" />);
    const size = () => screen.getByRole('heading', { name: 'Ingenting' }).getAttribute('data-size');
    expect(size()).toBe('2xs');
    rerender(<EmptyState level={4} title="Ingenting" />);
    expect(size()).toBe('2xs');
    rerender(<EmptyState level={2} title="Ingenting" />);
    expect(size()).toBe('lg');
  });

  it('shows no description line when the app gives none', () => {
    const { container } = render(<EmptyState title="Ingen treff" />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('carries the action that resolves it', () => {
    render(
      <EmptyState title="Ingen tråder ennå">
        <button type="button">Ny tråd</button>
      </EmptyState>,
    );
    expect(screen.getByRole('button', { name: 'Ny tråd' })).toBeTruthy();
  });
});

describe('the not-found state', () => {
  it('is the page itself: a level 2 heading in the page’s voice, not an alert', () => {
    render(
      <NotFoundState
        homeHref="/"
        title="Fant ikke tråden"
        description="Lenken peker på en tråd som ikke finnes."
      />,
    );
    const heading = screen.getByRole('heading', { name: 'Fant ikke tråden', level: 2 });
    expect(heading.getAttribute('data-size')).toBe('lg');
    expect(screen.getByText('Lenken peker på en tråd som ikke finnes.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the page does not exist when the app gives no text', () => {
    render(<NotFoundState homeHref="/" />);
    expect(screen.getByRole('heading', { name: 'Siden finnes ikke' })).toBeTruthy();
    expect(screen.getByText(/Adressen fører ingen steder/)).toBeTruthy();
  });

  it('never pairs its own description with the app’s title', () => {
    render(<NotFoundState homeHref="/" title="Fant ikke tråden" />);
    expect(screen.queryByText(/Adressen fører ingen steder/)).toBeNull();
  });

  // Whether the block kept the browser from following the link. jsdom cannot navigate, so the test
  // stops it after the block has had its say.
  const follows = (link: HTMLElement, init: MouseEventInit = {}) => {
    let prevented = false;
    const stop = (event: Event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener('click', stop);
    fireEvent.click(link, init);
    document.removeEventListener('click', stop);
    return !prevented;
  };

  it('links to the front page, a real link the browser follows', () => {
    render(<NotFoundState homeHref="/app/" />);
    const home = screen.getByRole('link', { name: 'Gå til forsiden' });
    expect(home.getAttribute('href')).toBe('/app/');
    expect(follows(home)).toBe(true);
  });

  it('lets the app route a plain click itself, and leaves a modified click to the browser', () => {
    const home = vi.fn();
    render(<NotFoundState homeHref="/" onGoHome={home} />);
    const link = screen.getByRole('link', { name: 'Gå til forsiden' });
    expect(follows(link)).toBe(false);
    expect(home).toHaveBeenCalledOnce();
    expect(follows(link, { metaKey: true })).toBe(true);
    expect(follows(link, { ctrlKey: true })).toBe(true);
    expect(home).toHaveBeenCalledOnce();
  });
});

describe('the states', () => {
  it('speak English when the person does', () => {
    render(
      <InLocale locale="en">
        <NotFoundState homeHref="/" />
        <ErrorState message="Could not fetch the threads." onRetry={() => {}} />
      </InLocale>,
    );
    expect(screen.getByRole('heading', { name: 'The page does not exist' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to the front page' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('have an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });
});
