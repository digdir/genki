// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

interface Call {
  method: string;
  path: string;
  body?: unknown;
  reason?: string;
  session?: string;
}

const recording = () => {
  const base = mockFetch();
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://mock');
    const headers = new Headers(init?.headers);
    const reason = headers.get('change-reason');
    const session = headers.get('support-session');
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api/, ''),
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      ...(reason ? { reason: decodeURIComponent(reason) } : {}),
      ...(session ? { session } : {}),
    });
    return base(input, init);
  };
  return { calls, fetch };
};

const startSession = async (fetch: typeof globalThis.fetch, minutes = '30 minutter') => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = '#/support-access?tenant=999888777';
  render(<App auth={auth} fetch={fetch} />);
  fireEvent.change(await screen.findByRole('textbox', { name: /Begrunnelse/ }), {
    target: { value: 'Kunden ser ikke kvoten riktig, sak DIG-4420' },
  });
  fireEvent.click(screen.getByRole('radio', { name: minutes }));
  fireEvent.click(screen.getByRole('button', { name: 'Start støttetilgang' }));
  await screen.findByRole('heading', { name: 'Portalen til Testetaten, støttetilgang' });
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('støttetilgang som kan endre', () => {
  it('asks for confirmation before saving a setting and logs it as a change from Digdir', async () => {
    const { calls, fetch } = recording();
    await startSession(fetch);

    const frame = await screen.findByRole('region', { name: 'Innstillinger › Virksomhet' });
    const field = within(frame).getAllByRole('textbox')[0] as HTMLInputElement;
    const label = document.querySelector(`label[for="${field.id}"]`)?.textContent ?? '';
    const before = field.value;
    fireEvent.change(field, { target: { value: '42' } });
    expect(within(frame).getByText('1 ulagret endring')).toBeTruthy();
    fireEvent.click(within(frame).getByRole('button', { name: 'Lagre' }));

    const dialog = await screen.findByRole('dialog', { name: 'Endre på vegne av Testetaten' });
    expect(within(dialog).getByText(`${label}:`)).toBeTruthy();
    expect(within(dialog).getByText(before || 'Ikke satt')).toBeTruthy();
    expect((within(dialog).getByLabelText('Begrunnelse') as HTMLTextAreaElement).value).toBe(
      'Kunden ser ikke kvoten riktig, sak DIG-4420',
    );
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre som endring fra Digdir' }));

    expect(
      await screen.findByText('Lagret som endring fra Digdir. Testetaten ser endringen i loggen.'),
    ).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toMatchObject({
      path: expect.stringMatching(/^\/tenants\/999888777\/settings\//),
      body: { value: 42 },
      reason: 'Kunden ser ikke kvoten riktig, sak DIG-4420',
      session: expect.any(String),
    });
    expect(document.body.textContent).not.toMatch(/Kun lesing/i);
  });

  it('lets the operator revoke an API key but never create one', async () => {
    const { calls, fetch } = recording();
    await startSession(fetch);

    fireEvent.click(screen.getByRole('tab', { name: 'Nøkler' }));
    const frame = await screen.findByRole('region', { name: 'Integrasjoner › Nøkler' });
    expect(within(frame).getByText(/Bare virksomheten selv kan lage API-nøkler/)).toBeTruthy();
    expect(within(frame).queryByRole('button', { name: /Lag|Ny nøkkel/ })).toBeNull();
    const row = (await within(frame).findByText('Test fra laptop')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Trekk tilbake' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Trekk tilbake nøkkelen «Test fra laptop»',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Trekk tilbake' }));

    expect(await within(row).findByText('Trukket tilbake')).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/revoke'))).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/api-keys/k-2/revoke',
      session: expect.any(String),
    });
  });

  it('extends the session from the banner with a reason', async () => {
    const { calls, fetch } = recording();
    await startSession(fetch, '15 minutter');

    const banner = screen
      .getAllByRole('status')
      .find((s) => s.textContent?.includes('Støttetilgang til Testetaten')) as HTMLElement;
    expect(banner.textContent).toMatch(/15 min igjen/);
    fireEvent.click(within(banner).getByRole('button', { name: 'Forleng' }));
    const dialog = await screen.findByRole('dialog', { name: 'Forleng støttetilgangen' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forleng med 15 minutter' }));
    expect(await within(dialog).findByText(/minst 10 tegn/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Trenger mer tid til feilsøkingen' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forleng med 15 minutter' }));

    await waitFor(() => expect(banner.textContent).toMatch(/30 min igjen/));
    expect(calls.find((c) => c.path.endsWith('/extend'))).toMatchObject({
      method: 'POST',
      body: { minutes: 15 },
      reason: 'Trenger mer tid til feilsøkingen',
    });
  });

  it('groups the changes made in a session under that session in the log', async () => {
    const { fetch } = recording();
    await startSession(fetch);
    fireEvent.click(screen.getByRole('tab', { name: 'Nøkler' }));
    const keys = await screen.findByRole('region', { name: 'Integrasjoner › Nøkler' });
    const row = (await within(keys).findByText('Test fra laptop')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Trekk tilbake' }));
    const dialog = await screen.findByRole('dialog', { name: /^Trekk tilbake nøkkelen/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Trekk tilbake' }));
    await within(row).findByText('Trukket tilbake');

    fireEvent.click(screen.getByRole('tab', { name: 'Logg' }));
    const log = await screen.findByRole('region', {
      name: 'Det Testetaten ser · Logg › Endringer',
    });
    expect(within(log).getByText('Lise Dahl, Digdir, åpnet portalen')).toBeTruthy();
    expect(within(log).getByText(/1 endring$/)).toBeTruthy();
    expect(within(log).getByText(/Trakk tilbake API-nøkkel: Test fra laptop/)).toBeTruthy();
    expect(within(log).getByText('Endring fra Digdir')).toBeTruthy();
  });

  it('shows the unsaved change when the session runs out before saving', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetch } = recording();
    await startSession(fetch, '15 minutter');
    const frame = await screen.findByRole('region', { name: 'Innstillinger › Virksomhet' });
    fireEvent.change(within(frame).getAllByRole('textbox')[0] as HTMLInputElement, {
      target: { value: '42' },
    });

    vi.setSystemTime(Date.now() + 16 * 60_000);
    await act(() => vi.advanceTimersByTimeAsync(15_000));

    expect(await screen.findByText('Tiden gikk ut før du lagret')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start en ny økt' }));
    expect(await screen.findByRole('heading', { name: 'Start støttetilgang' })).toBeTruthy();
  });
});
