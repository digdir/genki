// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const recording = (hold?: Promise<void>) => {
  const base = mockFetch();
  const sent: Sent[] = [];
  let overviews = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/operator\/tenants\/974222333$/.test(url)) {
      overviews += 1;
      if (hold) await hold;
    }
    if (init?.method && init.method !== 'GET') {
      const reason = new Headers(init.headers).get('change-reason');
      sent.push({
        method: init.method,
        path: new URL(url, 'http://x').pathname.replace(/^\/api/, ''),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        reason: reason === null ? null : decodeURIComponent(reason),
      });
    }
    return base(input, init);
  };
  return { fetch, sent, overviews: () => overviews };
};

const signedIn = async (path: string, fetch: typeof globalThis.fetch) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} />);
};

const page = '#/support-access?tenant=974222333';

const tabs = async () => within(await screen.findByRole('navigation', { name: 'Virksomheten' }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-26T12:00:00+01:00'));
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the organisation page', () => {
  it('names the organisation, its status, number and administrator, and what needs action', async () => {
    const { fetch } = recording();
    await signedIn(page, fetch);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Eksempeldirektoratet' }),
    ).toBeTruthy();
    expect(screen.getByText('Aktiv')).toBeTruthy();
    expect(screen.getByText('Org.nr. 974 222 333 · Bjørn Aas, administrator')).toBeTruthy();
    const needs = within(screen.getByRole('region', { name: 'Trenger handling (1)' }));
    expect(needs.getByText('Ber om 80 mill. tokens per måned')).toBeTruthy();
    expect(needs.getByRole('link', { name: /Behandle/ }).getAttribute('href')).toBe(
      '#/queue?request=974222333%2Fqr-eksempeldirektoratet',
    );
    const current = (await tabs()).getByRole('link', { name: 'Oversikt' });
    expect(current.getAttribute('aria-current')).toBe('page');
  });

  it('opens the tab named in the address, also when it is chosen while the page loads', async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetch } = recording(hold);
    await signedIn(page, fetch);

    window.location.hash = `${page}&tab=limits`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    release();

    expect(await screen.findByRole('heading', { name: 'Forbruk' })).toBeTruthy();
    expect((await tabs()).getByRole('link', { name: 'Grenser' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('shows the monthly token quota the organisation has now', async () => {
    const { fetch } = recording();
    await signedIn(`${page}&tab=limits`, fetch);

    const row = (await screen.findByRole('rowheader', { name: 'Tokens per måned' }))
      .parentElement as HTMLElement;
    expect(within(row).getByText('40 mill.', { selector: 'td' })).toBeTruthy();
  });

  it('changes a limit only with a reason and stays on the tab when the page refetches', async () => {
    const { fetch, sent, overviews } = recording();
    await signedIn(`${page}&tab=limits`, fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Endre kall per minutt' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Kall per minutt' }), {
      target: { value: '900' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sjekk endringen' }));
    expect(screen.getByRole('textbox', { name: 'Begrunnelse' }).getAttribute('aria-invalid')).toBe(
      'true',
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Sak DIG-4512: nattlige massekjøringer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sjekk endringen' }));
    expect(screen.getByText(/60 → 900\. Gjelder med en gang\./)).toBeTruthy();
    const before = overviews();
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));

    expect((await screen.findByRole('status')).textContent).toContain('Kall per minutt er 900');
    expect(sent).toEqual([
      {
        method: 'PUT',
        path: '/tenants/974222333/settings/usage.tenantCallsPerMinute',
        body: { value: 900 },
        reason: 'Sak DIG-4512: nattlige massekjøringer',
      },
    ]);
    await waitFor(() => expect(overviews()).toBeGreaterThan(before));
    expect(screen.getByRole('heading', { name: 'Forbruk' })).toBeTruthy();
    expect((await tabs()).getByRole('link', { name: 'Grenser' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('revokes an API key only with a reason', async () => {
    const { fetch, sent } = recording();
    await signedIn(`${page}&tab=access`, fetch);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Trekk tilbake horingsanalyse-i-bruk' }),
    );
    const warning = screen.getByText('Alt som bruker nøkkelen, slutter å virke med en gang.');
    const row = within(warning.closest('tr') as HTMLElement);
    fireEvent.click(row.getByRole('button', { name: 'Trekk tilbake' }));
    expect(sent).toHaveLength(0);

    fireEvent.change(row.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Nøkkelen lå i en offentlig kodebase, sak DIG-4520' },
    });
    fireEvent.click(row.getByRole('button', { name: 'Trekk tilbake' }));

    expect(await screen.findByText(/horingsanalyse-i-bruk er trukket tilbake\./)).toBeTruthy();
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: '/tenants/974222333/api-keys/k-ed-1/revoke',
      reason: 'Nøkkelen lå i en offentlig kodebase, sak DIG-4520',
    });
  });

  it('turns a feature off for the organisation with a reason', async () => {
    const { fetch, sent } = recording();
    await signedIn(`${page}&tab=flags`, fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Slå av Utforming' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Piloten for designelementer er over, sak DIG-4499' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Slå av' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      method: 'PUT',
      path: '/operator/flags/blockStudio',
      body: { tenant: '974222333', on: false },
      reason: 'Piloten for designelementer er over, sak DIG-4499',
    });
    expect(await screen.findByRole('button', { name: 'Slå på Utforming' })).toBeTruthy();
  });

  it('shows only what Digdir did when the log is filtered to Digdir', async () => {
    const { fetch } = recording();
    await signedIn(`${page}&tab=log`, fetch);

    expect(await screen.findByText('Bjørn Aas publiserte Høringsanalyse, utgave 7')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Vis' }), {
      target: { value: 'digdir' },
    });

    await waitFor(() =>
      expect(screen.queryByText('Bjørn Aas publiserte Høringsanalyse, utgave 7')).toBeNull(),
    );
    expect(screen.getByText('Jon Øien: «Sak DIG-4488, feil i Spør regelverket»')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Vis' })).toHaveProperty('value', 'digdir');
  });

  it("removes a person's own feature choice with a reason", async () => {
    const { fetch, sent } = recording();
    await signedIn(`${page}&tab=flags`, fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Fjern valget for Marte Solheim' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Opplæringen er ferdig, sak DIG-4501' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fjern valget' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      method: 'PUT',
      path: '/operator/flags/blockStudio',
      body: {
        tenant: '974222333',
        person: { issuer: 'ansattporten', subject: 'marte' },
        on: null,
      },
      reason: 'Opplæringen er ferdig, sak DIG-4501',
    });
  });

  it('opens every setting of the organisation from the More menu', async () => {
    const { fetch } = recording();
    await signedIn(page, fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Mer' }));
    const item = screen.getByRole('menuitem', { name: 'Alle innstillinger' });
    expect(item.getAttribute('href')).toBe('#/support-access?tenant=974222333&tab=settings');
  });

  it('asks for a content reason only when the operator chooses to see the people', async () => {
    const { fetch } = recording();
    await signedIn(`${page}&tab=access`, fetch);

    await screen.findByRole('button', { name: 'Trekk tilbake horingsanalyse-i-bruk' });
    expect(
      screen.queryByRole('dialog', { name: 'Se innhold fra Eksempeldirektoratet' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Vis personer' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Se innhold fra Eksempeldirektoratet',
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Sak DIG-4520, sjekker hvem som har tilgang' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Se innholdet' }));

    const people = await screen.findByRole('region', { name: 'Personer' });
    expect(within(people).getByText('Marte Solheim')).toBeTruthy();
  });
});
