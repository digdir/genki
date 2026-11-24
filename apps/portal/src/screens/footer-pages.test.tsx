// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  it('shows Pris og vilkår to someone who is signed in, not a missing page', async () => {
    await open('#/about/price-and-terms');
    expect(await screen.findByRole('heading', { level: 1, name: 'Pris og vilkår' })).toBeTruthy();
    expect(screen.queryByText('Fant ikke siden')).toBeNull();
  });

  it('Kom i gang promises no way to limit access under Tilgang, which cannot restrict anyone', async () => {
    await open('#/onboarding');
    await screen.findByRole('heading', { level: 1, name: 'Kom i gang' });

    expect(await screen.findByText(/kan alle i virksomheten med «Bruke tjenester»/)).toBeTruthy();
    expect(screen.queryByText(/begrense det under Tilgang/)).toBeNull();
  });

  it("Kom i gang shows the four steps ticked from the organisation's real data", async () => {
    await open('#/onboarding');
    expect(await screen.findByRole('heading', { level: 1, name: 'Kom i gang' })).toBeTruthy();

    expect(
      await screen.findByRole('heading', { level: 2, name: /1. Legg til en kilde \(gjort\)/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 2, name: /2. Lag tjenesten \(gjort\)/ }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Se dokumentsamlingene' }).getAttribute('href')).toBe(
      '#/datasets',
    );
    expect(screen.getByRole('link', { name: 'Slik behandles data' }).getAttribute('href')).toBe(
      '#/data-handling',
    );
    expectAccessible();
  });

  it('Kom i gang leads the try step to Backend in the playground, where questions are asked', async () => {
    await open('#/onboarding');
    const link = await screen.findByRole('link', { name: 'Åpne prøveområdet' });
    expect(link.getAttribute('href')).toBe('#/playground/backend');
  });

  it('says a missing page is not found and links to Oversikt', async () => {
    await open('#/docs');

    expect(await screen.findByRole('heading', { level: 1, name: 'Fant ikke siden' })).toBeTruthy();
    expect(screen.getByText('Adressen «#/docs» finnes ikke, eller siden er flyttet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gå til Oversikt' }).getAttribute('href')).toBe(
      '#/overview',
    );
  });

  it('shows what Driftsstatus checks, that the API answers, and the version', async () => {
    await open('#/developer/status', health([up('1.4.2')]));
    expect(await screen.findByText('1.4.2')).toBeTruthy();
    const check = screen.getByText('API-et svarer').closest('li') as HTMLElement;
    expect(within(check).getByText('Virker')).toBeTruthy();
    expect(screen.getByText('Versjon')).toBeTruthy();
  });

  it('shows a commit version as its short hash', async () => {
    await open('#/developer/status', health([up('a3f9c12d4e5f60718293a4b5c6d7e8f901234567')]));
    expect(await screen.findByText('a3f9c12')).toBeTruthy();
  });

  it('checks again when the person presses Sjekk nå', async () => {
    let version = '1.0.0';
    await open('#/developer/status', health([() => up(version)()]));
    expect(await screen.findByText('1.0.0')).toBeTruthy();
    version = '1.0.1';
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
    expect(await screen.findByRole('heading', { level: 1, name: 'Integrations' })).toBeTruthy();
    expect(await screen.findByText('Everything works')).toBeTruthy();
    cleanup();
    await open('#/contact', mockFetch(), ['en']);
    expect(
      await screen.findByText(/owned and developed by the Norwegian Digitalisation Agency/),
    ).toBeTruthy();
  });
});
