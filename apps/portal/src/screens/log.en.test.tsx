// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import { kari } from '../test-utils';
import { createFormat } from '@genai/i18n';
import { formatDuration, formatOffset, relativeTime } from './log/format';
import { translator } from '../i18n';

const open = async (hash: string) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = hash;
  render(<App auth={auth} fetch={mockFetch()} languages={['en']} />);
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Log in English', () => {
  it('shows the runs tab with English chrome and statuses', async () => {
    await open('#/log');
    expect(await screen.findByRole('heading', { level: 1, name: 'Log' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Runs' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Changes' })).toBeTruthy();
    const list = await screen.findByRole('region', { name: 'Latest runs' });
    const link = within(list).getByRole('link', { name: /Vedtaksutkast/ });
    expect(within(link).getByText('Waiting for approval')).toBeTruthy();
    expect(await screen.findByRole('list', { name: 'Steps in the run' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
  });

  it('shows the changes tab in English', async () => {
    await open('#/log?tab=changes');
    expect(await screen.findByText('Type of change')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Publishing' }));
    expect(screen.getByRole('list', { name: 'Changes' })).toBeTruthy();
  });

  it('formats times, offsets and durations for English', () => {
    const t = translator('en');
    const f = createFormat('en');
    const now = new Date('2026-10-09T10:00:00Z');
    expect(relativeTime('2026-10-09T08:52:00Z', t, f, now)).toBe('Today at 10:52');
    expect(formatOffset(4.7, f)).toBe('+4.7 s');
    expect(formatDuration(125, f)).toBe('2 min 5 s');
  });
});
