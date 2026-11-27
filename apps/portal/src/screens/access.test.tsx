// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { mockAnsattporten, type AuthClient } from '../auth';
import { mockFetch } from '../mock';
import type { AccessMockOptions } from '../mock/access';
import {
  entraGroupsFetch,
  expectAccessible,
  failingFetch,
  heldFetch,
  renderAt,
} from '../test-utils';

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
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const peopleReady = () => screen.findByText('Viser 4 av 10');
const personButton = (name: RegExp) => screen.getByRole('button', { name, expanded: false });
const servicesList = () => screen.findByRole('list', { name: 'Tjenester' });
const withAccess = (access: AccessMockOptions) =>
  mockFetch(undefined, undefined, undefined, undefined, { features: { access } });

const recording = (base: typeof fetch = mockFetch()) => {
  const calls: { url: string; method: string; body: unknown; reason: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      reason: decodeURIComponent(headers.get('change-reason') ?? ''),
    });
    return base(input, init);
  };
  return { fetch, writes: () => calls.filter((c) => c.method !== 'GET') };
};

const openService = async (name: string) => {
  await servicesList();
  fireEvent.click(screen.getByRole('button', { name: `Endre hvem som kan bruke ${name}` }));
  return screen.getByRole('group', { name: `Hvem kan bruke ${name}?` });
};

describe('Tilgang: personer', () => {
  it('lists the people of the organisation with the rights they hold in Altinn', async () => {
    await renderAt('#/access');
    expect(await screen.findByRole('heading', { level: 1, name: 'Tilgang' })).toBeTruthy();
    await peopleReady();
    expect(screen.getByRole('tab', { name: 'Personer' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const kari = within(screen.getByRole('list', { name: 'Personer' })).getByRole('button', {
      name: /Kari Nordmann/,
    });
    expect(kari.textContent).toContain(
      'Bruke tjenestene, Lage og endre tjenester, Forvalte dokumentsamlinger, Se forbruk og kostnad',
    );
    expect(
      screen.getByText(/Rettighetene gis i Altinn\. Her kan dere i tillegg begrense/),
    ).toBeTruthy();
    expectAccessible();
  });

  it('warns on a person chosen for a service who lacks the right to use services', async () => {
    await renderAt('#/access/people');
    await peopleReady();
    const per = personButton(/Per Hansen/);
    expect(within(per).getByText('Mangler «Bruke tjenester»')).toBeTruthy();
    expect(within(personButton(/Ingrid Berg/)).queryByText('Mangler «Bruke tjenester»')).toBeNull();
    fireEvent.click(per);
    expect(
      screen.getByText(
        'Per Hansen står på listen over hvem som får bruke Rapportassistenten, men mangler rettigheten «Bruke tjenester» i Altinn. Uten den kommer Per Hansen ikke inn.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('utvalgt, men kommer ikke inn')).toBeTruthy();
  });

  it('shows which services a person can use and how', async () => {
    await renderAt('#/access/people');
    await peopleReady();
    fireEvent.click(personButton(/Ola Nordmann/));
    const rapport = screen.getByRole('link', { name: 'Rapportassistenten' });
    expect(rapport.getAttribute('href')).toBe('#/access/services?open=rapportassistenten');
    expect(rapport.parentElement?.textContent).toMatch(/utvalgt 17\. nov.* av Kari Nordmann/);
    const post = screen.getByRole('link', { name: 'Postsortering' });
    expect(post.parentElement?.textContent).toContain('alle med «Bruke tjenester»');
  });

  it('leaves out people who only use services until someone searches for them', async () => {
    await renderAt('#/access/people');
    await peopleReady();
    expect(screen.queryByText('Anne Lund')).toBeNull();
    expect(
      screen.getByText(
        'I tillegg har 6 personer i Testetaten bare «Bruke tjenester». De vises når du søker etter dem.',
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Søk etter person'), { target: { value: 'anne' } });
    expect(screen.getByText('Viser 1 av 10')).toBeTruthy();
    expect(screen.getByText('Anne Lund')).toBeTruthy();
  });

  it('filters people by right and resets a search that finds nobody', async () => {
    await renderAt('#/access/people');
    await peopleReady();
    fireEvent.change(screen.getByLabelText('Vis de som kan'), {
      target: { value: 'manage-datasets' },
    });
    expect(screen.getByText('Viser 2 av 10')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Søk etter person'), { target: { value: 'zzz' } });
    expect(screen.getByRole('heading', { name: 'Ingen personer passer søket' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill søket' }));
    expect(screen.getByText('Viser 4 av 10')).toBeTruthy();
  });

  it('says only you have access when Altinn lists nobody else', async () => {
    await renderAt(
      '#/access',
      withAccess({
        people: [{ id: 'p-kari', name: 'Kari Nordmann', rights: ['use-services'] }],
        limits: [],
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Bare du har tilgang ennå' })).toBeTruthy();
    const [, inEmptyState] = screen.getAllByRole('button', { name: 'Gi en kollega tilgang' });
    fireEvent.click(inEmptyState as HTMLElement);
    expect(await screen.findByLabelText('Hvem skal få tilgang?')).toBeTruthy();
  });

  it('shows the last rights read, with their time, when Altinn does not answer', async () => {
    await renderAt('#/access', withAccess({ altinn: 'stale', at: '2026-11-18T07:15:00Z' }));
    await peopleReady();
    const alert = screen.getByText('Vi fikk ikke kontakt med Altinn.').parentElement as HTMLElement;
    expect(alert.textContent).toMatch(/slik de var 18\. nov.* 08[.:]15/);
    expect(
      within(alert.parentElement as HTMLElement).getByRole('button', { name: 'Prøv igjen' }),
    ).toBeTruthy();
  });

  it('shows no list but a retry when Altinn fails before any list was read', async () => {
    await renderAt('#/access', withAccess({ altinn: 'down' }));
    expect(await screen.findByText('Vi fikk ikke kontakt med Altinn.')).toBeTruthy();
    expect(
      screen.getByText('Derfor kan vi ikke vise hvem som har hvilke rettigheter akkurat nå.'),
    ).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Personer' })).toBeNull();
  });

  it('says Altinn is not connected, and shows your own rights, when no connection is configured', async () => {
    await renderAt('#/access', withAccess({ altinn: 'not-configured' }));
    expect(
      await screen.findByRole('heading', { name: 'Altinn er ikke koblet til ennå.' }),
    ).toBeTruthy();
    expect(screen.queryByText('Vi fikk ikke kontakt med Altinn.')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Kari Nordmann' })).toBeTruthy();
  });

  it('says rights come from Entra ID, with no Altinn text or link, when Entra groups give the rights', async () => {
    await renderAt('#/access', withAccess({ altinn: 'entra-groups' }));
    expect(
      await screen.findByRole('heading', { name: 'Hvem som har tilgang, bestemmes i Entra ID.' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Kari Nordmann' })).toBeTruthy();
    expect(screen.queryByText(/Altinn/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Altinn/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Gi en kollega tilgang' })).toBeNull();
  });

  it('never blames Altinn when the people list fails and Entra groups give the rights', async () => {
    await renderAt('#/access', entraGroupsFetch(withAccess({ altinn: 'down' })));
    expect(
      await screen.findByRole('heading', { name: 'Hvem som har tilgang, bestemmes i Entra ID.' }),
    ).toBeTruthy();
    expect(screen.queryByText(/Altinn/)).toBeNull();
  });
});

describe('Tilgang: tjenester', () => {
  it('opens the services tab from its own address', async () => {
    await renderAt('#/access/services');
    await servicesList();
    expect(screen.getByRole('tab', { name: 'Tjenester' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('link', { name: 'Tilgang' }).getAttribute('aria-current')).toBe('page');
  });

  it('puts the chosen tab in the address', async () => {
    await renderAt('#/access');
    await peopleReady();
    fireEvent.click(screen.getByRole('tab', { name: 'Tjenester' }));
    await waitFor(() => expect(window.location.hash).toBe('#/access/services'));
    await servicesList();
  });

  it('redirects the old tab query to the services tab', async () => {
    await renderAt('#/access?tab=groups&org=999888777');
    await waitFor(() => expect(window.location.hash).toBe('#/access/services?org=999888777'));
  });

  it('lists each service with its status and who may use it', async () => {
    await renderAt('#/access/services');
    const list = await servicesList();
    const rapport = within(list).getByRole('button', {
      name: 'Endre hvem som kan bruke Rapportassistenten',
    });
    expect(rapport.textContent).toContain(
      'Bare utvalgte: Kari Nordmann, Ola Nordmann og Per Hansen',
    );
    const post = within(list).getByRole('button', {
      name: 'Endre hvem som kan bruke Postsortering',
    });
    expect(post.textContent).toContain('Alle med «Bruke tjenester» (9 personer)');
    expect(post.textContent).toContain('I bruk');
    expectAccessible();
  });

  it('says every service is open to everyone with the right when none is limited', async () => {
    await renderAt('#/access/services', withAccess({ limits: [] }));
    await servicesList();
    expect(
      screen.getByText(
        'Alle med «Bruke tjenester» kan bruke alle tjenestene. Åpne en tjeneste for å begrense hvem som får bruke den.',
      ),
    ).toBeTruthy();
  });

  it('says a limit holds for people logging in with Ansattporten only, not for keys, systems, operators or other organisations', async () => {
    await renderAt('#/access/services', withAccess({ limits: [] }));
    const mode = await openService('Postsortering');
    expect(screen.queryByText(/Innlogging med Entra kommer ikke inn/)).toBeNull();
    fireEvent.click(within(mode).getByRole('radio', { name: 'Bare utvalgte personer' }));
    expect(
      screen.getByText(
        'Gjelder personer som logger inn med Ansattporten. Innlogging med Entra kommer ikke inn. API-nøkler, systemer og driften påvirkes ikke, og heller ikke andre virksomheter som bruker en delt tjeneste.',
      ),
    ).toBeTruthy();
  });

  it('offers nobody to choose for a service, and says why, while Altinn is not connected', async () => {
    await renderAt('#/access/services', withAccess({ altinn: 'not-configured', limits: [] }));
    const mode = await openService('Postsortering');
    fireEvent.click(within(mode).getByRole('radio', { name: 'Bare utvalgte personer' }));
    expect(screen.getByRole('heading', { name: 'Altinn er ikke koblet til ennå.' })).toBeTruthy();
    expect(
      screen.getByText(
        'Derfor er det ingen å velge blant her ennå. Når Altinn er koblet til, kan du velge hvem som får bruke tjenesten.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Legg til person')).toBeNull();
    expect(screen.queryByText('Vi fikk ikke kontakt med Altinn.')).toBeNull();
  });

  it('offers nobody to choose and claims no missing Altinn rights for members when Entra groups give the rights', async () => {
    await renderAt('#/access/services', withAccess({ altinn: 'entra-groups' }));
    await openService('Rapportassistenten');
    expect(
      screen.getByRole('heading', { name: 'Hvem som har tilgang, bestemmes i Entra ID.' }),
    ).toBeTruthy();
    expect(screen.getByText('Derfor er det ingen å velge blant her.')).toBeTruthy();
    expect(screen.queryByLabelText('Legg til person')).toBeNull();
    expect(screen.queryByText(/Altinn/)).toBeNull();
  });

  it('says a limit controls who can use a service, not who can read or copy its setup', async () => {
    await renderAt('#/access/services', withAccess({ limits: [] }));
    const mode = await openService('Postsortering');
    fireEvent.click(within(mode).getByRole('radio', { name: 'Bare utvalgte personer' }));
    expect(
      screen.getByText(
        'Begrensningen styrer hvem som kan bruke tjenesten, ikke hvem som kan lese eller kopiere oppsettet. Den som kan åpne prøveområdet, kan kjøre en kopi.',
      ),
    ).toBeTruthy();
  });

  it('limits a service to chosen people and saves it with the reason', async () => {
    const calls = recording(withAccess({ limits: [] }));
    await renderAt('#/access/services', calls.fetch);
    const mode = await openService('Postsortering');
    fireEvent.click(within(mode).getByRole('radio', { name: 'Bare utvalgte personer' }));
    fireEvent.change(screen.getByLabelText('Legg til person'), { target: { value: 'p-ingrid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));
    expect(screen.getByText('Du har endringer som ikke er lagret')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Hvorfor endrer du dette? (vises i loggen)'), {
      target: { value: 'Bare arkivet skal sortere post' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endringene' }));
    expect(await screen.findByText(/Ingrid Berg kan nå bruke Postsortering\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Se endringen i Logg' }).getAttribute('href')).toBe(
      '#/log/changes',
    );
    expect(calls.writes()).toEqual([
      expect.objectContaining({
        url: expect.stringContaining('/access/services/postsortering'),
        method: 'PUT',
        body: { mode: 'selected', members: ['p-ingrid'] },
        reason: 'Bare arkivet skal sortere post',
      }),
    ]);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Lukk Postsortering' }).textContent).toContain(
        'Bare utvalgte: Ingrid Berg',
      ),
    );
  });

  it('needs a reason of at least ten characters before it saves', async () => {
    const calls = recording();
    await renderAt('#/access/services', calls.fetch);
    const mode = await openService('Rapportassistenten');
    fireEvent.click(within(mode).getByRole('radio', { name: /Alle med «Bruke tjenester»/ }));
    fireEvent.change(screen.getByLabelText('Hvorfor endrer du dette? (vises i loggen)'), {
      target: { value: 'kort' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endringene' }));
    expect(screen.getByRole('alert').textContent).toBe('Skriv minst 10 tegn om hvorfor.');
    expect(calls.writes()).toEqual([]);
  });

  it('asks before removing a person and marks a person who lacks the right', async () => {
    await renderAt('#/access/services');
    await openService('Rapportassistenten');
    const members = screen.getByRole('list', { name: 'Bare utvalgte personer' });
    const per = within(members).getByText('Per Hansen').parentElement as HTMLElement;
    expect(within(per).getByText('Mangler «Bruke tjenester» i Altinn')).toBeTruthy();
    fireEvent.click(within(per).getByRole('button', { name: 'Fjern Per Hansen' }));
    const ask = screen.getByRole('alertdialog');
    expect(ask.textContent).toContain(
      'Fjerne Per Hansen? Hen kan ikke bruke Rapportassistenten etter at du har lagret.',
    );
    fireEvent.click(within(ask).getByRole('button', { name: 'Avbryt' }));
    expect(within(members).getByText('Per Hansen')).toBeTruthy();
    fireEvent.click(within(per).getByRole('button', { name: 'Fjern Per Hansen' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Fjern Per Hansen' }),
    );
    expect(within(members).queryByText('Per Hansen')).toBeNull();
  });

  it('keeps unsaved changes when someone tries to leave, until they are discarded', async () => {
    await renderAt('#/access/services');
    const mode = await openService('Rapportassistenten');
    fireEvent.click(within(mode).getByRole('radio', { name: /Alle med «Bruke tjenester»/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Personer' }));
    expect(
      await screen.findByText(
        'Du har endringer som ikke er lagret. Lagre eller forkast dem før du går videre.',
      ),
    ).toBeTruthy();
    expect(window.location.hash).toBe('#/access/services');
    fireEvent.click(screen.getByRole('button', { name: 'Gi en kollega tilgang' }));
    expect(screen.queryByLabelText('Hvem skal få tilgang?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Forkast' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Personer' }));
    await waitFor(() => expect(window.location.hash).toBe('#/access/people'));
  });

  it('shows who may use the services but no way to change it without the right to manage services', async () => {
    const auth = mockAnsattporten({
      name: 'Ingrid Berg',
      organisations: [
        { orgNumber: '999888777', name: 'Testetaten', actions: ['use-services', 'view-usage'] },
      ],
    });
    await auth.login();
    window.location.hash = '#/access/services';
    render(<App auth={auth} fetch={mockFetch()} live />);
    const list = await servicesList();
    expect(within(list).queryByRole('button')).toBeNull();
    expect(list.textContent).toContain('Bare utvalgte: Kari Nordmann, Ola Nordmann og Per Hansen');
  });

  it('says no access was changed when the list of limits cannot be fetched', async () => {
    await renderAt('#/access/services', withAccess({ servicesFail: true }));
    expect(
      await screen.findByRole('heading', {
        name: 'Vi fikk ikke hentet hvem som kan bruke tjenestene',
      }),
    ).toBeTruthy();
    expect(
      screen.getByText('Tjenesten som holder oversikten svarte ikke. Ingen tilganger er endret.'),
    ).toBeTruthy();
  });

  it('shows a refusal for a 403', async () => {
    await renderAt('#/access/people', failingFetch(/\/services$/, 403));
    expect(await screen.findByRole('heading', { name: 'Du har ikke tilgang' })).toBeTruthy();
  });

  it('keeps the services list on screen when the tab is opened again', async () => {
    let hold = false;
    const held = heldFetch(/\/access\/services$/);
    const base = mockFetch();
    await renderAt('#/access/services', (input, init) =>
      hold ? held.fetch(input, init) : base(input, init),
    );
    await servicesList();
    fireEvent.click(screen.getByRole('tab', { name: 'Personer' }));
    await peopleReady();
    hold = true;
    fireEvent.click(screen.getByRole('tab', { name: 'Tjenester' }));
    expect(
      await screen.findByRole('button', { name: 'Endre hvem som kan bruke Rapportassistenten' }),
    ).toBeTruthy();
    await held.release();
  });
});

describe('Tilgang: gi en kollega tilgang', () => {
  it('shows the grant button only once the people list has arrived', async () => {
    const held = heldFetch(/access\/people/);
    await renderAt('#/access', held.fetch);
    await screen.findByRole('heading', { level: 1, name: 'Tilgang' });
    expect(screen.queryByRole('button', { name: 'Gi en kollega tilgang' })).toBeNull();
    await held.release();
    await peopleReady();
    expect(screen.getByRole('button', { name: 'Gi en kollega tilgang' })).toBeTruthy();
  });

  it('writes the Altinn message for the chosen rights instead of granting', async () => {
    const calls = recording();
    await renderAt('#/access', calls.fetch);
    await peopleReady();
    fireEvent.click(screen.getByRole('button', { name: 'Gi en kollega tilgang' }));
    expect(
      await screen.findByText('Velg minst én ting over, så skriver vi meldingen.'),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Hvem skal få tilgang?'), {
      target: { value: 'Ola Nordmann' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Lage og endre tjenester/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Se forbruk og kostnad/ }));
    const message = screen.getByLabelText('Meldingen til tilgangsstyreren') as HTMLTextAreaElement;
    expect(message.value).toContain(
      'Kan du gi Ola Nordmann rettighetene «Administrere tjenester» og «Se forbruk og kostnad» for genki i Altinn, på vegne av Testetaten (org.nr. 999 888 777)?',
    );
    expect(message.value).toContain('Hilsen Kari Nordmann');

    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: 'Kopier meldingen' }));
    expect(
      await screen.findByText(
        'Kopiert. Lim inn meldingen i en e-post eller i Teams til tilgangsstyreren.',
      ),
    ).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(message.value);
    const altinn = screen.getByRole('link', { name: /Åpne Altinn \(ny fane\)/ });
    expect(altinn.getAttribute('target')).toBe('_blank');
    expect(calls.writes()).toEqual([]);
  });

  it('says so when the message could not be copied', async () => {
    await renderAt('#/access');
    await peopleReady();
    fireEvent.click(screen.getByRole('button', { name: 'Gi en kollega tilgang' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Bruke tjenestene/ }));
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kopier meldingen' }));
    expect(
      await screen.findByText('Fikk ikke kopiert. Merk teksten over og kopier den selv.'),
    ).toBeTruthy();
  });

  it('asks before discarding a typed name in the grant dialog', async () => {
    await renderAt('#/access');
    await peopleReady();
    fireEvent.click(screen.getByRole('button', { name: 'Gi en kollega tilgang' }));
    fireEvent.change(await screen.findByLabelText('Hvem skal få tilgang?'), {
      target: { value: 'Ola' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Avbryt' }));
    expect(screen.getByText('Forkaste det du har skrevet?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fortsett å skrive' }));
    expect((screen.getByLabelText('Hvem skal få tilgang?') as HTMLInputElement).value).toBe('Ola');
    fireEvent.click(screen.getByRole('button', { name: 'Lukk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forkast' }));
    await waitFor(() => expect(screen.queryByLabelText('Hvem skal få tilgang?')).toBeNull());
  });
});

describe('Uten tilgang', () => {
  it('previews the no-access page at view=no-access', async () => {
    await renderAt('#/access?view=no-access');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Du har ikke tilgang ennå' }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Du er logget inn som Erik Strand og handler for Testetaten\./),
    ).toBeTruthy();
    expectAccessible();
  });

  it('shows the full page without the shell when the user has no organisation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const auth = mockAnsattporten({ name: 'Erik Strand', organisations: [] });
    await auth.login();
    window.location.hash = '#/overview';
    render(<App auth={auth} fetch={mockFetch()} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Du har ikke tilgang ennå' }),
    ).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Hovedmeny' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Erik Strand' })).toBeTruthy();

    const managers = screen.getByRole('list');
    const mail = within(managers).getByRole('link', {
      name: 'kari.nordmann@testetaten.example.no',
    });
    expect(mail.getAttribute('href')).toMatch(
      /^mailto:kari\.nordmann@testetaten\.example\.no\?subject=/,
    );
    expect(screen.getByText('Bruke tjenester')).toBeTruthy();

    const message = screen.getByLabelText(
      'Forslag til melding du kan sende',
    ) as HTMLTextAreaElement;
    expect(message.value).toContain('Kan du gi meg rettigheten «Bruke tjenester»?');
    expect(screen.queryByText(/Altinn/)).toBeNull();
    expect(message.value).toContain('Hilsen Erik Strand');

    fireEvent.click(screen.getByRole('button', { name: 'Kopier meldingen' }));
    expect(screen.getByText('Meldingen er kopiert.').getAttribute('role')).toBe('status');

    const recheck = screen.getByRole('button', { name: 'Sjekk på nytt' });
    fireEvent.click(recheck);
    expect(screen.getByRole('button', { name: 'Sjekker tilgangen' })).toBe(recheck);
    expect(recheck.getAttribute('aria-disabled')).toBe('true');
    await act(() => vi.advanceTimersByTimeAsync(1300));
    await waitFor(() =>
      expect(
        screen.getByText('Du har fortsatt ingen rettigheter. Prøv igjen om litt.'),
      ).toBeTruthy(),
    );
    expectAccessible();
  });

  it('checks access again by signing in anew and opens the portal once rights have been granted', async () => {
    let granted = false;
    const auth: AuthClient = {
      current: () => ({ name: 'Erik Strand', organisations: [], token: 't' }),
      login: async () => ({
        name: 'Erik Strand',
        organisations: granted
          ? [{ orgNumber: '999888777', name: 'Testetaten', actions: ['read'] }]
          : [],
        token: 't',
      }),
      logout: async () => undefined,
    };
    window.location.hash = '#/overview';
    render(<App auth={auth} fetch={mockFetch()} />);
    await screen.findByRole('heading', { level: 1, name: 'Du har ikke tilgang ennå' });

    fireEvent.click(screen.getByRole('button', { name: 'Sjekk på nytt' }));
    expect(
      await screen.findByText('Du har fortsatt ingen rettigheter. Prøv igjen om litt.'),
    ).toBeTruthy();

    granted = true;
    fireEvent.click(screen.getByRole('button', { name: 'Sjekk på nytt' }));
    expect(await screen.findByRole('navigation', { name: 'Hovedmeny' })).toBeTruthy();
  });

  it('lets a person without access switch organisation by signing out instead of linking to the same page', async () => {
    const auth = mockAnsattporten({ name: 'Erik Strand', organisations: [] });
    await auth.login();
    window.location.hash = '#/overview';
    render(<App auth={auth} fetch={mockFetch()} />);
    await screen.findByRole('heading', { level: 1, name: 'Du har ikke tilgang ennå' });
    expect(screen.queryByRole('link', { name: 'Bytt virksomhet' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Bytt virksomhet' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Du har ikke tilgang ennå' }),
      ).toBeNull(),
    );
  });
});
