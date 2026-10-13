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
    await open('#/help');
    expect(await screen.findByRole('heading', { level: 1, name: 'Brukerveiledning' })).toBeTruthy();
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
        'Forbruk',
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
      'Kall en tjeneste fra kode': '#/integrations/code',
      'API-referansen': '#/api-reference',
      Forbruk: '#/usage',
      Logg: '#/log',
      Tilgang: '#/access',
      Innstillinger: '#/settings',
    });
    expectAccessible();
  });

  it('shows the API health and version on the status page', async () => {
    await open('#/status', health([up('1.4.2')]));
    expect(await screen.findByText('1.4.2')).toBeTruthy();
    expect(screen.getByText('Svarer')).toBeTruthy();
    expect(screen.getByText('Versjon')).toBeTruthy();
  });

  it('says the API does not answer and checks again on request', async () => {
    await open('#/status', health([down, up('2.0.0')]));
    expect(await screen.findByText(/API-et svarer ikke akkurat nå/)).toBeTruthy();
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
    await open('#/status', health([up('dev')]), ['en']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Service status' })).toBeTruthy();
    expect(await screen.findByText('Answering')).toBeTruthy();
    cleanup();
    await open('#/contact', mockFetch(), ['en']);
    expect(
      await screen.findByText(/owned and developed by the Norwegian Digitalisation Agency/),
    ).toBeTruthy();
  });
});
