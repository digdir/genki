// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAsync } from './hooks';

afterEach(cleanup);

describe('useAsync', () => {
  it('keeps the loaded data on screen while a retry reloads it', async () => {
    let calls = 0;
    const { result } = renderHook(() => useAsync(async () => ++calls, []));
    await waitFor(() => expect(result.current[0]).toEqual({ status: 'ready', data: 1 }));

    act(() => result.current[1]());

    expect(result.current[0]).toEqual({ status: 'ready', data: 1 });
    await waitFor(() => expect(result.current[0]).toEqual({ status: 'ready', data: 2 }));
  });

  it('shows loading again when its inputs change', async () => {
    const { result, rerender } = renderHook(({ id }) => useAsync(async () => id, [id]), {
      initialProps: { id: 'a' },
    });
    await waitFor(() => expect(result.current[0]).toEqual({ status: 'ready', data: 'a' }));

    rerender({ id: 'b' });

    expect(result.current[0]).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current[0]).toEqual({ status: 'ready', data: 'b' }));
  });
});
