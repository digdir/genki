// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { exampleOrganisations, mockFetch } from '../mock';
import { expectAccessible, failingFetch } from '../test-utils';

beforeEach(() => {
  window.location.hash = '#/data-handling';
});
afterEach(cleanup);

const models = [
  {
    id: 'foundry-openai/gpt-4.1-mini',
    name: 'GPT-4.1 mini',
    residency: 'global' as const,
    capabilities: ['stream'],
  },
  { id: 'tenant/norsk-7b', residency: 'norway' as const, capabilities: ['stream'] },
];

describe('Slik behandles data', () => {
  it('is readable before login, with the facts and what is not decided', async () => {
    const auth = mockAnsattporten({ name: 'Kari', organisations: exampleOrganisations });
    render(<App auth={auth} fetch={mockFetch()} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Slik behandles data' }),
    ).toBeTruthy();
    const page = document.body.textContent ?? '';
    expect(page).toContain('kryptert når det er lagret');
    expect(page).toContain('slettes når innholdsnøkkelen slettes');
    expect(page).toContain('samlet og uten navn');
    expect(page).toContain('bare gjennom en støtteøkt');
    expect(page).toContain('driftslogger inneholder ikke spørsmål eller svar');
    expect(page).toContain('Svar laget med KI');
    expect(page).toContain('I dag kjører modellene i Azure med global behandling');
    const undecided = screen.getByRole('list', { name: 'Ikke bestemt ennå' });
    expect(within(undecided).getByText('Databehandleravtale').parentElement?.textContent).toContain(
      'Ikke bestemt',
    );
    expect(
      within(undecided)
        .getAllByText('Ikke bestemt')
        .every((tag) => tag.matches('.ds-tag')),
    ).toBe(true);
    expect(page).not.toMatch(/example\.no|I Norge eller i EU/);
    expectAccessible();
  });

  it('names each model and where it processes data from the API once logged in', async () => {
    const auth = mockAnsattporten({ name: 'Kari', organisations: exampleOrganisations });
    await auth.login();
    render(<App auth={auth} fetch={mockFetch(undefined, undefined, models)} live />);

    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) =>
          within(row)
            .getAllByRole('cell')
            .map((cell) => cell.textContent),
        ),
    ).toEqual([
      ['GPT-4.1 minifoundry-openai/gpt-4.1-mini', 'Utenfor EU/EØS'],
      ['norsk-7btenant/norsk-7b', 'Norge'],
    ]);
    expect(
      screen.getByText(
        '1 av de 2 modellene dere kan bruke, behandler data utenfor EU/EØS. De er merket «Utenfor EU/EØS» i tabellen.',
      ),
    ).toBeTruthy();
  });

  it('shows a model list error with retry instead of an empty table', async () => {
    const auth = mockAnsattporten({ name: 'Kari', organisations: exampleOrganisations });
    await auth.login();
    let fail = true;
    const ok = mockFetch(undefined, undefined, models);
    const broken = failingFetch(/\/models/, 503, ok);
    render(<App auth={auth} fetch={(i, init) => (fail ? broken(i, init) : ok(i, init))} live />);
    expect(await screen.findByText('Kunne ikke hente dataene')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });
});
