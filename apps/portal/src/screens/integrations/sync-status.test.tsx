// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderLive } from '../../test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Systemer: siste synkronisering', () => {
  it('shows when a system was last synced', async () => {
    await renderLive('#/developer/systems', {
      features: {
        platformStatus: {
          toolConnections: [
            { id: 'arkiv', name: 'Arkivsøk', lastSync: { at: '2026-10-06T06:00:00Z', ok: true } },
          ],
        },
      },
    });
    const row = await screen.findByRole('button', { name: /^Arkivsøk/ });
    expect(await within(row).findByText(/Synkronisert 6\. oktober 2026/)).toBeTruthy();
  });

  it('marks a failed sync with the fixed message for its code and asks for follow-up', async () => {
    await renderLive('#/developer/systems', {
      features: {
        platformStatus: {
          toolConnections: [
            {
              id: 'arkiv',
              name: 'Arkivsøk',
              lastSync: {
                at: '2026-10-06T06:00:00Z',
                ok: false,
                code: 'timeout',
                message: 'Verktøyserveren svarte ikke i tide.',
              },
            },
          ],
        },
      },
    });
    const row = await screen.findByRole('button', { name: /^Arkivsøk/ });
    expect(await within(row).findByText('Feilet')).toBeTruthy();
    const system = await screen.findByRole('region', { name: 'Arkivsøk' });
    expect(within(system).getByText('Verktøyserveren svarte ikke i tide.')).toBeTruthy();
    expect(screen.getByText('Trenger oppfølging')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Se feilen' })).toBeTruthy();
  });

  it('says a system that was never synced is not synced yet', async () => {
    await renderLive('#/developer/systems', {
      features: { platformStatus: { toolConnections: [{ id: 'arkiv', name: 'Arkivsøk' }] } },
    });
    const row = await screen.findByRole('button', { name: /^Arkivsøk/ });
    expect(await within(row).findByText('Ikke synkronisert ennå')).toBeTruthy();
    expect(screen.queryByText('Trenger oppfølging')).toBeNull();
  });

  it('opens the first failing system and keeps the others folded', async () => {
    await renderLive('#/developer/systems', {
      features: {
        platformStatus: {
          toolConnections: [
            { id: 'arkiv', name: 'Arkivsøk', lastSync: { at: '2026-10-06T06:00:00Z', ok: false } },
          ],
        },
      },
    });
    const row = await screen.findByRole('button', { name: /^Arkivsøk/ });
    await screen.findByRole('region', { name: 'Arkivsøk' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Arkivsøk' })).toBeNull();
  });
});
