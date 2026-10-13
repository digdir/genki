// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';

document.getAnimations ??= () => [];

const app = (roles = [operatorRole]) =>
  inEnglish(<App auth={mockEntra({ name: 'Lise Dahl', roles })} fetch={mockFetch()} />);

afterEach(cleanup);

describe('console in English', () => {
  it('shows the login page and signs in', async () => {
    render(app());

    expect(screen.getByRole('heading', { level: 1, name: 'Operations console' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Digdir account' }));

    const menu = await screen.findByRole('navigation', { name: 'Console menu' });
    expect(within(menu).getByRole('link', { name: 'Organisations' })).toBeTruthy();
    expect(within(menu).getByRole('link', { name: 'Audit' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/logged in Audit/);
  });

  it('refuses an account without the operator role in English', async () => {
    window.location.hash = '#/tenants';
    const auth = mockEntra({ name: 'Lise Dahl', roles: [] });
    await auth.login();
    render(inEnglish(<App auth={auth} fetch={mockFetch()} />));

    expect(
      screen.getByRole('heading', { name: 'You do not have access to the operations console' }),
    ).toBeTruthy();
  });
});
