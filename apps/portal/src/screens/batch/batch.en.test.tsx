// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { mockFetch } from '../../mock';
import { kari } from '../../test-utils';

const open = async () => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = '#/services/rapportassistenten/batch';
  render(
    <App
      auth={auth}
      fetch={mockFetch(undefined, undefined, undefined, undefined, {
        features: { batchRuns: {} },
      })}
      live
      languages={['en']}
    />,
  );
  await screen.findByRole('heading', { name: 'Batch job' });
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(cleanup);

describe('Batch job in English', () => {
  it('explains an empty list', async () => {
    await open();
    expect(await screen.findByRole('heading', { name: 'No batch jobs yet' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New batch job' }).length).toBeGreaterThan(0);
  });

  it('walks the wizard in English', async () => {
    await open();
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'New batch job' }))[0] as HTMLElement,
    );
    expect(await screen.findByRole('heading', { name: 'Choose documents' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Steps' })).toBeTruthy();
    expect(screen.getByText('Step 1 of 4')).toBeTruthy();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Årsrapport' }));
    expect(await screen.findByText(/documents match$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Input' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('estimate-basis')).toBeTruthy());
    expect(screen.getByTestId('estimate-basis').textContent).toMatch(/^Assumed:/);
    expect(screen.getByRole('heading', { name: 'Cost and control' })).toBeTruthy();
  });
});
