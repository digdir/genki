// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrashBoundary } from './CrashBoundary.js';

/**
 * The page that stands where the app was, instead of a white window. The error seen in use is
 * thrown by the DOM in a real browser, when a translator moves nodes from under React; jsdom has
 * no translator, so these tests throw it themselves.
 */
const Throws = ({ error }: { error: unknown }): never => {
  throw error;
};

beforeEach(() => {
  // React logs every error a boundary catches. It is expected here, and would bury the result.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the crash page', () => {
  it('leaves the app alone when nothing fails', () => {
    render(
      <CrashBoundary>
        <p>Appen</p>
      </CrashBoundary>,
    );
    expect(screen.getByText('Appen')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Noe gikk galt' })).toBeNull();
  });

  it('shows a page with a heading and «Last inn på nytt» instead of a white screen', () => {
    render(
      <CrashBoundary>
        <Throws error={new Error('noe røk')} />
      </CrashBoundary>,
    );
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Noe gikk galt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Last inn på nytt' })).toBeTruthy();
    // Behind a Details, so it can be copied into a message.
    expect(screen.getByText(/Error: noe røk/)).toBeTruthy();
  });

  it('gives the heading focus, since what had it is gone', () => {
    render(
      <CrashBoundary>
        <Throws error={new Error('noe røk')} />
      </CrashBoundary>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 1, name: 'Noe gikk galt' }),
    );
  });

  it('reloads when the button is pressed, as the app says', () => {
    const onReload = vi.fn();
    render(
      <CrashBoundary onReload={onReload}>
        <Throws error={new Error('noe røk')} />
      </CrashBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Last inn på nytt' }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it('tells the app what was thrown, for its own log', () => {
    const onError = vi.fn();
    const error = new Error('noe røk');
    render(
      <CrashBoundary onError={onError}>
        <Throws error={error} />
      </CrashBoundary>,
    );
    expect(onError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
  });

  it('names extensions and translation only for the error the DOM gives when a node was moved', () => {
    const moved = new DOMException(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
      'NotFoundError',
    );
    render(
      <CrashBoundary>
        <Throws error={moved} />
      </CrashBoundary>,
    );
    expect(screen.getByText(/utvidelse i nettleseren/)).toBeTruthy();
    cleanup();

    render(
      <CrashBoundary>
        <Throws error={new TypeError('x is undefined')} />
      </CrashBoundary>,
    );
    expect(screen.queryByText(/utvidelse i nettleseren/)).toBeNull();
  });

  it('shows what was thrown even when it is not an error', () => {
    render(
      <CrashBoundary>
        <Throws error="en streng" />
      </CrashBoundary>,
    );
    expect(screen.getByText(/Error: en streng/)).toBeTruthy();
  });
});
