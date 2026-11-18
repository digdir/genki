// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { translator } from '../i18n';
import { exampleOrganisations, mockFetch } from '../mock';
import { expectAccessible, failingFetch } from '../test-utils';

const nb = translator('nb');

beforeEach(() => {
  window.location.hash = '#/data-handling';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const models = [
  {
    id: 'foundry-openai/gpt-4.1-mini',
    name: 'GPT-4.1 mini',
    residency: 'global' as const,
    capabilities: ['stream'],
  },
  {
    id: 'ai-gateway/aivar-borealis',
    name: 'Borealis',
    residency: 'norway' as const,
    capabilities: ['stream'],
  },
  {
    id: 'foundry-openai/gpt-6-luna',
    name: 'GPT-6 luna',
    residency: 'eu' as const,
    capabilities: ['stream'],
  },
];

const signedIn = async () => {
  const auth = mockAnsattporten({ name: 'Kari', organisations: exampleOrganisations });
  await auth.login();
  return auth;
};

const bodyRows = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    );

describe('Slik behandles data', () => {
  it('is readable before login, with the residency statement, storage, access and sub-processors', async () => {
    const auth = mockAnsattporten({ name: 'Kari', organisations: exampleOrganisations });
    render(<App auth={auth} fetch={mockFetch()} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Slik behandles data' }),
    ).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Modellene',
      'Hva som lagres, og hvor lenge',
      'Hvem som ser hva',
      'Underleverandører',
    ]);
    expect(screen.getByText(nb('about.residencyStatement'))).toBeTruthy();
    expect(screen.getByText(nb('about.dhModelsSignIn'))).toBeTruthy();
    const page = document.body.textContent ?? '';
    expect(page).toContain('Standard er 90 dager');
    expect(page).toContain('bare gjennom en støtteøkt');
    expect(page).toContain('Microsoft (Azure)');
    expect(page).not.toMatch(/example\.no|I dag kjører modellene i Azure med global behandling/);
    expectAccessible();
  });

  it('gives the same residency statement on the landing page as on the data handling page', async () => {
    window.location.hash = '#/';
    const auth = mockAnsattporten({ name: 'Kari', organisations: exampleOrganisations });
    render(<App auth={auth} fetch={mockFetch()} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText(nb('about.residencyStatement'))).toBeTruthy();
  });

  it('names each model and where it processes data from the API once logged in', async () => {
    render(<App auth={await signedIn()} fetch={mockFetch(undefined, undefined, models)} live />);

    const table = await screen.findByRole('table');
    expect(bodyRows(table)).toEqual([
      [
        'Borealisai-gateway/aivar-borealis',
        'Norge',
        'Ikke oppgitt',
        'Azure, Nederland',
        '90 dager (standard)',
      ],
      [
        'GPT-4.1 minifoundry-openai/gpt-4.1-mini',
        'Global behandling, kan være utenfor EU/EØS',
        'Ikke oppgitt',
        'Azure, Nederland',
        '90 dager (standard)',
      ],
      [
        'GPT-6 lunafoundry-openai/gpt-6-luna',
        'EU/EØS',
        'Ikke oppgitt',
        'Azure, Nederland',
        '90 dager (standard)',
      ],
    ]);
    expect(
      screen.getByText('1 av de 3 modellene dere kan bruke, har global behandling.'),
    ).toBeTruthy();
  });

  it('names who runs each model and its region from the model facts, and the Azure models as a sub-processor', async () => {
    const withOperators = [
      {
        id: 'foundry-openai/gpt-6-luna',
        name: 'GPT-6 luna',
        residency: 'eu' as const,
        capabilities: ['stream'],
        operator: { name: 'Microsoft Azure', region: 'Sverige' },
      },
      {
        id: 'ai-gateway/aivar-borealis',
        name: 'Borealis',
        residency: 'norway' as const,
        capabilities: ['stream'],
        operator: { name: 'KI-gatewayen', region: 'Norge' },
      },
    ];
    render(
      <App auth={await signedIn()} fetch={mockFetch(undefined, undefined, withOperators)} live />,
    );
    const table = await screen.findByRole('table');
    expect(bodyRows(table).map((r) => r.slice(1, 3))).toEqual([
      ['Norge (Norge)', 'KI-gatewayen'],
      ['EU/EØS (Sverige)', 'Microsoft Azure'],
    ]);
    expect(
      screen.getByText(
        'Kjører GPT-6 luna i Sverige. Lagrer spørsmål, svar og datasett i Nederland.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Kjører Borealis. Data forlater ikke Norge.')).toBeTruthy();
  });

  it('sorts the model table by a column and turns the order when the column is chosen again', async () => {
    render(<App auth={await signedIn()} fetch={mockFetch(undefined, undefined, models)} live />);

    const table = await screen.findByRole('table');
    const where = within(table).getByRole('columnheader', { name: 'Hvor data behandles' });
    expect(where.getAttribute('aria-sort')).toBe('none');
    fireEvent.click(within(where).getByRole('button'));
    expect(where.getAttribute('aria-sort')).toBe('ascending');
    expect(bodyRows(table).map((r) => r[1])).toEqual([
      'EU/EØS',
      'Global behandling, kan være utenfor EU/EØS',
      'Norge',
    ]);
    fireEvent.click(within(where).getByRole('button'));
    expect(where.getAttribute('aria-sort')).toBe('descending');
    expect(bodyRows(table).map((r) => r[1])[0]).toBe('Norge');
  });

  it('lists the AI gateway as a sub-processor only for the gateway models the API returns', async () => {
    render(<App auth={await signedIn()} fetch={mockFetch(undefined, undefined, models)} live />);
    await screen.findByRole('table');
    expect(screen.getByText('Kjører Borealis. Data forlater ikke Norge.')).toBeTruthy();

    cleanup();
    render(
      <App
        auth={await signedIn()}
        fetch={mockFetch(undefined, undefined, models.slice(0, 1))}
        live
      />,
    );
    await screen.findByRole('table');
    expect(screen.queryByText('KI-gatewayen i Norge')).toBeNull();
  });

  it('downloads as PDF through the print window', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    render(<App auth={await signedIn()} fetch={mockFetch(undefined, undefined, models)} live />);
    fireEvent.click(await screen.findByRole('button', { name: 'Last ned som PDF' }));
    expect(print).toHaveBeenCalledOnce();
  });

  it('shows a model list error with retry instead of an empty table', async () => {
    let fail = true;
    const ok = mockFetch(undefined, undefined, models);
    const broken = failingFetch(/\/models/, 503, ok);
    render(
      <App
        auth={await signedIn()}
        fetch={(i, init) => (fail ? broken(i, init) : ok(i, init))}
        live
      />,
    );
    expect(await screen.findByText('Vi fikk ikke hentet listen over modeller')).toBeTruthy();
    expect(screen.getByText(nb('about.residencyStatement'))).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });
});
