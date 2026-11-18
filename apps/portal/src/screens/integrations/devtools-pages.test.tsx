// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ConfigEntry } from '../../api';
import type { TenantStatus } from '../../api/platform-status';
import { translator } from '../../i18n';
import { exampleTracing } from '../../mock/devtools';
import { renderAt, renderLive } from '../../test-utils';
import { serviceOptionLabel } from './CallFromCode';
import { DevStatus } from './DevStatus';
import { runProblemText } from './Triggers';
import { codeInput } from '../../data/integrations';
import { sharedRules, whenItFires } from './Guardrails';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

document.getAnimations ??= () => [];

const rule = (id: string, mandatory: boolean, spec: Record<string, unknown> = {}): ConfigEntry =>
  ({ id, scope: '999888777', version: 1, mandatory, builtin: false, spec }) as ConfigEntry;

describe('Utviklerverktøy: sider', () => {
  it('says a developer page that does not exist is not found, with a way back', async () => {
    await renderAt('#/developer/finnes-ikke');
    expect(await screen.findByRole('heading', { name: 'Fant ikke siden' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gå til Driftsstatus' }).getAttribute('href')).toBe(
      '#/developer/status',
    );
  });
});

describe('Felles sikkerhetsfiltre', () => {
  it('lists required rules first, without the built-in ones, and names the services using each', () => {
    const rules = sharedRules(
      [
        rule('999888777/valgfri', false),
        rule('pakrevd', true),
        { ...rule('innebygd', true), builtin: true },
      ],
      [{ id: 'custom-rules/valgfri', usedBy: [{ id: 'rapport', name: 'Rapport' }] }],
    );
    expect(rules.map((r) => r.id)).toEqual(['pakrevd', 'valgfri']);
    expect(rules[1]?.usedBy).toEqual([{ id: 'rapport', name: 'Rapport' }]);
  });

  it('says in words what a rule does when it fires', () => {
    const t = translator('nb');
    expect(whenItFires(t, { stage: 'input', action: 'mask', mask: '[fjernet]' })).toMatch(
      /\[fjernet\]/,
    );
    expect(whenItFires(t, { stage: 'output', action: 'refuse', message: 'Nei takk.' })).toMatch(
      /Nei takk\./,
    );
  });

  it('filters the rules by required and optional', async () => {
    await renderLive('#/developer/guardrails');
    expect(await screen.findByText('fjern-personnummer')).toBeTruthy();
    expect(screen.getByText('ingen-helseraad')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /^Påbudt/ }));
    expect(screen.getByText('fjern-personnummer')).toBeTruthy();
    expect(screen.queryByText('ingen-helseraad')).toBeNull();
  });

  it('shows an empty state with a way to the building blocks when there are no shared rules', async () => {
    await renderLive('#/developer/guardrails', { features: { devtools: { guardrailRules: [] } } });
    expect(
      await screen.findByRole('heading', { name: 'Ingen felles sikkerhetsfiltre ennå' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Se vern i Byggeklosser' }).getAttribute('href')).toBe(
      '#/building-blocks/guardrail?show=catalogue',
    );
  });
});

describe('Sporing og evaluering', () => {
  it('shows the empty state when the organisation has no tracing connection', async () => {
    await renderLive('#/developer/tracing');
    expect(await screen.findByText('Sporing er ikke koblet til')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Hva som spores' })).toBeNull();
  });

  const sampleSetting = {
    key: 'tracing.sampleRate',
    description: 'Andel kjøringer som spores.',
    category: 'tracing',
    axis: 'service',
    sensitivity: 'normal',
    default: 1,
    settableAt: ['platform', 'tenant'],
  };
  const withRate = (initial: number) => {
    const state = { value: initial, puts: [] as { body: unknown; reason: string | null }[] };
    const override = (url: string, method: string) => {
      if (method === 'GET' && /\/settings\/effective$/.test(url))
        return Response.json({
          'tracing.sampleRate': {
            key: 'tracing.sampleRate',
            value: state.value,
            source: 'tenant',
            defaultVersion: 1,
            overridden: [],
            rejected: [],
          },
        });
      return undefined;
    };
    return { state, override };
  };

  it('offers the share of runs to trace only when the settings catalogue holds tracing.sampleRate', async () => {
    await renderLive('#/developer/tracing', {
      features: { devtools: { tracing: exampleTracing } },
    });
    await screen.findByRole('heading', { name: 'Hva som spores' });
    expect(screen.queryByRole('radio', { name: /Hver fjerde/ })).toBeNull();

    cleanup();
    const { override } = withRate(0.25);
    await renderLive(
      '#/developer/tracing',
      {
        features: {
          devtools: { tracing: exampleTracing },
          settings: { extras: [sampleSetting as never] },
        },
      },
      override,
    );
    const quarter = await screen.findByRole('radio', { name: /Hver fjerde/ });
    expect((quarter as HTMLInputElement).checked).toBe(true);
  });

  it('saves the share as the tenant setting with a reason, not on the Langfuse connection', async () => {
    const { state, override } = withRate(1);
    const calls: { url: string; method: string; body?: string; reason?: string }[] = [];
    await renderLive(
      '#/developer/tracing',
      {
        features: {
          devtools: { tracing: exampleTracing },
          settings: { extras: [sampleSetting as never] },
        },
      },
      (url, method) => {
        if (method === 'PUT' && url.endsWith('/settings/tracing.sampleRate')) {
          calls.push({ url, method });
          state.value = 0.1;
          return Response.json({ ok: true });
        }
        if (method === 'PUT') calls.push({ url, method });
        return override(url, method);
      },
    );
    fireEvent.click(await screen.findByRole('radio', { name: /Hver tiende/ }));
    const bar = screen.getByRole('region', { name: 'Du har endringer som ikke er lagret' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Lagre endringene' }));
    expect(await within(bar).findByText(/minst 10 tegn/)).toBeTruthy();
    fireEvent.change(within(bar).getByLabelText(/Hvorfor endrer du dette/), {
      target: { value: 'Sparer plass i Langfuse' },
    });
    fireEvent.click(within(bar).getByRole('button', { name: 'Lagre endringene' }));
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: /Hver tiende/ }) as HTMLInputElement).checked).toBe(
        true,
      ),
    );
    expect(calls.map((c) => c.url.replace(/.*\/tenants\/[^/]+/, ''))).toEqual([
      '/settings/tracing.sampleRate',
    ]);
  });
});

describe('Kall fra kode', () => {
  it('names a service without its variant unless two services share the name', () => {
    const a = { id: 'docs__faithful', name: 'Dokumenter' };
    const b = { id: 'docs__short', name: 'Dokumenter' };
    const c = { id: 'rapport', name: 'Rapport' };
    expect(serviceOptionLabel(c, [a, b, c])).toBe('Rapport');
    expect(serviceOptionLabel(a, [a, b, c])).toBe('Dokumenter (faithful)');
  });
});

describe('Kroker', () => {
  it('names the own hooks without bending the organisation name', async () => {
    await renderAt('#/developer/hooks');
    expect(await screen.findByRole('list', { name: 'Egne kroker' })).toBeTruthy();
  });
});

describe('API-nøkler: utløp', () => {
  it('offers 90 days, one year and never, with one year chosen', async () => {
    await renderAt('#/developer/keys');
    await screen.findByRole('list', { name: 'API-nøkler' });
    fireEvent.click(screen.getByRole('button', { name: 'Ny API-nøkkel' }));
    const select = screen.getByLabelText('Utløper') as HTMLSelectElement;
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      expect.stringMatching(/^Om 90 dager/),
      expect.stringMatching(/^Om ett år/),
      'Aldri',
    ]);
    expect(select.value).toBe('365');
  });
});

const calm: TenantStatus = {
  incidents: [],
  components: [{ name: 'API', status: 'normal' }],
  queueStats: [],
  queue: [],
  triggers: [],
};

const statusApi = (
  status: Record<string, unknown> = {},
  health: Record<string, unknown> = {},
  calls = { health: 0 },
): Pick<ApiClient, 'getHealth' | 'cache' | 'platformStatus'> => ({
  getHealth: () => {
    calls.health += 1;
    return Promise.resolve({ status: 'ok', version: 'a3f9c12e1d', ...health });
  },
  cache: { invalidate: () => undefined } as ApiClient['cache'],
  platformStatus: {
    tenant: () => Promise.resolve({ ...calm, ...status } as TenantStatus),
  },
});

describe('Driftsstatus: designet', () => {
  it('reads the environment from /health, not from the tenant status', async () => {
    render(<DevStatus api={statusApi({ environment: 'genki-test' })} tenant="999888777" />);
    expect(await screen.findByText('Versjon')).toBeTruthy();
    expect(screen.queryByText('genki-test')).toBeNull();
  });

  it('says how each component is checked when the API says so', async () => {
    render(
      <DevStatus
        api={statusApi({
          components: [{ name: 'Database', status: 'normal', how: 'Spør databasen hvert minutt' }],
        })}
        tenant="999888777"
      />,
    );
    expect(await screen.findByText('Spør databasen hvert minutt')).toBeTruthy();
  });

  it('calls a component that is only slow Treg, not Nedsatt', async () => {
    render(
      <DevStatus
        api={statusApi({
          components: [{ name: 'Søk', status: 'degraded', degradedBy: 'latency' }],
        })}
        tenant="999888777"
      />,
    );
    expect(await screen.findByText('Treg')).toBeTruthy();
    expect(screen.getByText('Noe går tregt')).toBeTruthy();
  });

  it('lists earlier incidents under their own heading', async () => {
    render(
      <DevStatus
        api={statusApi({
          pastIncidents: [
            {
              title: 'Treg innlesing',
              text: 'Søkemotoren ble oppgradert.',
              startedAt: '2026-11-10T08:00:00Z',
              resolvedAt: '2026-11-10T09:00:00Z',
            },
          ],
        })}
        tenant="999888777"
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Tidligere hendelser' })).toBeTruthy();
    expect(screen.getByText(/Treg innlesing\. Søkemotoren ble oppgradert\./)).toBeTruthy();
  });

  it('checks again every minute while the page is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = { health: 0 };
    render(<DevStatus api={statusApi({}, {}, calls)} tenant="999888777" />);
    await waitFor(() => expect(calls.health).toBe(1));
    expect(await screen.findByText(/Vi sjekker automatisk hvert minutt\./)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(calls.health).toBe(2));
  });
});

describe('Utløsere: run problems', () => {
  it('falls back to a plain text for an error it does not know, never the raw message', () => {
    const t = translator('nb');
    expect(runProblemText('ECONNRESET socket hang up', t)).toBe(
      'Kjøringen feilet. Åpne kjøringen for å se hva som skjedde.',
    );
  });
});

describe('Kall fra kode: the example body', () => {
  it('sends only what /api/tools/call takes: query, conversation_id or flat form fields', () => {
    for (const body of Object.values(codeInput) as Record<string, unknown>[]) {
      for (const key of ['vent', 'input', 'filter']) expect(body).not.toHaveProperty(key);
      for (const value of Object.values(body)) expect(typeof value).not.toBe('object');
    }
    const t = translator('nb');
    expect(t('integCode.apiStep2Wait')).not.toMatch(/vent/);
    expect(t('integCode.apiStep2Approval')).not.toMatch(/vent/);
  });
});
