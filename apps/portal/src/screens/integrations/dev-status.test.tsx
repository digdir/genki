// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../api';
import type { TenantStatus } from '../../api/platform-status';
import { DevStatus } from './DevStatus';

const calm: TenantStatus = {
  incidents: [],
  components: [
    { name: 'API', status: 'normal' },
    { name: 'Database', status: 'normal', note: 'Svarte på 4 ms.' },
    { name: 'Kjøringer', status: 'normal', errorRate: '1,2 %' },
  ],
  queueStats: [],
  queue: [],
  triggers: [],
};

const api = (
  health: { lockdown?: boolean; builtAt?: string; environment?: string } = {},
  status: (TenantStatus & { pastIncidents?: unknown[] }) | Error = calm,
): Pick<ApiClient, 'getHealth' | 'cache' | 'platformStatus'> => ({
  getHealth: () => Promise.resolve({ status: 'ok', version: 'a3f9c12e1d', ...health }),
  cache: { invalidate: () => undefined } as ApiClient['cache'],
  platformStatus: {
    tenant: () => (status instanceof Error ? Promise.reject(status) : Promise.resolve(status)),
  },
});

document.getAnimations ??= () => [];
afterEach(cleanup);

describe('Driftsstatus', () => {
  it('names the environment from /health and lists past incidents from the status, newest first as sent', async () => {
    render(
      <DevStatus
        api={api(
          { environment: 'genki-test' },
          {
            ...calm,
            pastIncidents: [
              {
                date: '2026-11-12T08:00:00Z',
                title: 'Treg innlesing',
                text: 'Løst etter 40 minutter.',
              },
            ],
          },
        )}
        tenant="999888777"
      />,
    );
    expect(await screen.findByText('genki-test')).toBeTruthy();
    expect(screen.getByText('Treg innlesing. Løst etter 40 minutter.')).toBeTruthy();
  });

  it('says the environment is locked when the API reports lockdown', async () => {
    render(<DevStatus api={api({ lockdown: true })} tenant="999888777" />);
    expect(await screen.findByText('Låst miljø')).toBeTruthy();
    expect(screen.getByText('Ja, bare noen kan endre noe nå')).toBeTruthy();
  });

  it('says the environment is open when the API reports no lockdown', async () => {
    render(<DevStatus api={api({ lockdown: false })} tenant="999888777" />);
    expect(await screen.findByText('Låst miljø')).toBeTruthy();
    expect(screen.getByText('Nei')).toBeTruthy();
  });

  it('says everything works when every component the tenant sees is normal', async () => {
    render(<DevStatus api={api()} tenant="999888777" />);
    expect(await screen.findByText('Alt virker')).toBeTruthy();
    expect(screen.getByText('Database')).toBeTruthy();
    expect(screen.getByText('1,2 % feilet den siste timen')).toBeTruthy();
  });

  it('names the components that are down in the summary', async () => {
    const down: TenantStatus = {
      ...calm,
      components: [...calm.components, { name: 'Innlesing', status: 'down', note: 'Nede.' }],
    };
    render(<DevStatus api={api({}, down)} tenant="999888777" />);
    expect(await screen.findByText('Noe virker ikke')).toBeTruthy();
    expect(screen.getByText('Gjelder: Innlesing.')).toBeTruthy();
  });

  it('shows the open incidents Digdir has written for the tenant', async () => {
    const incident: TenantStatus = {
      ...calm,
      incidents: [{ title: 'Treg innlesing', text: 'Søkemotoren oppgraderes.' }],
    };
    render(<DevStatus api={api({}, incident)} tenant="999888777" />);
    expect(await screen.findByRole('heading', { name: 'Hendelser nå' })).toBeTruthy();
    expect(screen.getByText('Treg innlesing')).toBeTruthy();
    expect(screen.getByText('Søkemotoren oppgraderes.')).toBeTruthy();
  });

  it('lists ingestions in the queue and failing scheduled ingestions', async () => {
    const busy: TenantStatus = {
      ...calm,
      queue: [
        {
          type: 'Innlesing',
          what: 'nattlig · nettsider',
          status: 'running',
          age: '12 min',
          at: '2026-10-07T09:48:00Z',
        },
      ],
      triggers: [
        {
          tenant: 'Testetaten',
          what: 'Planlagt innlesing: nattlig · nettsider',
          error: 'Kilden svarte ikke.',
          failedAt: '2026-10-07T04:00:00Z',
        },
      ],
    };
    render(<DevStatus api={api({}, busy)} tenant="999888777" />);
    expect(await screen.findByRole('heading', { name: 'Innlesinger i kø' })).toBeTruthy();
    expect(screen.getByText('nattlig · nettsider')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Planlagte innlesinger som feiler' })).toBeTruthy();
    expect(screen.getByText('Kilden svarte ikke.')).toBeTruthy();
  });

  it('shows the build date next to the version when the API reports it', async () => {
    render(<DevStatus api={api({ builtAt: '2026-11-17T10:00:00Z' })} tenant="999888777" />);
    expect(await screen.findByText('a3f9c12')).toBeTruthy();
    expect(screen.getByText(/17\. november 2026/)).toBeTruthy();
  });

  it('says the status check is unknown, not down, when only the status call fails', async () => {
    render(<DevStatus api={api({}, new Error('nede'))} tenant="999888777" />);
    expect(await screen.findByText('Vi fikk ikke kontakt med statussjekken')).toBeTruthy();
    expect(screen.getByText('API-et svarer')).toBeTruthy();
  });
});
