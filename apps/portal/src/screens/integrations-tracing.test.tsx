// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { exampleOrganisations, mockFetch } from '../mock';
import { expectAccessible } from '../test-utils';

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

const digdir = {
  id: 'digdir',
  host: 'https://langfuse.digdir.cloud',
  publicKey: 'pk-lf-digdir',
  secretKey: 'secret://tenant/991825827/langfuse-digdir',
  services: ['rapportassistenten'],
  residency: 'global',
  content: false,
  erasureDeclared: false,
  instance: true,
  residencySetBy: 'operator',
};

const renderTracing = async () => {
  const calls: Call[] = [];
  const saved: Record<string, unknown>[] = [digdir];
  const base = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({
      method,
      url,
      reason: decodeURIComponent(new Headers(init?.headers).get('change-reason') ?? ''),
      body,
    });
    const path = new URL(url, 'http://localhost').pathname;
    if (/\/tracing\/connections$/.test(path) && method === 'GET')
      return Response.json({ data: saved });
    const put = /\/tracing\/connections\/([^/]+)$/.exec(path);
    if (put && method === 'PUT') {
      const connection = { ...body, id: put[1], instance: false, residencySetBy: 'tenant' };
      saved.push(connection);
      return Response.json(connection);
    }
    if (/\/tracing\/connections\/[^/]+\/check$/.test(path))
      return Response.json({ ok: true, project: { id: 'p1', name: 'Rapportassistenten' } });
    return base(input, init);
  };
  const auth = mockAnsattporten({ name: 'Kari Nordmann', organisations: exampleOrganisations });
  await auth.login();
  window.location.hash = '#/integrations?tab=tracing';
  render(<App auth={auth} fetch={fetch} live />);
  return { calls, section: await screen.findByRole('region', { name: 'Langfuse' }) };
};

describe('Integrasjoner: Langfuse', () => {
  it('shows each connection with its services, who set its residency, and whether it gets text', async () => {
    const { section } = await renderTracing();

    expect(await within(section).findByText('https://langfuse.digdir.cloud')).toBeTruthy();
    expect(within(section).getByText('Tjenester: rapportassistenten')).toBeTruthy();
    expect(
      within(section).getByText('Lagringssted: ikke avklart (global), satt av Digdir'),
    ).toBeTruthy();
    expect(within(section).getByText('Får bare metadata')).toBeTruthy();

    fireEvent.click(within(section).getByRole('button', { name: 'Sjekk koblingen' }));
    expect(
      await within(section).findByText('Nøklene åpner prosjektet Rapportassistenten.'),
    ).toBeTruthy();
    await expectAccessible(section);
  });

  it('connects a service with a secret reference, never the key itself, and a reason', async () => {
    const { calls, section } = await renderTracing();
    await within(section).findByText('https://langfuse.digdir.cloud');

    fireEvent.click(within(section).getByRole('button', { name: 'Koble til Langfuse' }));
    const form = within(section).getByRole('form', { name: 'Ny Langfuse-kobling' });
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));
    expect(within(form).getAllByText('Fyll ut feltet').length).toBeGreaterThan(0);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    const fill = (label: string, value: string) =>
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    fill('Navn på koblingen', 'etaten');
    fill('Adresse', 'https://langfuse.etaten.example.no');
    fill('Offentlig nøkkel', 'pk-lf-etaten');
    fill('Hemmelig nøkkel', 'langfuse-etaten');
    fill('Tjenester', 'soknadsuttrekk, rapportassistenten');
    fill('Lagringssted', 'norway');
    fireEvent.change(within(form).getByLabelText(/Begrunnelse/), {
      target: { value: 'Teamet bruker Langfuse til dommere' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(await within(section).findByText('https://langfuse.etaten.example.no')).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toMatchObject({
      url: expect.stringMatching(/\/tracing\/connections\/etaten$/),
      reason: 'Teamet bruker Langfuse til dommere',
      body: {
        host: 'https://langfuse.etaten.example.no',
        publicKey: 'pk-lf-etaten',
        secretKey: expect.stringMatching(/^secret:\/\/tenant\/\d{9}\/langfuse-etaten$/),
        services: ['soknadsuttrekk', 'rapportassistenten'],
        residency: 'norway',
        content: false,
        erasureDeclared: false,
      },
    });
  });
});
