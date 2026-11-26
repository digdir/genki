// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { logTimelines } from '../../data/log';
import { exampleDatasets, exampleOrganisations, exampleServices, mockFetch } from '../../mock';

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

describe('features the design lacks keep their place on the service page', () => {
  it('lists the parts of Avansert of a published service in the order of its menu', async () => {
    await openService('#/services/rapportassistenten/advanced');
    const menu = await screen.findByRole('tablist', { name: 'Avansert' });
    expect(
      within(menu)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual([
      'Arbeidsmåte',
      'Verktøy',
      'Varianter',
      'Begrensninger og loggføring',
      'API-nøkler og kanaler',
      'Oppsettet som JSON',
      'Oppsettet som YAML',
    ]);
  });

  it('edits start, channels and variants under Avansert › API-nøkler og kanaler', async () => {
    await openService('#/services/rapportassistenten/advanced/channels');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'API-nøkler og kanaler' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Varianter' })).toBeTruthy();
    expect(screen.getByLabelText('Offentlig navn')).toBeTruthy();
  });

  it('takes the old start address to Avansert › API-nøkler og kanaler', async () => {
    await openService('#/services/rapportassistenten/setup/start');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'API-nøkler og kanaler' }),
    ).toBeTruthy();
    expect(window.location.hash).toBe('#/services/rapportassistenten/advanced/channels');
  });

  it('shows Lyd and Data fra et system as cards under Inndata even when they are off', async () => {
    await openService('#/services/rapportassistenten/setup');

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
});
