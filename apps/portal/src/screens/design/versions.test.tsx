// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../../mock';
import { exampleDesignBlocks } from '../../mock/design';
import { studioAt } from './studio.test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

interface Sent {
  method: string;
  path: string;
  body: unknown;
  reason: string | null;
}

const recording = (
  answer?: (sent: Sent) => Response | undefined,
  blocks = exampleDesignBlocks(),
) => {
  const sent: Sent[] = [];
  const base = mockFetch(undefined, undefined, undefined, undefined, {
    features: { design: { blocks } },
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const reason = new Headers(init?.headers).get('change-reason');
      const one = {
        method,
        path: new URL(url, 'http://mock').pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        reason: reason === null ? null : decodeURIComponent(reason),
      };
      sent.push(one);
      const own = answer?.(one);
      if (own) return own;
    }
    return base(input, init);
  };
  return { fetch, sent };
};

const open = async (path: string, fetch?: typeof globalThis.fetch) => {
  await studioAt(`#/design/${path}/versions`, fetch);
  return screen.findByRole('heading', { level: 1 });
};

const pinned = () => Response.json({ definition: {}, files: {}, baseVersion: null, checks: [] });

describe('Utgaver og deling', () => {
  it('shows the newest edition in the test edition and the edition in use', async () => {
    expect((await open('999888777/kildeliste-kompakt')).textContent).toBe('Kildeliste kompakt v3');
    const test = screen.getByRole('region', { name: 'Testutgave' });
    expect(within(test).getByText('v3')).toBeTruthy();
    const prod = screen.getByRole('region', { name: 'I bruk' });
    expect(within(prod).getByText('v2')).toBeTruthy();
    expect(within(prod).getByText('I bruk i én tjeneste.')).toBeTruthy();
  });

  it('puts the newest edition into the testutgave of a service that has an older one', async () => {
    const { fetch, sent } = recording((one) => (one.method === 'PUT' ? pinned() : undefined));
    await open('999888777/kildeliste-kompakt', fetch);
    const table = screen.getByRole('region', { name: 'Hva tjenestene får' });
    fireEvent.click(
      within(table).getAllByRole('button', { name: 'Legg v3 i test' })[0] as HTMLElement,
    );
    expect(await screen.findByText(/Lagt i testutgaven/)).toBeTruthy();
    const pin = sent.find((s) => s.method === 'PUT');
    expect(pin?.path).toMatch(
      /\/services\/rapportassistenten\/draft\/blocks\/999888777\/kildeliste-kompakt$/,
    );
    expect(pin?.body).toEqual({ version: 3 });
  });

  it('puts the newest edition in use for a service that has it in its test edition, with a reason', async () => {
    const blocks = exampleDesignBlocks();
    const own = blocks.find((b) => b.id === 'kildeliste-kompakt');
    if (own)
      own.usedIn = [
        { service: 'rapportassistenten', name: 'Rapportassistenten', test: 3, inUse: 2 },
      ];
    const { fetch, sent } = recording(
      (one) =>
        one.path.endsWith('/promote')
          ? Response.json({ environments: [], latestVersion: 3 })
          : undefined,
      blocks,
    );
    await open('999888777/kildeliste-kompakt', fetch);
    const panel = screen.getByRole('region', { name: 'Ta v3 i bruk' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ta i bruk' }));
    expect(await within(panel).findByText(/minst 10 tegn/)).toBeTruthy();
    expect(sent.filter((s) => s.path.endsWith('/promote'))).toEqual([]);
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Grunn' }), {
      target: { value: 'Godkjent i testutgaven' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ta i bruk' }));
    expect(await within(panel).findByText(/Rapportassistenten/)).toBeTruthy();
    const promote = sent.find((s) => s.path.endsWith('/promote'));
    expect(promote?.path).toMatch(/\/services\/rapportassistenten\/environments\/prod\/promote$/);
    expect(promote?.body).toEqual({ from: 'test' });
    expect(promote?.reason).toBe('Godkjent i testutgaven');
  });

  it('saves a new sharing for a block without code as the next edition', async () => {
    const { fetch, sent } = recording();
    await open('999888777/sporsmal-kort', fetch);
    const sharing = screen.getByRole('region', { name: 'Deling' });
    fireEvent.click(within(sharing).getByRole('radio', { name: 'Alle (Delt)' }));
    fireEvent.click(within(sharing).getByRole('button', { name: 'Lagre deling' }));
    await waitFor(() => expect(sent.some((s) => s.path.endsWith('/definitions'))).toBe(true));
    const saved = sent.find((s) => s.path.endsWith('/definitions'));
    expect(saved?.body).toMatchObject({ definition: { spec: { sharing: 'everyone' } } });
    expect(saved?.reason).toBe('Deling: Alle (Delt)');
  });

  it('sends a block with code to review before it is shared with everyone', async () => {
    const { fetch, sent } = recording();
    await open('999888777/figur-i-svaret', fetch);
    const sharing = screen.getByRole('region', { name: 'Deling' });
    fireEvent.click(within(sharing).getByRole('radio', { name: 'Alle (Delt)' }));
    expect(within(sharing).queryByRole('button', { name: 'Lagre deling' })).toBeNull();
    fireEvent.change(within(sharing).getByRole('textbox', { name: 'Hvorfor deler dere det?' }), {
      target: { value: 'Andre etater vil vise figurer' },
    });
    fireEvent.click(within(sharing).getByRole('button', { name: 'Send til gjennomgang' }));
    expect(await within(sharing).findByText('Til gjennomgang')).toBeTruthy();
    const request = sent.find((s) => s.path.endsWith('/share-requests'));
    expect(request?.body).toEqual({ version: 1 });
    expect(request?.reason).toBe('Andre etater vil vise figurer');
    expect(sent.filter((s) => s.path.endsWith('/definitions'))).toEqual([]);
  });

  it('lists each saved edition in Revisjon with who saved it and why', async () => {
    await open('999888777/kildeliste-kompakt');
    const audit = screen.getByRole('region', { name: 'Revisjon' });
    expect(
      within(audit).getByText(/Kari Nordmann lagret v3\. Grunn: «Dato i stedet for utgiver»/),
    ).toBeTruthy();
  });
});

describe('Slett designelementet', () => {
  it('deletes an unused block after a confirm in the page with a reason, and goes back to the catalogue', async () => {
    const { fetch, sent } = recording();
    await open('999888777/sporsmal-kort', fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Slett designelementet' }));
    const confirm = screen.getByRole('group', { name: 'Slett designelementet' });
    fireEvent.change(within(confirm).getByRole('textbox', { name: 'Grunn' }), {
      target: { value: 'Prøvekort som ikke trengs' },
    });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Slett' }));
    await waitFor(() => expect(window.location.hash).toBe('#/design'));
    const deleted = sent.find((s) => s.method === 'DELETE');
    expect(deleted?.path).toMatch(/\/tenants\/999888777\/blocks\/sporsmal-kort$/);
    expect(deleted?.reason).toBe('Prøvekort som ikke trengs');
    expect(await screen.findByRole('heading', { level: 1, name: 'Utforming' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Spørsmålskort/ })).toBeNull();
  });

  it('asks for a reason and sends nothing without one', async () => {
    const { fetch, sent } = recording();
    await open('999888777/sporsmal-kort', fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Slett designelementet' }));
    const confirm = screen.getByRole('group', { name: 'Slett designelementet' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Slett' }));
    expect(await within(confirm).findByText(/minst 10 tegn/)).toBeTruthy();
    expect(sent.filter((s) => s.method === 'DELETE')).toEqual([]);
  });

  it('keeps the block and names the services that use it when genki refuses', async () => {
    await open('999888777/kildeliste-kompakt');
    fireEvent.click(screen.getByRole('button', { name: 'Slett designelementet' }));
    const confirm = screen.getByRole('group', { name: 'Slett designelementet' });
    fireEvent.change(within(confirm).getByRole('textbox', { name: 'Grunn' }), {
      target: { value: 'Trengs ikke lenger her' },
    });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Slett' }));
    const refused = await within(confirm).findByRole('alert');
    expect(refused.textContent).toContain('Rapportassistenten');
    expect(window.location.hash).toBe('#/design/999888777/kildeliste-kompakt/versions');
  });

  it('is not offered for a genki block', async () => {
    await open('991825827/approach');
    expect(screen.queryByRole('button', { name: 'Slett designelementet' })).toBeNull();
  });
});
