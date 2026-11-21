// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient } from '../api';
import { parseRoute } from '../hooks';
import { translator } from '../i18n';
import { mockFetch } from '../mock';
import { exampleTracing } from '../mock/devtools';
import { RightsProvider } from '../Shell';
import '../test-utils';
import { Integrations } from './Integrations';
import { CallFromCode } from './integrations/CallFromCode';
import { TracingPage } from './integrations/TracingPage';
import { describeSchedule } from './integrations/Triggers';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(cleanup);

const api = createApiClient({ baseUrl: '/api', fetch: mockFetch(), token: () => 'test' });

const overview = (hash: string, live = false) =>
  render(
    inEnglish(
      <RightsProvider value={['manage-services']}>
        <Integrations
          api={api}
          tenant="999888777"
          tenantName="Testetaten"
          route={parseRoute(hash)}
          live={live}
        />
      </RightsProvider>,
    ),
  );

describe('integrations in English', () => {
  it('names schedules in plain English', () => {
    const t = translator('en');
    expect(describeSchedule('0 2 * * *', t)).toBe('Every night at 02:00');
    expect(describeSchedule('30 7 * * *', t)).toBe('Every day at 07:30');
    expect(describeSchedule('0 7 * * 1', t)).toBe('Every Monday at 07:00');
    expect(describeSchedule('0 * * * *', t)).toBe('Every hour');
    expect(describeSchedule('*/5 * * * *', t)).toBe('Schedule "*/5 * * * *"');
  });

  it('shows the systems and their status in English', async () => {
    overview('#/integrations');
    expect(await screen.findByText('Waiting for approval')).toBeTruthy();
    expect(screen.getByText('MCP server')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect a system' })).toBeTruthy();
  });

  it('shows the connect dialog and its problems in English', async () => {
    overview('#/integrations');
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a system' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getAllByText('Write the name of the system.').length).toBeGreaterThan(0);
  });

  it('shows live frontends and triggers in English', async () => {
    overview('#/integrations?tab=triggers', true);
    expect((await screen.findAllByText('Every night at 02:00')).length).toBeGreaterThan(0);
    cleanup();
    overview('#/integrations?tab=frontends', true);
    fireEvent.click(await screen.findByRole('button', { name: /Intranettet/ }));
    expect(screen.getByText('Return address after sign-in')).toBeTruthy();
    expect(screen.getByText('Browser with sign-in', { exact: false })).toBeTruthy();
  });

  it('shows keys, hooks and tracing in English', async () => {
    overview('#/integrations?tab=keys');
    expect(await screen.findByRole('button', { name: 'New API key' })).toBeTruthy();
    cleanup();
    overview('#/integrations?tab=hooks');
    expect(await screen.findByRole('button', { name: 'New run point' })).toBeTruthy();
    cleanup();
    const withTracing = createApiClient({
      baseUrl: '/api',
      fetch: mockFetch(undefined, undefined, undefined, undefined, {
        features: { devtools: { tracing: exampleTracing } },
      }),
      token: () => 'test',
    });
    render(inEnglish(<TracingPage api={withTracing} tenant="999888777" />));
    expect(await screen.findByRole('heading', { name: 'What is traced' })).toBeTruthy();
  });

  it('explains calling a service from code in English', () => {
    render(inEnglish(<CallFromCode tenantName="Testetaten" />));
    expect(screen.getByRole('heading', { name: 'Call a service from code' })).toBeTruthy();
    expect(screen.getByText('Get a token')).toBeTruthy();
    expect(screen.getByText('401 Not signed in')).toBeTruthy();
  });
});
