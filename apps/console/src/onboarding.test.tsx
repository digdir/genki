// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const recording = (fetch = mockFetch()) => {
  const calls: { method: string; path: string; body?: unknown; reason?: string }[] = [];
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://mock');
    const raw = new Headers(init?.headers).get('change-reason');
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      ...(raw ? { reason: decodeURIComponent(raw) } : {}),
    });
    return fetch(input, init);
  };
  return { calls, fetch: wrapped };
};

const open = async (fetch: typeof globalThis.fetch) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = '#/onboarding';
  render(<App auth={auth} fetch={fetch} />);
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('oppstart', () => {
  it('follows approved agencies through five steps and leaves pending requests to Til behandling', async () => {
    await open(mockFetch());

    const fylke = await screen.findByRole('article', { name: 'Fylkeskommunen i Testfylke' });
    expect(within(fylke).getByText('Trenger oppfølging')).toBeTruthy();
    expect(within(fylke).getByText(/kontaktperson Rune Moe/)).toBeTruthy();
    const steps = within(fylke)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(steps).toHaveLength(5);
    expect(steps[0]).toMatch(/Registrert.*Ferdig.*Lise Dahl, Digdir/);
    expect(steps[1]).toMatch(/Tilgang i Altinn.*Forsinket/);
    expect(steps[2]).toMatch(/Maskinporten-scopes.*Ikke startet.*Ikke bestemt/);
    expect(steps[4]).toMatch(/Første tjeneste publisert.*Ikke startet/);

    const kontroll = screen.getByRole('article', { name: 'Kontrollrådet' });
    expect(within(kontroll).getByText('I gang')).toBeTruthy();
    expect(within(kontroll).getByText('4 tjenester publisert')).toBeTruthy();

    expect(screen.queryByRole('article', { name: 'Testby kommune' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Til behandling' }).getAttribute('href')).toBe(
      '#/queue?tab=access',
    );
  });

  it('sends a reminder for a step that is late', async () => {
    const { calls, fetch } = recording();
    await open(fetch);

    const fylke = await screen.findByRole('article', { name: 'Fylkeskommunen i Testfylke' });
    fireEvent.click(within(fylke).getByRole('button', { name: 'Send påminnelse' }));

    expect(
      await screen.findByText('Påminnelse sendt til Rune Moe, Fylkeskommunen i Testfylke.'),
    ).toBeTruthy();
    expect(within(fylke).getByText(/Påminnelse sendt i dag\./)).toBeTruthy();
    expect(within(fylke).queryByRole('button', { name: 'Send påminnelse' })).toBeNull();
    expect(
      calls.some(
        (c) => c.method === 'POST' && c.path === '/api/operator/onboarding/921444555/reminders',
      ),
    ).toBe(true);
  });

  it('registers an agency directly from a dialog after checking the fields', async () => {
    const { calls, fetch } = recording();
    await open(fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Registrer virksomhet' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrer' }));
    expect(within(dialog).getByText('Organisasjonsnummeret har 9 siffer.')).toBeTruthy();
    expect(
      within(dialog).getByText('Skriv en begrunnelse på minst 10 tegn. Nå er det 0.'),
    ).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/operator/tenants')).toBe(
      false,
    );

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Organisasjonsnummer' }), {
      target: { value: '974760673' },
    });
    await waitFor(() =>
      expect(
        (within(dialog).getByRole('textbox', { name: 'Navn' }) as HTMLInputElement).value,
      ).toBe('Brønnøysundregistrene'),
    );
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Avtale signert 8. oktober' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrer' }));

    expect(
      await screen.findByText(
        'Brønnøysundregistrene er registrert. Beslutningen er logget i Revisjon.',
      ),
    ).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/operator/tenants');
    expect(post?.body).toEqual({ orgNumber: '974760673', name: 'Brønnøysundregistrene' });
    expect(post?.reason).toBe('Avtale signert 8. oktober');
    expect(await screen.findByRole('article', { name: 'Brønnøysundregistrene' })).toBeTruthy();
  });
});
