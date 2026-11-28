// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';

document.getAnimations ??= () => [];

afterEach(cleanup);

describe('settings in English', () => {
  it('shows the defaults table in English', async () => {
    const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
    await auth.login();
    window.location.hash = '#/settings';
    render(inEnglish(<App auth={auth} fetch={mockFetch()} />));

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    const table = await screen.findByRole('region', { name: 'Defaults' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Setting', 'Default', 'Own value in', 'Action']);
    expect(screen.getByText('Export, import and clone')).toBeTruthy();
  });
});
