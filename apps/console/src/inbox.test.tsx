// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { inEnglish } from '@genai/i18n/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';

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

const recording = (hold?: Promise<void>) => {
  const base = mockFetch();
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (hold && url.includes('/operator/inbox')) await hold;
    if (init?.method && init.method !== 'GET') {
      const reason = new Headers(init.headers).get('change-reason');
      sent.push({
        path: new URL(url, 'http://x').pathname.replace(/^\/api/, ''),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        reason: reason === null ? null : decodeURIComponent(reason),
      });
    }
    return base(input, init);
  };
  return { fetch, sent };
};

const signedIn = async (path: string, fetch: typeof globalThis.fetch) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} />);
};

const requests = async () => {
  const region = await screen.findByRole('region', { name: 'Forespørsler' });
  return within(region).getAllByRole('row').slice(1);
};

const openQuota = async () => {
  fireEvent.click(
    await screen.findByRole('link', { name: /^Behandle: Eksempeldirektoratet, 80 mill\./ }),
  );
  return within(await screen.findByRole('dialog', { name: 'Eksempeldirektoratet' }));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-26T12:00:00+01:00'));
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Til behandling', () => {
  it('lists every waiting item with its type, organisation, what it is about and how long it has waited', async () => {
    const { fetch } = recording();
    await signedIn('#/queue', fetch);

    const quota = (await requests()).find((r) => within(r).queryByText('Kvote'));
    if (!quota) throw new Error('no quota row');
    const cells = within(quota);
    expect(cells.getByRole('link', { name: 'Eksempeldirektoratet' })).toBeTruthy();
    expect(cells.getByText(/80 mill\. tokens per måned, har 40 \(97 % brukt\)/)).toBeTruthy();
    expect(cells.getByText('Blokkerer')).toBeTruthy();
    expect(cells.getByText('Bjørn Aas')).toBeTruthy();
    expect(cells.getByText('2 d')).toBeTruthy();
    expect(screen.getByText('4 blokkerer en virksomhet')).toBeTruthy();
  });

  it('keeps the type chosen while the list loads once it arrives', async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetch } = recording(hold);
    await signedIn('#/queue', fetch);

    fireEvent.click(await screen.findByRole('button', { name: /^Kvote/ }));
    release();

    await waitFor(async () => expect(await requests()).toHaveLength(1));
    const [row] = await requests();
    expect(within(row as HTMLElement).getByText('Kvote')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Kvote/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('keeps the chosen type when the list is fetched again after a decision', async () => {
    const { fetch } = recording();
    await signedIn('#/queue?type=quota', fetch);

    const panel = await openQuota();
    fireEvent.change(panel.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Godkjent etter forespørsel' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Godkjenn og sett kvoten' }));

    expect(await screen.findByRole('status')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Ingenting av denne typen venter.')).toBeTruthy());
    expect(screen.getByRole('button', { name: /^Kvote/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('approves a quota request only with a reason, and sends the new quota with it', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/queue', fetch);

    const panel = await openQuota();
    fireEvent.change(panel.getByRole('textbox', { name: 'Ny kvote' }), { target: { value: '60' } });
    fireEvent.click(panel.getByRole('button', { name: 'Godkjenn og sett kvoten' }));

    expect(panel.getByRole('textbox', { name: 'Begrunnelse' }).getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(sent).toHaveLength(0);

    fireEvent.change(panel.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Godkjent etter forespørsel' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Godkjenn og sett kvoten' }));

    expect((await screen.findByRole('status')).textContent).toContain(
      'Kvoten til Eksempeldirektoratet er 60 mill.',
    );
    expect(sent).toEqual([
      {
        path: '/operator/quota-requests/974222333/qr-eksempeldirektoratet/decision',
        body: { decision: 'approved', monthlyTokens: 60_000_000 },
        reason: 'Godkjent etter forespørsel',
      },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('rejects a quota request with a reason', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/queue', fetch);

    const panel = await openQuota();
    fireEvent.click(panel.getByRole('radio', { name: 'Avslå' }));
    fireEvent.change(panel.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Bruken er ikke begrunnet godt nok ennå' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Avslå' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({ decision: 'rejected' });
    expect(sent[0]?.reason).toBe('Bruken er ikke begrunnet godt nok ennå');
  });

  it('postpones a quota request to a later day and takes it off the list until then', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/queue', fetch);

    const panel = await openQuota();
    fireEvent.click(panel.getByRole('radio', { name: 'Utsett' }));
    fireEvent.change(panel.getByLabelText('Utsett til'), { target: { value: '2026-12-01' } });
    fireEvent.change(panel.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Venter på budsjettet for desember' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Utsett' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({ decision: 'postponed', until: '2026-12-01' });
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /^Behandle: Eksempeldirektoratet/ })).toBeNull(),
    );
  });

  it('closes the quota panel with Escape without deciding', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/queue', fetch);

    await openQuota();
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent).toHaveLength(0);
  });

  it('keeps the old lanes when a lane is named in the address', async () => {
    const { fetch } = recording();
    await signedIn('#/queue?tab=blocks', fetch);

    expect(await screen.findByRole('tab', { name: /Deler fra katalogen/ })).toBeTruthy();
  });

  it('refuses a new quota that is not a positive number of millions', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/queue', fetch);

    const panel = await openQuota();
    fireEvent.change(panel.getByRole('textbox', { name: 'Ny kvote' }), { target: { value: '0' } });
    fireEvent.change(panel.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Godkjent etter forespørsel' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Godkjenn og sett kvoten' }));

    expect(panel.getByRole('textbox', { name: 'Ny kvote' }).getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(sent).toHaveLength(0);
  });

  it('accepts a decimal comma in the new quota', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/queue', fetch);

    const panel = await openQuota();
    fireEvent.change(panel.getByRole('textbox', { name: 'Ny kvote' }), {
      target: { value: '62,5' },
    });
    fireEvent.change(panel.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Godkjent etter forespørsel' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Godkjenn og sett kvoten' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toEqual({ decision: 'approved', monthlyTokens: 62_500_000 });
  });

  it('refuses to postpone to today or earlier', async () => {
    const { fetch, sent } = recording();
    await signedIn('#/queue', fetch);

    const panel = await openQuota();
    fireEvent.click(panel.getByRole('radio', { name: 'Utsett' }));
    fireEvent.change(panel.getByLabelText('Utsett til'), { target: { value: '2026-11-26' } });
    fireEvent.change(panel.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Venter på budsjettet for desember' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Utsett' }));

    expect(panel.getByText('Velg en dato etter i dag.')).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it('tells the operator when someone else decided the request while the panel was open', async () => {
    const { fetch } = recording();
    await signedIn('#/queue', fetch);

    const panel = await openQuota();
    await fetch('/api/operator/quota-requests/974222333/qr-eksempeldirektoratet/decision', {
      method: 'POST',
      headers: { 'change-reason': 'Avgjort av en kollega' },
      body: JSON.stringify({ decision: 'rejected' }),
    });
    fireEvent.change(panel.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Godkjent etter forespørsel' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Godkjenn og sett kvoten' }));

    expect((await panel.findByRole('alert')).textContent).toBe(
      'Forespørselen er allerede behandlet.',
    );
  });

  it('shows the list and the quota panel in English', async () => {
    const { fetch } = recording();
    const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
    await auth.login();
    window.location.hash = '#/queue';
    render(inEnglish(<App auth={auth} fetch={fetch} />));

    expect(await screen.findByRole('heading', { level: 1, name: 'To handle' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('link', { name: /^Handle: Eksempeldirektoratet/ }));
    const panel = within(await screen.findByRole('dialog', { name: 'Eksempeldirektoratet' }));
    expect(panel.getByRole('button', { name: 'Approve and set the quota' })).toBeTruthy();
  });
});
