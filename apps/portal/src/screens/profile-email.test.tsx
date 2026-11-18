// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderLive } from '../test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Profil: e-post', () => {
  it('shows the email the login carried, from /me', async () => {
    await renderLive('#/profile', {
      features: { platformStatus: { email: 'kari.nordmann@testetaten.no' } },
    });
    expect(await screen.findByText('kari.nordmann@testetaten.no')).toBeTruthy();
    expect(screen.getByText('E-post')).toBeTruthy();
  });

  it('leaves the email row out when the login carried none', async () => {
    await renderLive('#/profile', { features: { platformStatus: { email: '' } } });
    expect(await screen.findByText('Navn')).toBeTruthy();
    expect(screen.queryByText('E-post')).toBeNull();
  });
});
