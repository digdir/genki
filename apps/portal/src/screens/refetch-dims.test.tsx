// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import { kari } from '../test-utils';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const switchable = (base: typeof fetch) => {
  let held: RegExp | undefined;
  let failing: RegExp | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (held && method === 'GET' && held.test(url)) return new Promise<Response>(() => undefined);
    if (failing?.test(url))
      return new Response(JSON.stringify({ title: 'Feil', status: 503 }), {
        status: 503,
        headers: { 'content-type': 'application/problem+json' },
      });
    return base(input, init);
  };
  return {
    fetch,
    hold: (pattern: RegExp) => {
      held = pattern;
    },
    fail: (pattern: RegExp | undefined) => {
      failing = pattern;
    },
  };
};

const open = async (hash: string, fetch: typeof globalThis.fetch, live: boolean) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = hash;
  render(<App auth={auth} fetch={fetch} live={live} />);
};

const reason = 'Ryddet bort etter test';

const busyAround = (element: HTMLElement) => element.closest('[aria-busy="true"]');

describe('a refetch keeps the rows on screen, dimmed, until the new ones arrive', () => {
  it('Tilgang keeps the rows dimmed while the services are fetched again after a save', async () => {
    const api = switchable(
      mockFetch(undefined, undefined, undefined, undefined, {
        features: { access: { limits: [] } },
      }),
    );
    await open('#/access/services', api.fetch, false);
    const row = await screen.findByRole('button', { name: 'Endre hvem som kan bruke Møtereferat' });
    fireEvent.click(screen.getByRole('button', { name: 'Endre hvem som kan bruke Postsortering' }));
    const mode = screen.getByRole('group', { name: 'Hvem kan bruke Postsortering?' });
    fireEvent.click(within(mode).getByRole('radio', { name: 'Bare utvalgte personer' }));
    fireEvent.change(screen.getByLabelText('Legg til person'), { target: { value: 'p-ingrid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));
    fireEvent.change(screen.getByLabelText('Hvorfor endrer du dette? (vises i loggen)'), {
      target: { value: reason },
    });

    api.hold(/access\/|\/services(\?|$)/);
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endringene' }));

    await waitFor(() => expect(busyAround(row)).not.toBeNull());
    expect(screen.getByRole('button', { name: 'Endre hvem som kan bruke Møtereferat' })).toBe(row);
  });

  it('Byggeklosser keeps the blocks dimmed while the list is fetched again', async () => {
    const api = switchable(mockFetch());
    api.fail(/proposals/);
    await open('#/building-blocks', api.fetch, false);
    const row = await screen.findByRole('link', { name: 'Borealis-27B' });
    const retry = await screen.findByRole('button', { name: 'Prøv igjen' });

    api.fail(undefined);
    api.hold(/building-blocks|proposals|connectors/);
    fireEvent.click(retry);

    await waitFor(() => expect(busyAround(row)).not.toBeNull());
    expect(screen.getByRole('link', { name: 'Borealis-27B' })).toBe(row);
  });

  it('Brukerflater keeps the frontends dimmed while the list is fetched again', async () => {
    const api = switchable(mockFetch());
    await open('#/developer/frontends', api.fetch, true);
    const row = await screen.findByRole('button', { name: /^Intranettet/ });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: 'Fjern' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), { target: { value: reason } });

    api.hold(/clients/);
    fireEvent.click(screen.getByRole('button', { name: 'Fjern brukerflaten' }));

    await waitFor(() => expect(busyAround(row)).not.toBeNull());
    expect(screen.getByRole('button', { name: /^Intranettet/ })).toBe(row);
  });

  it('Tilgangspolicyer keeps the policies dimmed while the list is fetched again', async () => {
    const api = switchable(mockFetch());
    await open('#/developer/keys', api.fetch, true);
    const section = await screen.findByRole('region', { name: 'Tilgangspolicyer' });
    const row = await within(section).findByRole('button', { name: /Bare klarspråk/ });
    fireEvent.click(
      within(section).getAllByRole('button', {
        name: /^Velg tilgangspolicy for /,
      })[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog', { name: /^Velg tilgangspolicy for / });
    fireEvent.click(within(dialog).getByLabelText('Ingen'));
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), { target: { value: reason } });

    api.hold(/api-key-policies|\/access/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bruk' }));

    await waitFor(() => expect(busyAround(row)).not.toBeNull());
    expect(within(section).getByRole('button', { name: /Bare klarspråk/ })).toBe(row);
  });

  it('Maskinporten-klienter keep their rows dimmed while the list is fetched again', async () => {
    const api = switchable(mockFetch());
    await open('#/developer/systems', api.fetch, true);
    const row = await screen.findByRole('button', { name: /^Tilskuddssystemet/ });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: 'Fjern' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), { target: { value: reason } });

    api.hold(/maskinporten/);
    fireEvent.click(screen.getByRole('button', { name: 'Fjern klienten' }));

    await waitFor(() => expect(busyAround(row)).not.toBeNull());
    expect(screen.getByRole('button', { name: /^Tilskuddssystemet/ })).toBe(row);
  });
});
