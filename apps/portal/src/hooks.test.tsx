// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAsync } from './hooks';

afterEach(cleanup);

const later = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('useAsync', () => {
  it('a filter change keeps the current list on screen until the new one arrives', async () => {
    let release: (value: string) => void = () => undefined;
    const view = renderHook(
      ({ filter }) =>
        useAsync(
          (): Promise<string> =>
            filter === 'all' ? Promise.resolve('all') : new Promise((r) => (release = r)),
          [filter],
          { keepPreviousFor: 'tenant' },
        ),
      { initialProps: { filter: 'all' } },
    );
    await waitFor(() => expect(view.result.current[0]).toEqual({ status: 'ready', data: 'all' }));

    view.rerender({ filter: 'failed' });
    await act(later);

    expect(view.result.current[0]).toEqual({ status: 'ready', data: 'all' });
    expect(view.result.current[2]).toBe(true);
    await act(async () => release('failed'));
    expect(view.result.current[0]).toEqual({ status: 'ready', data: 'failed' });
    expect(view.result.current[2]).toBe(false);
  });

  it('shows the loading state when what the data belongs to changes', async () => {
    const view = renderHook(
      ({ tenant }) =>
        useAsync(
          (): Promise<string> => (tenant === 'a' ? Promise.resolve('a') : new Promise(() => {})),
          [tenant],
          { keepPreviousFor: tenant },
        ),
      { initialProps: { tenant: 'a' } },
    );
    await waitFor(() => expect(view.result.current[0].status).toBe('ready'));

    view.rerender({ tenant: 'b' });
    await act(later);

    expect(view.result.current[0]).toEqual({ status: 'loading' });
  });

  it('an answer that is already there is shown without a loading state in between', async () => {
    const seen: string[] = [];
    const view = renderHook(
      ({ n }) => {
        const [state] = useAsync(() => Promise.resolve(n), [n]);
        seen.push(state.status === 'ready' ? `ready ${state.data}` : state.status);
        return state;
      },
      { initialProps: { n: 1 } },
    );
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    seen.length = 0;

    view.rerender({ n: 2 });
    await act(later);

    expect(seen).not.toContain('loading');
    expect(seen.at(-1)).toBe('ready 2');
  });
});
