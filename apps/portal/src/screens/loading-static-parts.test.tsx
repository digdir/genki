// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import { go, kari } from '../test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const whileDataLoads = async (hash: string) => {
  const base = mockFetch();
  let holding = false;
  const fetch: typeof globalThis.fetch = (input, init) =>
    holding ? new Promise<Response>(() => undefined) : base(input, init);
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = '#/profile';
  render(<App auth={auth} fetch={fetch} live />);
  await screen.findByRole('heading', { level: 1, name: 'Profil' });
  holding = true;
  go(hash);
  await waitFor(() => expect(document.querySelector('main .state.loading')).not.toBeNull(), {
    timeout: 5_000,
  });
};

const loading = (name: string) => screen.getByRole('status', { name });

describe('the title, back link, tabs and buttons show while the data loads', () => {
  it('Tjenester shows its title, Ny tjeneste and the search while the list loads', async () => {
    await whileDataLoads('#/services');

    expect(loading('Henter tjenester')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Tjenester' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ny tjeneste' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Søk i tjenester' })).toBeTruthy();
  });

  it('a service shows the back link, its tabs and a grey Publiser while it loads', async () => {
    await whileDataLoads('#/services/rapportassistenten/setup');

    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Tjenester' })).toBeTruthy();
    const tabs = screen.getByRole('tablist');
    expect(within(tabs).getByRole('tab', { name: 'Oppsett' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(within(tabs).getByRole('tab', { name: 'Oversikt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publiser' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('a building block shows the back link and its tabs while it loads', async () => {
    await whileDataLoads('#/building-blocks/model/qwen');

    expect(loading('Henter byggeklossen')).toBeTruthy();
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Byggeklosser' }),
    ).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Om' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Brukes av' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Versjoner' })).toBeTruthy();
  });

  it('Innstillinger shows its title and tabs while the settings load', async () => {
    await whileDataLoads('#/settings/all');

    expect(screen.getByRole('heading', { level: 1, name: 'Innstillinger' })).toBeTruthy();
    expect(
      screen.getByRole('tab', { name: 'Alle innstillinger' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByRole('tab', { name: 'Vanlige' })).toBeTruthy();
  });

  it('Stegflyter shows its tabs, title and Ny stegflyt while the flows load', async () => {
    await whileDataLoads('#/step-flows');

    expect(screen.getByRole('tab', { name: 'I tjenesten' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Stegflyter' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ny stegflyt' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Ingen stegflyter ennå' })).toBeNull();
  });

  it('Brukerflater shows the lead and Registrer brukerflate while the list loads', async () => {
    await whileDataLoads('#/developer/frontends');

    expect(await screen.findByRole('status', { name: 'Henter brukerflater' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Registrer brukerflate' })).toBeTruthy();
  });
});
