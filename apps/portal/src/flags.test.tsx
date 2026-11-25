// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockAnsattporten } from './auth';
import type { FlagState } from '@genai/contracts/flags';
import type { ApiClient } from './api';
import { FlagsOn, FlagsProvider, useFlag, useFlags } from './flags';
import { renderAt, withFlags } from './test-utils';

const Studio = () => (useFlag('blockStudio') ? <h2>Block Studio</h2> : null);

const newFeatures = () => screen.findByRole('region', { name: 'Nye funksjoner' });

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('feature flags in the portal', () => {
  it('hides a screen behind a flag that is off', () => {
    render(<Studio />);

    expect(screen.queryByRole('heading', { name: 'Block Studio' })).toBeNull();
  });

  it('shows a screen behind a flag a test turns on in one line', () => {
    render(
      <FlagsOn flags={['blockStudio']}>
        <Studio />
      </FlagsOn>,
    );

    expect(screen.getByRole('heading', { name: 'Block Studio' })).toBeTruthy();
  });

  it('drops the previous organisation’s flags while the next organisation’s load', async () => {
    const on: FlagState = {
      key: 'blockStudio',
      on: true,
      source: 'tenant',
      selfService: true,
      person: null,
      tenant: true,
    };
    const api = {
      flags: {
        mine: (tenant: string) =>
          tenant === '999888777'
            ? Promise.resolve([on])
            : new Promise<FlagState[]>(() => undefined),
      },
    } as unknown as Pick<ApiClient, 'flags'>;
    const { rerender } = render(
      <FlagsProvider api={api} tenant="999888777">
        <Studio />
      </FlagsProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Block Studio' })).toBeTruthy();

    rerender(
      <FlagsProvider api={api} tenant="999777666">
        <Studio />
      </FlagsProvider>,
    );

    expect(screen.queryByRole('heading', { name: 'Block Studio' })).toBeNull();
  });

  it('treats an answer without flags as every flag off, and is ready', async () => {
    const api = {
      flags: { mine: () => Promise.resolve(undefined) },
    } as unknown as Pick<ApiClient, 'flags'>;
    const Ready = () => (useFlags().ready ? <p>Klar</p> : null);
    render(
      <FlagsProvider api={api} tenant="999888777">
        <Ready />
        <Studio />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Klar')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Block Studio' })).toBeNull();
  });

  it('says a flag is on for the whole organisation when the organisation turned it on', async () => {
    await renderAt('#/profile', withFlags({ tenant: { blockStudio: true } }));

    const region = await newFeatures();
    expect(await within(region).findByText('På for hele virksomheten')).toBeTruthy();
    expect(within(region).getByRole('switch', { name: 'Slå på for meg' })).toHaveProperty(
      'checked',
      true,
    );
  });

  it('turns a flag on for the person alone and says it is on for you', async () => {
    await renderAt('#/profile', withFlags({}));
    const region = await newFeatures();

    await act(async () => {
      fireEvent.click(within(region).getByRole('switch', { name: 'Slå på for meg' }));
    });

    expect(await within(region).findByText('På for deg')).toBeTruthy();
    expect(within(region).getByRole('switch', { name: 'På for hele Testetaten' })).toHaveProperty(
      'checked',
      false,
    );
  });

  it('lets a person turn off for themselves what the organisation turned on, and follow it again', async () => {
    await renderAt('#/profile', withFlags({ tenant: { blockStudio: true } }));
    const region = await newFeatures();
    await within(region).findByText('På for hele virksomheten');

    await act(async () => {
      fireEvent.click(within(region).getByRole('switch', { name: 'Slå på for meg' }));
    });
    expect(await within(region).findByText('Av for deg')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Følg virksomhetens valg' }));
    });

    expect(await within(region).findByText('På for hele virksomheten')).toBeTruthy();
  });

  it('asks a tenant admin for a reason before turning a flag on for the whole organisation', async () => {
    await renderAt('#/profile', withFlags({}));
    const region = await newFeatures();

    fireEvent.click(within(region).getByRole('switch', { name: 'På for hele Testetaten' }));
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Lagre' }));
    });
    expect(within(region).getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(within(region).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Hele etaten skal prøve ny utforming' },
    });
    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Lagre' }));
    });

    expect(await within(region).findByText('På for hele virksomheten')).toBeTruthy();
  });

  it('hides the organisation switch from a member without manage-services', async () => {
    const auth = mockAnsattporten({
      name: 'Ingrid Berg',
      organisations: [{ orgNumber: '999888777', name: 'Testetaten', actions: ['use-services'] }],
    });
    await auth.login();
    window.location.hash = '#/profile';
    render(<App auth={auth} fetch={withFlags({})} />);

    const region = await newFeatures();
    expect(within(region).getByRole('switch', { name: 'Slå på for meg' })).toBeTruthy();
    expect(within(region).queryByRole('switch', { name: /hele/ })).toBeNull();
  });
});
