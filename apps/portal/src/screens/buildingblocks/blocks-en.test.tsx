// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient, ApiContext } from '../../api';
import { blocksApi } from '../../api/blocks';
import type { CatalogItem } from '../../api/building-blocks';
import { exampleBlocks, exampleProposal } from '../../data/building-blocks';
import { RightsProvider } from '../../Shell';
import { BlockDetail } from './BlockDetail';
import { BlocksOverview } from './BlocksOverview';
import { initialFilters, TypeList } from './BlockList';
import { MappingTable, ProposalSection } from './ProposalSection';

afterEach(cleanup);

const api = {
  buildingBlocks: { path: () => '/x', proposalsPath: () => '/y' },
  blocks: { models: async () => [], toolConnections: async () => [] },
  skills: { list: async () => [] },
} as unknown as ApiClient;

const borealis = exampleBlocks.find((b) => b.id === 'aivar/borealis-27b') as CatalogItem;

describe('building blocks in English', () => {
  it('shows the overview by type in English, with counts and the places that have their own home', () => {
    render(
      inEnglish(
        <RightsProvider value={['manage-services', 'register-building-blocks']}>
          <BlocksOverview
            api={api}
            tenant="t"
            tenantName="Testetaten"
            items={exampleBlocks}
            proposals={[]}
            q=""
            onQuery={() => undefined}
          />
        </RightsProvider>,
      ),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Building blocks' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Register a building block' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Types' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Models/ }).textContent).toMatch(/\d+ in use/);
    expect(screen.getByRole('link', { name: /^Step flows/ }).textContent).toContain(
      'Opens in Developer tools, Step flows',
    );
  });

  it('describes a row in English', () => {
    render(
      inEnglish(
        <RightsProvider value={['manage-services']}>
          <TypeList
            api={api}
            tenant="t"
            tenantName="Testetaten"
            type="model"
            items={[borealis]}
            proposals={[]}
            filters={initialFilters}
            onFilters={() => undefined}
            onFlash={() => undefined}
          />
        </RightsProvider>,
      ),
    );
    expect(screen.getByText('Update available')).toBeTruthy();
    expect(screen.getByText('Used in 5 services')).toBeTruthy();
  });

  it('shows the detail page with English sections and a short date', () => {
    render(
      inEnglish(
        <RightsProvider value={['manage-services']}>
          <BlockDetail
            api={api}
            tenant="t"
            tenantName="Testetaten"
            item={borealis}
            services={[]}
            versions={{ ok: true, data: [] }}
            tab="about"
            onRetry={() => undefined}
            onChanged={() => undefined}
          />
        </RightsProvider>,
      ),
    );
    expect(screen.getByRole('heading', { name: 'What it is good at' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Where data is processed' })).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: /^Version 2\.2, available from \d+ Oct$/ }),
    ).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Versions' })).toBeTruthy();
  });

  it('shows the price and the request for approval of a model the organisation must ask for', async () => {
    const gpt41 = exampleBlocks.find((b) => b.id === 'gpt41') as CatalogItem;
    const ctx = {
      tenantPath: (tenant: string) => `/tenants/${tenant}`,
      get: async (path: string) =>
        path === '/models?all=true'
          ? {
              data: [
                {
                  id: 'gpt41',
                  price: { inputPerThousand: 0.02, outputPerThousand: 0.08 },
                  available: false,
                  reason: 'requires_approval',
                },
              ],
            }
          : { data: [] },
    } as unknown as ApiContext;
    render(
      inEnglish(
        <RightsProvider value={['manage-services']}>
          <BlockDetail
            api={{ ...api, blocks: blocksApi(ctx) } as unknown as ApiClient}
            tenant="t"
            tenantName="Testetaten"
            item={gpt41}
            services={[]}
            versions={{ ok: true, data: [] }}
            tab="about"
            onRetry={() => undefined}
            onChanged={() => undefined}
          />
        </RightsProvider>,
      ),
    );

    expect(await screen.findByText('NOK 0.02 per 1,000 tokens')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Request approval' }).length).toBeGreaterThan(0);
  });

  it('shows a read-only notice naming the right in English', () => {
    render(
      inEnglish(
        <RightsProvider value={['use-services']}>
          <BlockDetail
            api={api}
            tenant="t"
            tenantName="Testetaten"
            item={borealis}
            services={[]}
            versions={{ ok: true, data: [] }}
            tab="about"
            onRetry={() => undefined}
            onChanged={() => undefined}
          />
        </RightsProvider>,
      ),
    );
    expect(screen.getByText(/You can see the building block but not change it/)).toBeTruthy();
  });

  it('labels a proposal and its mapping in English', () => {
    render(
      inEnglish(
        <RightsProvider value={['register-building-blocks']}>
          <ProposalSection
            api={api}
            tenant="t"
            proposal={exampleProposal}
            onDone={() => undefined}
          />
          <MappingTable mapping={[{ table: 'soknad', becomes: 'excluded', reason: 'x' }]} />
        </RightsProvider>,
      ),
    );
    expect(screen.getByText('Proposed by the build assistant')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve and adopt' })).toBeTruthy();
    const table = screen.getByRole('region', { name: 'What the tables become' });
    expect(within(table).getByText('Not included')).toBeTruthy();
    expect(
      screen.getByText(/Created by the build assistant for Postsortering on 6 October at/),
    ).toBeTruthy();
  });
});
