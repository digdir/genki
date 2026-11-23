// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { logTimelines } from '../../data/log';
import { exampleDatasets, exampleOrganisations, mockFetch } from '../../mock';
import { go } from '../../test-utils';
import { forgetNotYetSaved } from './not-yet-saved';

document.getAnimations ??= () => [];
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => {
  window.location.hash = '';
  forgetNotYetSaved();
});
afterEach(cleanup);

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const draftChecks = /\/services\/utkast-[0-9a-f]{8}\/draft\/checks$/;

const openNew = async (problems: { path: string; message: string }[] = []) => {
  const calls: Call[] = [];
  const base = mockFetch([], logTimelines, undefined, exampleDatasets);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET' && draftChecks.test(url))
      return Response.json({ revision: 1, ready: problems.length === 0, problems });
    return base(input, init);
  };
  const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
  await auth.login();
  window.location.hash = '#/services/new';
  render(<App auth={auth} fetch={fetch} live />);
  await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });
  return calls;
};

const draftBodies = (calls: Call[]) =>
  calls
    .filter((c) => c.method === 'PUT' && /\/draft$/.test(c.url))
    .map((c) => JSON.stringify(c.body));

const area = (name: string) => screen.getByRole('region', { name });
const webField = () => within(area('Kunnskap')).getByRole('textbox', { name: 'Nettsider' });
const addPage = (url: string) => {
  fireEvent.change(webField(), { target: { value: url } });
  fireEvent.click(within(area('Kunnskap')).getByRole('button', { name: 'Legg til nettside' }));
};
const wishField = () =>
  within(area('Resultat')).getByRole('textbox', {
    name: 'Hva ønsker dere å få ut av tjenesten?',
  }) as HTMLTextAreaElement;

describe('Oppsett of a new service', () => {
  it('marks an area missing from the draft checks before the service is ever published', async () => {
    await openNew([{ path: 'spec.purpose', message: 'Formålet må fylles ut.' }]);

    const purpose = area('Formål og målgruppe');
    expect(await within(purpose).findByText('Formålet må fylles ut.')).toBeTruthy();
    expect(
      within(purpose).getByRole('heading', { name: 'Dette mangler før publisering' }),
    ).toBeTruthy();
    expect(within(area('Kunnskap')).queryByText('Dette mangler før publisering')).toBeNull();
  });

  it('shows web pages and own documents under Kunnskap as coming, and never puts them in the draft', async () => {
    const calls = await openNew();
    const sources = area('Kunnskap');

    const pages = within(sources).getByRole('group', { name: 'Nettsider' });
    expect(within(pages).getByText('Kommer')).toBeTruthy();
    addPage('https://www.nav.no/arbeid');
    expect(
      within(screen.getByRole('list', { name: 'Valgte nettsider' })).getByRole('button', {
        name: 'Fjern nettsiden https://www.nav.no/arbeid',
      }),
    ).toBeTruthy();

    const documents = within(sources).getByRole('group', { name: 'Egne dokumenter' });
    expect(within(documents).getByText('Kommer')).toBeTruthy();
    expect(within(documents).getByText('Velg filer')).toBeTruthy();
    expect(within(documents).getByText('Slipp filer her')).toBeTruthy();
    fireEvent.change(within(documents).getByLabelText('Egne dokumenter'), {
      target: { files: [new File(['rutine'], 'permisjonsrutine.pdf')] },
    });
    expect(
      within(screen.getByRole('list', { name: 'Valgte dokumenter' })).getByRole('button', {
        name: 'Fjern dokumentet permisjonsrutine.pdf',
      }),
    ).toBeTruthy();
    expect(within(sources).getByText(/^Lagres ikke i utkastet ennå/)).toBeTruthy();

    const datasets = within(sources).getByRole('combobox', { name: 'Dokumentsamlinger' });
    fireEvent.focus(datasets);
    fireEvent.click(datasets);
    fireEvent.input(datasets, { target: { value: 'Kudos' } });
    // jsdom has no popover support, so the open list counts as hidden to the accessibility tree.
    fireEvent.click(
      await within(sources).findByRole('option', { name: 'Kudos-rapporter', hidden: true }),
    );
    await waitFor(() => expect(draftBodies(calls).at(-1)).toContain('digdir/kudos'));
    expect(draftBodies(calls).join()).not.toMatch(/nav\.no|permisjonsrutine/);
  });

  it('keeps the web pages, documents and wished result when the person leaves Oppsett and comes back', async () => {
    await openNew();
    const setupHref = window.location.hash;
    addPage('https://lovdata.no/lov/2005-06-17-62');
    fireEvent.change(wishField(), { target: { value: 'Et kort svar med henvisning til loven' } });

    go(setupHref.replace(/\/setup$/, '/interface'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Kunnskap' })).toBeNull());
    go(setupHref);
    await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });

    expect(
      within(area('Kunnskap')).getByRole('button', {
        name: 'Fjern nettsiden https://lovdata.no/lov/2005-06-17-62',
      }),
    ).toBeTruthy();
    expect(wishField().value).toBe('Et kort svar med henvisning til loven');
  });

  it('refuses a web page that is not an https address and says what to write', async () => {
    await openNew();
    const web = webField();

    for (const value of ['nav.no', 'http://www.nav.no', 'javascript:alert(1)']) {
      addPage(value);
      expect(screen.getByText(/^Skriv en nettadresse som begynner med https:\/\//)).toBeTruthy();
      expect(web.getAttribute('aria-invalid')).toBe('true');
    }
    expect(screen.queryByRole('list', { name: 'Valgte nettsider' })).toBeNull();
  });
});
