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

interface Call {
  method: string;
  path: string;
  body?: unknown;
  reason?: string;
}

const fakeValue = 'fake-value-7f3a9c';
const reason = 'Ny nøkkel fra leverandøren';

const recorded = (base: typeof fetch = mockFetch()) => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const raw = new Headers(init?.headers).get('change-reason');
    calls.push({
      method: init?.method ?? 'GET',
      path: new URL(String(input), 'http://mock').pathname.replace(/^\/api/, ''),
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      ...(raw ? { reason: decodeURIComponent(raw) } : {}),
    });
    return base(input, init);
  };
  return { calls, fetch, puts: () => calls.filter((c) => c.method === 'PUT') };
};

const signedIn = async (fetch: typeof globalThis.fetch) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = '/platform-secrets';
  render(<App auth={auth} fetch={fetch} />);
};

const typeInto = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });

const table = async () => screen.findByRole('table');

beforeEach(() => {
  document.documentElement.lang = 'nb';
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('platform secrets screen', () => {
  it('lists each secret as set or not set with the connections that use it', async () => {
    await signedIn(mockFetch());

    const rows = within(await table()).getAllByRole('row');
    const row = (name: string) => {
      const found = rows.find((r) => within(r).queryByText(name));
      if (!found) throw new Error(`no row for ${name}`);
      return found;
    };

    expect(within(row('foundry-key')).getByText('Satt')).toBeTruthy();
    expect(within(row('foundry-signing-key')).getByText('Ikke satt')).toBeTruthy();
    expect(
      within(row('foundry-signing-key'))
        .getByRole('link', { name: 'Tilkobling foundry' })
        .getAttribute('href'),
    ).toBe('#/models?connection=foundry');
  });

  it('sends the value and the reason, then shows it as set and never shows the value', async () => {
    const { fetch, puts } = recorded();
    await signedIn(fetch);
    await table();

    fireEvent.click(screen.getByRole('button', { name: 'Sett verdi for foundry-signing-key' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Sett verdi for foundry-signing-key',
    });
    typeInto(within(dialog).getByLabelText('Verdi', { exact: false }), fakeValue);
    typeInto(within(dialog).getByRole('textbox', { name: 'Begrunnelse' }), reason);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre' }));

    await screen.findByText(
      'Hemmeligheten foundry-signing-key er lagret. Verdien vises ikke igjen.',
    );
    expect(puts()).toEqual([
      {
        method: 'PUT',
        path: '/operator/secrets/foundry-signing-key',
        body: { value: fakeValue },
        reason,
      },
    ]);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Bytt verdi for foundry-signing-key' }),
      ).toBeTruthy(),
    );
    expect(document.body.innerHTML).not.toContain(fakeValue);
  });

  it('refuses a change without a reason and sends nothing', async () => {
    const { fetch, puts } = recorded();
    await signedIn(fetch);
    await table();

    fireEvent.click(screen.getByRole('button', { name: 'Bytt verdi for foundry-key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bytt verdi for foundry-key' });
    typeInto(within(dialog).getByLabelText('Verdi', { exact: false }), fakeValue);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre' }));

    expect(await within(dialog).findByText(/Skriv en begrunnelse/)).toBeTruthy();
    expect(puts()).toEqual([]);
  });

  it('refuses a new secret whose name is not a secret name and sends nothing', async () => {
    const { fetch, puts } = recorded();
    await signedIn(fetch);
    await table();

    fireEvent.click(screen.getByRole('button', { name: 'Ny hemmelighet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ny plattformhemmelighet' });
    typeInto(within(dialog).getByRole('textbox', { name: /^Navn/ }), 'Ugyldig Navn');
    typeInto(within(dialog).getByLabelText('Verdi', { exact: false }), fakeValue);
    typeInto(within(dialog).getByRole('textbox', { name: 'Begrunnelse' }), reason);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre' }));

    expect(
      await within(dialog).findByText(
        'Bruk små bokstaver, tall, punktum og bindestrek, høyst 63 tegn.',
      ),
    ).toBeTruthy();
    expect(puts()).toEqual([]);
  });

  it('opens a new secret while the list is still loading', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = mockFetch();
    const slow: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/operator/secrets') && (init?.method ?? 'GET') === 'GET')
        await held;
      return base(input, init);
    };
    await signedIn(slow);

    fireEvent.click(await screen.findByRole('button', { name: 'Ny hemmelighet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ny plattformhemmelighet' });
    typeInto(within(dialog).getByRole('textbox', { name: /^Navn/ }), 'ny-nokkel');
    release();
    await table();

    expect((within(dialog).getByRole('textbox', { name: /^Navn/ }) as HTMLInputElement).value).toBe(
      'ny-nokkel',
    );
  });
});
