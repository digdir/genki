// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inEnglish } from '@genai/i18n/react';
import { App } from '../App';
import { createApiClient } from '../api';
import { parseRoute } from '../hooks';
import { Integrations } from './Integrations';
import { mockAnsattporten } from '../auth';
import { exampleAccess, exampleOrganisations, mockFetch } from '../mock';
import { expectAccessible } from '../test-utils';

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

interface Call {
  method: string;
  url: string;
  reason: string;
  body: unknown;
}

const unboundKey = {
  ...(exampleAccess.keys[0] as (typeof exampleAccess.keys)[number]),
  id: 'key-gammel',
  name: 'Fagsystemet',
  revokedAt: null,
};

const boundKey = {
  ...unboundKey,
  id: 'key-ka',
  name: 'Kunnskapsassistenten-nøkkel',
  service: 'kunnskapsassistenten',
};

const renderKeys = async () => {
  const calls: Call[] = [];
  const base = mockFetch(undefined, undefined, undefined, undefined, {
    access: { ...exampleAccess, keys: [...exampleAccess.keys, unboundKey, boundKey] },
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      method: init?.method ?? 'GET',
      url,
      reason: decodeURIComponent(new Headers(init?.headers).get('change-reason') ?? ''),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return base(input, init);
  };
  const auth = mockAnsattporten({ name: 'Kari Nordmann', organisations: exampleOrganisations });
  await auth.login();
  window.location.hash = '#/integrations?tab=keys';
  render(<App auth={auth} fetch={fetch} live />);
  return { calls, section: await screen.findByRole('region', { name: 'Tilgangspolicyer' }) };
};

describe('Integrasjoner: tilgangspolicyer', () => {
  it('lists the policies with their grants and the keys that use them', async () => {
    const { section } = await renderKeys();

    const row = await within(section).findByRole('button', { name: /Bare klarspråk/ });
    expect(within(row).getByText('Brukes av 1 nøkler')).toBeTruthy();
    fireEvent.click(row);
    expect(within(section).getByText('klarsprak__default')).toBeTruthy();
    expect(within(section).getByText(/Fagsystemet/)).toBeTruthy();
    await expectAccessible(section);
  });

  it('validates, then creates a policy with the chosen grants and a reason', async () => {
    const { calls, section } = await renderKeys();
    await within(section).findByRole('button', { name: /Bare klarspråk/ });
    fireEvent.click(within(section).getByRole('button', { name: 'Lag tilgangspolicy' }));
    const dialog = await screen.findByRole('dialog', { name: 'Lag tilgangspolicy' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre' }));
    expect(within(dialog).getByText('Skriv et navn')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('Navn'), { target: { value: 'Innlesing' } });
    fireEvent.click(within(dialog).getByLabelText('ingest'));
    fireEvent.change(within(dialog).getByLabelText('Datasett'), {
      target: { value: 'digdir/kudos, digdir/nettsider' },
    });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Innlesing fra fagsystemet' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre' }));

    expect(await screen.findByText(/Tilgangspolicyen Innlesing er laget/)).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api-key-policies'));
    expect(post?.body).toMatchObject({
      name: 'Innlesing',
      scopes: ['query', 'ingest'],
      datasets: ['digdir/kudos', 'digdir/nettsider'],
    });
    expect(post?.reason).toBe('Innlesing fra fagsystemet');
  });

  it('offers a policy only to keys that are not bound to one service', async () => {
    const { section } = await renderKeys();
    await within(section).findByRole('button', { name: 'Velg tilgangspolicy for Fagsystemet' });
    expect(
      within(section).queryByRole('button', {
        name: 'Velg tilgangspolicy for Kunnskapsassistenten-nøkkel',
      }),
    ).toBeNull();
  });

  it('attaches a policy to a key with a reason', async () => {
    const { calls, section } = await renderKeys();
    fireEvent.click(
      await within(section).findByRole('button', { name: 'Velg tilgangspolicy for Fagsystemet' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Velg tilgangspolicy for Fagsystemet',
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Bruk' }));
    expect(within(dialog).getByText(/minst 10 tegn/)).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText('Ingen'));
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Nøkkelen skal ikke ha policy' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bruk' }));

    expect(await screen.findByText(/Tilgangspolicyen til Fagsystemet er endret/)).toBeTruthy();
    const call = calls.find((c) => c.url.endsWith('/api-keys/key-gammel/policy'));
    expect(call?.method).toBe('DELETE');
    expect(call?.reason).toBe('Nøkkelen skal ikke ha policy');
  });

  it('refuses to remove a policy that keys still use and explains why', async () => {
    const { section } = await renderKeys();
    fireEvent.click(await within(section).findByRole('button', { name: /Bare klarspråk/ }));
    fireEvent.click(within(section).getByRole('button', { name: 'Fjern' }));

    expect(within(section).getByText(/brukes av 1 nøkler og kan ikke fjernes/)).toBeTruthy();
  });
});

describe('Integrations: access policies in English', () => {
  it('shows the policy section without Norwegian text', async () => {
    const api = createApiClient({ baseUrl: '/api', fetch: mockFetch(), token: () => 'test' });
    render(
      inEnglish(
        <Integrations
          api={api}
          tenant="999888777"
          tenantName="Testetaten"
          route={parseRoute('#/integrations?tab=keys')}
          live
        />,
      ),
    );

    const section = await screen.findByRole('region', { name: 'Access policies' });
    expect(await within(section).findByText('Used by 1 keys')).toBeTruthy();
    expect(within(section).getByText(/collects scopes and grants/)).toBeTruthy();
    expect(section.textContent).not.toMatch(/Tilgang|Brukes av|Lag /);
  });
});
