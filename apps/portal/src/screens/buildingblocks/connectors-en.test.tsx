// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../api';
import type { ConnectorView } from '../../api/building-blocks';
import { ConnectorList, ConnectorsSummary, NetworkAlert, ReadsSummary } from './Connectors';

afterEach(cleanup);

const api = {
  buildingBlocks: { privateNetworks: () => Promise.resolve({ entries: [] }) },
} as unknown as ApiClient;

const connector: ConnectorView = {
  id: 'c1',
  name: 'Saker i fagsystem',
  status: 'failed',
  lastSync: {
    status: 'failed',
    startedAt: '2026-10-01T08:00:00Z',
    endedAt: '2026-10-01T08:01:00Z',
    error: 'Databasen svarte ikke innen 15 sekunder.',
  },
} as ConnectorView;

describe('connectors in English', () => {
  it('summarises pending and failed connections', () => {
    render(inEnglish(<ConnectorsSummary pending={2} connectors={[connector]} />));
    expect(screen.getByText('Connections to your own databases')).toBeTruthy();
    expect(
      screen.getByText(
        '2 new connections are waiting for approval. 1 connection in use, 1 failed.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View and approve the connections' })).toBeTruthy();
  });

  it('explains a private network that is not open', () => {
    render(
      inEnglish(
        <NetworkAlert
          reach={{ host: '10.0.0.5', network: 'private', allowed: false }}
          tenantName="Kudos"
        />,
      ),
    );
    expect(screen.getByText('The database is on a private network')).toBeTruthy();
    expect(screen.getByText(/has not opened it for Kudos/)).toBeTruthy();
  });

  it('describes what the platform reads', () => {
    render(
      inEnglish(
        <ReadsSummary
          dataset="Saker"
          source={{
            host: 'db',
            database: 'x',
            table: 'cases',
            fields: { id: 'id', title: 'name', text: ['body'] },
            filter: [{ column: 'status', op: 'neq', value: 'closed' }],
          }}
        />,
      ),
    );
    expect(screen.getByText('What the platform will read')).toBeTruthy();
    expect(screen.getByText(/title from/).textContent).toContain('only where status is not closed');
  });

  it('lists connections with a failed status and English actions', async () => {
    render(inEnglish(<ConnectorList api={api} tenant="t" connectors={[connector]} />));
    expect(screen.getByRole('heading', { name: 'Connections' })).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText(/\(failed\)$/)).toBeTruthy();
    expect(await screen.findByText(/No private networks are open/)).toBeTruthy();
  });
});
