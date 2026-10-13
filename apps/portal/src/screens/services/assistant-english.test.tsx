// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { serviceRows } from '../../data/services';
import { ServiceList } from './ServiceList';
import { VersionsTab } from './VersionsTab';
import { AssistantBanner } from './assistant/cards';

afterEach(cleanup);

describe('the services area in English', () => {
  it('lists services with English labels and filters', () => {
    render(inEnglish(<ServiceList rows={serviceRows} tenantName="DFØ" />));
    expect(screen.getByRole('heading', { level: 1, name: 'Services' })).toBeTruthy();
    expect(screen.getByLabelText('Search services')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'zzzz' } });
    expect(screen.getByText('No services match the search')).toBeTruthy();
  });

  it('shows versions with English labels', () => {
    render(
      inEnglish(
        <VersionsTab
          versions={[
            { n: 2, when: 'x', who: 'y', state: 'I bruk', score: '', diff: [] },
            { n: 1, when: 'x', who: 'y', state: 'Tidligere', score: '', diff: [] },
          ]}
          changes={['a', 'b']}
          onRollback={() => undefined}
        />,
      ),
    );
    expect(screen.getByText('2 changes since version 2')).toBeTruthy();
    expect(screen.getByText('In use')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Roll back to this/ })).toHaveLength(2);
  });

  it('formats the assistant budget notice in English', () => {
    render(
      inEnglish(
        <AssistantBanner
          availability={{
            kind: 'budget',
            usage: { tokens: 1, budgetLeftToday: 0, dailyBudget: 200000 },
          }}
          tenantName="DFØ"
          onRetry={() => undefined}
        />,
      ),
    );
    expect(screen.getByText(/200,000 tokens per day at DFØ/)).toBeTruthy();
  });
});
