// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import { renderAt } from '../test-utils';
import type { Organisation } from '../types';

const openProfileAs = async (organisation: Organisation) => {
  const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: [organisation] });
  await auth.login();
  window.location.hash = '#/profile';
  render(<App auth={auth} fetch={mockFetch()} />);
  await screen.findByRole('heading', { level: 1, name: 'Profil' });
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Profil', () => {
  it('keeps each right apart from what it allows, so they never run together', async () => {
    await renderAt('#/profile');

    const rights = await screen.findByRole('region', { name: 'Rettighetene dine' });
    const first = within(rights).getAllByRole('listitem')[0];
    expect(first?.textContent).toBe(
      'Bruke tjenester Stille spørsmål og få svar i tjenestene virksomheten har tatt i bruk.',
    );
  });

  it('says where the rights are granted and who changes them, for this organisation', async () => {
    await renderAt('#/profile');

    expect(
      await screen.findByText(
        'Gitt i Altinn for Testetaten. Det er tilgangsstyreren deres som endrer dem.',
      ),
    ).toBeTruthy();
  });

  it('shows the organisation number once when the organisation has no name', async () => {
    await openProfileAs({ orgNumber: '312521172', name: '312521172', actions: ['use-services'] });

    const facts = screen.getByText('Handler for').closest('dl') as HTMLElement;
    expect(within(facts).getByText('Org.nr. 312 521 172')).toBeTruthy();
    expect(within(facts).queryByText(/\(org\.nr\./)).toBeNull();
  });

  it('shows the name and the organisation number when the organisation has a name', async () => {
    await openProfileAs({ orgNumber: '999888777', name: 'Testetaten', actions: ['use-services'] });

    expect(screen.getByText('Testetaten (org.nr. 999 888 777)')).toBeTruthy();
  });
});
