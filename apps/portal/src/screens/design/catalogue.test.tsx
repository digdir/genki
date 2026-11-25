// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../../mock';
import { renderAt } from '../../test-utils';
import { heldStudio, studioAt } from './studio.test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const cardNames = () =>
  Array.from(document.querySelectorAll('.design-card h2')).map((h) => h.textContent);

describe('Block Studio’s catalogue at Utforming', () => {
  it('shows every block the organisation may use as a card that opens it', async () => {
    await studioAt('#/design');
    expect(await screen.findByRole('heading', { level: 1, name: 'Utforming' })).toBeTruthy();
    const card = await screen.findByRole('link', { name: /Kildeliste kompakt/ });
    expect(card.getAttribute('href')).toBe('#/design/999888777/kildeliste-kompakt');
    expect(within(card).getByText('v3')).toBeTruthy();
    expect(cardNames()).toContain('Samtale');
    expect(cardNames()).toContain('Kudos-dokumentkort');
  });

  it('offers «Åpne i Claude» and «Importer fra Claude» in its header', async () => {
    await studioAt('#/design');
    const claude = await screen.findByRole('link', { name: 'Åpne i Claude' });
    expect(claude.getAttribute('href')).toMatch(/^https:\/\/claude\.ai\/new\?q=/);
    expect(screen.getByRole('link', { name: 'Importer fra Claude' }).getAttribute('href')).toBe(
      '#/design/import',
    );
  });

  it('narrows the cards to genki’s, the organisation’s own or those shared by others', async () => {
    await studioAt('#/design');
    await screen.findByRole('link', { name: /Samtale/ });
    const show = screen.getByRole('group', { name: 'Vis' });
    fireEvent.click(within(show).getByRole('radio', { name: 'Fra genki' }));
    expect(cardNames()).toContain('Samtale');
    expect(cardNames()).not.toContain('Kildeliste kompakt');
    fireEvent.click(within(show).getAllByRole('radio')[2] as HTMLElement);
    expect(cardNames()).toEqual(['Kildeliste kompakt', 'Figur i svaret', 'Spørsmålskort']);
    fireEvent.click(within(show).getByRole('radio', { name: 'Delt' }));
    expect(cardNames()).toEqual(['Kudos-dokumentkort']);
  });

  it('finds a block by a word in its summary, and offers the import when nothing matches', async () => {
    await studioAt('#/design');
    await screen.findByRole('link', { name: /Samtale/ });
    const search = screen.getByRole('searchbox', { name: 'Søk i designelementene' });
    fireEvent.change(search, { target: { value: 'høyre panel' } });
    expect(cardNames()).not.toContain('Samtale');
    expect(cardNames().length).toBeGreaterThan(0);
    fireEvent.change(search, { target: { value: 'finnes ikke' } });
    expect(cardNames()).toEqual([]);
    expect(
      screen
        .getAllByRole('link', { name: /Importer/ })
        .at(-1)
        ?.getAttribute('href'),
    ).toBe('#/design/import');
  });

  it('says so when the organisation may use no block at all', async () => {
    await studioAt(
      '#/design',
      mockFetch(undefined, undefined, undefined, undefined, {
        features: { design: { blocks: [] } },
      }),
    );
    expect(await screen.findByText(/Ingen designelementer passer/)).toBeTruthy();
  });

  it('never answers the Utforming address with page not found while the flags load', async () => {
    const { fetch, release } = heldStudio();
    await renderAt('#/design', fetch);
    await screen.findByRole('navigation', { name: 'Hovedmeny' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('heading', { name: 'Fant ikke siden' })).toBeNull();
    release();
    expect(await screen.findByRole('heading', { level: 1, name: 'Utforming' })).toBeTruthy();
  });

  it('stands after Tjenester in the menu', async () => {
    await studioAt('#/design');
    const menu = await screen.findByRole('navigation', { name: 'Hovedmeny' });
    const links = within(menu)
      .getAllByRole('link')
      .map((a) => a.textContent?.trim());
    expect(links.indexOf('Utforming')).toBe(links.indexOf('Tjenester') + 1);
  });
});

describe('Utforming with blockStudio off', () => {
  it('leaves Utforming out of the menu', async () => {
    await renderAt('#/services');
    const menu = await screen.findByRole('navigation', { name: 'Hovedmeny' });
    await screen.findByRole('heading', { level: 1 });
    expect(within(menu).queryByRole('link', { name: 'Utforming' })).toBeNull();
  });

  it('answers the Utforming address and a block’s address with page not found', async () => {
    await renderAt('#/design');
    expect(await screen.findByRole('heading', { level: 1, name: 'Fant ikke siden' })).toBeTruthy();
    cleanup();
    await renderAt('#/design/999888777/kildeliste-kompakt/versions');
    expect(await screen.findByRole('heading', { level: 1, name: 'Fant ikke siden' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Slett designelementet' })).toBeNull();
  });
});
