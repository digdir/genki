// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api';
import { RightsProvider } from '../../Shell';
import { RunEstimate } from './RunHistory';

document.getAnimations ??= () => [];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the cost estimate of a run', () => {
  it('gives up with a retry that asks again without reloading and keeps the marked cases', async () => {
    const usage = vi.fn(() => new Promise<never>(() => undefined));
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const api = { usage } as unknown as ApiClient;
    const Harness = () => {
      const [marked, setMarked] = useState(false);
      return (
        <RightsProvider value={['view-usage']}>
          <input
            type="checkbox"
            aria-label="Marker"
            checked={marked}
            onChange={() => setMarked(true)}
          />
          <RunEstimate api={api} tenant="t" serviceId="s" runs={[]} cases={3} />
        </RightsProvider>
      );
    };
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Marker' }));
    await act(() => vi.advanceTimersByTime(30_000));

    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));

    expect(usage).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
    expect((screen.getByRole('checkbox', { name: 'Marker' }) as HTMLInputElement).checked).toBe(
      true,
    );
  });
});
