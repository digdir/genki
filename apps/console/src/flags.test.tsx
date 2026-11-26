// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { FlagsOn, FlagsProvider, useFlag } from './flags';
import { mockFetch } from './mock';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

interface Call {
  method: string;
  path: string;
  body?: unknown;
  reason?: string;
}

const recorded = () => {
  const base = mockFetch();
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const raw = new Headers(init?.headers).get('change-reason');
    calls.push({
      method: init?.method ?? 'GET',
      path: new URL(String(input), 'http://mock').pathname.replace(/^\/api/, ''),
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      ...(raw ? { reason: decodeURIComponent(raw) } : {}),
    });
    return base(input, init);
  };
  return { calls, fetch };
};

const signedIn = async (fetch: typeof globalThis.fetch) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = '/flags';
  render(<App auth={auth} fetch={fetch} />);
};

const Studio = () => (useFlag('blockStudio') ? <h2>Block Studio</h2> : null);

beforeEach(() => {
  document.documentElement.lang = 'nb';
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('feature flags on the console', () => {
  it('hides a screen behind a flag that is off and shows it when a test turns it on', () => {
    const { unmount } = render(<Studio />);
    expect(screen.queryByRole('heading', { name: 'Block Studio' })).toBeNull();
    unmount();

    render(
      <FlagsOn flags={['blockStudio']}>
        <Studio />
      </FlagsOn>,
    );
    expect(screen.getByRole('heading', { name: 'Block Studio' })).toBeTruthy();
  });

  it('loads the flags once from /me/flags and shows what is on for the operator', async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [
        {
          key: 'blockStudio' as const,
          on: true,
          source: 'tenant' as const,
          selfService: true,
          person: null,
          tenant: true,
        },
      ];
    };
    render(
      <FlagsProvider load={load}>
        <Studio />
      </FlagsProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Block Studio' })).toBeTruthy();
    expect(loads).toBe(1);
  });

  it('lists each flag with its description, owner, removal date and where it is on', async () => {
    await signedIn(mockFetch());

    const section = await screen.findByRole('region', { name: 'blockStudio' });
    expect(
      within(section).getByText(/New design tools: build and edit design elements/),
    ).toBeTruthy();
    expect(within(section).getByText(/Eier: the lab\. Fjernes innen/)).toBeTruthy();
    expect(within(section).getByText('Selvbetjent')).toBeTruthy();
    const row = within(section).getByRole('row', { name: /Digitaliseringsdirektoratet/ });
    expect(within(row).getByText('På')).toBeTruthy();
    expect(within(row).getByText('Laben prøver ny utforming først')).toBeTruthy();
  });

  it('switches a flag for one person in an organisation with a reason', async () => {
    const { calls, fetch } = recorded();
    await signedIn(fetch);
    const section = await screen.findByRole('region', { name: 'blockStudio' });

    fireEvent.click(within(section).getByRole('button', { name: 'Slå på eller av' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Org.nr.' }), {
      target: { value: '999888777' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Personens utsteder/ }), {
      target: { value: 'ansattporten' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Personens subjekt/ }), {
      target: { value: 'kari' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Kari tester ny utforming for etaten' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre' }));
    });

    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      {
        method: 'PUT',
        path: '/operator/flags/blockStudio',
        body: {
          tenant: '999888777',
          person: { issuer: 'ansattporten', subject: 'kari' },
          on: true,
        },
        reason: 'Kari tester ny utforming for etaten',
      },
    ]);
    expect(await screen.findByText('Lagret valget for blockStudio.')).toBeTruthy();
  });
});
