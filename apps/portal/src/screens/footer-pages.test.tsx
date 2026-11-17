// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import { expectAccessible, kari } from '../test-utils';

const open = async (hash: string, fetch: typeof window.fetch = mockFetch(), languages = ['nb']) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = hash;
  render(<App auth={auth} fetch={fetch} languages={languages} />);
};

const health =
  (answers: (() => Response)[], base = mockFetch()): typeof window.fetch =>
  (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/health'))
      return Promise.resolve((answers.length > 1 ? answers.shift() : answers[0])?.() ?? down());
    return base(input, init);
  };

const up = (version: string) => () => Response.json({ status: 'ok', version });
const down = () => new Response('', { status: 503 });

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('footer pages', () => {
  it('links the user guide to the real portal screens', async () => {
    await open('#/onboarding');
    expect(await screen.findByRole('heading', { level: 1, name: 'Kom i gang' })).toBeTruthy();
    const targets = Object.fromEntries(
      [
        'Oversikt',
        'Tjenester',
        'Datasett',
        'Byggeklosser',
        'Fellestjenester',
        'Prøveområdet',
        'Kall en tjeneste fra kode',
        'API-referansen',
        'Statistikk',
        'Logg',
        'Tilgang',
        'Innstillinger',
      ].map((name) => [
        name,
        screen
          .getAllByRole('link', { name })
          .map((a) => a.getAttribute('href'))
          .find((href) => href !== null && document.querySelector(`main a[href="${href}"]`)),
      ]),
    );
    expect(targets).toMatchObject({
      Oversikt: '#/overview',
      Tjenester: '#/services',
      Datasett: '#/datasets',
      Byggeklosser: '#/building-blocks',
      Fellestjenester: '#/shared-services',
      Prøveområdet: '#/playground',
      'Kall en tjeneste fra kode': '#/developer/api/code',
      'API-referansen': '#/api-reference',
      Statistikk: '#/statistics',
      Logg: '#/log',
      Tilgang: '#/access',
      Innstillinger: '#/settings',
    });
    expectAccessible();
  });

  it('shows what Driftsstatus checks, that the API answers, and the version', async () => {
    await open('#/developer/status', health([up('1.4.2')]));
    expect(await screen.findByText('1.4.2')).toBeTruthy();
    expect(screen.getByText('API-et svarer')).toBeTruthy();
    expect(screen.getByText('Svarer')).toBeTruthy();
    expect(screen.getByText('Versjon')).toBeTruthy();
  });

  it('shows a commit version as its short hash', async () => {
    await open('#/developer/status', health([up('a3f9c12d4e5f60718293a4b5c6d7e8f901234567')]));
    expect(await screen.findByText('a3f9c12')).toBeTruthy();
  });

  it('checks again when the person presses Sjekk nå', async () => {
    await open('#/developer/status', health([up('1.0.0'), up('1.0.1')]));
    expect(await screen.findByText('1.0.0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sjekk nå' }));
    expect(await screen.findByText('1.0.1')).toBeTruthy();
  });

  it('says the API does not answer and checks again on request', async () => {
    await open('#/developer/status', health([down, down, up('2.0.0')]));
    expect(await screen.findByText('Vi fikk ikke kontakt med API-et')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sjekk igjen' }));
    expect(await screen.findByText('2.0.0')).toBeTruthy();
  });

  it('names Digdir and the genki repository as owner without inventing a contact address', async () => {
    await open('#/contact');
    expect(await screen.findByText(/eies og utvikles av Digitaliseringsdirektoratet/)).toBeTruthy();
    expect(screen.getByText(/genki/)).toBeTruthy();
    expect(document.querySelector('main')?.textContent).not.toMatch(/@|\+47|mailto/);
  });

  it('shows the footer pages in English when the language is English', async () => {
    await open('#/developer/status', health([up('dev')]), ['en']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Developer tools' })).toBeTruthy();
    expect(await screen.findByText('Answering')).toBeTruthy();
    cleanup();
    await open('#/contact', mockFetch(), ['en']);
    expect(
      await screen.findByText(/owned and developed by the Norwegian Digitalisation Agency/),
    ).toBeTruthy();
  });
});
