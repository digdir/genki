// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';
import type { SettingInfo } from './types';

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
}

const monthlyTokens: SettingInfo = {
  key: 'usage.monthlyTokens',
  description: 'Monthly token quota',
  category: 'usage',
  axis: 'service',
  sensitivity: 'normal',
  default: 40_000_000,
  settableAt: ['platform', 'tenant'],
};

const withMonthlyTokens =
  (base: typeof globalThis.fetch): typeof globalThis.fetch =>
  async (input, init) => {
    const answer = await base(input, init);
    if (!String(input).endsWith('/settings') || (init?.method ?? 'GET') !== 'GET') return answer;
    const { data } = (await answer.json()) as { data: SettingInfo[] };
    return Response.json({ data: [monthlyTokens, ...data] });
  };

const recording = (base = mockFetch()) => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://mock');
    const headers = new Headers(init?.headers);
    const reason = headers.get('change-reason');
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api/, ''),
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      ...(reason ? { reason: decodeURIComponent(reason) } : {}),
    });
    return base(input, init);
  };
  return { calls, fetch };
};

const open = async (hash: string, fetch: typeof globalThis.fetch) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = hash;
  render(<App auth={auth} fetch={fetch} />);
};

const lookUpRun = async () => {
  const field = await screen.findByRole('textbox', { name: 'ID for kjøringen' });
  fireEvent.change(field, { target: { value: 'opg_7f2kq9d1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Slå opp' }));
};

const timeline = '/tenants/999888777/tasks/opg_7f2kq9d1/timeline';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('content of an organisation', () => {
  it("asks for a reason before showing an organisation's content and retries with it", async () => {
    const { calls, fetch } = recording();
    await open('#/diagnostics?tenant=999888777', fetch);
    await lookUpRun();

    const dialog = await screen.findByRole('dialog', { name: 'Grunn for å se innhold' });
    expect(
      within(dialog).getByText(
        'Innholdet til Testetaten kan inneholde personopplysninger. Skriv hvorfor du trenger å se det.',
      ),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Kunden melder feil svar, sak DIG-4412' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Se innhold' }));

    expect(await screen.findByRole('heading', { name: 'opg_7f2kq9d1' })).toBeTruthy();
    const after = calls.filter((c) => c.path === timeline || c.path.endsWith('/content-reason'));
    expect(after.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${timeline}`,
      'POST /operator/tenants/999888777/content-reason',
      `GET ${timeline}`,
    ]);
    expect(after[1]?.body).toEqual({ reason: 'Kunden melder feil svar, sak DIG-4412' });
  });

  it('shows the content without asking again once a reason is given', async () => {
    const { calls, fetch } = recording();
    await open('#/diagnostics?tenant=999888777', fetch);
    await lookUpRun();
    const dialog = await screen.findByRole('dialog', { name: 'Grunn for å se innhold' });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Kunden melder feil svar, sak DIG-4412' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Se innhold' }));
    await screen.findByRole('heading', { name: 'opg_7f2kq9d1' });

    fireEvent.click(screen.getByRole('button', { name: 'Slå opp' }));

    await waitFor(() => expect(calls.filter((c) => c.path === timeline)).toHaveLength(3));
    expect(screen.queryByRole('dialog', { name: 'Grunn for å se innhold' })).toBeNull();
    expect(calls.filter((c) => c.path.endsWith('/content-reason'))).toHaveLength(1);
  });

  it('cancelling the reason dialog shows the refusal and sends nothing', async () => {
    const { calls, fetch } = recording();
    await open('#/diagnostics?tenant=999888777', fetch);
    await lookUpRun();

    const dialog = await screen.findByRole('dialog', { name: 'Grunn for å se innhold' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Avbryt' }));

    expect(await screen.findByText('Kunne ikke slå opp. Prøv igjen om litt.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'opg_7f2kq9d1' })).toBeNull();
    expect(calls.filter((c) => c.path === timeline)).toHaveLength(1);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('an organisation in the console', () => {
  it("saves an organisation's monthly tokens as Digdir with a change reason, without a support session", async () => {
    const { calls, fetch } = recording(withMonthlyTokens(mockFetch()));
    await open('#/support-access?tenant=999888777&tab=settings&setting=usage.monthlyTokens', fetch);

    const field = await screen.findByRole('textbox', { name: 'Tokens per måned' });
    fireEvent.change(field, { target: { value: '50000000' } });
    const frame = screen.getByRole('region', { name: 'Innstillinger › Virksomhet' });
    fireEvent.click(within(frame).getByRole('button', { name: 'Lagre' }));
    const dialog = await screen.findByRole('dialog', { name: 'Endre på vegne av Testetaten' });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Kunden trenger mer kvote, sak DIG-4420' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre som endring fra Digdir' }));

    expect(
      await screen.findByText('Lagret som endring fra Digdir. Testetaten ser endringen i loggen.'),
    ).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toEqual({
      method: 'PUT',
      path: '/tenants/999888777/settings/usage.monthlyTokens',
      body: { value: 50000000 },
      reason: 'Kunden trenger mer kvote, sak DIG-4420',
    });
  });

  it('shows the portal of the organisation picked, without a session to start', async () => {
    const { fetch } = recording();
    await open('#/support-access?tenant=999888777', fetch);

    expect(await screen.findByRole('heading', { name: 'Portalen til Testetaten' })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Virksomhet' }), {
      target: { value: '974222333' },
    });
    expect(
      await screen.findByRole('heading', { name: 'Portalen til Eksempeldirektoratet' }),
    ).toBeTruthy();
  });

  it('follows a later link to another organisation after one was picked', async () => {
    const { fetch } = recording();
    await open('#/support-access?tenant=999888777', fetch);
    await screen.findByRole('heading', { name: 'Portalen til Testetaten' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Virksomhet' }), {
      target: { value: '974222333' },
    });
    await screen.findByRole('heading', { name: 'Portalen til Eksempeldirektoratet' });

    window.location.hash = '#/support-access?tenant=999888777';

    expect(await screen.findByRole('heading', { name: 'Portalen til Testetaten' })).toBeTruthy();
  });

  it('lets the operator revoke an API key with a reason but never create one', async () => {
    const { calls, fetch } = recording();
    await open('#/support-access?tenant=999888777&tab=keys', fetch);

    const frame = await screen.findByRole('region', { name: 'Integrasjoner › Nøkler' });
    expect(within(frame).queryByRole('button', { name: /Lag|Ny nøkkel/ })).toBeNull();
    const row = (await within(frame).findByText('Test fra laptop')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Trekk tilbake' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Trekk tilbake nøkkelen «Test fra laptop»',
    });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Nøkkelen er på avveie, sak DIG-4421' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Trekk tilbake' }));

    expect(await within(row).findByText('Trukket tilbake')).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/revoke'))).toEqual({
      method: 'POST',
      path: '/tenants/999888777/api-keys/k-2/revoke',
      body: {},
      reason: 'Nøkkelen er på avveie, sak DIG-4421',
    });
  });

  it("shows Digdir's content reads and reasons in the organisation's log", async () => {
    const { fetch } = recording();
    await open('#/diagnostics?tenant=999888777', fetch);
    await lookUpRun();
    const dialog = await screen.findByRole('dialog', { name: 'Grunn for å se innhold' });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Kunden melder feil svar, sak DIG-4412' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Se innhold' }));
    await screen.findByRole('heading', { name: 'opg_7f2kq9d1' });

    window.location.hash = '#/support-access?tenant=999888777&tab=log';
    const log = await screen.findByRole('region', { name: 'Det Testetaten ser · Logg' });
    expect(
      within(log).getByText(/^Digdir oppga grunn for å se innhold/, { selector: 'span' }),
    ).toBeTruthy();
    expect(within(log).getByText(/^Digdir så innhold/, { selector: 'span' })).toBeTruthy();
    expect(within(log).getAllByText(/Kunden melder feil svar, sak DIG-4412/)).toHaveLength(2);
  });
});
