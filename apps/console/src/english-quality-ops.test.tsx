// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';

document.getAnimations ??= () => [];

const open = async (path: string) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = path;
  render(inEnglish(<App auth={auth} fetch={mockFetch()} />));
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('quality, tracing and operations in English', () => {
  it('shows the quality trend with English labels', async () => {
    await open('#/quality');

    expect(await screen.findByRole('heading', { level: 1, name: 'Quality' })).toBeTruthy();
    expect(await screen.findByText(/regressions after/)).toBeTruthy();
    const table = screen.getByRole('region', { name: 'Quality per service' });
    expect(within(table).getByText('Regression -8')).toBeTruthy();
  });

  it('shows the quality matrix tabs and the judges', async () => {
    await open('#/quality-matrix?tab=judges');

    expect(await screen.findByRole('tab', { name: 'Judges' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Quality matrix' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Assess answers' })).toBeTruthy();
    expect(screen.getByLabelText('Threshold (kappa)')).toBeTruthy();
  });

  it('shows tracing in English', async () => {
    await open('#/tracing');

    expect(
      await screen.findByRole('heading', { name: 'Tracing and evaluation for the platform' }),
    ).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Tools' })).toBeTruthy();
  });

  it('shows operations in English', async () => {
    await open('#/operations');

    expect(await screen.findByRole('heading', { level: 1, name: 'Operations' })).toBeTruthy();
    expect(await screen.findByText(/Fetched from the platform/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Runs in progress' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Definitions in quarantine' })).toBeTruthy();
  });

  it('shows diagnostics in English', async () => {
    await open('#/diagnostics');

    expect(await screen.findByRole('heading', { level: 1, name: 'Diagnostics' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Look up' })).toBeTruthy();
  });
});
