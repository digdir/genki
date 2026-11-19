// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api';
import type { ScreenProps } from '../screen';
import { SharedServices } from './SharedServices';

document.getAnimations ??= () => [];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('shared services that load slowly', () => {
  it('retries every pending load, not only the first', async () => {
    const never = () => new Promise<never>(() => undefined);
    const sharedServices = vi.fn(never);
    const listModels = vi.fn(never);
    const list = vi.fn(never);
    const api = { sharedServices, listModels, buildingBlocks: { list } } as unknown as ApiClient;
    const props = { api, tenant: 't', live: true, route: { segments: ['shared-services'] } };
    render(<SharedServices {...(props as unknown as ScreenProps)} />);
    await act(() => vi.advanceTimersByTime(30_000));

    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));

    expect(sharedServices).toHaveBeenCalledTimes(2);
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
