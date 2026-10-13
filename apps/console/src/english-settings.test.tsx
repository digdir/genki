// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';

document.getAnimations ??= () => [];

afterEach(cleanup);

describe('settings in English', () => {
  it('shows the grid chrome in English', async () => {
    const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
    await auth.login();
    window.location.hash = '#/settings';
    render(inEnglish(<App auth={auth} fetch={mockFetch()} />));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Settings across organisations' }),
    ).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Export, import and clone' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search settings' })).toBeTruthy();
    expect(screen.getByText('The value that applies')).toBeTruthy();
  });
});
