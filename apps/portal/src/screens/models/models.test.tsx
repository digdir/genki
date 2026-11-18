// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogModel } from '../../api/models';
import { mockFetch } from '../../mock';
import { expectAccessible, heldFetch, renderAt } from '../../test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id,
  maker: 'OpenAI',
  operator: { name: 'Microsoft Azure', region: 'Sverige' },
  residency: 'eu',
  capabilities: ['stream'],
  operations: ['chat'],
  price: null,
  recommended: false,
  available: true,
  ...extra,
});

const fillers = Array.from({ length: 21 }, (_, i) => model(`m${String(i).padStart(2, '0')}`));

const catalog: CatalogModel[] = [
  ...fillers,
  model('aivar/borealis-27b', {
    name: 'Borealis-27B',
    maker: 'AIVAR',
    operator: { name: 'AI-gatewayen' },
    residency: 'norway',
    contextWindow: 128000,
    releaseDate: '2026-09-01',
  }),
  model('mistral-large', {
    maker: 'Mistral AI',
    operator: { name: 'Mistral AI', region: 'Frankrike' },
    price: { inputPerThousand: 0.002, outputPerThousand: 0.006 },
    releaseDate: '2026-10-01',
  }),
  model('dear', { price: { inputPerThousand: 0.06, outputPerThousand: 0.12 } }),
  model('zeta', { recommended: true }),
  model('held', { available: false, reason: 'requires_approval', residency: 'global' }),
  model('refused', { available: false, reason: 'not_allowed' }),
];

const at = (path: string, models: CatalogModel[] = catalog) =>
  renderAt(path, mockFetch(undefined, undefined, models));

const cardNames = () =>
  screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '');

describe('the model catalogue', () => {
  it('shows the models the tenant can use as cards, recommended first, 20 at a time', async () => {
    await at('#/building-blocks/models');
    expect(await screen.findByRole('heading', { level: 1, name: 'Modeller' })).toBeTruthy();
    expect(await screen.findByText('Viser 20 av 25 modeller dere kan bruke')).toBeTruthy();
    expect(cardNames()[0]).toBe('zeta');
    expect(cardNames()).toHaveLength(20);
    expect(cardNames()).not.toContain('held');

    fireEvent.click(screen.getByRole('button', { name: 'Vis flere' }));
    expect(cardNames()).toHaveLength(25);
    expect(screen.queryByRole('button', { name: 'Vis flere' })).toBeNull();
  });

  it('shows the three facts on a card from the API: context window, price per 1M tokens and where data is processed', async () => {
    await at('#/building-blocks/models');
    const card = (await screen.findByRole('link', { name: 'Borealis-27B' })).closest('li');
    fireEvent.click(screen.getByRole('button', { name: 'Vis flere' }));
    expect(within(card as HTMLElement).getByText('128 000 tokens')).toBeTruthy();
    expect(within(card as HTMLElement).getByText('Ikke priset')).toBeTruthy();
    expect(within(card as HTMLElement).getByText('Norge')).toBeTruthy();
    const mistral = screen.getByRole('link', { name: 'mistral-large' }).closest('li');
    expect(within(mistral as HTMLElement).getByText('2,00 / 6,00 kr')).toBeTruthy();
    expect(within(mistral as HTMLElement).getByText('EU/EØS (Frankrike)')).toBeTruthy();
    expect(within(mistral as HTMLElement).getByText('Ikke oppgitt')).toBeTruthy();
  });

  it('searches by name, maker or where data is processed', async () => {
    await at('#/building-blocks/models');
    await screen.findByText('Viser 20 av 25 modeller dere kan bruke');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk' }), {
      target: { value: 'norge' },
    });
    expect(cardNames()).toEqual(['Borealis-27B']);
  });

  it('filters by provider and counts the models behind each option', async () => {
    await at('#/building-blocks/models');
    const filters = await screen.findByRole('complementary', { name: 'Filtre' });
    const mistral = within(filters).getByRole('checkbox', { name: 'Mistral AI 1' });
    fireEvent.click(mistral);
    expect(cardNames()).toEqual(['mistral-large']);
    expect(screen.getByText('Viser 1 av 1 modeller dere kan bruke')).toBeTruthy();

    fireEvent.click(within(filters).getByRole('button', { name: 'Nullstill' }));
    expect(cardNames()).toHaveLength(20);
  });

  it('shows models the policy holds back under "Alle modeller", with their status and a way to ask for access', async () => {
    await at('#/building-blocks/models');
    const filters = await screen.findByRole('complementary', { name: 'Filtre' });
    fireEvent.click(within(filters).getByRole('radio', { name: /^Alle modeller/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Vis flere' }));

    const held = screen.getByRole('link', { name: 'held' }).closest('li') as HTMLElement;
    expect(within(held).getByText('Krever godkjenning')).toBeTruthy();
    expect(
      within(held).getByRole('link', { name: 'Be om tilgang til held' }).getAttribute('href'),
    ).toBe('#/building-blocks/model/held');
    const refused = screen.getByRole('link', { name: 'refused' }).closest('li') as HTMLElement;
    expect(within(refused).getByText('Ikke tillatt')).toBeTruthy();
    expect(within(refused).queryByRole('link', { name: /Be om tilgang/ })).toBeNull();
  });

  it('takes the status and the services that use a model from the building blocks', async () => {
    await at('#/building-blocks/models');
    const card = (await screen.findByRole('link', { name: 'Borealis-27B' })).closest('li');
    expect(within(card as HTMLElement).getByText('I bruk')).toBeTruthy();
  });

  it('sorts by price lowest first and by release date newest first', async () => {
    await at('#/building-blocks/models');
    await screen.findByText('Viser 20 av 25 modeller dere kan bruke');
    const sort = screen.getByRole('combobox', { name: 'Sorter etter' });
    fireEvent.change(sort, { target: { value: 'price' } });
    expect(cardNames().slice(0, 2)).toEqual(['mistral-large', 'dear']);
    fireEvent.change(sort, { target: { value: 'newest' } });
    expect(cardNames().slice(0, 2)).toEqual(['mistral-large', 'Borealis-27B']);
  });

  it('compares two or three models in a table that marks the rows that differ', async () => {
    await at('#/building-blocks/models');
    await screen.findByText('Viser 20 av 25 modeller dere kan bruke');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sammenlign zeta' }));
    const bar = screen.getByRole('region', { name: 'Sammenligning' });
    const go = within(bar).getByRole('button', { name: 'Sammenlign modeller' });
    expect(go.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sammenlign Borealis-27B' }));
    expect(within(bar).getByText('2 av 3 valgt:')).toBeTruthy();
    fireEvent.click(go);

    const table = screen.getByRole('table');
    const row = (label: RegExp) =>
      within(table).getByRole('rowheader', { name: label }).closest('tr') as HTMLElement;
    expect(within(row(/^Laget av/)).getByText('Ulik')).toBeTruthy();
    expect(within(row(/^Bruksområder/)).queryByText('Ulik')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tilbake til katalogen' }));
    expect(screen.getByRole('checkbox', { name: 'Sammenlign zeta' })).toBeTruthy();
  });

  it('offers a way out when no model matches', async () => {
    await at('#/building-blocks/models');
    await screen.findByText('Viser 20 av 25 modeller dere kan bruke');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk' }), {
      target: { value: 'finnes ikke' },
    });
    expect(screen.getByText('Ingen modeller passer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill filtre' }));
    expect(cardNames()).toHaveLength(20);
  });

  it('is reachable from the models in Byggeklosser and passes the accessibility checks', async () => {
    await at('#/building-blocks/models');
    await screen.findByText('Viser 20 av 25 modeller dere kan bruke');
    expectAccessible();
  });
});

describe('models in use', () => {
  it('shows the real column headings with skeleton rows while the models load', async () => {
    const { fetch, release } = heldFetch(
      /\/models\?all=true/,
      mockFetch(undefined, undefined, catalog),
    );
    await renderAt('#/building-blocks/models/in-use', fetch);
    expect(await screen.findByRole('heading', { level: 1, name: 'Modeller i bruk' })).toBeTruthy();
    expect(
      await screen.findByRole('columnheader', { name: 'Brukes av tjenester', hidden: true }),
    ).toBeTruthy();
    expect(screen.queryByRole('rowheader')).toBeNull();
    await release();
    expect(await screen.findByRole('link', { name: 'Borealis-27B' })).toBeTruthy();
  });

  it('pages the table 15 rows at a time', async () => {
    await at('#/building-blocks/models/in-use');
    expect(await screen.findByRole('heading', { level: 1, name: 'Modeller i bruk' })).toBeTruthy();
    const pager = screen.getByRole('navigation', { name: 'Sider' });
    expect(within(pager).getByText('1-15 av 27')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(16);
    expect(
      within(pager).getByRole('button', { name: 'Forrige' }).getAttribute('aria-disabled'),
    ).toBe('true');

    fireEvent.click(within(pager).getByRole('button', { name: 'Side 2' }));
    expect(within(pager).getByText('16-27 av 27')).toBeTruthy();
    expect(within(pager).getByRole('button', { name: 'Side 2' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(pager).getByRole('button', { name: 'Neste' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('lists the most used first and sorts by a column when its heading is clicked', async () => {
    await at('#/building-blocks/models/in-use');
    const table = await screen.findByRole('table');
    const first = () => within(table).getAllByRole('rowheader')[0]?.textContent;
    expect(first()).toBe('Borealis-27B');

    fireEvent.click(within(table).getByRole('button', { name: 'Navn' }));
    expect(
      within(table).getByRole('columnheader', { name: 'Navn' }).getAttribute('aria-sort'),
    ).toBe('ascending');
    expect(first()).toBe('Borealis-27B');
    fireEvent.click(within(table).getByRole('button', { name: 'Navn' }));
    expect(first()).toBe('zeta');
  });

  it('names the services that use a model and can show only the models in use', async () => {
    await at('#/building-blocks/models/in-use');
    const table = await screen.findByRole('table');
    expect(within(table).getByText(/^5 tjenester: /)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bare de som brukes av en tjeneste' }));
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual(['Borealis-27B']);
  });

  it('searches models by the services that use them', async () => {
    await at('#/building-blocks/models/in-use');
    const table = await screen.findByRole('table');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk' }), {
      target: { value: 'rapportassistenten' },
    });
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual(['Borealis-27B']);
    expectAccessible();
  });
});
