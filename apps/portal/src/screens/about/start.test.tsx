// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { translator } from '../../i18n';
import { mockFetch } from '../../mock';
import { expectAccessible, kari } from '../../test-utils';

const nb = translator('nb');
const desktop = 1440;

const open = (hash: string, languages?: readonly string[], width = desktop) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.location.hash = hash;
  return render(<App auth={mockAnsattporten(kari)} fetch={mockFetch()} languages={languages} />);
};

const main = () => screen.getByRole('main');

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
  window.localStorage.clear();
  document.title = '';
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('public start page', () => {
  it('puts the sections in the agreed order: build, architecture, price and data, access, community', async () => {
    open('#/?landing=new');

    await screen.findByRole('heading', { level: 1, name: nb('about.heroTitle') });
    expect(
      within(main())
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual([
      'Hva dere kan lage',
      'Slik er Genki bygd',
      'Pris, vilkår og data',
      'Slik får dere tilgang',
      'Bygg sammen med oss',
    ]);
    expectAccessible();
  });

  it('has one primary action, Be om tilgang, in the hero and after the steps', async () => {
    open('#/?landing=new');
    await screen.findByRole('heading', { level: 1 });

    const primary = [...main().querySelectorAll('.ds-button[data-variant="primary"]')];
    expect(primary.map((b) => b.textContent)).toEqual(['Be om tilgang', 'Be om tilgang']);
    expect(primary[0]?.getAttribute('href')).toBe('#kom-i-gang');
    expect(within(main()).queryByRole('button', { name: 'Send forespørsel' })).toBeNull();
  });

  it('says each key fact once: where data is processed, price, GitHub and Ansattporten', async () => {
    open('#/?landing=new');
    await screen.findByRole('heading', { level: 1 });

    expect(within(main()).getAllByText(nb('dataHandling.processingToday'))).toHaveLength(1);
    expect(within(main()).getAllByText(nb('about.factCost'))).toHaveLength(1);
    expect(
      [...main().querySelectorAll('a')].filter((a) => a.href === 'https://github.com/digdir/genki')
        .length,
    ).toBe(1);
    const prose = [...main().querySelectorAll('p, dd')].filter((e) => !e.closest('.figure'));
    expect(prose.filter((e) => e.textContent?.includes('Ansattporten'))).toHaveLength(1);
  });

  it('shows at most six cards and no more than one Ikke bestemt tag', async () => {
    open('#/?landing=new');
    await screen.findByRole('heading', { level: 1 });

    expect(main().querySelectorAll('.ds-card').length).toBeLessThanOrEqual(6);
    expect(within(main()).queryAllByText('Ikke bestemt').length).toBeLessThanOrEqual(1);
    expect(main().querySelectorAll('.ds-alert')).toHaveLength(0);
  });

  it('restores the shared services and the three examples from the old start page', async () => {
    open('#/?landing=new');
    await screen.findByRole('heading', { level: 1 });

    const build = screen.getByRole('region', { name: 'Hva dere kan lage' });
    for (const name of ['Klarspråk', 'Anonymisering', 'Spør rapportene', 'Utkast til vedtak'])
      expect(within(build).getByRole('heading', { name })).toBeTruthy();
  });

  it('links price and terms, data handling and status to their own public pages', async () => {
    open('#/?landing=new');
    await screen.findByRole('heading', { level: 1 });

    const tiles = screen.getByRole('region', { name: 'Pris, vilkår og data' });
    expect(
      within(tiles)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['#/about/price-and-terms', '#/data-handling', '#/about/status']);
  });

  it('lists the four access steps and names the access manager in step three', async () => {
    open('#/?landing=new');
    await screen.findByRole('heading', { level: 1 });

    const access = screen.getByRole('region', { name: 'Slik får dere tilgang' });
    expect(within(access).getAllByRole('listitem')).toHaveLength(4);
    expect(within(access).getByText(/Den som styrer tilganger i Altinn hos dere/)).toBeTruthy();
    expect(within(access).queryByText(/Tilgangsstyreren|Første administrator/)).toBeNull();
  });

  it('signs in from the line for agencies that already have access', async () => {
    open('#/?landing=new');
    const access = await screen.findByRole('region', { name: 'Slik får dere tilgang' });

    fireEvent.click(within(access).getByRole('button', { name: 'Logg inn' }));

    expect(
      await screen.findByRole('button', {
        name: 'Handler for Testetaten, org.nr. 999 888 777. Bytt virksomhet',
      }),
    ).toBeTruthy();
  });

  it('shows the Norwegian-only line under the hero buttons on English pages only', async () => {
    open('#/?landing=new', ['en']);
    await screen.findByRole('heading', {
      level: 1,
      name: 'Genki: generative AI for public agencies',
    });
    expect(
      screen
        .getByText('The documentation is only available in Norwegian for now.')
        .closest('.about-hero'),
    ).toBeTruthy();

    cleanup();
    open('#/?landing=new');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(nb('about.nbOnly'))).toBeNull();
  });

  it('gives the start page and the price page their own document titles', async () => {
    open('#/?landing=new');
    await screen.findByRole('heading', { level: 1 });
    const start = document.title;

    cleanup();
    open('#/about/price-and-terms');
    await screen.findByRole('heading', { level: 1, name: 'Pris og vilkår' });

    expect(start).toBe('Genki: generativ KI for offentlige virksomheter');
    expect(document.title).toBe('Pris og vilkår | Genki');
  });

  it('opens the price and terms page without signing in, with the open questions tagged', async () => {
    open('#/about/price-and-terms');

    expect(await screen.findByRole('heading', { level: 1, name: 'Pris og vilkår' })).toBeTruthy();
    expect(within(main()).getAllByText('Ikke bestemt')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Slik behandles data' }).getAttribute('href')).toBe(
      '#/data-handling',
    );
    expectAccessible();
  });

  it('has one footer that carries the source line', async () => {
    open('#/?landing=new');
    await screen.findByRole('heading', { level: 1 });

    const footers = screen.getAllByRole('contentinfo');
    expect(footers).toHaveLength(1);
    expect(within(footers[0] as HTMLElement).getByText(nb('about.footerSource'))).toBeTruthy();
  });
});

describe('public header', () => {
  it('shows four sections, search, more and sign in on wide screens', async () => {
    open('#/?landing=new');

    const nav = await screen.findByRole('navigation', { name: 'Om Genki' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Målbilde', 'Byggeklosser', 'Tjenestetyper', 'Flyt']);
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('button', { name: 'Søk (Ctrl+K)' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'Mer' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'Logg inn' })).toBeTruthy();
  });

  it('keeps For utviklere, GitHub, theme and language in the more menu', async () => {
    open('#/?landing=new');
    const header = within(await screen.findByRole('banner'));
    fireEvent.click(header.getByRole('button', { name: 'Mer' }));
    const menu = within(document.querySelector('.ds-dropdown') as HTMLElement);
    const inPopover = { hidden: true };

    expect(
      menu.getByRole('link', { name: 'For utviklere', ...inPopover }).getAttribute('href'),
    ).toBe('#/about/developers');
    expect(menu.getByRole('link', { name: 'Kildekoden', ...inPopover })).toBeTruthy();
    expect(menu.getByRole('link', { name: 'Arkitekturbeslutninger', ...inPopover })).toBeTruthy();
    expect(menu.getByRole('button', { name: 'Mørkt tema', ...inPopover })).toBeTruthy();
    expect(header.queryByRole('link', { name: 'For utviklere' })).toBeNull();
  });

  it('names the language switch with its visible text, in the language it switches to', async () => {
    open('#/?landing=new');
    const header = within(await screen.findByRole('banner'));
    fireEvent.click(header.getByRole('button', { name: 'Mer' }));

    const english = header.getByRole('button', { name: 'English', hidden: true });
    expect(english.getAttribute('aria-label')).toBeNull();
    expect(english.getAttribute('lang')).toBe('en');

    fireEvent.click(english);

    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'More' }));
    const norsk = await within(screen.getByRole('banner')).findByRole('button', {
      name: 'Norsk',
      hidden: true,
    });
    expect(norsk.getAttribute('lang')).toBe('nb');
  });

  it('shows only the brand, the menu and sign in on narrow screens, the rest in the menu', async () => {
    open('#/?landing=new', undefined, 375);
    const header = within(await screen.findByRole('banner'));

    expect(header.queryByRole('navigation', { name: 'Om Genki' })).toBeNull();
    expect(header.queryByRole('button', { name: 'Søk (Ctrl+K)' })).toBeNull();
    expect(header.queryByRole('button', { name: 'English' })).toBeNull();

    fireEvent.click(header.getByRole('button', { name: 'Meny' }));

    const menu = within(document.getElementById('sidemeny') as HTMLElement);
    expect(menu.getByRole('navigation', { name: 'Om Genki' })).toBeTruthy();
    expect(menu.getByRole('button', { name: 'Søk' })).toBeTruthy();
    expect(menu.getByRole('link', { name: 'For utviklere' })).toBeTruthy();
    expect(menu.getByRole('button', { name: 'Mørkt tema' })).toBeTruthy();
    expect(menu.getByRole('button', { name: 'English' }).getAttribute('lang')).toBe('en');
  });

  it('marks the public root neutral so headings use neutral text', async () => {
    open('#/?landing=new');
    await screen.findByRole('heading', { level: 1 });

    expect(document.querySelector('.about-site')?.getAttribute('data-color')).toBe('neutral');
  });
});
