// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaygroundOptions, PlaygroundRunRequest } from '../api/playground';
import { examplePlaygroundOptions } from '../data/playground';
import { mockFetch } from '../mock';
import { failingFetch, renderAt } from '../test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const question = 'Hvilke prinsipper evaluerer vi en løsning mot?';

const withArchitectureService: PlaygroundOptions = {
  ...examplePlaygroundOptions,
  services: [
    ...examplePlaygroundOptions.services,
    {
      id: 'arkitekturassistent',
      name: 'Arkitekturassistent',
      chat: true,
      exampleQuestions: [question],
      latestVersion: 4,
      versions: [
        {
          version: 4,
          draft: false,
          inUse: true,
          setup: {
            model: 'aivar/borealis-27b',
            datasets: ['999888777/veiledere'],
            skills: [],
            blocks: [],
            output: 'text',
          },
        },
      ],
    },
  ],
};

const fetchWith = (options: PlaygroundOptions, runs: PlaygroundRunRequest[] = []) =>
  mockFetch(undefined, undefined, undefined, undefined, {
    features: { playground: { options, runs } },
  });

describe('the architecture assistant page', () => {
  it('shows the chat with the example questions and the sources when the organisation has the service', async () => {
    const runs: PlaygroundRunRequest[] = [];
    await renderAt('#/architecture-assistant', fetchWith(withArchitectureService, runs));

    fireEvent.click(await screen.findByRole('button', { name: question }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Kilder')).toBeTruthy();
    expect(runs[0]?.setup.service).toEqual({ id: 'arkitekturassistent', version: 4 });
    expect(runs[0]?.input).toEqual({ text: question });
    expect(screen.getByText(/Assistenten er under utprøving/)).toBeTruthy();
  });

  it('keeps the setup in a closed menu beside Send until the person opens it', async () => {
    await renderAt('#/architecture-assistant', fetchWith(withArchitectureService));

    const menu = await screen.findByRole('button', { name: 'Oppsett' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Endre oppsett' })).toBeNull();

    fireEvent.click(menu);

    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Endre oppsett' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Svarspråk' })).toBeTruthy();
  });

  it('explains that the service is missing instead of opening the chat when the organisation does not have it', async () => {
    await renderAt('#/architecture-assistant', fetchWith(examplePlaygroundOptions));

    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'Arkitekturassistenten finnes ikke i Testetaten',
      }),
    ).toBeTruthy();
    expect(screen.getByText(/tjenesten med id-en «arkitekturassistent»/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gå til tjenestene' }).getAttribute('href')).toBe(
      '#/services',
    );
    expect(screen.queryByRole('textbox', { name: 'Spørsmål' })).toBeNull();
  });

  it('says the person has no access when the organisation refuses the chat', async () => {
    await renderAt('#/architecture-assistant', failingFetch(/playground\/options/, 403));

    expect(await screen.findByRole('heading', { name: 'Du har ikke tilgang' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Spørsmål' })).toBeNull());
  });
});
