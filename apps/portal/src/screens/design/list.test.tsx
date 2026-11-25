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

const table = async () =>
  within(await screen.findByRole('region', { name: 'Designelementer' })).getByRole('table');

const names = (rows: HTMLElement) =>
  within(rows)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.querySelector('a')?.textContent);

describe('Utforming, the organisation’s designelementer', () => {
  it('lists our designelementer, genki’s and those shared with everyone', async () => {
    await studioAt('#/design');
    expect(await screen.findByRole('heading', { level: 1, name: 'Utforming' })).toBeTruthy();
    const listed = names(await table());
    expect(listed).toContain('Kildeliste kompakt');
    expect(listed).toContain('Samtale');
    expect(listed).toContain('Kudos-dokumentkort');
    const row = screen
      .getByRole('link', { name: 'Kildeliste kompakt' })
      .closest('tr') as HTMLElement;
    expect(within(row).getByText('Uten kode')).toBeTruthy();
    expect(within(row).getByText('21. nov.')).toBeTruthy();
    expect(within(row).getByText('1 tjeneste')).toBeTruthy();
    expect(within(row).getByText('Delt med alle')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Lag et designelement' }).getAttribute('href')).toBe(
      '#/design/new',
    );
  });

  it('filters to Våre, Fra genki and Delt med alle', async () => {
    await studioAt('#/design');
    await table();
    fireEvent.click(screen.getByRole('radio', { name: 'Våre' }));
    expect(names(await table())).toEqual(['Kildeliste kompakt', 'Figur i svaret', 'Spørsmålskort']);
    fireEvent.click(screen.getByRole('radio', { name: 'Fra genki' }));
    expect(names(await table())).toContain('Samtale');
    expect(names(await table())).not.toContain('Kildeliste kompakt');
    fireEvent.click(screen.getByRole('radio', { name: 'Delt med alle' }));
    expect(names(await table())).toEqual(['Kudos-dokumentkort']);
  });

  it('says so in one line when there are none', async () => {
    await studioAt(
      '#/design',
      mockFetch(undefined, undefined, undefined, undefined, {
        features: { design: { blocks: [] } },
      }),
    );
    expect(await screen.findByText('Ingen designelementer ennå.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says so in one line when nothing matches the search', async () => {
    await studioAt('#/design');
    await table();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i designelementene' }), {
      target: { value: 'finnes ikke' },
    });
    expect(screen.getByText('Ingen designelementer passer søket.')).toBeTruthy();
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

  it('answers the Utforming address with page not found', async () => {
    await renderAt('#/design');
    expect(await screen.findByRole('heading', { level: 1, name: 'Fant ikke siden' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Designelementer' })).toBeNull();
  });
});
