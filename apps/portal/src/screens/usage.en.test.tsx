// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import { kari } from '../test-utils';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(cleanup);

describe('Usage in English', () => {
  it('shows quota, period and table headings in English', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/usage';
    render(<App auth={auth} fetch={mockFetch()} languages={['en']} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Statistics' })).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 2, name: 'Quota in October' })).toBeTruthy();
    expect(screen.getByText(/Last updated today at \d\d:\d\d\./)).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Quota used in October' })).toBeTruthy();
    expect(screen.getAllByRole('region', { name: 'Split by service' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('option', { name: 'October 2026 (to date)' })).toBeTruthy();
    expect(screen.queryByText('Kvote i oktober')).toBeNull();
  });
});
