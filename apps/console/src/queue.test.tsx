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

const recording = (base = mockFetch()) => {
  const calls: { method: string; path: string; body?: unknown; reason?: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://mock');
    const raw = new Headers(init?.headers).get('change-reason');
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api/, ''),
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      ...(raw ? { reason: decodeURIComponent(raw) } : {}),
    });
    return base(input, init);
  };
  return { calls, fetch };
};

const open = async (hash: string, fetch: typeof globalThis.fetch = mockFetch()) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = hash;
  render(<App auth={auth} fetch={fetch} />);
};

const navLink = () =>
  within(screen.getByRole('navigation', { name: 'Konsollmeny' })).getByRole('link', {
    name: /^Til behandling/,
  });

const done = () => screen.getAllByRole('region', { name: 'Behandlet' })[0] as HTMLElement;

const openRow = async (title: string) => {
  const table = await screen.findByRole('region', { name: /^Venter/ });
  fireEvent.click(within(table).getByRole('button', { name: title }));
  return screen.getByRole('dialog', { name: title });
};

const decide = async (panel: HTMLElement, button: string, reason: string) => {
  fireEvent.click(within(panel).getByRole('button', { name: button }));
  const dialog = await screen.findByRole('dialog', { name: new RegExp(`^${button}`) });
  fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), { target: { value: reason } });
  fireEvent.click(within(dialog).getByRole('button', { name: button }));
  return dialog;
};

beforeEach(() => {
  window.location.hash = '';
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe('til behandling', () => {
  it('shows how many requests wait for a decision in the menu', async () => {
    await open('#/tenants');

    await waitFor(() => expect(navLink().textContent).toMatch(/\d+ venter på beslutning/));
  });

  it('shows why a building block needs approval, approves it and moves it to Behandlet', async () => {
    const { calls, fetch } = recording();
    await open('#/queue', fetch);

    const panel = await openRow('Claude Sonnet 5.5');
    expect(within(panel).getByText('Testetaten')).toBeTruthy();
    expect(within(panel).getByText('Kari Nordmann')).toBeTruthy();
    expect(within(panel).getByText(/resonnerer bedre over lange regelverk/)).toBeTruthy();
    expect(within(panel).getByText(/plattformregel M-3/)).toBeTruthy();
    expect(within(panel).getByText('Utenfor EU/EØS')).toBeTruthy();
    expect(within(panel).getByText('Sendes til api.anthropic.com')).toBeTruthy();
    expect(within(panel).getByText('Vedtaksutkast')).toBeTruthy();

    const dialog = await decide(panel, 'Godkjenn', 'For kort');
    expect(within(dialog).getAllByText(/minst 10 tegn. Nå er det 8./).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/fire øyne/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Modellen er godkjent for EU-data' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Godkjenn' }));

    expect(await screen.findByText(/Claude Sonnet 5.5 er godkjent/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/operator/building-blocks/approval-requests/ar-12/decision',
      body: { approve: true, reason: 'Modellen er godkjent for EU-data' },
      reason: 'Modellen er godkjent for EU-data',
    });
    const row = within(done()).getByText('Claude Sonnet 5.5').closest('tr') as HTMLElement;
    expect(within(row).getByText('Godkjent')).toBeTruthy();
    expect(within(row).getByText('Lise Dahl, Digdir')).toBeTruthy();
    expect(screen.getByText('Ingenting venter')).toBeTruthy();
  });

  it('shows what changed in a skill since the shared version, and rejects the share', async () => {
    const { calls, fetch } = recording();
    await open('#/queue?tab=skills', fetch);

    const panel = await openRow('Klarspråk');
    expect(within(panel).getByText('Endret siden versjon 2, som er delt i dag')).toBeTruthy();
    expect(within(panel).getByText('Bruk De-form til mottakeren.')).toBeTruthy();
    expect(within(panel).getByText('19 av 20 bestått (krav: 90 prosent)')).toBeTruthy();
    await decide(panel, 'Avvis', 'Ferdigheten mangler testsett for nynorsk');

    expect(await screen.findByText(/Klarspråk er avvist/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      approve: false,
      reason: 'Ferdigheten mangler testsett for nynorsk',
    });
    expect(within(done()).getByText('Avvist')).toBeTruthy();
  });

  it('puts a platform change under review, then takes it into the plan with a case number', async () => {
    const { calls, fetch } = recording();
    await open('#/queue?tab=proposals', fetch);

    const panel = await openRow('Koble til journalsystemet');
    expect(within(panel).getByText(/lese pasientforløpet i journalsystemet/)).toBeTruthy();
    await decide(panel, 'Sett under vurdering', 'Vi ser på dette i plattformteamet');
    expect(await screen.findByText(/er satt under vurdering/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: '/operator/proposals/p-41/status',
      body: { status: 'under_review' },
    });

    const again = screen.getByRole('dialog', { name: 'Koble til journalsystemet' });
    expect(within(again).queryByRole('button', { name: 'Sett under vurdering' })).toBeNull();
    fireEvent.click(within(again).getByRole('button', { name: 'Ta med i planen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ta med i planen' });
    fireEvent.change(within(dialog).getByLabelText('Saksnummer (valgfritt)'), {
      target: { value: 'DIG-4471' },
    });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Følges opp i plattformteamet' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ta med i planen' }));

    expect(await screen.findByText(/tatt med i planen \(sak DIG-4471\)/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST').at(-1)).toMatchObject({
      path: '/operator/proposals/p-41/decision',
      body: { approve: true, reason: 'Følges opp i plattformteamet', caseId: 'DIG-4471' },
    });
    expect(within(done()).getByText('Tatt med i planen')).toBeTruthy();
  });

  it('shows the person who asked the build assistant for a platform change', async () => {
    await open('#/queue?tab=proposals');

    const panel = await openRow('Koble til journalsystemet');
    expect(within(panel).getByText('Byggeassistenten, for Hanne Lie')).toBeTruthy();
  });

  it('approves an access request and shows who sent it apart from the contact person', async () => {
    const { calls, fetch } = recording();
    await open('#/queue?tab=access', fetch);

    const panel = await openRow('Eksempel kommune');
    expect(within(panel).getByText('Ola Viken')).toBeTruthy();
    expect(within(panel).getByText('Ola Nordmann')).toBeTruthy();
    expect(within(panel).getByText('ola.nordmann@example.no')).toBeTruthy();
    expect(within(panel).getByText('Sjekk mot Enhetsregisteret')).toBeTruthy();
    await decide(panel, 'Godkjenn', 'Avtale og databehandleravtale er signert');

    expect(await screen.findByText(/Eksempel kommune er godkjent/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.path).toBe(
      '/operator/onboarding/requests/req-7/decision',
    );
  });

  it('says so when nothing waits, and keeps the other tabs working when one cannot be fetched', async () => {
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = async (input, init) =>
      /skills\/shares/.test(String(input))
        ? new Response(JSON.stringify({ title: 'Feil' }), { status: 500 })
        : /approval-requests|operator\/proposals|onboarding\/requests/.test(String(input))
          ? new Response(JSON.stringify({ data: [] }), { status: 200 })
          : base(input, init);
    await open('#/queue', fetch);

    expect(await screen.findByText('Ingenting venter')).toBeTruthy();
    expect(screen.getByText('Ingen beslutninger de siste 90 dagene.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Deling av ferdigheter/ }));
    expect(await screen.findByText('Fikk ikke hentet delingsforespørslene')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
  });

  it('tells the operator when someone else decided the request while it was open', async () => {
    const base = mockFetch();
    let decided = false;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (/approval-requests\/ar-12\/decision/.test(url)) {
        decided = true;
        return new Response(JSON.stringify({ title: 'Conflict', status: 409 }), { status: 409 });
      }
      if (decided && /approval-requests$/.test(url.split('?')[0] ?? ''))
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'ar-12',
                tenant: '999888777',
                tenantName: 'Testetaten',
                block: {
                  kind: 'model',
                  id: 'claude-sonnet-5-5',
                  version: '1.0',
                  name: 'Claude Sonnet 5.5',
                },
                requestedAt: '2026-10-07T08:30:00Z',
                status: 'approved',
                decision: {
                  by: 'operator:entra:jonas',
                  byName: 'Jonas Berg',
                  at: new Date().toISOString(),
                  reason: 'Testsettet er bestått',
                },
              },
            ],
          }),
          { status: 200 },
        );
      return base(input, init);
    };
    await open('#/queue', fetch);

    const panel = await openRow('Claude Sonnet 5.5');
    await decide(panel, 'Godkjenn', 'Modellen er godkjent for EU-data');

    expect(await screen.findByText('Allerede behandlet av Jonas Berg, Digdir')).toBeTruthy();
    expect(screen.getByText('Testsettet er bestått', { selector: 'p *, p' })).toBeTruthy();
  });

  it('brings back the reason after the session expired during a decision', async () => {
    window.sessionStorage.setItem(
      'queue-decision',
      JSON.stringify({
        kind: 'access',
        id: 'req-7',
        mode: 'approve',
        reason: 'Org.nr. er sjekket på brreg.no',
        caseNo: '',
        expired: true,
      }),
    );
    await open('#/queue');

    const dialog = await screen.findByRole('dialog', { name: 'Godkjenn Eksempel kommune' });
    expect(within(dialog).getByText('Økten din var utløpt')).toBeTruthy();
    expect((within(dialog).getByLabelText('Begrunnelse') as HTMLTextAreaElement).value).toBe(
      'Org.nr. er sjekket på brreg.no',
    );
  });
});
