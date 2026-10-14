// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import type { Organisation, UsageReport } from '../types';

document.getAnimations ??= () => [];
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const useOnly: Organisation[] = [
  { orgNumber: '999888777', name: 'Testetaten', actions: ['use-services', 'view-usage'] },
];
const manager: Organisation[] = [
  {
    orgNumber: '999888777',
    name: 'Testetaten',
    actions: ['use-services', 'manage-services', 'view-usage'],
  },
];

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const renderAs = async (
  path: string,
  organisations: Organisation[],
  base: typeof fetch = mockFetch(undefined, undefined, undefined, undefined, {
    features: { quality: {} },
  }),
) => {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${urlOf(input)}`);
    return base(input, init);
  };
  const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} live />);
  return calls;
};

const reason = 'Du trenger rettigheten «Administrere tjenester».';

const expectLockedWithReason = (button: HTMLElement) => {
  expect(button.getAttribute('aria-disabled')).toBe('true');
  const hint = document.getElementById(button.getAttribute('aria-describedby') ?? '');
  expect(hint?.textContent).toMatch(/Administrere tjenester/);
  expect(button.parentElement?.contains(hint)).toBe(true);
};

describe('buttons the person has no right for', () => {
  it('API key buttons are disabled with the missing right next to them', async () => {
    const calls = await renderAs('#/integrations?tab=keys', useOnly);
    const create = await screen.findByRole('button', { name: 'Lag API-nøkkel' });
    expectLockedWithReason(create);
    fireEvent.click(create);
    expect(screen.queryByRole('heading', { name: 'Ny API-nøkkel' })).toBeNull();
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('test set and run buttons are disabled with the reason, and nothing is sent', async () => {
    const calls = await renderAs('#/services/rapportassistenten/quality', useOnly);
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    expectLockedWithReason(screen.getByRole('button', { name: 'Nytt testtilfelle' }));
    const run = screen.getByRole('button', { name: 'Kjør testsettet' });
    expect(run.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById('run-hint')?.textContent).toBe(reason);
    expectLockedWithReason(
      screen.getByRole('button', { name: /^Slett testtilfellet «Hvor mange tilsyn/ }),
    );
    fireEvent.click(run);
    expect(screen.queryByRole('button', { name: 'Start kjøringen' })).toBeNull();
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('candidate review buttons are disabled with the reason, and nothing is sent', async () => {
    const calls = await renderAs('#/services/rapportassistenten/quality', useOnly);
    const section = await screen.findByRole('region', { name: 'Forslag til testtilfeller' });
    const item = (await within(section).findByText('Hva var ventetiden på telefon i fjor?'))
      .parentElement as HTMLElement;
    const accept = within(item).getByRole('button', { name: 'Godta' });
    expectLockedWithReason(accept);
    expectLockedWithReason(within(item).getByRole('button', { name: 'Avvis' }));
    fireEvent.click(accept);
    fireEvent.click(within(item).getByRole('button', { name: 'Avvis' }));
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('opening a new service without manage-services explains it up front instead of the builder', async () => {
    await renderAs('#/services/new', useOnly);
    expect(await screen.findByRole('heading', { name: 'Du kan ikke lage tjenester' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Lag med KI|Start/ })).toBeNull();
  });

  it('the builder is read-only without manage-services', async () => {
    const calls = await renderAs('#/services/rapportassistenten/setup', useOnly);
    expect(
      await screen.findByRole('heading', { name: 'Du ser tjenesten uten å kunne endre den' }),
    ).toBeTruthy();
    const toggles = [...document.querySelectorAll<HTMLButtonElement>('.setup-toggle')];
    expect(toggles.length).toBeGreaterThan(0);
    for (const toggle of toggles)
      if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    const editable = document.querySelectorAll(
      '.setup-body input:not(:disabled), .setup-body textarea:not(:disabled)',
    );
    expect(document.querySelectorAll('.setup-readonly').length).toBeGreaterThan(0);
    expect(editable.length).toBe(0);
    expect(calls.some((c) => c.startsWith('PUT') && c.includes('/draft'))).toBe(false);
  });

  it('calls certain to be refused are not fired on load for people without the right', async () => {
    const calls = await renderAs('#/overview', useOnly);
    await screen.findByRole('heading', { name: 'Siste endringer' });
    expect(await screen.findByText(reason)).toBeTruthy();
    cleanup();
    calls.push(...(await renderAs('#/integrations?tab=systems', useOnly)));
    await screen.findByRole('heading', { name: /Maskinporten/ });
    cleanup();
    calls.push(...(await renderAs('#/settings?tab=transfer', useOnly)));
    await screen.findAllByText(reason);
    expect(calls.filter((c) => /\/(audit|maskinporten-clients|export)(\?|$)/.test(c))).toEqual([]);
  });
});

describe('cost estimate before a paid test set run', () => {
  it('Kjør testsettet asks for confirmation with an estimate before starting a run', async () => {
    const usage: UsageReport = {
      from: '',
      to: '',
      priced: true,
      totals: { inputTokens: 0, outputTokens: 0, requests: 4, runs: 4, costMicroNok: 2_000_000 },
      daily: [],
      byService: [
        {
          service: 'rapportassistenten',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            requests: 4,
            runs: 4,
            costMicroNok: 2_000_000,
          },
        },
      ],
      byModel: [],
    };
    const base = mockFetch(undefined, undefined, undefined, undefined, {
      features: { quality: {} },
    });
    const calls = await renderAs(
      '#/services/rapportassistenten/quality',
      manager,
      async (input, init) =>
        urlOf(input).split('?')[0]?.endsWith('/usage')
          ? new Response(JSON.stringify(usage), {
              headers: { 'content-type': 'application/json' },
            })
          : base(input, init),
    );
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));

    const confirm = (await screen.findByRole('heading', { name: /^Kjøre testsettet med \d+/ }))
      .parentElement as HTMLElement;
    expect(await within(confirm).findByText(/^Anslått kostnad: omtrent/)).toBeTruthy();
    expect(within(confirm).getByText(/snittet per kjøring av tjenesten de siste 30 dagene/));
    expect(calls.some((c) => c.startsWith('POST') && c.includes('/eval-runs'))).toBe(false);

    fireEvent.click(within(confirm).getByRole('button', { name: 'Start kjøringen' }));
    await screen.findByRole('region', { name: 'Kjøringer av testsettet' });
    expect(calls.some((c) => c.startsWith('POST') && c.includes('/eval-runs'))).toBe(true);
  });
});

describe('rights in live mode', () => {
  const fromApi =
    (org: string, rights: string[]): typeof fetch =>
    (input, init) =>
      (urlOf(input).split('?')[0] ?? '').endsWith(`/tenants/${org}/me`)
        ? Promise.resolve(Response.json({ rights }))
        : mockFetch()(input, init);

  it('uses the rights the API reports when the login lists the organisation without actions', async () => {
    await renderAs(
      '#/integrations?tab=keys',
      [{ orgNumber: '312521172', name: 'FALSK IDIOTSIKKER ELEFANT' }],
      fromApi('312521172', ['use-services', 'manage-services', 'view-usage']),
    );
    const create = await screen.findByRole('button', { name: 'Lag API-nøkkel' });
    await expect.poll(() => create.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('the API answer wins over the actions in the login', async () => {
    await renderAs('#/integrations?tab=keys', manager, fromApi('999888777', ['use-services']));
    const create = await screen.findByRole('button', { name: 'Lag API-nøkkel' });
    await expect.poll(() => create.getAttribute('aria-disabled')).toBe('true');
  });
});
