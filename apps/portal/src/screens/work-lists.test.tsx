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
      if (new URL(url, 'http://x').searchParams.get('origin') === 'playground')
        return json({ data: [], total: 0 });
      const service = new URL(url, 'http://x').searchParams.get('service');
      const data = service ? runs.map((r) => ({ ...r, service })) : runs;
      return json({ data, total: data.length });
    }
    if (/\/tasks\/assist1\/timeline$/.test(path))
      return json({
        id: 'assist1',
        service: 'platform/draft/assistant/def',
        serviceName: 'Byggeassistenten',
        status: 'failed',
        trigger: 'api',
        caller: 'employee',
        startedAt: '2026-10-09T08:41:00Z',
        durationSeconds: 1,
        inputTokens: 0,
        outputTokens: 0,
        costOre: 0,
        steps: [],
      });
    if (/\/tasks\/assist1$/.test(path)) return new Response('{}', { status: 404 });
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

describe('a run that belongs to no published service', () => {
  it('takes its name from the timeline, so a builder assistant run is called Byggeassistenten', async () => {
    await open('#/log/assist1');
    expect(await screen.findByText('Byggeassistenten')).toBeTruthy();
    expect(screen.queryByText('Assistant')).toBeNull();
  });
});

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

describe('the Tjenester list filters', () => {
  const withDraft = (): typeof fetch => {
    const base = platform();
    return async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/service-drafts(\?|$)/.test(url))
        return Response.json({
          data: [
            {
              id: 'utkast-1',
              name: 'Permisjonssvar',
              purpose: 'Svarer om permisjon',
              outputKind: 'answer',
              latestVersion: null,
              revision: 1,
              at: '2026-10-09T08:00:00Z',
              by: 'employee:test:kari',
              byName: 'Kari Testansatt',
            },
          ],
        });
      return base(input, init);
    };
  };
  const openList = async (hash: string, fetch: typeof globalThis.fetch = platform()) => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = hash;
    render(<App auth={auth} fetch={fetch} live />);
    await screen.findByText(/^Viser \d+ av/);
  };

  it('offers no I test filter when no service on the platform is in test', async () => {
    await openList('#/services');

    expect(screen.queryByRole('radio', { name: /^I test/ })).toBeNull();
    expect(screen.getByRole('radio', { name: /^I bruk/ })).toBeTruthy();
  });

  it('counts in Viser N av M only the services the filter covers, so archived ones are not in Alle', async () => {
    await openList('#/services');

    expect(screen.getByText('Viser 2 av 2 tjenester')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Alle 2' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Arkivert 1' })).toBeTruthy();
  });

  it('counts Alle as Oversikt counts the services: unpublished drafts and every service not archived', async () => {
    await openList('#/services', withDraft());

    expect(screen.getByRole('radio', { name: 'Alle 3' })).toBeTruthy();
  });

  it('keeps search and filter in the address, and reads them back on reload', async () => {
    await openList('#/services');

    fireEvent.click(screen.getByRole('radio', { name: /^Satt på pause/ }));
    fireEvent.change(screen.getByLabelText('Søk i tjenester'), { target: { value: 'alfa' } });
    expect(window.location.hash).toBe('#/services?status=paused&q=alfa');

    cleanup();
    await openList('#/services?status=archived');
    expect(screen.queryByText('Svar med kilder')).toBeNull();
    expect(await screen.findByText('Gamma')).toBeTruthy();
  });

  it('says a draft has no runs yet and no start chosen, instead of a dash before the unit', async () => {
    await openList('#/services', withDraft());

    const row = (await screen.findByRole('link', { name: 'Permisjonssvar' })).closest(
      'li',
    ) as HTMLElement;
    expect(within(row).getByText('Ingen kjøringer ennå')).toBeTruthy();
    expect(within(row).getByText('Ikke valgt ennå')).toBeTruthy();
    expect(within(row).queryByText(/–/)).toBeNull();
  });
});

describe('pausing and archiving from the service page', () => {
  it('hides archived services from Tjenester until the Arkivert filter is chosen', async () => {
    await open('#/services');

    await screen.findByText('Svar med kilder');
    expect(screen.queryByText('Gamma')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /^Arkivert/ }));

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

    fireEvent.click(await screen.findByRole('button', { name: 'Mer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sett på pause', hidden: true }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sett på pause' }));
    expect(reasons).toEqual([]);
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Venter på ny modell' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sett på pause' }));

    await waitFor(() => expect(reasons).toEqual(['Venter på ny modell']));
    expect(await screen.findByText('Tjenesten er på pause.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start igjen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Arkiver', hidden: true })).toBeTruthy();
  });

  it('offers restore for an archived service and names the actions in English', async () => {
    await open('#/services/rapportassistenten', ['en']);

    fireEvent.click(await screen.findByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive', hidden: true }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Replaced by a new service' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));

    expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
  });
});

describe('Mer on the service page', () => {
  it('opens Kjør på mange dokumenter as a dialog over the service page', async () => {
    await open('#/services/rapportassistenten');

    fireEvent.click(await screen.findByRole('button', { name: 'Mer' }));
    const menu = screen.getByRole('button', { name: 'Mer' }).parentElement as HTMLElement;
    fireEvent.click(
      within(menu).getByRole('button', { name: 'Kjør på mange dokumenter', hidden: true }),
    );

    expect(await screen.findByRole('dialog', { name: 'Kjør på mange dokumenter' })).toBeTruthy();
    expect(window.location.hash).toBe('#/services/rapportassistenten');
  });
});

describe('an archived service', () => {
  it('reads as archived only, with a read-only banner, the read-only tabs and no publishing', async () => {
    await open('#/services/rapportassistenten');

    fireEvent.click(await screen.findByRole('button', { name: 'Mer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Arkiver', hidden: true }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Erstattet av en ny tjeneste' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arkiver' }));

    expect(await screen.findByText('Tjenesten er arkivert og kan bare leses.')).toBeTruthy();
    const header = screen.getByRole('banner');
    expect(within(header).getByText('Arkivert')).toBeTruthy();
    expect(within(header).queryByText('I bruk')).toBeNull();
    expect(within(header).queryByRole('button', { name: 'Publiser' })).toBeNull();
    expect(within(header).queryByRole('button', { name: 'Sett på pause' })).toBeNull();
    const tabs = screen.getByRole('tablist', { name: /^Faner for/ });
    expect(within(tabs).queryByRole('tab', { name: 'Oppsett' })).toBeNull();
    expect(within(tabs).getByRole('tab', { name: 'Utviklerverktøy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gjenopprett' })).toBeTruthy();
  });
});

describe('an archived service opened at an editing address', () => {
  const archivedFetch = (): typeof fetch => {
    const base = platform();
    return async (input, init) =>
      String(input).endsWith('/services/rapportassistenten/lifecycle') && !init?.method
        ? Response.json({ state: 'archived', reason: 'Erstattet av en ny tjeneste' })
        : base(input, init);
  };

  it.each(['settings', 'channels', 'interface', 'batch'])(
    'shows Oversikt and no editable form at #/services/<id>/%s',
    async (section) => {
      const auth = mockAnsattporten(kari);
      await auth.login();
      window.location.hash = `#/services/rapportassistenten/${section}`;
      render(<App auth={auth} fetch={archivedFetch()} live />);

      await screen.findByText('Tjenesten er arkivert og kan bare leses.');
      const tabs = screen.getByRole('tablist', { name: /^Faner for/ });
      expect(
        within(tabs).getByRole('tab', { name: 'Oversikt' }).getAttribute('aria-selected'),
      ).toBe('true');
      const main = screen.getByRole('main');
      expect(within(main).queryAllByRole('textbox')).toEqual([]);
      expect(within(main).queryAllByRole('combobox')).toEqual([]);
      expect(within(main).queryByRole('button', { name: /^Lagre/ })).toBeNull();
    },
  );

  it('moves the address to Oversikt, the section it shows', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten/settings';
    render(<App auth={auth} fetch={archivedFetch()} live />);

    await screen.findByText('Tjenesten er arkivert og kan bare leses.');
    await waitFor(() => expect(window.location.hash).toBe('#/services/rapportassistenten'));
  });
});

describe('Service header in live mode', () => {
  const openService = async (lifecycle: unknown, publishedByName?: string) => {
    const base = platform();
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten';
    render(
      <App
        auth={auth}
        live
        fetch={async (input, init) => {
          const path = String(input).split('?')[0] ?? '';
          if (!init?.method && path.endsWith('/services/rapportassistenten/lifecycle'))
            return new Response(JSON.stringify(lifecycle), {
              headers: { 'content-type': 'application/json' },
            });
          const response = await base(input, init);
          if (!publishedByName || !path.endsWith('/definitions/services/rapportassistenten'))
            return response;
          const body = (await response.json()) as { latest: Record<string, unknown> };
          return new Response(
            JSON.stringify({ ...body, latest: { ...body.latest, publishedByName } }),
            { headers: { 'content-type': 'application/json' } },
          );
        }}
      />,
    );
    return (await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' })).closest(
      'header',
    ) as HTMLElement;
  };

  it('shows a paused service as Satt på pause, not I bruk', async () => {
    const title = await openService({ state: 'paused', reason: 'Venter på ny modell' });

    await waitFor(() => expect(within(title).getByText('Satt på pause')).toBeTruthy());
    expect(within(title).queryByText('I bruk')).toBeNull();
  });

  it('shows an archived service as Arkivert, not I bruk', async () => {
    const title = await openService({ state: 'archived' });

    await waitFor(() => expect(within(title).getByText('Arkivert')).toBeTruthy());
    expect(within(title).queryByText('I bruk')).toBeNull();
  });

  it('keeps only the version tag in the header and names who published it on Oversikt', async () => {
    const title = await openService({ state: 'active' }, 'Kari Nordmann');

    await waitFor(() => expect(within(title).getByText(/^Versjon \d+ i bruk$/)).toBeTruthy());
    expect(title.textContent).not.toContain('publisert');
    expect(await screen.findByText(/^Versjon \d+, publisert .+ av Kari Nordmann$/)).toBeTruthy();
  });
});

describe('Oversikt in live mode', () => {
  it('lists own datasets whose last ingestion failed or was cancelled under what needs you', async () => {
    await open('#/overview');

    const section = await screen.findByRole('region', { name: 'Trenger deg nå' });
    await within(section).findByText('stopp');

    expect(within(section).getByText('avbrutt')).toBeTruthy();
    expect(within(section).queryByText('ok')).toBeNull();
    expect(within(section).queryByText('delt')).toBeNull();
    expect(within(section).queryByText('pagar')).toBeNull();
    expect(within(section).getByText('Feilet')).toBeTruthy();
    expect(within(section).getByText('Avbrutt')).toBeTruthy();
  });
});

describe('Logg in live mode', () => {
  it('lists runs by service and question instead of by task id', async () => {
    await open('#/log');

    const table = await screen.findByRole('table', { name: 'Kjøringer' });
    const first = await within(table).findByRole('link', {
      name: 'Kunnskapsassistenten: Hva er fristen for å søke?',
    });

    expect(first.textContent).not.toContain('0f4c9745');
    expect(within(table).getAllByText('0,36 kr')).toHaveLength(2);
  });

  it('shows run status in English on an English screen', async () => {
    await open('#/log', ['en']);

    const table = await screen.findByRole('table', { name: 'Runs' });
    await within(table).findByText('Completed');

    expect(within(table).getByText('Failed')).toBeTruthy();
    expect(within(table).queryByText('Fullført')).toBeNull();
  });

  it('shows the run head with the service name, question and person, not the capability id or "api · employee"', async () => {
    await open('#/log/0f4c9745-a123-4060-9062-9b0ced7e2fd6');

    await screen.findByText(/Kari Testansatt/);
    const heading = screen.getByRole('heading', { level: 1 });

    expect(heading.textContent).toBe('Kunnskapsassistenten: Hva er fristen for å søke?');
    expect(document.body.textContent).toContain('Startet av Kari Testansatt');
    expect(document.body.textContent).not.toContain('api · employee');
    expect(document.body.textContent).toMatch(/0,36\skr/);
    expect(document.body.textContent).not.toContain('991825827/kunnskapsassistenten/default');
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
