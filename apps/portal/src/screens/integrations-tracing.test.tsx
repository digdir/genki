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
  secretKey: 'secret://tenant/999888777/langfuse-digdir',
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
      const at = saved.findIndex((c) => c.id === put[1]);
      if (at >= 0) saved[at] = connection;
      else saved.push(connection);
      return Response.json(connection);
    }
    const secret = /\/secrets\/([^/]+)$/.exec(path);
    if (secret && method === 'PUT')
      return Response.json({ ref: `secret://tenant/999888777/${secret[1]}` });
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
    await expectAccessible(section);
  });

  it('says the check shows the secret key opens the project, and that Langfuse does not check the public key', async () => {
    const { section } = await renderTracing();
    await within(section).findByText('https://langfuse.digdir.cloud');

    fireEvent.click(within(section).getByRole('button', { name: 'Sjekk koblingen' }));

    expect(
      await within(section).findByText(
        'Den hemmelige nøkkelen åpner prosjektet Rapportassistenten. Langfuse sjekker ikke den offentlige nøkkelen, så se selv at den hører til samme prosjekt.',
      ),
    ).toBeTruthy();
  });

  it("stores the secret key for the connection's address alone, then saves the connection with only a reference to it", async () => {
    const { calls, section } = await renderTracing();
    await within(section).findByText('https://langfuse.digdir.cloud');

    fireEvent.click(within(section).getByRole('button', { name: 'Koble til Langfuse' }));
    const form = within(section).getByRole('form', { name: 'Ny Langfuse-kobling' });
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));
    expect(within(form).getAllByText('Fyll ut feltet').length).toBeGreaterThan(0);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    const fill = (label: string, value: string) =>
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    fill('Id for koblingen', 'etaten');
    fill('Adresse', 'https://langfuse.etaten.example.no');
    fill('Offentlig nøkkel', 'pk-lf-etaten');
    fill('Hemmelig nøkkel', 'sk-lf-etaten');
    fill('Tjenester', 'soknadsuttrekk, rapportassistenten');
    fill('Lagringssted', 'norway');
    fireEvent.change(within(form).getByLabelText(/Begrunnelse/), {
      target: { value: 'Teamet bruker Langfuse til dommere' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(await within(section).findByText('https://langfuse.etaten.example.no')).toBeTruthy();
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts[0]).toMatchObject({
      url: expect.stringMatching(/\/secrets\/langfuse-etaten$/),
      reason: 'Teamet bruker Langfuse til dommere',
      body: { value: 'sk-lf-etaten', allowedHosts: ['https://langfuse.etaten.example.no'] },
    });
    // The key goes to the secret store only, never with the connection.
    expect(JSON.stringify(puts.slice(1))).not.toContain('sk-lf-etaten');
    const put = puts[1];
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

  it('asks for another name rather than replacing a connection that has it', async () => {
    const { calls, section } = await renderTracing();
    await within(section).findByText('https://langfuse.digdir.cloud');

    fireEvent.click(within(section).getByRole('button', { name: 'Koble til Langfuse' }));
    const form = within(section).getByRole('form', { name: 'Ny Langfuse-kobling' });
    const fill = (label: string, value: string) =>
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    fill('Id for koblingen', 'digdir');
    fill('Adresse', 'https://langfuse.etaten.example.no');
    fill('Offentlig nøkkel', 'pk-lf-etaten');
    fill('Hemmelig nøkkel', 'sk-lf-etaten');
    fireEvent.change(within(form).getByLabelText(/Begrunnelse/), {
      target: { value: 'Teamet bruker Langfuse til dommere' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(
      await within(form).findByText(
        'Det finnes allerede en kobling med id-en digdir. Velg en annen, eller endre den.',
      ),
    ).toBeTruthy();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('refuses an id with anything but small letters, digits and hyphens, in the language of the portal', async () => {
    const { calls, section } = await renderTracing();
    await within(section).findByText('https://langfuse.digdir.cloud');

    fireEvent.click(within(section).getByRole('button', { name: 'Koble til Langfuse' }));
    const form = within(section).getByRole('form', { name: 'Ny Langfuse-kobling' });
    const fill = (label: string, value: string) =>
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    fill('Id for koblingen', 'Lokal Langfuse');
    fill('Adresse', 'https://langfuse.etaten.example.no');
    fill('Offentlig nøkkel', 'pk-lf-etaten');
    fill('Hemmelig nøkkel', 'sk-lf-etaten');
    fireEvent.change(within(form).getByLabelText(/Begrunnelse/), {
      target: { value: 'Teamet bruker Langfuse til dommere' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(
      await within(form).findByText(
        'Bruk bare små bokstaver, tall og bindestrek, og start med en bokstav eller et tall, for eksempel etaten-langfuse.',
      ),
    ).toBeTruthy();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('keeps the stored secret key when it is left empty, and asks for it again when the address changes', async () => {
    const { calls, section } = await renderTracing();
    await within(section).findByText('https://langfuse.digdir.cloud');
    const edit = () => {
      fireEvent.click(within(section).getByRole('button', { name: 'Endre' }));
      const form = within(section).getByRole('form', { name: 'Endre Langfuse-koblingen' });
      const fill = (label: string, value: string) =>
        fireEvent.change(within(form).getByLabelText(label), { target: { value } });
      fireEvent.change(within(form).getByLabelText(/Begrunnelse/), {
        target: { value: 'Flytter Langfuse til ny adresse' },
      });
      return { form, fill };
    };

    const first = edit();
    first.fill('Tjenester', 'rapportassistenten, soknadsuttrekk');
    fireEvent.click(within(first.form).getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText('Koblingen digdir er lagret.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT')).toMatchObject([
      { body: { secretKey: 'secret://tenant/999888777/langfuse-digdir' } },
    ]);

    const second = edit();
    second.fill('Adresse', 'https://langfuse.ny.example.no');
    fireEvent.click(within(second.form).getByRole('button', { name: 'Lagre' }));
    expect(
      await within(second.form).findByText(
        'Skriv inn den hemmelige nøkkelen på nytt når adressen endres, så den bare sendes dit.',
      ),
    ).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);

    second.fill('Hemmelig nøkkel', 'sk-lf-ny');
    fireEvent.click(within(second.form).getByRole('button', { name: 'Lagre' }));
    expect(await within(section).findByText('https://langfuse.ny.example.no')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT').slice(1)).toMatchObject([
      {
        url: expect.stringMatching(/\/secrets\/langfuse-digdir$/),
        body: { value: 'sk-lf-ny', allowedHosts: ['https://langfuse.ny.example.no'] },
      },
      { body: { secretKey: 'secret://tenant/999888777/langfuse-digdir' } },
    ]);
  });
});
