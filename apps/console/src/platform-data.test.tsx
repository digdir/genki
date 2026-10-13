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

type Call = { method: string; path: string; body?: unknown; reason?: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const serve = (override: (path: string, method: string) => Response | undefined) => {
  const base = mockFetch();
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://mock');
    const method = init?.method ?? 'GET';
    const raw = new Headers(init?.headers).get('change-reason');
    calls.push({
      method,
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      ...(raw ? { reason: decodeURIComponent(raw) } : {}),
    });
    return override(url.pathname, method) ?? base(input, init);
  };
  return { calls, fetch };
};

const open = async (path: string, fetch: typeof globalThis.fetch) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} />);
};

const overview = (components: unknown[], incidents: unknown[] = []) => ({
  incidents,
  components,
  queueStats: [{ label: 'Innlesinger som kjører', value: '2' }],
  queue: [],
  triggers: [],
});

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('drift', () => {
  it('shows no alert, an empty incident list and no failed pipelines when all is normal', async () => {
    const { fetch } = serve((path) =>
      path === '/api/operator/operations'
        ? json(
            overview([
              { name: 'API', status: 'normal' },
              { name: 'Database', status: 'normal', note: 'Svarte på 4 ms.' },
              { name: 'Kjøringer', status: 'normal', errorRate: '0,4 %' },
              { name: 'Innlesing', status: 'normal' },
            ]),
          )
        : undefined,
    );
    await open('#/operations', fetch);

    const endpoints = await screen.findByRole('region', { name: 'Database og modellendepunkter' });
    expect(within(endpoints).getByText('Virker')).toBeTruthy();
    expect(within(endpoints).queryByText('API')).toBeNull();
    const rates = screen.getByRole('region', { name: 'Feilrate siste time' });
    expect(within(rates).getByText('0,4 %')).toBeTruthy();
    expect(within(rates).getAllByText('Normalt')).toHaveLength(2);
    expect(screen.getByText(/Ingenting rapporterer hendelser hit ennå/)).toBeTruthy();
    expect(screen.getByText('Ingen. Alle planlagte innlesinger gikk bra sist.')).toBeTruthy();
    expect(
      screen.getByText(/Hentet fra plattformen i dag kl\. .*Oppdateres hvert minutt\./),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /svarer/ })).toBeNull();
  });

  it('raises a warning when a part is slow and a danger alert when it is down', async () => {
    const { fetch } = serve((path) =>
      path === '/api/operator/operations'
        ? json(
            overview([
              { name: 'API', status: 'normal' },
              { name: 'Database', status: 'down', note: 'Svarer ikke.' },
              { name: 'Kjøringer', status: 'degraded', errorRate: '3,8 %' },
            ]),
          )
        : undefined,
    );
    await open('#/operations', fetch);

    const down = await screen.findByRole('heading', { name: 'Database svarer ikke' });
    expect(down.closest('[data-color]')?.getAttribute('data-color')).toBe('danger');
    const slow = screen.getByRole('heading', { name: 'Kjøringer svarer tregt' });
    expect(slow.closest('[data-color]')?.getAttribute('data-color')).toBe('warning');
    expect(screen.getByText('Feilraten siste time er 3,8 %.')).toBeTruthy();
    const endpoints = screen.getByRole('region', { name: 'Database og modellendepunkter' });
    expect(within(endpoints).getByText('Nede')).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Feilrate siste time' })).getByText('Høyt'),
    ).toBeTruthy();
  });
});

const detail = (status: string, scores: [string, number, number | null][]) => ({
  id: 'run-1',
  model: 'NorLlama-70B 0.9',
  current: 'Borealis-27B 2.1',
  status,
  startedAt: '2026-10-08T10:00:00Z',
  endedAt: status === 'succeeded' ? '2026-10-08T10:20:00Z' : null,
  estimatedCostNok: 4.2,
  costNok: status === 'succeeded' ? 4.31 : 1.05,
  testSets: scores.length,
  done: scores.filter((s) => s[2] !== null).length,
  rows: scores.map(([testSet, before, after]) => ({
    tenant: '991825827',
    service: 'rapportassistenten',
    name: 'Rapportassistenten',
    testSet,
    cases: 40,
    current: { score: before, passed: 30, total: 40 },
    candidate: after === null ? null : { score: after, passed: 30, total: 40 },
  })),
});

const startRun = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Beregn kostnad' }));
  fireEvent.change(await screen.findByRole('textbox', { name: /Begrunnelse/ }), {
    target: { value: 'Ny modell fra AIVAR, sak DIG-4500' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Kjør for omtrent 4,20 kr' }));
};

describe('kvalitetsmatrise for nye modeller', () => {
  it('shows each test set as done, running or waiting while the run goes on', async () => {
    const { fetch } = serve((path) =>
      path.startsWith('/api/operator/quality/matrix/runs/')
        ? json(
            detail('running', [
              ['Saksbehandling, bokmål', 0.84, 0.85],
              ['Nynorsk', 0.79, null],
              ['Klarspråk', 0.81, null],
            ]),
          )
        : undefined,
    );
    await open('#/quality-matrix', fetch);
    await startRun();

    const progress = await screen.findByRole('region', { name: 'Kjøringer' });
    const items = within(progress)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items).toEqual([
      'Rapportassistenten: Saksbehandling, bokmålFerdig',
      'Rapportassistenten: NynorskKjører',
      'Rapportassistenten: KlarspråkVenter',
    ]);
    expect(
      within(progress).getByText('Kostnad så langt: 1,05 kr av omtrent 4,20 kr.'),
    ).toBeTruthy();
  });

  it('refuses to release a model when a test set drops more than three points', async () => {
    const { fetch } = serve((path) =>
      path.startsWith('/api/operator/quality/matrix/runs/')
        ? json(
            detail('succeeded', [
              ['Saksbehandling, bokmål', 0.841, 0.853],
              ['Nynorsk', 0.796, 0.754],
            ]),
          )
        : undefined,
    );
    await open('#/quality-matrix', fetch);
    await startRun();

    const result = await screen.findByRole('region', { name: 'Resultat' });
    expect(within(result).getByText('+1,2')).toBeTruthy();
    expect(within(result).getByText('−4,2').getAttribute('data-color')).toBe('danger');
    expect(screen.getByRole('heading', { name: 'Modellen kan ikke slippes' })).toBeTruthy();
    expect(screen.getByText(/Testsettet «Nynorsk» falt 4,2 poeng/)).toBeTruthy();
    expect(screen.getByText('Ferdig. Kostnad: 4,31 kr, anslaget var 4,20 kr.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Slipp modellen' })).toBeNull();
  });

  it('lets the operator release the model with a reason when no test set got worse', async () => {
    const { calls, fetch } = serve((path) =>
      path.startsWith('/api/operator/quality/matrix/runs/')
        ? json(detail('succeeded', [['Saksbehandling, bokmål', 0.84, 0.85]]))
        : undefined,
    );
    await open('#/quality-matrix', fetch);
    await startRun();

    const release = await screen.findByRole('button', { name: 'Slipp modellen' });
    fireEvent.click(release);
    expect(
      await screen.findByText('Skriv en begrunnelse på minst 10 tegn. Nå er det 0.'),
    ).toBeTruthy();
    const section = screen.getByRole('region', { name: 'Slipp modellen' });
    fireEvent.change(within(section).getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Like god eller bedre i alle testsett' },
    });
    fireEvent.click(release);

    expect(await screen.findByText(/NorLlama-70B 0\.9 er sluppet/)).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/operator/quality/matrix/release')).toMatchObject({
      body: { kind: 'models', name: 'NorLlama-70B 0.9' },
      reason: 'Like god eller bedre i alle testsett',
    });
  });
});

describe('ekstern byggekloss', () => {
  it('registers a plug-in from a YAML manifest and shows it as external', async () => {
    const { calls, fetch } = serve(() => undefined);
    await open('#/building-blocks', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Registrer ekstern byggekloss' }));
    const dialog = await screen.findByRole('dialog');
    const manifest = within(dialog).getByRole('textbox', { name: 'Manifest (YAML)' });
    fireEvent.change(manifest, { target: { value: 'kind: [' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrer og test' }));
    expect(await within(dialog).findByText('Manifestet er ikke gyldig YAML.')).toBeTruthy();

    fireEvent.change(manifest, {
      target: {
        value:
          'kind: tool-source\nid: lovdata-pro\nversion: 2.0.0\ncontract: tool-source@1\ntitle: Lovdata Pro\ndataLocation: norway\n',
      },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrer og test' }));

    expect(
      await screen.findByText('Lovdata Pro 2.0.0 er registrert. Kontrakttesten kjører.'),
    ).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/operator/plugins')).toMatchObject({
      method: 'POST',
      body: {
        manifest: {
          kind: 'tool-source',
          id: 'lovdata-pro',
          version: '2.0.0',
          contract: 'tool-source@1',
          title: 'Lovdata Pro',
          dataLocation: 'norway',
        },
      },
      reason: 'Registrerte ekstern byggekloss lovdata-pro',
    });
    const row = (await screen.findByText('Lovdata Pro')).closest('button') as HTMLElement;
    expect(within(row).getByText('Ekstern')).toBeTruthy();
    expect(within(row).getByText('Norge')).toBeTruthy();
  });

  it('shows the errors the platform gives for a manifest it refuses', async () => {
    const { fetch } = serve((path, method) =>
      path === '/api/operator/plugins' && method === 'POST'
        ? json(
            {
              title: 'Invalid plug-in',
              status: 400,
              errors: [{ path: 'manifest.contract', message: 'the contract names the kind' }],
            },
            400,
          )
        : undefined,
    );
    await open('#/building-blocks', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Registrer ekstern byggekloss' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrer og test' }));
    await waitFor(() =>
      expect(
        within(dialog).getByText('manifest.contract: the contract names the kind'),
      ).toBeTruthy(),
    );
  });
});
