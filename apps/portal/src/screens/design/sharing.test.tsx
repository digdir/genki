// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../../mock';
import { studioAt } from './studio.test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const openSharing = async (id: string, fetch?: typeof globalThis.fetch) => {
  await studioAt(`#/design/999888777/${id}?tab=sharing`, fetch);
  await screen.findByRole('radio', { name: 'Alle organisasjoner' });
};

describe('sharing a designelement', () => {
  it('shares a designelement without code with everyone at once', async () => {
    await openSharing('sporsmal-kort');
    expect(screen.getByRole('radio', { name: 'Bare vår organisasjon' })).toHaveProperty(
      'checked',
      true,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Alle organisasjoner' }));
    expect(screen.queryByRole('textbox', { name: 'Hvorfor deler dere den?' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText('Lagret som ny utgave.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Utgaver' }));
    const rows = within(await screen.findByRole('region', { name: 'Utgaver' })).getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('Alle organisasjoner')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Deling: Alle organisasjoner')).toBeTruthy();
  });

  it('sends a code designelement to review and shows its status', async () => {
    await openSharing('figur-i-svaret');
    fireEvent.click(screen.getByRole('radio', { name: 'Alle organisasjoner' }));
    expect(screen.queryByRole('button', { name: 'Lagre' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Hvorfor deler dere den?' }), {
      target: { value: 'Andre etater med registerdata kan bruke den.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send til gjennomgang' }));
    const status = (await screen.findByText('Til gjennomgang')).closest(
      '[role="status"]',
    ) as HTMLElement;
    expect(status).toBeTruthy();
    expect(
      (screen.getByRole('radio', { name: 'Alle organisasjoner' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(within(status).getByText(/^Sendt \d+\. \S+$/)).toBeTruthy();
    expect(screen.getAllByRole('option', { name: /^Utgave / })).toHaveLength(1);
  });

  it('shows Alle organisasjoner chosen while a review is pending', async () => {
    const fetch = mockFetch();
    await openSharing('figur-i-svaret', fetch);
    fireEvent.click(screen.getByRole('radio', { name: 'Alle organisasjoner' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Hvorfor deler dere den?' }), {
      target: { value: 'Andre etater med registerdata kan bruke den.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send til gjennomgang' }));
    await screen.findByText('Til gjennomgang');
    cleanup();
    await openSharing('figur-i-svaret', fetch);
    expect(
      (screen.getByRole('radio', { name: 'Alle organisasjoner' }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('asks why before it sends a code designelement to review', async () => {
    await openSharing('figur-i-svaret');
    fireEvent.click(screen.getByRole('radio', { name: 'Alle organisasjoner' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send til gjennomgang' }));
    expect(await screen.findByText(/minst 10 tegn/)).toBeTruthy();
    expect(screen.queryByText('Til gjennomgang')).toBeNull();
  });

  it('shares only from the newest edition, so an older one is never published again', async () => {
    await openSharing('kildeliste-kompakt');
    fireEvent.change(screen.getByRole('combobox', { name: 'Utgave' }), { target: { value: '1' } });
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Alle organisasjoner' })).toHaveProperty(
        'disabled',
        true,
      ),
    );
    expect(screen.queryByRole('button', { name: 'Lagre' })).toBeNull();
  });
});
