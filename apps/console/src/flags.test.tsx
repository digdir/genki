// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createApiClient } from './api';
import { Flags } from './screens/Flags';
import { mockEntra, operatorRole } from './auth';
import { FlagsOn, FlagsProvider, useFlag } from './flags';
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

const recorded = () => {
  const base = mockFetch();
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
  return { calls, fetch };
};

const signedIn = async (fetch: typeof globalThis.fetch) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = '/flags';
  render(<App auth={auth} fetch={fetch} />);
};

const Studio = () => (useFlag('blockStudio') ? <h2>Block Studio</h2> : null);

beforeEach(() => {
  document.documentElement.lang = 'nb';
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('feature flags on the console', () => {
  it('hides a screen behind a flag that is off and shows it when a test turns it on', () => {
    const { unmount } = render(<Studio />);
    expect(screen.queryByRole('heading', { name: 'Block Studio' })).toBeNull();
    unmount();

    render(
      <FlagsOn flags={['blockStudio']}>
        <Studio />
      </FlagsOn>,
    );
    expect(screen.getByRole('heading', { name: 'Block Studio' })).toBeTruthy();
  });

  it('loads the flags once from /me/flags and shows what is on for the operator', async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [
        {
          key: 'blockStudio' as const,
          on: true,
          source: 'tenant' as const,
          selfService: true,
          person: null,
          tenant: true,
        },
      ];
    };
    render(
      <FlagsProvider load={load}>
        <Studio />
      </FlagsProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Block Studio' })).toBeTruthy();
    expect(loads).toBe(1);
  });

  it('lists each flag by its portal name with default, owner, removal date and where it is chosen', async () => {
    await signedIn(mockFetch());

    const section = await screen.findByRole('region', { name: 'Utforming' });
    expect(within(section).getByText(/Standard av · Eier: the lab · Fjernes innen/)).toBeTruthy();
    expect(within(section).getByText('Selvbetjent')).toBeTruthy();
    const table = within(section).getByRole('region', { name: 'Hvor Utforming er valgt' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Hvor', 'Status', 'Går ut', 'Endret', 'Begrunnelse', 'Handling']);
    const org = within(table).getByRole('row', { name: /^Kontrollrådet På/ });
    expect(within(org).getByText(/31\. des\./)).toBeTruthy();
    expect(within(org).getByText('Lise Dahl, 12. nov.')).toBeTruthy();
    expect(within(org).getByText('Pilot for designelementer')).toBeTruthy();
    const person = within(table).getByRole('row', { name: /Marte Solheim i Kontrollrådet/ });
    expect(within(person).getByText('Av')).toBeTruthy();
    expect(within(person).getByText('Ingen')).toBeTruthy();
  });

  it('switches a flag for a person in an organisation picked by name, with an expiry and a reason', async () => {
    const { calls, fetch } = recorded();
    await signedIn(fetch);
    const section = await screen.findByRole('region', { name: 'Utforming' });

    const org = within(section).getByRole('combobox', { name: 'Virksomhet' });
    fireEvent.change(org, { target: { value: 'kontroll' } });
    const options = await within(section).findByRole('listbox', { name: 'Virksomheter' });
    expect(within(options).getByRole('option', { name: /Kontrollrådet 983555666/ })).toBeTruthy();
    fireEvent.keyDown(org, { key: 'Enter' });
    expect((org as HTMLInputElement).value).toBe('Kontrollrådet');
    expect(within(section).queryByRole('listbox')).toBeNull();
    fireEvent.change(within(section).getByRole('textbox', { name: 'Utsteder' }), {
      target: { value: 'ansattporten' },
    });
    fireEvent.change(within(section).getByRole('textbox', { name: 'Subjekt' }), {
      target: { value: 'kari' },
    });
    fireEvent.click(within(section).getByRole('radio', { name: 'Slå av' }));
    fireEvent.change(within(section).getByLabelText(/Går ut/), { target: { value: '2099-12-31' } });
    fireEvent.change(within(section).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Kari tester uten ny utforming' },
    });
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Lagre' }));
    });

    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      {
        method: 'PUT',
        path: '/operator/flags/blockStudio',
        body: {
          tenant: '983555666',
          person: { issuer: 'ansattporten', subject: 'kari' },
          on: false,
          expiresAt: new Date('2099-12-31T23:59:59').toISOString(),
        },
        reason: 'Kari tester uten ny utforming',
      },
    ]);
    expect(
      await screen.findByText('Lagret valget for Utforming. Endringen er logget.'),
    ).toBeTruthy();
  });

  it('saves nothing until an organisation is picked or its number typed, and the reason is long enough', async () => {
    const { calls, fetch } = recorded();
    await signedIn(fetch);
    const section = await screen.findByRole('region', { name: 'Utforming' });

    fireEvent.change(within(section).getByRole('combobox', { name: 'Virksomhet' }), {
      target: { value: 'kontroll' },
    });
    fireEvent.change(within(section).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'kort' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Lagre' }));

    expect(await within(section).findByText('Velg en virksomhet fra listen.')).toBeTruthy();
    expect(within(section).getByText(/minst 10 tegn/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('takes a typed organisation number when the list of organisations cannot be loaded', async () => {
    const { calls, fetch } = recorded();
    await signedIn(async (input, init) =>
      String(input).endsWith('/operator/tenants')
        ? new Response('{}', { status: 500 })
        : fetch(input, init),
    );
    const section = await screen.findByRole('region', { name: 'Utforming' });

    const org = within(section).getByRole('combobox', { name: 'Virksomhet' });
    expect(
      await within(section).findByText('Fant ikke listen over virksomheter. Skriv org.nr.'),
    ).toBeTruthy();
    fireEvent.change(org, { target: { value: ' 983555666 ' } });
    fireEvent.change(within(section).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Pilot for designelementer' },
    });
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Lagre' }));
    });

    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      expect.objectContaining({ body: { tenant: '983555666', on: true } }),
    ]);
  });

  it('refuses an expiry of today and accepts tomorrow', async () => {
    const { calls, fetch } = recorded();
    const api = createApiClient({ baseUrl: '/api', fetch, token: () => 'ops' });
    render(<Flags api={api} now={() => new Date('2026-11-26T10:00:00Z')} />);
    const section = await screen.findByRole('region', { name: 'Utforming' });
    const org = within(section).getByRole('combobox', { name: 'Virksomhet' });
    fireEvent.change(org, { target: { value: 'kontroll' } });
    fireEvent.click(await within(section).findByRole('option', { name: /Kontrollrådet/ }));
    fireEvent.change(within(section).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Pilot for designelementer' },
    });

    fireEvent.change(within(section).getByLabelText(/Går ut/), { target: { value: '2026-11-26' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Lagre' }));
    expect(await within(section).findByText('Velg en dato etter i dag.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);

    fireEvent.change(within(section).getByLabelText(/Går ut/), { target: { value: '2026-11-27' } });
    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Lagre' }));
    });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('says when a choice has expired and when a flag is past its removal date', async () => {
    const base = mockFetch();
    const expired: typeof globalThis.fetch = async (input, init) => {
      const response = await base(input, init);
      if (!String(input).endsWith('/operator/flags')) return response;
      const body = (await response.json()) as { data: { rows: { expiresAt?: string }[] }[] };
      for (const flag of body.data)
        for (const row of flag.rows) if (row.expiresAt) Object.assign(row, { expired: true });
      return Response.json(body);
    };
    const api = createApiClient({ baseUrl: '/api', fetch: expired, token: () => 'ops' });
    render(<Flags api={api} now={() => new Date('2027-06-01T10:00:00Z')} />);

    const section = await screen.findByRole('region', { name: 'Utforming' });
    expect(within(section).getByText('Skulle vært fjernet')).toBeTruthy();
    const ended = within(section).getByRole('row', { name: /^Eksempelhelseforetaket/ });
    expect(within(ended).getByText(/Gikk ut 30\. nov\./)).toBeTruthy();
  });

  it('offers the organisations typed while they were still loading once they arrive', async () => {
    const base = mockFetch();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await signedIn(async (input, init) => {
      if (new URL(String(input), 'http://mock').pathname.endsWith('/operator/tenants')) await held;
      return base(input, init);
    });
    const section = await screen.findByRole('region', { name: 'Utforming' });

    fireEvent.change(within(section).getByRole('combobox', { name: 'Virksomhet' }), {
      target: { value: 'kontroll' },
    });
    expect(within(section).queryByRole('listbox')).toBeNull();
    await act(async () => release());

    const options = await within(section).findByRole('listbox', { name: 'Virksomheter' });
    fireEvent.click(within(options).getByRole('option', { name: /Kontrollrådet/ }));
    expect(
      (within(section).getByRole('combobox', { name: 'Virksomhet' }) as HTMLInputElement).value,
    ).toBe('Kontrollrådet');
  });

  it('keeps a half-filled switch when a cleared choice reloads the list', async () => {
    const { calls, fetch } = recorded();
    await signedIn(fetch);
    const section = await screen.findByRole('region', { name: 'Utforming' });
    fireEvent.change(within(section).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Halvferdig begrunnelse' },
    });

    fireEvent.click(
      within(section).getByRole('button', { name: 'Fjern valget for Marte Solheim' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Marte er ferdig med testen' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Fjern valget' }));
    });

    expect(await screen.findByText('Valget er fjernet. Endringen er logget.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      expect.objectContaining({
        body: {
          tenant: '983555666',
          person: { issuer: 'https://login.example.no', subject: 'marte' },
          on: null,
        },
        reason: 'Marte er ferdig med testen',
      }),
    ]);
    await waitFor(() => expect(within(section).queryByRole('row', { name: /Marte/ })).toBeNull());
    expect(
      (within(section).getByRole('textbox', { name: 'Begrunnelse' }) as HTMLInputElement).value,
    ).toBe('Halvferdig begrunnelse');
  });
});
