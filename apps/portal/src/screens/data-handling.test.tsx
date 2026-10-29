// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { exampleOrganisations, mockFetch } from '../mock';
import { expectAccessible } from '../test-utils';

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
    expect(screen.getByText('Databehandleravtale').nextElementSibling?.textContent).toBe(
      'Ikke bestemt ennå',
    );
    expect(page).not.toMatch(/example\.no|I Norge eller i EU/);
    expectAccessible();
  });

  it('names each model and where it processes data from the API once logged in', async () => {
    const auth = mockAnsattporten({ name: 'Kari', organisations: exampleOrganisations });
    await auth.login();
    render(<App auth={auth} fetch={mockFetch(undefined, undefined, models)} live />);

    const list = await screen.findByRole('list', { name: 'Modeller og hvor de behandler data' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['GPT-4.1 mini: globalt, også utenfor EU/EØS', 'norsk-7b: i Norge']);
  });
});
