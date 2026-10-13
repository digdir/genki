// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import { kari } from '../test-utils';

const used = { inputTokens: 1000, outputTokens: 200, requests: 1, costMicroNok: 360_000 };

const runs = [
  {
    id: '0f4c9745-a123-4060-9062-9b0ced7e2fd6',
    status: 'completed',
    service: 'kunnskapsassistenten',
    serviceName: 'Kunnskapsassistenten',
    excerpt: 'Hva er fristen for å søke?',
    actor: { kind: 'person', name: 'Kari Testansatt' },
    capability: '991825827/kunnskapsassistenten/default',
    createdAt: '2026-10-09T08:41:00Z',
    endedAt: '2026-10-09T08:42:00Z',
    usage: used,
  },
  {
    id: '5d5dc10c-ecdd-4ed0-8e21-e866ca60760c',
    status: 'failed',
    service: 'kunnskapsassistenten',
    serviceName: 'Kunnskapsassistenten',
    actor: { kind: 'api-key', name: 'Fagsystemet' },
    capability: '991825827/kunnskapsassistenten/default',
    createdAt: '2026-10-08T21:23:00Z',
    endedAt: '2026-10-08T21:24:00Z',
    usage: used,
  },
];

const summaries = [
  {
    id: 'kunnskapsassistenten',
    name: 'Kunnskapsassistenten',
    purpose: 'Svar med kilder',
    outputKind: 'answer',
    channels: ['api', 'mcp'],
    latestVersion: 3,
    status: 'active',
    statusReason: null,
    lifecycle: 'active',
    updatedAt: '2026-10-09T04:08:00Z',
    updatedBy: 'employee:test:kari',
    updatedByName: 'Kari Testansatt',
    runsThisWeek: 12,
  },
  {
    id: 'alfa',
    name: 'Alfa',
    purpose: 'Svarer på alt',
    outputKind: 'answer',
    channels: [],
    latestVersion: 1,
    status: 'paused',
    statusReason: 'Modellen er tatt ut av bruk',
    lifecycle: 'paused',
    updatedAt: '2026-10-01T10:00:00Z',
    updatedBy: 'platform:seed',
    runsThisWeek: 0,
  },
  {
    id: 'gamma',
    name: 'Gamma',
    purpose: 'Utgått',
    outputKind: 'answer',
    channels: [],
    latestVersion: 1,
    status: 'active',
    statusReason: null,
    lifecycle: 'archived',
    updatedAt: '2026-09-01T10:00:00Z',
    updatedBy: 'platform:seed',
    runsThisWeek: 0,
  },
];

const dataset = (id: string, patch: Record<string, unknown>) => ({
  id,
  fullId: `991825827/${id}`,
  name: id,
  editable: true,
  source: 'website',
  documents: 10,
  chunks: 100,
  lastExecution: null,
  nextRunAt: null,
  ...patch,
});

const execution = (status: string) => ({
  status,
  startedAt: '2026-10-09T06:00:00Z',
  endedAt: null,
  stored: 1,
  skipped: 0,
});

const platform = (calls: string[] = []): typeof fetch => {
  const base = mockFetch();
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = (url.replace(/^(\/api)+/, '').split('?')[0] ?? '').replace(/\/$/, '');
    calls.push(path);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (/^\/tenants\/[^/]+\/services$/.test(path)) return json({ data: summaries });
    if (/^\/tenants\/[^/]+\/tasks$/.test(path)) {
      const service = new URL(url, 'http://x').searchParams.get('service');
      const data = service ? runs.map((r) => ({ ...r, service })) : runs;
      return json({ data, total: data.length });
    }
    if (/\/tasks\/[^/]+\/timeline$/.test(path))
      return json({
        id: runs[0]?.id,
        service: '991825827/kunnskapsassistenten/default',
        status: 'completed',
        trigger: 'api',
        caller: 'employee',
        startedAt: '2026-10-09T08:41:00Z',
        durationSeconds: 60,
        inputTokens: 1000,
        outputTokens: 200,
        costOre: 0,
        steps: [],
      });
    const one = /^\/tenants\/[^/]+\/tasks\/([^/]+)$/.exec(path);
    if (one) return json(runs.find((r) => r.id === one[1]) ?? runs[0]);
    if (/^\/tenants\/[^/]+\/datasets$/.test(path))
      return json({
        data: [
          dataset('stopp', { state: 'degraded', lastExecution: execution('failed') }),
          dataset('avbrutt', { state: 'configured', lastExecution: execution('cancelled') }),
          dataset('pagar', { state: 'running', lastExecution: execution('running') }),
          dataset('ok', { state: 'ready', lastExecution: execution('succeeded') }),
          dataset('delt', {
            fullId: '999888777/delt',
            editable: false,
            state: 'degraded',
            lastExecution: execution('failed'),
          }),
        ],
      });
    return base(input, init);
  };
};

const open = async (hash: string, languages: string[] = ['nb'], calls: string[] = []) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = hash;
  render(<App auth={auth} fetch={platform(calls)} live languages={languages} />);
};

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
afterEach(cleanup);

describe('Tjenester in live mode', () => {
  it('reads the whole list from one summary call, in the order the platform gives it', async () => {
    const calls: string[] = [];
    await open('#/services', ['nb'], calls);

    await screen.findByText('Svar med kilder');
    const list = document.querySelector('.services-rows') as HTMLElement;
    const names = Array.from(list.querySelectorAll('.services-name')).map((a) => a.textContent);

    expect(names).toEqual(['Kunnskapsassistenten', 'Alfa']);
    expect(calls.filter((c) => /\/services$/.test(c))).toHaveLength(1);
    expect(calls.filter((c) => /\/definitions\/services\//.test(c))).toEqual([]);
    expect(calls.filter((c) => /\/tasks$/.test(c))).toEqual([]);
    expect(within(list).getByText('Satt på pause')).toBeTruthy();
    expect(within(list).getByText('12')).toBeTruthy();
  });
});

describe('pausing and archiving from the service page', () => {
  it('hides archived services from Tjenester until the Arkivert filter is chosen', async () => {
    await open('#/services');

    await screen.findByText('Svar med kilder');
    expect(screen.queryByText('Gamma')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Arkivert' }));

    expect(await screen.findByText('Gamma')).toBeTruthy();
    expect(screen.queryByText('Kunnskapsassistenten')).toBeNull();
  });

  it('asks for a reason of at least ten characters, sends it, and shows the service as paused', async () => {
    const calls: string[] = [];
    const base = platform(calls);
    const reasons: string[] = [];
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten';
    render(
      <App
        auth={auth}
        live
        fetch={async (input, init) => {
          const headers = new Headers(init?.headers);
          if (init?.method === 'PUT' && String(input).endsWith('/lifecycle'))
            reasons.push(decodeURIComponent(headers.get('change-reason') ?? ''));
          return base(input, init);
        }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Sett på pause' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sett på pause' }));
    expect(reasons).toEqual([]);
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Venter på ny modell' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sett på pause' }));

    await waitFor(() => expect(reasons).toEqual(['Venter på ny modell']));
    expect(await screen.findByRole('button', { name: 'Ta i bruk igjen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Arkiver' })).toBeTruthy();
  });

  it('offers restore for an archived service and names the actions in English', async () => {
    await open('#/services/rapportassistenten', ['en']);

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Replaced by a new service' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));

    expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
  });
});

describe('Oversikt in live mode', () => {
  it('lists own datasets whose last ingestion failed or was cancelled, and counts running ones', async () => {
    await open('#/overview');

    const section = (
      await screen.findByRole('heading', { name: 'Innlesinger som trenger oppfølging' })
    ).closest('section') as HTMLElement;
    await within(section).findByText('stopp');

    expect(within(section).getByText('avbrutt')).toBeTruthy();
    expect(within(section).queryByText('ok')).toBeNull();
    expect(within(section).queryByText('delt')).toBeNull();
    expect(within(section).queryByText('pagar')).toBeNull();
    expect(within(section).getByText('1 innlesing pågår')).toBeTruthy();
    expect(within(section).getByText('Feilet')).toBeTruthy();
    expect(within(section).getByText('Avbrutt')).toBeTruthy();
  });
});

describe('Logg in live mode', () => {
  it('lists runs by service, question and person instead of by task id', async () => {
    await open('#/log');

    const list = await screen.findByRole('region', { name: 'Siste kjøringer' });
    const first = await within(list).findByRole('link', { name: /Hva er fristen for å søke/ });

    expect(within(first).getByText('Kunnskapsassistenten')).toBeTruthy();
    expect(first.textContent).toContain('Kari Testansatt');
    expect(first.textContent).not.toContain('0f4c9745');
    expect(within(list).getByText(/API-nøkkel Fagsystemet/)).toBeTruthy();
  });

  it('shows run status and the key of an API run in English on an English screen', async () => {
    await open('#/log', ['en']);

    const list = await screen.findByRole('region', { name: 'Latest runs' });
    await within(list).findByText(/API key Fagsystemet/);

    expect(within(list).getByText('Completed')).toBeTruthy();
    expect(within(list).getByText('Failed')).toBeTruthy();
    expect(within(list).queryByText('Fullført')).toBeNull();
  });

  it('shows the run head with the service name and person, not the capability id or "api · employee"', async () => {
    await open('#/log/0f4c9745-a123-4060-9062-9b0ced7e2fd6');

    const heading = await screen.findByRole('heading', { level: 2, name: 'Kunnskapsassistenten' });
    const head = heading.closest('.log-run-head') as HTMLElement;

    expect(head.textContent).toContain('Kari Testansatt');
    expect(head.textContent).toContain('Hva er fristen for å søke?');
    expect(head.textContent).not.toContain('api · employee');
    expect(document.body.textContent).toContain('36 øre');
    expect(head.textContent).not.toContain('991825827/kunnskapsassistenten/default');
  });

  it('translates run status on the service Logg tab in English', async () => {
    await open('#/services/rapportassistenten/log', ['en']);

    const table = await screen.findByRole('table');

    expect(within(table).getByText('Completed')).toBeTruthy();
    expect(within(table).getByText('Failed')).toBeTruthy();
    expect(within(table).getByText('Hva er fristen for å søke?')).toBeTruthy();
    expect(within(table).queryByText('Fullført')).toBeNull();
  });
});

describe('service draft in the portal client', () => {
  it('reads a draft answer of null as no draft without an error', async () => {
    const { createApiClient } = await import('../api');
    const api = createApiClient({
      baseUrl: '',
      token: () => 'kari',
      fetch: async () =>
        new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
    });

    await expect(api.quality.draft('991825827', 'kunnskapsassistenten')).resolves.toBeUndefined();
  });
});
