// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api';
import type { ConnectorView } from '../../api/building-blocks';
import { ConnectorList, connectorPollMs } from './Connectors';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const syncing = {
  id: 'c1',
  name: 'Saker i fagsystem',
  status: 'syncing',
  lastSync: { status: 'running', startedAt: '2026-10-01T08:00:00Z' },
} as ConnectorView;

const connected = {
  ...syncing,
  status: 'connected',
  lastSync: {
    status: 'succeeded',
    startedAt: '2026-10-01T08:00:00Z',
    endedAt: '2026-10-01T08:01:00Z',
    rows: 50,
  },
} as ConnectorView;

const apiWith = (connectors: () => Promise<ConnectorView[]>) =>
  ({
    buildingBlocks: {
      privateNetworks: () => Promise.resolve({ entries: [] }),
      connectors,
    },
  }) as unknown as ApiClient;

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('connector polling', () => {
  it('keeps polling a connector after a failed poll', async () => {
    const connectors = vi
      .fn((): Promise<ConnectorView[]> => Promise.resolve([connected]))
      .mockImplementationOnce(() => Promise.reject(new Error('network')));
    render(<ConnectorList api={apiWith(connectors)} tenant="t" connectors={[syncing]} />);

    await advance(connectorPollMs);
    expect(connectors).toHaveBeenCalledTimes(1);
    await advance(connectorPollMs * 2);
    expect(connectors).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Tilkoblet')).toBeTruthy();
  });

  it('waits longer after each failed poll', async () => {
    const connectors = vi.fn((): Promise<ConnectorView[]> => Promise.reject(new Error('network')));
    render(<ConnectorList api={apiWith(connectors)} tenant="t" connectors={[syncing]} />);

    await advance(connectorPollMs);
    expect(connectors).toHaveBeenCalledTimes(1);
    await advance(connectorPollMs * 2 - 1);
    expect(connectors).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(connectors).toHaveBeenCalledTimes(2);
    await advance(connectorPollMs * 4);
    expect(connectors).toHaveBeenCalledTimes(3);
  });

  it('says when polling keeps failing and polls again at once on retry', async () => {
    const connectors = vi.fn((): Promise<ConnectorView[]> => Promise.reject(new Error('network')));
    render(<ConnectorList api={apiWith(connectors)} tenant="t" connectors={[syncing]} />);

    await advance(connectorPollMs);
    await advance(connectorPollMs * 2);
    await advance(connectorPollMs * 4);
    expect(connectors).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/Vi får ikke oppdatert statusen akkurat nå/)).toBeTruthy();

    connectors.mockImplementation(() => Promise.resolve([connected]));
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    await advance(connectorPollMs);
    expect(screen.getByText('Tilkoblet')).toBeTruthy();
    expect(screen.queryByText(/Vi får ikke oppdatert statusen akkurat nå/)).toBeNull();
  });
});
