// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderLive } from '../../test-utils';
import { mergePages } from './audit-pages';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Logg, Endringer: sider', () => {
  it('asks for one page of the audit log and says how many of the total it shows', async () => {
    const urls = await renderLive('#/log/changes');
    expect(await screen.findByText('Viser 50 av 64 endringer')).toBeTruthy();
    expect(urls.some((u) => /\/audit\?limit=50&offset=0$/.test(u))).toBe(true);
  });

  it('the short list on Oversikt asks for one page of the audit log', async () => {
    const urls = await renderLive('#/overview');
    await screen.findByRole('heading', { name: 'Siste endringer' });
    await waitFor(() => expect(urls.some((u) => /\/audit\?limit=50&offset=0$/.test(u))).toBe(true));
  });

  it('loads the next page after the rows already shown', async () => {
    const urls = await renderLive('#/log/changes');
    fireEvent.click(await screen.findByRole('button', { name: 'Vis flere' }));

    expect(await screen.findByText('Viser 64 av 64 endringer')).toBeTruthy();
    expect(urls.some((u) => /\/audit\?limit=50&offset=50$/.test(u))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Vis flere' })).toBeNull();
  });

  it('keeps an entry once when a new change pushes it onto the next page', () => {
    const row = (task: string) => ({
      task,
      tenant: '999888777',
      action: 'platform.service.publish',
      actor: 'person:kari',
      at: '2026-10-06T09:00:00Z',
      outcome: 'applied' as const,
      target: 'rapportassistenten',
      reason: '',
    });
    expect(mergePages([row('a'), row('b')], [row('b'), row('c')]).map((r) => r.task)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});
