// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderLive } from '../../test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const rowOf = async (name: string) =>
  (await screen.findByRole('link', { name })).closest('tr') as HTMLElement;

describe('Datasett: brukes av', () => {
  it('counts the services that use each dataset from the API', async () => {
    await renderLive('#/datasets');
    const row = await rowOf('Nettsidene til Testetaten');
    expect(screen.getByRole('columnheader', { name: 'Brukes av' })).toBeTruthy();
    expect(within(row).getByText('1 tjeneste')).toBeTruthy();
  });

  it('says none when no service uses the dataset', async () => {
    await renderLive('#/datasets');
    const row = await rowOf('Veiledere og rundskriv');
    expect(within(row).getByText('Ingen')).toBeTruthy();
  });
});
