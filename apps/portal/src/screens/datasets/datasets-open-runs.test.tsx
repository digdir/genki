// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import type { DatasetDetailView, ExecutionStatus, ExecutionView } from '../../api/datasets';
import { mockAnsattporten } from '../../auth';
import { exampleOrganisations, mockFetch, type FeatureMockOptions } from '../../mock';
import { exampleLiveDatasets } from '../../mock/datasets';
import { LeaveDialog } from './DatasetSettings';
import { CancelDialog } from './Ingestions';
import { pollMs } from './LiveDatasetDetail';

document.getAnimations ??= () => [];
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
  vi.useRealTimers();
  cleanup();
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const recorded = (
  datasets: FeatureMockOptions['datasets'] = {},
  answer?: (url: string, method: string) => Response | undefined,
) => {
  const calls: Call[] = [];
  const base = mockFetch(undefined, undefined, undefined, undefined, { features: { datasets } });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return answer?.(url, method) ?? base(input, init);
  };
  return { calls, fetch };
};

const renderLive = async (path: string, fetch: typeof globalThis.fetch) => {
  const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
  await auth.login();
  window.location.hash = path;
  return render(<App auth={auth} fetch={fetch} live />);
};

const veiledere = `#/datasets/${encodeURIComponent('999888777/veiledere')}`;

const openRun = (status: ExecutionStatus): ExecutionView => ({
  id: `ex-${status}`,
  status,
  startedAt: '2026-11-18T05:00:00Z',
});

const withOpenRun = (status: ExecutionStatus): FeatureMockOptions['datasets'] => ({
  datasets: exampleLiveDatasets.map((d) =>
    d.fullId === '999888777/veiledere'
      ? {
          ...d,
          lastExecution: {
            status,
            startedAt: '2026-11-18T05:00:00Z',
            endedAt: null,
            stored: null,
            skipped: null,
          },
        }
      : d,
  ),
  executions: { '999888777/veiledere/upload': [openRun(status)] },
});

describe('an open ingestion run on the dataset page', () => {
  it.each([
    ['queued', 'I kø', /står i kø/],
    ['waiting', 'Venter', /Ingenting er endret ennå/],
  ] as const)('shows a %s run as open, never as finished', async (status, label, banner) => {
    const { fetch } = recorded(withOpenRun(status));
    await renderLive(`${veiledere}/ingestions`, fetch);
    const runs = await screen.findByRole('list', { name: 'Innlesinger' });

    expect(within(runs).getByText(label)).toBeTruthy();
    expect(within(runs).queryByText('Fullført')).toBeNull();
    expect(document.querySelector('.page-head')?.textContent).toContain(label);
    expect(screen.getByText(banner)).toBeTruthy();
    expect(within(runs).getByRole('button', { name: 'Avbryt innlesingen' })).toBeTruthy();
  });

  it.each(['queued', 'waiting'] as const)('keeps polling a %s run', async (status) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls, fetch } = recorded(withOpenRun(status));
    await renderLive(`${veiledere}/ingestions`, fetch);
    await screen.findByRole('list', { name: 'Innlesinger' });
    const polls = () => calls.filter((c) => c.url.endsWith('/pipelines/upload/executions')).length;
    const before = polls();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(pollMs * 2 + 100);
    });

    expect(polls()).toBeGreaterThan(before);
  });

  it('cancels a queued run through the cancel route', async () => {
    const { calls, fetch } = recorded(withOpenRun('queued'));
    await renderLive(`${veiledere}/ingestions`, fetch);
    const runs = await screen.findByRole('list', { name: 'Innlesinger' });
    fireEvent.click(within(runs).getByRole('button', { name: 'Avbryt innlesingen' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Avbryt innlesingen' }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'POST' && c.url.endsWith('/pipelines/upload/executions/ex-queued/cancel'),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText('Avbrutt')).toBeTruthy();
  });
});

const noDescription: DatasetDetailView = {
  ...(exampleLiveDatasets.find((d) => d.fullId === '999888777/veiledere') as DatasetDetailView),
  id: 'notater',
  fullId: '999888777/notater',
  name: 'Notater',
};
delete noDescription.description;

describe('saving the settings of a dataset made in the portal', () => {
  const save = async (fetch: typeof globalThis.fetch) => {
    await renderLive(`#/datasets/${encodeURIComponent(noDescription.fullId)}/source`, fetch);
    fireEvent.change(await screen.findByLabelText('Navn'), { target: { value: 'Møtenotater' } });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Tydeligere navn' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endringene' }));
  };

  it('saves a dataset without a description, leaving the description out', async () => {
    const { calls, fetch } = recorded({ datasets: [...exampleLiveDatasets, noDescription] });
    await save(fetch);

    expect(await screen.findByText(/^Lagret kl\./)).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ name: 'Møtenotater' });
  });

  it('shows a refused field in our words, never the API validation text', async () => {
    const { fetch } = recorded({ datasets: [...exampleLiveDatasets, noDescription] }, (_, m) =>
      m === 'PUT'
        ? Response.json(
            {
              title: 'Invalid request',
              status: 400,
              errors: [
                { path: 'name', message: 'Too small: expected string to have >=1 characters' },
              ],
            },
            { status: 400 },
          )
        : undefined,
    );
    await save(fetch);

    expect(await screen.findByText(/Dette ble ikke godtatt: Navn\./)).toBeTruthy();
    expect(screen.queryByText(/Too small/)).toBeNull();
  });

  it('does not send an emptied description, which the API cannot clear yet', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${veiledere}/source`, fetch);
    fireEvent.change(await screen.findByLabelText('Beskrivelse'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), { target: { value: 'Ikke nødvendig' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endringene' }));

    expect(await screen.findAllByText(/Beskrivelsen kan ikke tømmes ennå/)).not.toHaveLength(0);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });
});

const ownEndpoint: DatasetDetailView = {
  id: 'saksarkivet',
  fullId: '999888777/saksarkivet',
  name: 'Saksarkivet',
  scope: '999888777',
  editable: true,
  residency: 'global',
  index: { endpoint: '999888777/endpoint-saksarkivet' },
  facets: [],
  searchScope: 'tenant',
  source: 'endpoint',
  state: 'external',
  documents: null,
  chunks: null,
  lastExecution: null,
  nextRunAt: null,
  usedBy: [],
};

describe("an organisation's own endpoint dataset page", () => {
  it('is its own endpoint and explains why Innhold has no list, without asking for one', async () => {
    const { calls, fetch } = recorded({ datasets: [...exampleLiveDatasets, ownEndpoint] });
    await renderLive(`#/datasets/${encodeURIComponent(ownEndpoint.fullId)}`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Saksarkivet' });

    const head = document.querySelector('.page-head')?.textContent ?? '';
    expect(head).toContain('Eget endepunkt');
    expect(head).toContain('Søkes direkte');
    expect(head).not.toContain('Delt');
    expect(head).not.toContain('endpoint-saksarkivet');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Dokumentene ligger hos dere' }),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls.some((c) => c.url.includes('/documents'))).toBe(false);
  });
});

describe('dataset dialogs in English', () => {
  it.each([
    [
      'cancel run',
      <CancelDialog
        key="c"
        run={openRun('running')}
        onKeep={() => undefined}
        onCancel={() => undefined}
      />,
    ],
    ['leave', <LeaveDialog key="l" onLeave={() => undefined} onStay={() => undefined} />],
  ])('labels the close button of the %s dialog in English', (_, dialog) => {
    render(inEnglish(dialog));

    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lukk dialogvindu' })).toBeNull();
  });
});

describe('who started an ingestion', () => {
  it('names the person, never the raw id, when the API gives a name', async () => {
    const { fetch } = recorded();
    await renderLive(`#/datasets/${encodeURIComponent('999888777/nettsider')}/ingestions`, fetch);
    const table = await screen.findByRole('table', { name: 'Innlesinger' });

    expect(within(table).getAllByText('Kari Nordmann').length).toBeGreaterThan(0);
    expect(within(table).queryByText('kari.nordmann@testetaten.example.no')).toBeNull();
  });
});

describe('a dataset with an open run on Oversikt', () => {
  it('counts a queued run as still reading in, never as a finished partial ingestion', async () => {
    const queued = withOpenRun('queued');
    const datasets = (queued?.datasets ?? []).map((d) =>
      d.fullId === '999888777/veiledere' && d.lastExecution
        ? { ...d, lastExecution: { ...d.lastExecution, stored: 6, skipped: 2 } }
        : d,
    );
    const { fetch } = recorded({ ...queued, datasets });
    await renderLive('#/overview', fetch);
    const attention = await screen.findByRole('region', { name: 'Trenger deg nå' });

    await waitFor(() => expect(screen.queryByLabelText('Sjekker hva som trenger deg')).toBeNull());
    expect(within(attention).queryByText('Delvis')).toBeNull();
    expect(within(attention).queryByText(/2 av 8 dokumenter kunne ikke leses/)).toBeNull();
  });
});
