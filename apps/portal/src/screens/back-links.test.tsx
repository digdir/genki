// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderAt } from '../test-utils';

afterEach(cleanup);

describe('Lane 5 pages use the shared back link, not slash crumbs', () => {
  it('the hook editor links back to Kroker', async () => {
    await renderAt('#/developer/hooks/new');
    const back = await screen.findByRole('link', { name: 'Kroker' });
    expect(back.className).toBe('back-link');
    expect(screen.queryByRole('navigation', { name: 'Brødsmuler' })).toBeNull();
  });

  it('the settings of the organisation have no crumb at all', async () => {
    await renderAt('#/settings');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('navigation', { name: 'Brødsmuler' })).toBeNull();
    expect(document.querySelector('.back-link')).toBeNull();
  });
});
