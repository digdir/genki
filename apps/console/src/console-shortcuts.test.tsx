// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { exampleTenants, mockFetch } from './mock';
import type { EffectiveSettings, SettingInfo } from './types';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const catalog: SettingInfo[] = [
  {
    key: 'usage.monthlyTokens',
    description: 'Monthly token quota',
    category: 'usage',
    axis: 'service',
    sensitivity: 'normal',
    default: 40_000_000,
    settableAt: ['platform', 'tenant'],
  },
  {
    key: 'answer.tone',
    description: 'Hvordan svaret skal låte',
    category: 'Svar',
    axis: 'service',
    sensitivity: 'normal',
    default: 'nøytral',
    settableAt: ['platform', 'tenant'],
  },
  {
    key: 'answer.maxWords',
    description: 'Lengste svar',
    category: 'Svar',
    axis: 'service',
    sensitivity: 'normal',
    default: 300,
    settableAt: ['platform', 'tenant'],
  },
  {
    key: 'model.temperatureCap',
    description: 'Øvre grense for temperatur',
    category: 'Modell',
    axis: 'service',
    sensitivity: 'normal',
    default: 0.7,
    settableAt: ['platform', 'tenant'],
  },
];

const effective: EffectiveSettings = Object.fromEntries(
  catalog.map((s) => [
    s.key,
    {
      key: s.key,
      value: s.default,
      source: 'platform',
      defaultVersion: 1,
      overridden: [],
      rejected: [],
      ...(s.key === 'model.temperatureCap' ? { locked: 'fastsatt av Digdir' } : {}),
    },
  ]),
);

const recording = (base = mockFetch(), settings = false) => {
  const calls: { method: string; path: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://mock');
    const method = init?.method ?? 'GET';
    const path = `${url.pathname.replace(/^\/api/, '')}${url.search}`;
    calls.push({ method, path });
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (settings && method === 'GET' && path === '/settings') return reply({ data: catalog });
    if (settings && method === 'GET' && path === '/tenants/974222333/settings/effective')
      return reply(effective);
    return base(input, init);
  };
  return { calls, fetch };
};

const open = async (hash: string, fetch: typeof globalThis.fetch, live = false) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = hash;
  render(<App auth={auth} fetch={fetch} live={live} />);
};

const startSupport = async () => {
  fireEvent.change(await screen.findByRole('textbox', { name: /Begrunnelse/ }), {
    target: { value: 'Kunden er nær kvoten, sak DIG-4421' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start støttetilgang' }));
  return screen.findByRole('region', { name: 'Innstillinger › Virksomhet' });
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('near quota on the tenants screen', () => {
  it('links the near quota tag to the monthly token setting in support access', async () => {
    await open('#/tenants', mockFetch());

    const link = await screen.findByRole('link', {
      name: 'Nær kvoten: juster månedlig tokenkvote for Eksempeldirektoratet',
    });
    expect(link.getAttribute('href')).toBe(
      '#/support-access?tenant=974222333&tab=settings&setting=usage.monthlyTokens',
    );
  });

  it('explains instead of linking when the tenant is still onboarding', async () => {
    const tenants = exampleTenants.map((x) =>
      x.orgNumber === '921444555' ? { ...x, tokensMillions: 19, quotaMillions: 20 } : x,
    );
    await open('#/tenants', mockFetch(tenants));

    const row = (await screen.findByRole('rowheader', { name: /Fylkeskommunen i Testfylke/ }))
      .parentElement as HTMLElement;
    expect(within(row).getByText('Nær kvoten')).toBeTruthy();
    expect(
      within(row).getByText('Kvoten kan justeres i støttetilgang når oppstarten er ferdig.'),
    ).toBeTruthy();
    expect(within(row).queryByRole('link', { name: /Nær kvoten/ })).toBeNull();
  });
});

describe('support access settings', () => {
  it('opens on the setting named in the query and focuses it', async () => {
    const { fetch } = recording(mockFetch(), true);
    await open('#/support-access?tenant=974222333&tab=settings&setting=usage.monthlyTokens', fetch);
    await startSupport();

    expect(screen.getByRole('tab', { name: 'Innstillinger' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const field = await screen.findByRole('textbox', { name: 'Tokens per måned' });
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('groups settings under their category and shows locked ones with the reason', async () => {
    const { fetch } = recording(mockFetch(), true);
    await open('#/support-access?tenant=974222333', fetch);
    const frame = await startSupport();

    const groups = within(frame)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(groups).toEqual(['Forbruk', 'Svar', 'Modell']);
    const svar = within(frame).getByRole('region', { name: 'Svar' });
    expect(within(svar).getByRole('textbox', { name: 'answer.tone' })).toBeTruthy();
    expect(within(svar).getByRole('textbox', { name: 'answer.maxWords' })).toBeTruthy();

    const locked = within(frame).getByRole('textbox', { name: 'model.temperatureCap' });
    expect((locked as HTMLInputElement).readOnly).toBe(true);
    expect(within(frame).getByText('Låst: fastsatt av Digdir')).toBeTruthy();
  });

  it('filters settings by key, label and description', async () => {
    const { fetch } = recording(mockFetch(), true);
    await open('#/support-access?tenant=974222333', fetch);
    const frame = await startSupport();
    const search = within(frame).getByRole('searchbox', { name: 'Søk i innstillinger' });

    fireEvent.change(search, { target: { value: 'answer.' } });
    expect(within(frame).queryByRole('textbox', { name: 'Tokens per måned' })).toBeNull();
    expect(
      within(frame)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Svar']);

    fireEvent.change(search, { target: { value: 'tokens per' } });
    expect(within(frame).getByRole('textbox', { name: 'Tokens per måned' })).toBeTruthy();
    expect(within(frame).queryByRole('textbox', { name: 'answer.tone' })).toBeNull();

    fireEvent.change(search, { target: { value: 'øvre grense' } });
    expect(within(frame).getByRole('textbox', { name: 'model.temperatureCap' })).toBeTruthy();

    fireEvent.change(search, { target: { value: 'finnes ikke' } });
    expect(within(frame).getByText('Ingen innstillinger passer søket.')).toBeTruthy();
  });

  it('keeps the search after saving a setting', async () => {
    const { fetch } = recording(mockFetch(), true);
    await open('#/support-access?tenant=974222333', fetch);
    const frame = await startSupport();
    const search = within(frame).getByRole('searchbox', { name: 'Søk i innstillinger' });
    fireEvent.change(search, { target: { value: 'answer' } });

    fireEvent.change(within(frame).getByRole('textbox', { name: 'answer.maxWords' }), {
      target: { value: '250' },
    });
    fireEvent.click(within(frame).getByRole('button', { name: 'Lagre' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre som endring fra Digdir' }));
    await screen.findByText(/Lagret som endring fra Digdir/);

    expect((search as HTMLInputElement).value).toBe('answer');
    expect(within(frame).queryByRole('textbox', { name: 'Tokens per måned' })).toBeNull();
    expect(
      (within(frame).getByRole('textbox', { name: 'answer.maxWords' }) as HTMLInputElement).value,
    ).toBe('250');
  });
});

describe('actions the platform does not have yet', () => {
  it('hides save, test and disconnect for tracing tools outside mock mode', async () => {
    await open('#/tracing', mockFetch(), true);

    await screen.findByRole('heading', { name: /Langfuse/ });
    expect(screen.queryByRole('button', { name: /^(Lagre|Koble til)$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Koble fra' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send testspor' })).toBeNull();
    expect(screen.getByText(/^Ikke tilgjengelig ennå\. Plattformen kan ikke lagre/)).toBeTruthy();
  });

  it('keeps the tracing actions in mock mode', async () => {
    await open('#/tracing', mockFetch());

    expect(await screen.findByRole('button', { name: /^(Lagre|Koble til)$/ })).toBeTruthy();
  });

  it('replaces the onboarding reminder with a reason outside mock mode', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
    await open('#/onboarding', mockFetch(), true);

    const fylke = await screen.findByRole('article', { name: 'Fylkeskommunen i Testfylke' });
    expect(within(fylke).queryByRole('button', { name: 'Send påminnelse' })).toBeNull();
    expect(within(fylke).getByText('Påminnelse: ikke tilgjengelig ennå.')).toBeTruthy();
  });
});

describe('operations task status', () => {
  it('shows running tasks by default without asking for other statuses', async () => {
    const { calls, fetch } = recording();
    await open('#/operations', fetch);

    expect(await screen.findByRole('radio', { name: 'Pågår' })).toHaveProperty('checked', true);
    await screen.findByText('t-101');
    expect(calls.some((c) => c.path.startsWith('/operator/running-tasks'))).toBe(true);
    expect(calls.some((c) => c.path.startsWith('/operator/tasks?'))).toBe(false);
  });

  it('asks the platform for the chosen status and lists those tasks', async () => {
    const { calls, fetch } = recording();
    await open('#/operations', fetch);

    fireEvent.click(await screen.findByRole('radio', { name: 'Feilet' }));

    const table = await screen.findByRole('region', { name: 'Kjøringer med valgt status' });
    expect(within(table).getByText('t-091')).toBeTruthy();
    expect(within(table).queryByText('t-101')).toBeNull();
    expect(within(table).queryByRole('button', { name: /Avbryt/ })).toBeNull();
    expect(calls).toContainEqual({ method: 'GET', path: '/operator/tasks?status=failed' });
  });

  it('keeps the chosen status and tenant filter when the screen refreshes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
    const { calls, fetch } = recording();
    await open('#/operations', fetch);

    fireEvent.click(await screen.findByRole('radio', { name: 'Fullført' }));
    fireEvent.change(screen.getByRole('textbox', { name: /^Virksomhet/ }), {
      target: { value: '974222333' },
    });
    await screen.findByText('t-090');
    const before = calls.filter((c) => c.path === '/operator/tasks?status=completed').length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/operator/tasks?status=completed').length).toBe(
        before + 1,
      ),
    );
    expect(screen.getByRole('radio', { name: 'Fullført' })).toHaveProperty('checked', true);
    expect((screen.getByRole('textbox', { name: /^Virksomhet/ }) as HTMLInputElement).value).toBe(
      '974222333',
    );
    expect(screen.getByText('t-090')).toBeTruthy();
  });
});
