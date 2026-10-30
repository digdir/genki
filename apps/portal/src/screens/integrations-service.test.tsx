// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../api';
import { parseRoute } from '../hooks';
import { mockFetch } from '../mock';
import '../test-utils';
import { IntegrationService, IntegrationTab } from './DeveloperTools';
import { Integrations } from './Integrations';

afterEach(cleanup);

const api = createApiClient({ baseUrl: '/api', fetch: mockFetch(), token: () => 'test' });

const triggersOf = (service?: { id: string; name: string }) =>
  render(
    <IntegrationService.Provider value={service}>
      <IntegrationTab.Provider value="triggers">
        <Integrations
          api={api}
          tenant="999888777"
          tenantName="Testetaten"
          route={parseRoute('#/services/sortering/developer/triggers')}
          live={false}
        />
      </IntegrationTab.Provider>
    </IntegrationService.Provider>,
  );

describe('triggers on a service', () => {
  it('shows only the triggers that start this service, and only their problems', () => {
    triggersOf({ id: 'sortering', name: 'Sorter innkommende post' });
    expect(screen.getByText('Køen «innkommende-post»')).toBeTruthy();
    expect(screen.queryByText('Mappen «Søknader»')).toBeNull();
    expect(screen.getByRole('heading', { name: '1 integrasjon trenger oppfølging' })).toBeTruthy();
  });

  it('shows every trigger on the organisation page', () => {
    triggersOf();
    expect(screen.getByText('Køen «innkommende-post»')).toBeTruthy();
    expect(screen.getByText('Mappen «Søknader»')).toBeTruthy();
  });
});
