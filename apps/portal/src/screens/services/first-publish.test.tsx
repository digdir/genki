// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirstPublish, type Left } from './FirstPublish';

afterEach(cleanup);

const page = (left: Left[], onPublish = vi.fn(async () => {})) => {
  render(
    <FirstPublish
      title="Publiser Ny tjeneste"
      intro="Tjenesten blir tilgjengelig for brukerne når du publiserer."
      backHref="#/services/utkast-1/setup"
      left={left}
      facts={[{ label: 'Testsett', value: 'Ikke laget' }]}
      riskConfirmed={false}
      riskName="Minimal risiko"
      risk={<button type="button">Bekreft risikonivå</button>}
      guards={<p>Ingen sikkerhetsregler</p>}
      apiCall={{
        action: 'Publiser',
        method: 'POST',
        path: '/definitions',
        body: {},
        right: 'Administrere tjenester',
      }}
      canPublish
      onPublish={onPublish}
    />,
  );
  return onPublish;
};

const confirmRisk: Left = { key: 'risk', text: 'Bekreft risikonivået', on: 'risk' };

describe('the first publish of a new service', () => {
  it('lists what is left under one heading, with a link to where it is put right', () => {
    page([
      {
        key: 'p',
        text: 'Formål og målgruppe: Må fylles ut.',
        href: '#/services/utkast-1/setup/purpose',
      },
      confirmRisk,
    ]);
    expect(screen.getByText('Dette gjenstår før du kan publisere')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Formål og målgruppe: Må fylles ut.' }).getAttribute('href'),
    ).toBe('#/services/utkast-1/setup/purpose');
  });

  it('never locks Publiser, and says what is left instead of publishing when pressed', async () => {
    const onPublish = page([confirmRisk]);
    const button = screen.getByRole('button', { name: 'Publiser' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByText(/Du kan ikke publisere ennå/)).toBeTruthy();
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('moves to the risk level on the same page instead of leaving it', () => {
    page([confirmRisk]);
    const link = screen.getByRole('link', { name: 'Bekreft risikonivået' });
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
    expect(document.activeElement?.getAttribute('aria-labelledby')).toBe(
      screen.getByRole('heading', { name: 'Risiko og KI-forordningen' }).id,
    );
  });

  it('asks for a reason before it publishes', async () => {
    const onPublish = page([]);
    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    expect(onPublish).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Første utgave av tjenesten for ansatte.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    await waitFor(() =>
      expect(onPublish).toHaveBeenCalledWith('Første utgave av tjenesten for ansatte.'),
    );
  });

  it('shows the edition as a table with a caption and row headers', () => {
    page([]);
    const table = screen.getByRole('table', { name: 'Utgave 1, første utgave' });
    expect(table.querySelector('th[scope="row"]')?.textContent).toBe('Testsett');
  });
});
