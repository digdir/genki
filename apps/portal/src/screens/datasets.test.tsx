// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatasetDetailView } from '../api/datasets';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import { expectAccessible, failingFetch, kari, renderAt } from '../test-utils';

const openList = async (fetch?: typeof globalThis.fetch) => {
  await renderAt('#/datasets', fetch);
  await screen.findByRole('heading', { level: 1, name: 'Datasett' });
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const sharedExternal: DatasetDetailView = {
  id: 'kudos',
  fullId: 'digdir/kudos',
  name: 'Kudos',
  scope: 'platform',
  editable: false,
  source: 'kudos',
  state: 'external',
  documents: 10064,
  chunks: null,
  lastExecution: null,
  nextRunAt: null,
};

const renderLive = async (path: string) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = path;
  render(
    <App
      auth={auth}
      fetch={mockFetch(undefined, undefined, undefined, undefined, {
        features: { datasets: { datasets: [sharedExternal] } },
      })}
      live
    />,
  );
};

describe('Datasett: delte datasett lest inn utenfor plattformen', () => {
  it('lists a dataset shared with the organisation under the shared filter and not under its own', async () => {
    await renderLive('#/datasets');
    await screen.findByRole('link', { name: 'Kudos' });
    fireEvent.click(screen.getByRole('button', { name: 'Delt med dere' }));
    expect(screen.getByText('Viser 1 av 1 datasett')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Testetatens egne' }));
    expect(screen.getByText('Viser 0 av 1 datasett')).toBeTruthy();
  });

  it('does not tell the overview there are no datasets when only shared ones exist', async () => {
    await renderLive('#/overview');
    await screen.findByRole('heading', { level: 1, name: 'Oversikt' });
    await screen.findByRole('region', { name: 'Trenger deg nå' });
    await waitFor(() => expect(screen.queryByLabelText('Sjekker hva som trenger deg')).toBeNull());
    expect(screen.queryByText(/Vi fikk ikke sjekket datasettene/)).toBeNull();
  });
});

describe('Datasett in the mock: the live screens users get', () => {
  it('lists the datasets from the tenant dataset API', async () => {
    await openList();
    const table = screen.getByRole('table', { name: 'Datasett' });
    const kudosRow = within(table)
      .getByRole('link', { name: 'Kudos-rapporter' })
      .closest('tr') as HTMLElement;
    expect(within(kudosRow).getByText('48 312')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Veiledere og rundskriv' })).toBeTruthy();
    expectAccessible();
  });

  it('links to detail pages with the slash in the id encoded', async () => {
    await openList();
    expect(screen.getByRole('link', { name: 'Kudos-rapporter' }).getAttribute('href')).toBe(
      '#/datasets/digdir%2Fkudos',
    );
  });

  it('offers no example wizard, OCR or linked-PDF controls', async () => {
    await renderAt('#/datasets/new');
    await screen.findByRole('heading', { level: 1, name: 'Nytt datasett' });
    expect(screen.queryByText(/Velg kilde/)).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /tekstgjenkjenning|PDF/i })).toBeNull();
  });

  it('shows the Innhold and Brukes av tabs on a dataset', async () => {
    await renderAt(`#/datasets/${encodeURIComponent('999888777/veiledere')}`);
    await screen.findByRole('heading', { level: 1, name: 'Veiledere og rundskriv' });
    expect(screen.getByRole('tab', { name: 'Innhold' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Brukes av' })).toBeTruthy();
  });

  it('shows an empty state when there are no datasets', async () => {
    await openList(
      mockFetch(undefined, undefined, undefined, undefined, {
        features: { datasets: { datasets: [] } },
      }),
    );
    expect(screen.getByText('Ingen datasett ennå')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nytt datasett' }));
    expect(window.location.hash).toBe('#/datasets/new');
  });

  it('shows an error with retry when the list cannot be loaded', async () => {
    await renderAt('#/datasets', failingFetch(/\/tenants\/[^/]+\/datasets$/));
    expect(await screen.findByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Datasett' })).toBeTruthy();
  });

  it('says the dataset was not found for an unknown id', async () => {
    await renderAt(`#/datasets/${encodeURIComponent('999888777/ukjent')}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fant ikke datasettet' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gå til Datasett' })).toBeTruthy();
  });
});
