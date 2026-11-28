// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

interface Sent {
  method: string;
  path: string;
  body: unknown;
  reason: string | null;
}

const recording = (hold?: (path: string) => Promise<void> | undefined) => {
  const base = mockFetch();
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^.*\/api/, '');
    const reason = new Headers(init?.headers).get('change-reason');
    sent.push({
      method: init?.method ?? 'GET',
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      reason: reason === null ? null : decodeURIComponent(reason),
    });
    await hold?.(path);
    return base(input, init);
  };
  return { fetch, sent };
};

const signedIn = async (path: string, fetch: typeof globalThis.fetch = mockFetch()) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} />);
};

const bodyRows = async (name: string) => {
  const region = (await screen.findAllByRole('region', { name })).at(-1) as HTMLElement;
  return within(region).getAllByRole('row').slice(1);
};

const giveReason = (dialog: HTMLElement, reason: string) =>
  fireEvent.change(within(dialog).getByRole('textbox', { name: /Begrunnelse/ }), {
    target: { value: reason },
  });

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Virksomheter', () => {
  it('lists organisations by quota used, highest first, with status, cost and what waits', async () => {
    await signedIn('#/tenants');

    const rows = await bodyRows('Virksomheter');
    const first = within(rows[0] as HTMLElement);
    expect(first.getByRole('link', { name: 'Eksempeldirektoratet' }).getAttribute('href')).toBe(
      '#/support-access?tenant=974222333',
    );
    expect(first.getByText('974 222 333')).toBeTruthy();
    expect(first.getByText('Aktiv')).toBeTruthy();
    expect(first.getByText('97 %')).toBeTruthy();
    expect(first.getByText('310 kr')).toBeTruthy();
    expect(
      first.getByRole('link', { name: 'Til behandling for Eksempeldirektoratet: Kvote' }),
    ).toBeTruthy();
    const last = within(rows.at(-1) as HTMLElement);
    expect(last.getByText('Ikke i bruk')).toBeTruthy();
  });

  it('counts each status in the filter and narrows to those that wait', async () => {
    await signedIn('#/tenants');
    await bodyRows('Virksomheter');

    const status = screen.getByRole('combobox', { name: 'Status' });
    expect(within(status).getByRole('option', { name: 'Alle (11)' })).toBeTruthy();
    expect(within(status).getByRole('option', { name: 'Oppstart (3)' })).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Bare de som venter' }));
    expect(await bodyRows('Virksomheter')).toHaveLength(6);

    fireEvent.change(status, { target: { value: 'onboarding' } });
    const rows = await bodyRows('Virksomheter');
    expect(rows).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByText('Testby kommune')).toBeTruthy();
  });

  it('finds an organisation by its org. number with spaces', async () => {
    await signedIn('#/tenants');
    await bodyRows('Virksomheter');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk' }), {
      target: { value: '983 555 666' },
    });

    const rows = await bodyRows('Virksomheter');
    expect(rows).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByText('Kontrollrådet')).toBeTruthy();
  });
});

describe('Drift', () => {
  it('puts the open incident and failed runs first, with links to each run', async () => {
    await signedIn('#/operations');

    expect(await screen.findByText('Feilrate siste time 2,1 %')).toBeTruthy();
    expect(
      await screen.findByRole('heading', { name: 'Hendelse: Borealis-27B svarer tregt' }),
    ).toBeTruthy();
    const failed = await bodyRows('Feilede kjøringer');
    expect(failed).toHaveLength(3);
    const run = within(failed[0] as HTMLElement).getByRole('link', {
      name: 'Diagnostikk for kjøring t-091',
    });
    expect(run.getAttribute('href')).toBe('#/diagnostics?tenant=974222333&task=t-091');
    const models = await bodyRows('Modeller');
    expect(within(models[0] as HTMLElement).getByText('Borealis-27B 2.1')).toBeTruthy();
    expect(within(models[0] as HTMLElement).getByText('Treg')).toBeTruthy();
  });

  it('resolves an incident only with a reason, and the reason goes with the call', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/operations', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Løs' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Løs hendelsen' }));
    expect(await within(dialog).findByText(/minst 10 tegn/)).toBeTruthy();
    expect(sent.some((s) => s.path.endsWith('/resolve'))).toBe(false);

    giveReason(dialog, 'Leverandøren har rettet køen');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Løs hendelsen' }));

    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Hendelse: Borealis-27B svarer tregt' }),
      ).toBeNull(),
    );
    expect(sent.find((s) => s.path.endsWith('/resolve'))).toMatchObject({
      method: 'POST',
      path: '/operator/incidents/inc-borealis/resolve',
      reason: 'Leverandøren har rettet køen',
    });
  });

  it('keeps the dialog open and Avbryt inactive while the resolve is on its way', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { fetch } = recording((path) => (path.endsWith('/resolve') ? held : undefined));
    await signedIn('#/operations', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Løs' }));
    const dialog = await screen.findByRole('dialog');
    giveReason(dialog, 'Leverandøren har rettet køen');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Løs hendelsen' }));
    const cancel = within(dialog).getByRole('button', { name: 'Avbryt' });
    await waitFor(() => expect(cancel.getAttribute('aria-disabled')).toBe('true'));
    fireEvent.click(cancel);
    expect(screen.getByRole('dialog')).toBeTruthy();

    await act(async () => {
      release();
      await held;
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens the resolve dialog while the failed runs are still loading', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { fetch } = recording((path) => (path === '/operator/failed-runs' ? held : undefined));
    await signedIn('#/operations', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Løs' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    release();

    expect(await bodyRows('Feilede kjøringer')).toHaveLength(3);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('Hendelser', () => {
  it('shows the open incident with what it concerns and resolved ones with duration and reach', async () => {
    await signedIn('#/operations?tab=incidents');

    expect(await screen.findByRole('heading', { name: 'Borealis-27B svarer tregt' })).toBeTruthy();
    expect(screen.getByText('På statussiden')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Kontrollrådet' }).getAttribute('href')).toBe(
      '#/support-access?tenant=983555666',
    );
    const resolved = await bodyRows('Løste hendelser');
    expect(within(resolved[0] as HTMLElement).getByText(/, 3 t 10 min$/)).toBeTruthy();
    expect(within(resolved[0] as HTMLElement).getByText('2 virksomheter')).toBeTruthy();
    expect(within(resolved[1] as HTMLElement).getByText('Alle')).toBeTruthy();
  });

  it('publishes a new incident for the chosen organisations with a reason', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/operations?tab=incidents', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Ny hendelse' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Tittel' }), {
      target: { value: 'Søk svarer tregt' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Hva skjer' }), {
      target: { value: 'Søk tar over 5 s.' },
    });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'Testetaten' }));
    giveReason(dialog, 'Meldt av Testetaten i dag');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publiser hendelsen' }));

    expect(await screen.findByRole('heading', { name: 'Søk svarer tregt' })).toBeTruthy();
    expect(sent.find((s) => s.method === 'POST' && s.path === '/operator/incidents')).toEqual({
      method: 'POST',
      path: '/operator/incidents',
      body: { title: 'Søk svarer tregt', text: 'Søk tar over 5 s.', tenants: ['999888777'] },
      reason: 'Meldt av Testetaten i dag',
    });
  });
});

describe('Logg', () => {
  it('sends every filter to the API and keeps the others when one changes', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/audit', fetch);
    await bodyRows('Logg');

    fireEvent.change(screen.getByRole('combobox', { name: 'Handling' }), {
      target: { value: 'content' },
    });
    await waitFor(() => expect(screen.getByText('2 hendelser')).toBeTruthy());
    fireEvent.change(screen.getByRole('combobox', { name: 'Hvem' }), {
      target: { value: 'operator' },
    });

    await waitFor(() => {
      const last = new URLSearchParams(
        sent
          .filter((s) => s.path.startsWith('/operator/audit?'))
          .at(-1)
          ?.path.split('?')[1],
      );
      expect(last.get('action')).toBe('platform.content.read');
      expect(last.get('by')).toBe('operator');
    });
    expect((screen.getByRole('combobox', { name: 'Handling' }) as HTMLSelectElement).value).toBe(
      'content',
    );
    const rows = await bodyRows('Logg');
    expect(within(rows[0] as HTMLElement).getByText('Jon Øien, Digdir')).toBeTruthy();
  });

  it('filters by an organisation picked by name', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/audit', fetch);
    await bodyRows('Logg');

    fireEvent.change(screen.getByRole('combobox', { name: 'Virksomhet' }), {
      target: { value: 'Prøvetilsynet' },
    });

    await waitFor(() =>
      expect(sent.filter((s) => s.path.startsWith('/operator/audit?')).at(-1)?.path).toMatch(
        /tenant=986666777/,
      ),
    );
    const region = await screen.findByRole('region', { name: 'Logg' });
    expect(await within(region).findByText('Satte virksomheten på pause')).toBeTruthy();
  });

  it('shows the latest filter when it changes before the first page arrives', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const { fetch } = recording((path) => {
      if (!path.startsWith('/operator/audit?') || !first) return undefined;
      first = false;
      return held;
    });
    await signedIn('#/audit', fetch);

    fireEvent.change(await screen.findByRole('combobox', { name: 'Handling' }), {
      target: { value: 'content' },
    });
    expect(await screen.findByText('2 hendelser')).toBeTruthy();
    await act(async () => {
      release();
      await held;
    });
    expect(screen.getByText('2 hendelser')).toBeTruthy();
  });

  it('shows no entries and asks the API for nothing while the organisation typed is unknown', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/audit', fetch);
    await bodyRows('Logg');
    const asked = sent.filter((s) => s.path.startsWith('/operator/audit?')).length;

    fireEvent.change(screen.getByRole('combobox', { name: 'Virksomhet' }), {
      target: { value: 'Finnes ikke' },
    });

    expect(await screen.findByText('Fant ingen virksomhet med det navnet.')).toBeTruthy();
    expect(await screen.findByText('0 hendelser')).toBeTruthy();
    expect(sent.filter((s) => s.path.startsWith('/operator/audit?'))).toHaveLength(asked);
  });

  it('shows the error instead of the previous entries when a new filter fails', async () => {
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = async (input, init) =>
      String(input).includes('/operator/audit?') && String(input).includes('by=tenant')
        ? new Response('{}', { status: 503 })
        : base(input, init);
    await signedIn('#/audit', fetch);
    await bodyRows('Logg');

    fireEvent.change(screen.getByRole('combobox', { name: 'Hvem' }), {
      target: { value: 'tenant' },
    });

    expect(await screen.findByRole('heading', { name: 'Kunne ikke hente dataene' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Logg' })).toBeNull();
  });
});

describe('Kjøring and the daily content reason', () => {
  it('asks for the day’s reason before showing a run, then shows the reason on top', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/diagnostics?tenant=974222333&task=t-091', fetch);

    const dialog = await screen.findByRole('dialog', {
      name: 'Se innhold fra Eksempeldirektoratet',
    });
    expect(
      within(dialog).getByText('Kan inneholde personopplysninger. Gjelder resten av dagen.'),
    ).toBeTruthy();
    expect(within(dialog).getByText('Virksomheten ser den i loggen.')).toBeTruthy();
    giveReason(dialog, 'Sak DIG-4512, feil i Høringsanalyse');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Se innholdet' }));

    expect(await screen.findByRole('heading', { name: 'Kjøring t-091' })).toBeTruthy();
    expect(await screen.findByText('Innsyn: Sak DIG-4512, feil i Høringsanalyse')).toBeTruthy();
    expect(screen.getByText('Feilet')).toBeTruthy();
    expect(screen.getByText('Høringsanalyse, utgave 7')).toBeTruthy();
    expect(screen.getByText('4 812')).toBeTruthy();
    expect(screen.getByText('Tidsavbrudd etter 30 s')).toBeTruthy();
    expect(screen.getByText('Ingen svar. Kjøringen feilet før modellen svarte.')).toBeTruthy();
    expect(sent.find((s) => s.path.endsWith('/content-reason'))?.body).toEqual({
      reason: 'Sak DIG-4512, feil i Høringsanalyse',
    });
  });

  it('keeps the content hidden when the operator cancels', async () => {
    await signedIn('#/diagnostics?tenant=974222333&task=t-091');

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Avbryt' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Kjøring t-091' })).toBeTruthy();
    expect(screen.queryByText('Inndata')).toBeNull();
  });
});
