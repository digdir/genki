// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectAccessible, renderAt } from '../../test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const open = async (hash: string) => {
  await renderAt(hash);
  await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' }, { timeout: 5000 });
};

const header = () =>
  screen.getByRole('heading', { level: 1, name: 'Rapportassistenten' }).closest('header');

describe('the Oppsett of a published service', () => {
  it('opens a published service in the one-form Oppsett with the builder assistant beside it', async () => {
    await open('#/services/rapportassistenten/setup');
    expect(await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' })).toBeTruthy();
    for (const area of ['Formål og målgruppe', 'Kunnskap', 'Inndata', 'Resultat', 'Modell'])
      expect(screen.getByRole('heading', { level: 3, name: area })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Byggeassistent og prøving' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Deler av oppsettet' })).toBeNull();
    const tabs = within(screen.getByRole('tablist', { name: /^Faner for/ }))
      .getAllByRole('tab')
      .map((tab) => tab.textContent);
    expect(tabs).toContain('Avansert');
    expectAccessible();
  });

  it("shows Test tjenesten and no Prøv side pane in a published service's header", async () => {
    await open('#/services/rapportassistenten/setup');
    const top = header() as HTMLElement;
    expect(within(top).getByRole('link', { name: 'Test tjenesten' }).getAttribute('href')).toBe(
      '#/services/rapportassistenten/interface/preview',
    );
    expect(within(top).queryByRole('button', { name: 'Prøv' })).toBeNull();
    expect(within(top).queryByRole('link', { name: 'Prøv' })).toBeNull();
  });
});

describe("the footer of a published service's Oppsett", () => {
  it('does not say Oversikt and Kvalitet come once the service is published, when it already is', async () => {
    await open('#/services/rapportassistenten/setup');
    await screen.findByRole('heading', { level: 3, name: 'Inndata' }, { timeout: 5000 });
    expect(
      screen.queryByText('Oversikt og Kvalitet kommer når tjenesten er publisert.'),
    ).toBeNull();
  });
});

describe('Avansert → API-nøkler og kanaler of a published service', () => {
  it('shows API keys, address and clients under Avansert → Kanaler for a published service', async () => {
    await open('#/services/rapportassistenten/advanced/channels');
    expect(
      await screen.findByRole('button', { name: 'Lag API-nøkkel' }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'API-nøkler' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Egne løsninger' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Egen nettside' })).toBeTruthy();
  });
});
