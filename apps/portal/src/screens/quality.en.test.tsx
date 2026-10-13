// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import { kari } from '../test-utils';

const open = async (query = '') => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = `#/services/rapportassistenten/quality${query}`;
  render(<App auth={auth} fetch={mockFetch()} languages={['en']} />);
  await screen.findByRole('tablist', { name: 'Quality' });
};

afterEach(cleanup);

describe('Quality in English', () => {
  it('shows the tabs and the test set toolbar in English', async () => {
    await open();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Test sets',
      'Feedback, 7 new',
      'Improvement proposals, 3 new',
      'Publish',
      'How users see it',
    ]);
    expect(await screen.findByRole('button', { name: 'New test case' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import a spreadsheet' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Scores per topic' })).toBeTruthy();
    expect(screen.queryByText('Testsett')).toBeNull();
  });

  it('explains approvals for a high-risk service in English', async () => {
    await open('?tab=proposals&risk=hoy');
    expect(await screen.findByText(/two people must approve/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByText('Approvals: 0 of 2')).toBeTruthy();
  });
});
