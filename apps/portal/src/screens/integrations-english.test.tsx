// @vitest-environment jsdom
import { createFormat } from '@genai/i18n';
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient } from '../api';
import { parseRoute } from '../hooks';
import { translator } from '../i18n';
import { mockFetch } from '../mock';
import '../test-utils';
import { Integrations } from './Integrations';
import { CallFromCode } from './integrations/CallFromCode';
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
      <Integrations
        api={api}
        tenant="999888777"
        tenantName="Testetaten"
        route={parseRoute(hash)}
        live={live}
      />,
    ),
  );

describe('integrations in English', () => {
  it('names schedules in plain English', () => {
    const t = translator('en');
    const f = createFormat('en');
    expect(describeSchedule('0 2 * * *', t, f)).toBe('Every night at 02:00');
    expect(describeSchedule('30 7 * * *', t, f)).toBe('Every day at 07:30');
    expect(describeSchedule('0 7 * * 1', t, f)).toBe('Every Monday at 07:00');
    expect(describeSchedule('0 * * * *', t, f)).toBe('Every hour');
    expect(describeSchedule('*/5 * * * *', t, f)).toBe('Schedule "*/5 * * * *"');
  });

  it('shows statuses and the follow-up warning in English', () => {
    overview('#/integrations');
    expect(screen.getByText('2 integrations need follow-up')).toBeTruthy();
    expect(screen.getAllByText('Failing').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Connect a system' })).toBeTruthy();
  });

  it('shows the connect dialog and its problems in English', () => {
    overview('#/integrations');
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getAllByText('Enter the name of the system.').length).toBeGreaterThan(0);
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
    expect(await screen.findByRole('button', { name: 'Create API key' })).toBeTruthy();
    cleanup();
    overview('#/integrations?tab=hooks');
    expect(await screen.findByRole('heading', { name: 'From the platform' })).toBeTruthy();
    cleanup();
    overview('#/integrations?tab=tracing');
    expect(screen.getByText('Where is Langfuse hosted?')).toBeTruthy();
  });

  it('explains calling a service from code in English', () => {
    render(inEnglish(<CallFromCode tenantName="Testetaten" />));
    expect(screen.getByRole('heading', { name: 'Call a service from code' })).toBeTruthy();
    expect(screen.getByText('Get a token')).toBeTruthy();
    expect(screen.getByText('401 Not signed in')).toBeTruthy();
  });
});
