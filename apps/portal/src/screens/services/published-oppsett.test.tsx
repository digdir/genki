// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../../mock';
import { expectAccessible, renderAt } from '../../test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

// Each test opens the whole portal and waits up to 5 s for it, so the tests get more than the default 5 s.

const open = async (hash: string, fetch?: typeof globalThis.fetch) => {
  await renderAt(hash, fetch);
  await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' }, { timeout: 5000 });
};

const header = () =>
  screen.getByRole('heading', { level: 1, name: 'Rapportassistenten' }).closest('header');

describe('the Oppsett of a published service', () => {
  it('opens a published service in the one-form Oppsett with the builder assistant beside it', async () => {
    await open('#/services/rapportassistenten/setup');
    expect(await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' })).toBeTruthy();
    for (const area of ['Formål og målgruppe', 'Kunnskap', 'Inndata', 'Resultat', 'Modell'])
      expect(screen.getByRole('heading', { level: 3, name: area })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Byggeassistent og prøving' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Deler av oppsettet' })).toBeNull();
    const tabs = within(screen.getByRole('tablist', { name: /^Faner for/ }))
      .getAllByRole('tab')
      .map((tab) => tab.textContent);
    expect(tabs).toContain('Avansert');
    expectAccessible();
  }, 20000);

  it("shows Test tjenesten and no Prøv side pane in a published service's header", async () => {
    await open('#/services/rapportassistenten/setup');
    const top = header() as HTMLElement;
    expect(within(top).getByRole('link', { name: 'Test tjenesten' }).getAttribute('href')).toBe(
      '#/services/rapportassistenten/interface/preview',
    );
    expect(within(top).queryByRole('button', { name: 'Prøv' })).toBeNull();
    expect(within(top).queryByRole('link', { name: 'Prøv' })).toBeNull();
  }, 20000);
});

describe('Test tjenesten in the header', () => {
  it('is not shown for an archived service, whose Oppsett and Utforming are closed', async () => {
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = async (input, init) =>
      /\/services\/rapportassistenten\/lifecycle$/.test(String(input))
        ? Response.json({ state: 'archived', reason: 'Erstattet', at: '2026-11-20T10:00:00Z' })
        : base(input, init);
    await open('#/services/rapportassistenten', fetch);
    await waitFor(() => expect(header()?.textContent).toMatch(/Arkivert/), { timeout: 5000 });
    expect(screen.queryByRole('link', { name: 'Test tjenesten' })).toBeNull();
  }, 20000);

  it('is not shown on the edition in use, since it tests the test edition', async () => {
    await open('#/services/rapportassistenten/setup?edition=in-use');
    await screen.findByRole('heading', { level: 3, name: 'Inndata' }, { timeout: 5000 });
    expect(screen.queryByRole('link', { name: 'Test tjenesten' })).toBeNull();
  }, 20000);
});

describe("the footer of a published service's Oppsett", () => {
  it('does not say Oversikt and Kvalitet come once the service is published, when it already is', async () => {
    await open('#/services/rapportassistenten/setup');
    await screen.findByRole('heading', { level: 3, name: 'Inndata' }, { timeout: 5000 });
    expect(
      screen.queryByText('Oversikt og Kvalitet kommer når tjenesten er publisert.'),
    ).toBeNull();
  }, 20000);
});

describe('Avansert → API-nøkler og kanaler of a published service', () => {
  it('shows API keys, address and clients under Avansert → Kanaler for a published service', async () => {
    await open('#/services/rapportassistenten/advanced/channels');
    expect(
      await screen.findByRole('button', { name: 'Lag API-nøkkel' }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'API-nøkler' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Egne løsninger' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Egen nettside' })).toBeTruthy();
  }, 20000);

  it('opens a client from its old /channels/<frontend> address on its own page under Avansert', async () => {
    await open('#/services/rapportassistenten/channels/intranettet');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Intranettet' }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(window.location.hash).toBe(
      '#/services/rapportassistenten/advanced/channels/intranettet',
    );
    expect(screen.getByRole('link', { name: 'API-nøkler og kanaler' }).getAttribute('href')).toBe(
      '#/services/rapportassistenten/advanced/channels',
    );
  }, 20000);
});

describe('Avansert → YAML of a published service', () => {
  it("sends the draft's prompt files with the YAML it validates, so a service with prompt files can be edited", async () => {
    const base = mockFetch();
    const validated: { files?: Record<string, string> }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, 'http://test').pathname;
      if (path.endsWith('/definitions/validate'))
        validated.push(
          JSON.parse(String(init?.body ?? '{}')) as { files?: Record<string, string> },
        );
      const response = await base(input, init);
      if (!path.endsWith('/definitions/services/rapportassistenten')) return response;
      const found = (await response.json()) as { latest: Record<string, unknown> };
      const latest = { ...found.latest, files: { 'prompts/svar.md': 'Svar kort.' } };
      return new Response(JSON.stringify({ ...found, latest }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    await open('#/services/rapportassistenten/advanced/yaml', fetch);
    const field = (await screen.findByRole(
      'textbox',
      { name: 'Oppsettet som YAML' },
      { timeout: 5000 },
    )) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: `${field.value}\n` } });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));
    await waitFor(() => expect(validated.length).toBeGreaterThan(0));
    expect(validated[0]?.files).toEqual({ 'prompts/svar.md': 'Svar kort.' });
    fireEvent.click(screen.getByRole('button', { name: 'Sjekk mot skjemaet' }));
    await waitFor(() => expect(validated.length).toBe(2));
    expect(validated[1]?.files).toEqual({ 'prompts/svar.md': 'Svar kort.' });
  }, 20000);
});
