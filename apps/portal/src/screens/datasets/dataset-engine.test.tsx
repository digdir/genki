// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import type { DatasetDetailView, DatasetEffective } from '../../api/datasets';
import { exampleLiveDatasets } from '../../mock/datasets';
import { RightsProvider } from '../../Shell';
import { LiveDatasetDetail } from './LiveDatasetDetail';

document.getAnimations ??= () => [];
afterEach(cleanup);

const kudos = exampleLiveDatasets.find((d) => d.id === 'digdir/kudos') as DatasetDetailView;

const onSeed: DatasetEffective = {
  endpoint: 'kudos-typesense',
  engine: 'typesense',
  engineTitle: 'Typesense',
  version: 0,
  fromSeed: true,
  expected: {
    endpoint: 'kunnskapsserveren',
    engine: 'knowledge',
    engineTitle: 'Kunnskapsdatabasen',
    generation: 'g-20261116-abcdef',
    version: 4,
    at: '2026-11-17T08:22:00Z',
  },
};

const show = async (view: DatasetDetailView) => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.endsWith(`/datasets/${encodeURIComponent(view.id)}`)
      ? json(view)
      : json({ data: [] });
  };
  const api = createApiClient({ baseUrl: '/api', fetch, token: () => 'ingrid' });
  render(
    <RightsProvider value={['use-services']}>
      <LiveDatasetDetail
        api={api}
        tenant="991825827"
        tenantName="Digdir"
        id={view.id}
        tab="used-by"
      />
    </RightsProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: view.name });
};

describe('where a dataset runs, in the portal', () => {
  it('warns when the dataset runs on its seed while a saved version says otherwise', async () => {
    await show({ ...kudos, documents: 10064, effective: onSeed });

    expect(
      screen.getByRole('heading', { name: 'Kjører på standardoppsettet, ikke lagret versjon' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Søkene går nå til Typesense\. Den nyeste lagrede versjonen \(4, .+\) bruker Kunnskapsdatabasen/,
      ),
    ).toBeTruthy();
    expect(screen.getByText('Søkemotor: Typesense')).toBeTruthy();
  });

  it('shows the engine and generation without a warning when the saved version is in use', async () => {
    await show({
      ...kudos,
      effective: {
        endpoint: 'kunnskapsserveren',
        engineTitle: 'Kunnskapsdatabasen',
        generation: 'g-20261116-abcdef',
        version: 4,
        fromSeed: false,
      },
    });

    expect(
      screen.getByText('Søkemotor: Kunnskapsdatabasen · generasjon g-20261116-abcdef'),
    ).toBeTruthy();
    expect(screen.queryByText(/standardoppsettet/)).toBeNull();
  });

  it('says the count is what the search engine holds, not what was ingested', async () => {
    await show({ ...kudos, documents: 10064 });

    expect(screen.getByText(/10\s064 dokumenter i søkemotoren/)).toBeTruthy();
    expect(screen.queryByText(/Søkemotor:/)).toBeNull();
  });

  it('names a cancelled last run as such, not as a partial ingestion', async () => {
    await show({
      ...kudos,
      scope: '991825827',
      editable: true,
      lastExecution: {
        status: 'cancelled',
        startedAt: '2026-11-19T13:04:00Z',
        endedAt: '2026-11-19T13:24:00Z',
        stored: 120,
        skipped: 0,
      },
    });

    expect(screen.getByText('Siste innlesing ble avbrutt')).toBeTruthy();
    expect(screen.queryByText('Delvis lest inn')).toBeNull();
  });
});
