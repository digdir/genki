// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from './api';
import { StateRegister } from './screens/StateRegister';

document.getAnimations ??= () => [];
afterEach(cleanup);

const apiFor = (routes: Record<string, unknown>) =>
  createApiClient({
    baseUrl: '/api',
    token: () => 'ops',
    fetch: async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const key = `${init?.method ?? 'GET'} ${url.pathname.replace(/^\/api/, '')}${url.search}`;
      const body = routes[key];
      return new Response(JSON.stringify(body ?? { title: 'Not found' }), {
        status: body === undefined ? 404 : 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

const register = {
  syncedAt: '2026-11-17T01:40:00.000Z',
  lastGood: '2026-11-18T01:40:00.000Z',
  failedNights: 0,
  units: 324,
  accountsPeriod: '202609',
  same: 162,
  differences: [
    {
      orgnr: '974760223',
      name: 'Riksrevisjonen',
      kind: 'budget-booking',
      registerMinistry: '971524960',
      registerMinistryName: 'STORTINGET',
      accountsMinistry: '972417807',
      accountsMinistryName: 'FINANSDEPARTEMENTET',
    },
    {
      orgnr: '974761076',
      name: 'Skatteetaten',
      kind: 'mismatch',
      registerMinistry: '972417807',
      registerMinistryName: 'FINANSDEPARTEMENTET',
      accountsMinistry: '972417858',
      accountsMinistryName: 'KOMMUNAL- OG DISTRIKTSDEPARTEMENTET',
    },
  ],
};

describe('the state register screen', () => {
  it('shows operators the differences between the register and the state accounts with budget bookings marked', async () => {
    render(<StateRegister api={apiFor({ 'GET /operator/state-register': register })} />);

    const region = await screen.findByRole('region', { name: /forskjeller/i });
    const table = within(region).getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);

    expect(screen.getByRole('heading', { name: 'Statens organisering' })).toBeTruthy();
    expect(screen.getByText(/18\.11\.2026/)).toBeTruthy();
    expect(screen.getByText(/324 enheter/)).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('Riksrevisjonen')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('Budsjettføring')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Skatteetaten')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Avvik')).toBeTruthy();
  });

  it('shows the NLOD credit with links to the licence and the sources on Statens organisering', async () => {
    render(<StateRegister api={apiFor({ 'GET /operator/state-register': register })} />);

    const credit = (await screen.findByText(/Inneholder data under/)).closest('p') as HTMLElement;

    expect(credit.textContent).toBe(
      'Inneholder data under norsk lisens for offentlige data (NLOD) tilgjengeliggjort av Brønnøysundregistrene og Direktoratet for forvaltning og økonomistyring (DFØ).',
    );
    const href = (name: string) => within(credit).getByRole('link', { name }).getAttribute('href');
    expect(href('norsk lisens for offentlige data (NLOD)')).toBe(
      'https://data.norge.no/nlod/no/2.0',
    );
    expect(href('Brønnøysundregistrene')).toBe(
      'https://data.brreg.no/enhetsregisteret/oppslag/enheter',
    );
    expect(href('Direktoratet for forvaltning og økonomistyring (DFØ)')).toBe(
      'https://statsregnskapet.dfo.no/',
    );
  });

  it('warns when the register has not been read for two nights', async () => {
    render(
      <StateRegister
        api={apiFor({
          'GET /operator/state-register': { ...register, failedNights: 2, differences: [] },
        })}
      />,
    );

    expect((await screen.findByRole('alert')).textContent).toMatch(/siste 2 nettene/);
  });
});
