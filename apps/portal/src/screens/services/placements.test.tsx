// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { logTimelines } from '../../data/log';
import { exampleDatasets, exampleOrganisations, exampleServices, mockFetch } from '../../mock';
import { openArea, setupNav } from './setup-areas.test-utils';

document.getAnimations ??= () => [];
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const openService = async (hash: string) => {
  const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
  await auth.login();
  window.location.hash = hash;
  render(
    <App
      auth={auth}
      fetch={mockFetch(exampleServices, logTimelines, undefined, exampleDatasets)}
      live
    />,
  );
  return (await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' })).closest(
    'header',
  ) as HTMLElement;
};

const tabTo = async (section: string, tab: string) => {
  window.location.hash = `#/services/rapportassistenten/${section}`;
  await waitFor(() =>
    expect(
      within(screen.getByRole('tablist', { name: /^Faner for/ })).getByRole('tab', {
        selected: true,
      }).textContent,
    ).toBe(tab),
  );
};

describe('features the design lacks keep their place on the service page', () => {
  it('lists Arbeidsmåte right after Modell and Kanaler right after Varianter under Avansert', async () => {
    await openService('#/services/rapportassistenten/setup');
    await screen.findByRole('navigation', { name: 'Deler av oppsettet' });
    fireEvent.click(within(setupNav()).getByRole('button', { name: /^Avansert/ }));

    const names = within(setupNav())
      .getAllByRole('button')
      .map((b) => b.querySelector('.setup-nav-name')?.textContent)
      .filter(Boolean);
    expect(names.slice(names.indexOf('Modell'))).toEqual([
      'Modell',
      'Arbeidsmåte',
      'Verktøy',
      'Varianter',
      'Kanaler',
      'Sikkerhetsregler',
      'Risiko og KI-forordningen',
      'Begrensninger og loggføring',
    ]);
  });

  it('edits start, channels and variants under Oppsett › Kanaler, and Nøkler og kanaler links there', async () => {
    await openService('#/services/rapportassistenten/setup/channels');
    expect(await screen.findByRole('heading', { level: 2, name: 'Kanaler' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Varianter' })).toBeTruthy();
    expect(screen.getByLabelText('Offentlig navn')).toBeTruthy();

    await tabTo('channels', 'Teknisk');
    const link = await screen.findByRole('link', {
      name: 'Kanaler og varianter endrer du i Oppsett, under Kanaler',
    });
    expect(link.getAttribute('href')).toBe('#/services/rapportassistenten/setup/channels');
    expect(screen.queryByLabelText('Offentlig navn')).toBeNull();
  });

  it('takes the old start address to Oppsett › Kanaler', async () => {
    await openService('#/services/rapportassistenten/setup/start');
    expect(await screen.findByRole('heading', { level: 2, name: 'Kanaler' })).toBeTruthy();
  });

  it('shows Lyd and Data fra et system as cards under Inndata even when they are off', async () => {
    await openService('#/services/rapportassistenten/setup');
    await screen.findByRole('navigation', { name: 'Deler av oppsettet' });
    openArea(/^Inndata/);

    const kinds = await screen.findByRole('group', { name: 'Hva sender brukeren?' });
    const audio = within(kinds).getByRole('checkbox', { name: /^Lyd/ }) as HTMLInputElement;
    const system = within(kinds).getByRole('checkbox', {
      name: /^Data fra et system/,
    }) as HTMLInputElement;
    expect(audio.checked).toBe(false);
    expect(system.checked).toBe(false);

    fireEvent.click(audio);
    expect(
      (within(kinds).getByRole('checkbox', { name: /^Lyd/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('opens the Prøv pane from Prøv in the header on Oppsett, links Prøv to Prøveområdet on other tabs', async () => {
    const header = await openService('#/services/rapportassistenten/setup');
    await screen.findByRole('navigation', { name: 'Deler av oppsettet' });
    expect(within(header).queryByRole('link', { name: 'Prøv' })).toBeNull();

    fireEvent.click(within(header).getByRole('button', { name: 'Prøv' }));
    const pane = screen.getByRole('region', { name: 'Byggeassistent og prøving' });
    expect(
      within(pane)
        .getByRole('link', { name: 'Åpne i Prøveområdet med tidslinje' })
        .getAttribute('href'),
    ).toBe('#/playground?service=rapportassistenten');
    expect(within(pane).queryByRole('button', { name: /Sammenlign/ })).toBeNull();
    expect(within(pane).queryByRole('combobox', { name: 'Svarspråk' })).toBeNull();

    await tabTo('quality', 'Kvalitet');
    expect(within(header).getByRole('link', { name: 'Prøv' }).getAttribute('href')).toBe(
      '#/playground?service=rapportassistenten',
    );
  });
});
