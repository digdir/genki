// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../api';
import { DevStatus } from './DevStatus';

const api = (lockdown: boolean): Pick<ApiClient, 'getHealth' | 'cache'> => ({
  getHealth: () => Promise.resolve({ status: 'ok', version: '1.4.2', lockdown }),
  cache: { invalidate: () => undefined } as ApiClient['cache'],
});

document.getAnimations ??= () => [];
afterEach(cleanup);

describe('Driftsstatus', () => {
  it('says the environment is locked when the API reports lockdown', async () => {
    render(<DevStatus api={api(true)} />);
    expect(await screen.findByText('Låst miljø')).toBeTruthy();
    expect(screen.getByText('Ja, bare noen kan endre noe nå')).toBeTruthy();
  });

  it('says the environment is open when the API reports no lockdown', async () => {
    render(<DevStatus api={api(false)} />);
    expect(await screen.findByText('Låst miljø')).toBeTruthy();
    expect(screen.getByText('Nei')).toBeTruthy();
  });
});
