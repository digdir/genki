// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { InLocale } from '@genai/i18n/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noticeTime, useLogOnly, useNotice, useStoredColorScheme } from './host.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  delete document.documentElement.dataset.colorScheme;
});

const Notice = ({ text }: { text?: string }) => {
  const [say, view] = useNotice();
  return (
    <>
      <button type="button" onClick={() => say(text ?? 'Lagret.')}>
        Si fra
      </button>
      {view}
    </>
  );
};

describe('useNotice', () => {
  it('says each notice in a polite live region, and takes it away after seven seconds', () => {
    vi.useFakeTimers();
    render(<Notice />);
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    act(() => screen.getByRole('button').click());
    expect(region.textContent).toBe('Lagret.');
    expect(noticeTime).toBe(7000);
    act(() => vi.advanceTimersByTime(noticeTime - 1));
    expect(region.textContent).toBe('Lagret.');
    act(() => vi.advanceTimersByTime(1));
    expect(region.textContent).toBe('');
  });

  it('draws the same notice said again as a new one, so it is announced again', () => {
    render(<Notice />);
    act(() => screen.getByRole('button').click());
    const first = screen.getByRole('status').firstElementChild;
    act(() => screen.getByRole('button').click());
    expect(screen.getByRole('status').firstElementChild).not.toBe(first);
  });
});

describe('useStoredColorScheme', () => {
  it('starts from the scheme the page has, and keeps a choice on the page and in the browser', () => {
    document.documentElement.dataset.colorScheme = 'dark';
    const { result } = renderHook(() => useStoredColorScheme('host.colorScheme'));
    expect(result.current[0]).toBe('dark');
    act(() => result.current[1]('light'));
    expect(document.documentElement.dataset.colorScheme).toBe('light');
    expect(localStorage.getItem('host.colorScheme')).toBe('light');
  });

  it('follows a choice made in another tab, and reads anything else as «auto»', () => {
    const { result } = renderHook(() => useStoredColorScheme('host.colorScheme'));
    expect(result.current[0]).toBe('auto');
    const other = (newValue: string | null, key = 'host.colorScheme') =>
      act(() => {
        dispatchEvent(new StorageEvent('storage', { key, newValue }));
      });
    other('dark');
    expect(result.current[0]).toBe('dark');
    other('light', 'another.key');
    expect(result.current[0]).toBe('dark');
    other('purple');
    expect(result.current[0]).toBe('auto');
  });
});

describe('useLogOnly', () => {
  const thread = { id: 't1', title: 'Rapportering', updatedAt: '2026-11-09T10:00:00Z' };
  const handlers = (wrapper?: ({ children }: { children: ReactNode }) => ReactNode) => {
    const say = vi.fn<(text: string) => void>();
    const log = vi.fn();
    const { result } = renderHook(() => useLogOnly(say, log), wrapper ? { wrapper } : {});
    return { say, log, result };
  };

  it('logs and says feedback, a rename and a delete, and changes nothing', async () => {
    vi.useFakeTimers();
    const { say, log, result } = handlers();
    const sent = result.current.onFeedback({
      answerId: 'a1',
      rating: 'down',
      reasons: ['Feil', 'Mangler kilder'],
    });
    expect(log).toHaveBeenCalledWith('feedback', expect.objectContaining({ answerId: 'a1' }));
    expect(say).toHaveBeenLastCalledWith(
      'Ville sendt tilbakemelding: tommel ned (Feil, Mangler kilder). Ikke sendt i forhåndsvisningen.',
    );
    // «Sender …» for a moment, as a real request would show it.
    let done = false;
    void sent.then(() => (done = true));
    await act(async () => vi.advanceTimersByTimeAsync(399));
    expect(done).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(done).toBe(true);

    await result.current.onRename(thread, 'Ny tittel');
    expect(log).toHaveBeenLastCalledWith('rename', { id: 't1', title: 'Ny tittel' });
    expect(say).toHaveBeenLastCalledWith(
      'Ville gitt tråden nytt navn: «Ny tittel». Ikke endret i genki: det gamle navnet er tilbake når du laster siden på nytt.',
    );
    await result.current.onDelete({ ...thread, title: '' });
    expect(log).toHaveBeenLastCalledWith('delete', { id: 't1' });
    expect(say).toHaveBeenLastCalledWith(
      'Ville slettet tråden «Uten tittel». Ikke slettet i genki: den er tilbake når du laster siden på nytt.',
    );
  });

  it('says it in the reader’s language', () => {
    const { say, result } = handlers(({ children }) => <InLocale locale="en">{children}</InLocale>);
    void result.current.onFeedback({ answerId: 'a1', rating: 'up', reasons: [] });
    expect(say).toHaveBeenLastCalledWith(
      'Would have sent feedback: thumbs up. Not sent in the preview.',
    );
  });

  it('keeps the same handlers across renders, so the assistant does not draw again for them', () => {
    const say = () => {};
    const log = () => {};
    const { result, rerender } = renderHook(() => useLogOnly(say, log));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
