// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../api';
import type { CatalogItem } from '../../api/building-blocks';
import { exampleBlocks, exampleProposal } from '../../data/building-blocks';
import { RightsProvider } from '../../Shell';
import { BlockCard } from './BlockCard';
import { BlockDetail } from './BlockDetail';
import { BlockList, initialFilters } from './BlockList';
import { MappingTable, ProposalSection } from './ProposalSection';

afterEach(cleanup);

const api = {
  buildingBlocks: { path: () => '/x', proposalsPath: () => '/y' },
} as unknown as ApiClient;

const borealis = exampleBlocks.find((b) => b.id === 'borealis') as CatalogItem;

describe('building blocks in English', () => {
  it('lists blocks with English headings, counts and tags', () => {
    render(
      inEnglish(
        <RightsProvider value={['manage-services', 'register-building-blocks']}>
          <BlockList
            api={api}
            tenant="t"
            tenantName="Testetaten"
            items={exampleBlocks}
            proposals={[]}
            filters={initialFilters}
            onFilters={() => undefined}
            onFlash={() => undefined}
          />
        </RightsProvider>,
      ),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Building blocks' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(
      /^Showing \d+ building blocks that Testetaten uses$/,
    );
    expect(screen.getByRole('button', { name: 'Add your own building block' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Models' })).toBeTruthy();
  });

  it('describes a card in English', () => {
    render(inEnglish(<BlockCard item={borealis} />));
    expect(screen.getByText('In use')).toBeTruthy();
    expect(screen.getByText('Update available')).toBeTruthy();
    expect(screen.getByText(/^Digdir · version 2\.1 · Used by 5 services$/)).toBeTruthy();
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
            versions={[]}
            onChanged={() => undefined}
          />
        </RightsProvider>,
      ),
    );
    expect(screen.getByRole('heading', { name: 'What it can do' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'What it can access' })).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: /^Version 2\.2, available from \d+ Oct$/ }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to a service' })).toBeTruthy();
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
            versions={[]}
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
