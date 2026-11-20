// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { logTimelines } from '../../data/log';
import { exampleDatasets, exampleOrganisations, mockFetch } from '../../mock';
import { forgetNotYetSaved } from './not-yet-saved';
import { openArea, setupNav } from './setup-areas.test-utils';

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
  await screen.findByRole('navigation', { name: 'Deler av oppsettet' });
  return calls;
};

const draftBodies = (calls: Call[]) =>
  calls
    .filter((c) => c.method === 'PUT' && /\/draft$/.test(c.url))
    .map((c) => JSON.stringify(c.body));

describe('Oppsett of a new service', () => {
  it('marks an area missing from the draft checks before the service is ever published', async () => {
    await openNew([{ path: 'spec.purpose', message: 'Formålet må fylles ut.' }]);

    const purpose = await waitFor(() =>
      within(setupNav()).getByRole('button', { name: /^Formål og målgruppe.*Mangler/ }),
    );
    fireEvent.click(purpose);
    expect(await screen.findByText('Formålet må fylles ut.')).toBeTruthy();
  });

  it('shows web pages and own documents under Kilder as coming later, and never puts them in the draft', async () => {
    const calls = await openNew();
    openArea(/^Kilder/);

    const web = screen.getByRole('textbox', { name: 'Nettsider' });
    const pages = web.closest('[role="group"]') as HTMLElement;
    expect(within(pages).getByText('Kommer senere')).toBeTruthy();
    fireEvent.change(web, { target: { value: 'https://www.nav.no/arbeid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til nettside' }));
    expect(
      within(screen.getByRole('list', { name: 'Valgte nettsider' })).getByText(
        'https://www.nav.no/arbeid',
      ),
    ).toBeTruthy();

    const pick = screen.getByRole('button', { name: 'Velg filer' });
    expect(
      within(pick.closest('[role="group"]') as HTMLElement).getByText('Kommer senere'),
    ).toBeTruthy();
    const docs = pick.previousElementSibling as HTMLInputElement;
    fireEvent.change(docs, {
      target: { files: [new File(['rutine'], 'permisjonsrutine.pdf')] },
    });
    expect(
      within(screen.getByRole('list', { name: 'Valgte dokumenter' })).getByText(
        'permisjonsrutine.pdf',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Lagres ikke i utkastet ennå/)).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Datasett' }), {
      target: { value: 'Kudos' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Legg til Kudos-rapporter' }));
    await waitFor(() => expect(draftBodies(calls).at(-1)).toContain('digdir/kudos'));
    expect(draftBodies(calls).join()).not.toMatch(/nav\.no|permisjonsrutine/);
  });

  it('keeps the web pages, documents and wished result when the person moves between areas', async () => {
    await openNew();
    openArea(/^Kilder/);
    fireEvent.change(screen.getByRole('textbox', { name: 'Nettsider' }), {
      target: { value: 'https://lovdata.no/lov/2005-06-17-62' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til nettside' }));
    openArea(/^Sluttresultat/);
    const wish = screen.getByRole('textbox', { name: 'Hva ønsker dere å få ut av tjenesten?' });
    fireEvent.change(wish, { target: { value: 'Et kort svar med henvisning til loven' } });

    openArea(/^Kilder/);
    expect(screen.getByText('https://lovdata.no/lov/2005-06-17-62')).toBeTruthy();
    openArea(/^Sluttresultat/);
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Hva ønsker dere å få ut av tjenesten?',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Et kort svar med henvisning til loven');
  });

  it('refuses a web page that is not an https address and says what to write', async () => {
    await openNew();
    openArea(/^Kilder/);
    const web = screen.getByRole('textbox', { name: 'Nettsider' });

    for (const value of ['nav.no', 'http://www.nav.no', 'javascript:alert(1)']) {
      fireEvent.change(web, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Legg til nettside' }));
      expect(screen.getByText(/^Skriv en nettadresse som begynner med https:\/\//)).toBeTruthy();
      expect(web.getAttribute('aria-invalid')).toBe('true');
    }
    expect(screen.queryByRole('list', { name: 'Valgte nettsider' })).toBeNull();
  });
});
