// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const renderEnglish = async (path: string) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={mockFetch()} languages={['en']} />);
};

describe('settings in English', () => {
  it('shows the grid, the panel and the preview in English', async () => {
    await renderEnglish('#/settings');
    const region = await screen.findByRole('region', { name: 'Settings per layer' });
    expect(screen.getByRole('heading', { level: 1, name: 'Settings for Testetaten' })).toBeTruthy();
    expect(
      within(region).getAllByText('Inherited from the platform default').length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('radio', { name: 'Ingestion' })).toBeTruthy();

    fireEvent.click(within(region).getByRole('button', { name: 'Number of hits read' }));
    const panel = screen.getByRole('dialog');
    expect(within(panel).getByText('Editing: Organisation (Testetaten)')).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('Value (hits)'), { target: { value: 'x' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview change' }));
    expect(within(panel).getByText('Enter a number.')).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('Value (hits)'), { target: { value: '99' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview change' }));
    expect(within(panel).getByText('Must be between 1 and 50.')).toBeTruthy();
  });

  it('offers export and import in English', async () => {
    await renderEnglish('#/settings?tab=transfer');
    expect(await screen.findByText('What do you want to do?')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Import from file' }));
    expect(screen.getByText('Configuration file (YAML)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run dry run' })).toBeTruthy();
  });
});

describe('access in English', () => {
  it('shows rights and people in English', async () => {
    await renderEnglish('#/access');
    expect(await screen.findByRole('heading', { level: 1, name: 'Access' })).toBeTruthy();
    expect(await screen.findByText('Showing 10 of 10 people')).toBeTruthy();
    expect(screen.getAllByText('Use services').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Change in Altinn/ }).textContent).toContain(
      '(opens in a new tab)',
    );
    fireEvent.click(screen.getByRole('radio', { name: 'No rights' }));
    expect(screen.getByText('Showing 1 of 10 people')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Groups' })).toBeTruthy();
  });
});
