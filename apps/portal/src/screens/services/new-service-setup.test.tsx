// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
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

let lastFetch: typeof globalThis.fetch = globalThis.fetch;

const openNew = async (problems: { path: string; message: string }[] = [], strict = false) => {
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
  lastFetch = fetch;
  const app = <App auth={auth} fetch={fetch} live />;
  render(strict ? <StrictMode>{app}</StrictMode> : app);
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
  it('says what the builder assistant is for before the first message, over a field three rows high, as the chat', async () => {
    await openNew();

    const side = screen.getByRole('region', { name: 'Byggeassistent og prøving' });
    expect(
      within(side).getByText(
        'Hvis du vil kan jeg hjelpe med å fylle ut skjemaet til høyre. Bruk forslagsknappene eller spør hvis du lurer på noe.',
      ),
    ).toBeTruthy();
    expect(
      within(side).getByRole('textbox', { name: 'Skriv til assistenten' }).getAttribute('rows'),
    ).toBe('3');
    // The heading and the line stand together in the middle until the first message.
    expect(
      within(side)
        .getByRole('complementary', { name: 'Byggeassistent' })
        .hasAttribute('data-empty'),
    ).toBe(true);
  });

  it('lists what an area lacks only after the person presses Publiser', async () => {
    const calls = await openNew([{ path: 'spec.purpose', message: 'Formålet må fylles ut.' }]);

    const purpose = area('Formål og målgruppe');
    await waitFor(() => expect(calls.some((c) => draftChecks.test(c.url))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(purpose).queryByText('Formålet må fylles ut.')).toBeNull();
    expect(within(purpose).queryByText('Dette mangler før publisering')).toBeNull();

    const setupHref = window.location.hash;
    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    await waitFor(() => expect(window.location.hash).toMatch(/\/publish$/));
    go(setupHref);
    const back = await screen.findByRole('region', { name: 'Formål og målgruppe' });
    expect(await within(back).findByText('Formålet må fylles ut.')).toBeTruthy();
    expect(
      within(back).getByRole('heading', { name: 'Dette mangler før publisering' }),
    ).toBeTruthy();
    expect(within(area('Kunnskap')).queryByText('Dette mangler før publisering')).toBeNull();
  });

  it('shows web pages and own documents under Kunnskap as coming and turned off, and says nothing about saving them', async () => {
    const calls = await openNew();
    const sources = area('Kunnskap');

    const pages = within(sources).getByRole('group', { name: 'Nettsider' });
    expect(within(pages).getByText('Kommer')).toBeTruthy();
    expect((webField() as HTMLInputElement).disabled).toBe(true);
    expect(
      (within(pages).getByRole('button', { name: 'Legg til nettside' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    const documents = within(sources).getByRole('group', { name: 'Egne dokumenter' });
    expect(within(documents).getByText('Kommer')).toBeTruthy();
    expect(within(documents).getByText('Slipp filer her')).toBeTruthy();
    expect((within(documents).getByLabelText('Egne dokumenter') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(within(sources).queryByText(/^Lagres ikke i utkastet ennå/)).toBeNull();

    const datasets = within(sources).getByRole('combobox', { name: 'Dokumentsamlinger' });
    fireEvent.focus(datasets);
    fireEvent.click(datasets);
    fireEvent.input(datasets, { target: { value: 'Kudos' } });
    // jsdom has no popover support, so the open list counts as hidden to the accessibility tree.
    fireEvent.click(
      await within(sources).findByRole('option', { name: 'Kudos-rapporter', hidden: true }),
    );
    await waitFor(() => expect(draftBodies(calls).at(-1)).toContain('digdir/kudos'));
  });

  it('keeps the wished result when the person leaves Oppsett and comes back', async () => {
    await openNew();
    const setupHref = window.location.hash;
    fireEvent.change(wishField(), { target: { value: 'Et kort svar med henvisning til loven' } });

    go(setupHref.replace(/\/setup$/, '/interface'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Kunnskap' })).toBeNull());
    go(setupHref);
    await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });

    expect(wishField().value).toBe('Et kort svar med henvisning til loven');
  });

  it('adds a document once and removes only that one when React runs updates twice in StrictMode', async () => {
    await openNew([], true);
    const documents = within(area('Kunnskap')).getByRole('group', { name: 'Egne dokumenter' });
    const upload = (name: string) =>
      fireEvent.change(within(documents).getByLabelText('Egne dokumenter'), {
        target: { files: [new File(['rutine'], name)] },
      });
    upload('permisjonsrutine.pdf');
    upload('ferierutine.pdf');
    const chosen = () =>
      within(screen.getByRole('list', { name: 'Valgte dokumenter' })).getAllByRole('button');
    expect(chosen().map((b) => b.getAttribute('aria-label') ?? b.textContent)).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Fjern dokumentet permisjonsrutine.pdf' }));
    expect(screen.getByRole('button', { name: 'Fjern dokumentet ferierutine.pdf' })).toBeTruthy();
    expect(chosen()).toHaveLength(1);
  });

  it('never sends web pages, documents or the wished result to the API, also not to the builder assistant or the publish check', async () => {
    const calls = await openNew();
    addPage('https://www.nav.no/arbeid');
    const documents = within(area('Kunnskap')).getByRole('group', { name: 'Egne dokumenter' });
    fireEvent.change(within(documents).getByLabelText('Egne dokumenter'), {
      target: { files: [new File(['rutine'], 'permisjonsrutine.pdf')] },
    });
    fireEvent.change(wishField(), { target: { value: 'Et kort svar med lovhenvisning' } });
    const panel = screen.getByRole('complementary', { name: 'Byggeassistent' });
    fireEvent.change(within(panel).getByLabelText('Skriv til assistenten'), {
      target: { value: 'Lag en tjeneste om permisjon' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/assistant/turns'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/definitions/validate'))).toBe(true),
    );

    const sent = calls.map((c) => JSON.stringify(c.body ?? '')).join();
    expect(sent).toContain('Lag en tjeneste om permisjon');
    expect(sent).not.toMatch(/nav\.no|permisjonsrutine|lovhenvisning/);
  });

  it('forgets the web pages and the wished result when the person logs out', async () => {
    await openNew();
    const setupHref = window.location.hash;
    addPage('https://www.nav.no/arbeid');
    fireEvent.change(wishField(), { target: { value: 'Et kort svar med lovhenvisning' } });

    fireEvent.click(screen.getByRole('button', { name: /^Brukermeny for Ingrid Berg/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Logg ut' }));
    expect((await screen.findAllByRole('button', { name: 'Logg inn' })).length).toBeGreaterThan(0);
    cleanup();
    const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = setupHref;
    render(<App auth={auth} fetch={lastFetch} live />);
    await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });

    expect(screen.queryByRole('list', { name: 'Valgte nettsider' })).toBeNull();
    expect(wishField().value).toBe('');
  });

  it('keeps what was entered for one organisation away from another with the same draft address', async () => {
    await openNew();
    const setupHref = window.location.hash;
    addPage('https://www.nav.no/arbeid');

    fireEvent.click(screen.getByRole('button', { name: /^Brukermeny for Ingrid Berg/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Prøvekommunen/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/overview?org=999777666'));
    go(setupHref);
    await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });

    expect(screen.queryByRole('list', { name: 'Valgte nettsider' })).toBeNull();
  });
});
