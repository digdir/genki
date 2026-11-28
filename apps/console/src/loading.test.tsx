// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAsync } from './hooks';
import {
  GIVE_UP_AFTER_MS,
  Loading,
  ScreenBoundary,
  SKELETON_DELAY_MS,
  SLOW_AFTER_MS,
} from './states';

document.getAnimations ??= () => [];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const skeleton = () => document.querySelector('.skeleton');

describe('loading in the console', () => {
  it('shows nothing for a quick load and a skeleton shaped like the content after 300 ms', () => {
    vi.useFakeTimers();
    render(<Loading label="Henter virksomheter" shape="table" columns={3} rows={2} />);

    expect(screen.getByRole('status', { name: 'Henter virksomheter' })).toBeTruthy();
    expect(skeleton()).toBeNull();
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS));

    expect(screen.getByText('Henter virksomheter …')).toBeTruthy();
    expect(document.querySelectorAll('.skeleton-table tbody tr')).toHaveLength(2);
    expect(document.querySelectorAll('.skeleton-table thead th')).toHaveLength(3);
  });

  it('says a load is slow after 10 seconds and offers to try again after 30', () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    render(<Loading label="Henter virksomheter" onRetry={retry} />);

    act(() => vi.advanceTimersByTime(SLOW_AFTER_MS));
    expect(screen.getByText('Dette tar lengre tid enn vanlig. Vi henter fortsatt.')).toBeTruthy();
    act(() => vi.advanceTimersByTime(GIVE_UP_AFTER_MS - SLOW_AFTER_MS));
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));

    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole('status', { name: 'Henter virksomheter' })).toBeTruthy();
  });

  it('offers to try again after 30 seconds only when the screen can retry', () => {
    vi.useFakeTimers();
    render(<Loading label="Henter skjemaet" />);

    act(() => vi.advanceTimersByTime(GIVE_UP_AFTER_MS));

    expect(screen.getByText('Det tok for lang tid')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prøv igjen' })).toBeNull();
  });

  it('shows an error with a way to reload when a screen fails to load, and clears it on the next page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.fn();
    const Broken = () => {
      throw new Error('chunk failed');
    };
    const { rerender } = render(
      <ScreenBoundary path="/flags" onRetry={reload}>
        <Broken />
      </ScreenBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(reload).toHaveBeenCalledOnce();
    rerender(
      <ScreenBoundary path="/tenants" onRetry={reload}>
        <p>Virksomheter</p>
      </ScreenBoundary>,
    );
    expect(screen.getByText('Virksomheter')).toBeTruthy();
  });

  it('draws a list skeleton for a screen that names no shape', () => {
    vi.useFakeTimers();
    render(<Loading label="Henter demoene" />);
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS));

    expect(document.querySelectorAll('.skeleton-list-row')).toHaveLength(5);
  });

  it('reports a retry as pending and keeps the data on screen until the new data arrives', async () => {
    let calls = 0;
    let release = () => {};
    const { result } = renderHook(() =>
      useAsync(
        () =>
          ++calls === 1
            ? Promise.resolve(calls)
            : new Promise<number>((resolve) => (release = () => resolve(2))),
        [],
      ),
    );
    await waitFor(() => expect(result.current[0]).toEqual({ status: 'ready', data: 1 }));

    act(() => result.current[1]());
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toEqual({ status: 'ready', data: 1 });
    act(() => release());

    await waitFor(() => expect(result.current[0]).toEqual({ status: 'ready', data: 2 }));
    expect(result.current[2]).toBe(false);
  });
});
