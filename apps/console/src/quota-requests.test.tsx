// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { exampleTenants, mockFetch } from './mock';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

interface Sent {
  path: string;
  body: unknown;
  reason: string | null;
}

const recording = () => {
  const base = mockFetch();
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/quota-requests/') && init?.method === 'POST') {
      const reason = new Headers(init.headers).get('change-reason');
      sent.push({
        path: url.replace(/^.*\/api/, ''),
        body: JSON.parse(String(init.body)),
        reason: reason === null ? null : decodeURIComponent(reason),
      });
    }
    return base(input, init);
  };
  return { fetch, sent };
};

const signedIn = async (path: string, fetch: typeof globalThis.fetch = mockFetch()) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} />);
};

const rows = async () => {
  const table = await screen.findByRole('table');
  return within(table).getAllByRole('row').slice(1);
};

const row = async (index: number) => {
  const found = (await rows())[index];
  if (!found) throw new Error(`no row ${index}`);
  return within(found);
};

const decide = async (button: string, reason: string) => {
  fireEvent.click(await screen.findByRole('button', { name: button }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Begrunnelse' }), {
    target: { value: reason },
  });
  return dialog;
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('quota requests in the console', () => {
  it('lists pending quota requests before decided ones', async () => {
    await signedIn('#/quota-requests');

    const first = await row(0);
    const second = await row(1);

    expect(first.getByText('Eksempeldirektoratet')).toBeTruthy();
    expect(first.getByText('Venter')).toBeTruthy();
    expect(second.getByText('Testetaten')).toBeTruthy();
    expect(second.getByText('Godkjent')).toBeTruthy();
  });

  it('shows the organisation, the amount asked for against use and quota, who asked and why', async () => {
    await signedIn('#/quota-requests');

    const cells = await row(0);

    expect(cells.getByText('974 222 333')).toBeTruthy();
    expect(cells.getByText('80 mill. per måned')).toBeTruthy();
    expect(cells.getByText('38,6 av 40 mill. (97 %)')).toBeTruthy();
    expect(cells.getByText('Bjørn Aas')).toBeTruthy();
    expect(
      cells.getByText('Saksbehandlingsassistenten går i drift for alle avdelinger i desember'),
    ).toBeTruthy();
  });

  it('reaches the quota requests from a tab under Til behandling', async () => {
    await signedIn('#/quota-requests');

    const menu = screen.getByRole('navigation', { name: 'Konsollmeny' });
    expect(
      within(menu)
        .getByRole('link', { name: /^Til behandling/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    const tabs = screen.getByRole('navigation', { name: 'Sider i Til behandling' });
    expect(within(tabs).getByRole('link', { name: 'Kvote' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('approves a request with the change reason and counts one less on Til behandling', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/quota-requests', fetch);
    const menu = screen.getByRole('navigation', { name: 'Konsollmeny' });
    const waiting = () =>
      Number(
        /, (\d+) venter/.exec(
          within(menu).getByRole('link', { name: /^Til behandling/ }).textContent ?? '',
        )?.[1] ?? 0,
      );
    await waitFor(() => expect(waiting()).toBe(6));

    const dialog = await decide(
      'Godkjenn kvoteforespørselen fra Eksempeldirektoratet',
      'Godkjent etter samtale med Bjørn',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Godkjenn' }));

    expect(
      await screen.findByText('Godkjent. Eksempeldirektoratet har nå 80 mill. tokens per måned.'),
    ).toBeTruthy();
    expect(sent).toEqual([
      {
        path: '/operator/quota-requests/974222333/qr-eksempeldirektoratet/decision',
        body: { decision: 'approved' },
        reason: 'Godkjent etter samtale med Bjørn',
      },
    ]);
    await waitFor(() => expect(waiting()).toBe(5));
  });

  it('rejects a request with the change reason', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/quota-requests', fetch);

    const dialog = await decide(
      'Avslå kvoteforespørselen fra Eksempeldirektoratet',
      'Ta det opp igjen i januar',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Avslå' }));

    expect(
      await screen.findByText('Kvoteforespørselen fra Eksempeldirektoratet er avslått.'),
    ).toBeTruthy();
    expect(sent).toMatchObject([{ body: { decision: 'rejected' } }]);
  });

  it('reloads the list and the badge when another operator already decided the request', async () => {
    const base = mockFetch();
    let lists = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/quota-requests/') && init?.method === 'POST')
        return Response.json(
          { title: 'Conflict', status: 409, type: 'urn:genai:problem:quota-request-decided' },
          { status: 409 },
        );
      if (url.includes('/operator/quota-requests')) lists += 1;
      return base(input, init);
    };
    await signedIn('#/quota-requests', fetch);
    await rows();
    await waitFor(() => expect(lists).toBe(2));

    const dialog = await decide(
      'Godkjenn kvoteforespørselen fra Eksempeldirektoratet',
      'Godkjent etter samtale med Bjørn',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Godkjenn' }));

    expect(await within(dialog).findByText(/Conflict/)).toBeTruthy();
    await waitFor(() => expect(lists).toBe(4));
  });

  it('asks for a change reason before it decides', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/quota-requests', fetch);

    const dialog = await decide('Godkjenn kvoteforespørselen fra Eksempeldirektoratet', 'ok');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Godkjenn' }));

    expect(await within(dialog).findByText(/minst 10 tegn/)).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it('links an organisation waiting on a quota request to Til behandling', async () => {
    await signedIn('#/tenants');

    const link = await screen.findByRole('link', {
      name: 'Til behandling for Eksempeldirektoratet: Kvote',
    });
    expect(link.getAttribute('href')).toBe('#/queue?type=quota');
  });

  it("shows only that organisation's requests when opened from the tenants screen", async () => {
    await signedIn('#/quota-requests?tenant=999888777');

    expect(await rows()).toHaveLength(1);
    expect((await row(0)).getByText('Testetaten')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Vis alle kvoteforespørsler' })).toBeTruthy();
  });
});

describe('quota on the tenants screen', () => {
  it('shows quota use from the quota and monthly tokens the tenant list returns', async () => {
    const apiShaped = exampleTenants.map(({ tokensMillions: _t, quotaMillions: _q, ...rest }) =>
      rest.orgNumber === '974222333'
        ? { ...rest, usedTokens: 38_600_000, monthlyTokens: 40_000_000 }
        : rest,
    );
    const base = mockFetch(apiShaped);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/operator/usage')) return new Response(null, { status: 503 });
      return base(input, init);
    };
    await signedIn('#/tenants', fetch);

    const row = (await screen.findByRole('link', { name: 'Eksempeldirektoratet' })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByText('97 %')).toBeTruthy();
  });
});
