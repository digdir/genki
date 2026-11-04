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
  datasets: [
    {
      service: 'rapportassistenten',
      testSet: 'rapport-kjerne',
      name: 'genki/rapportassistenten/rapport-kjerne',
      id: 'ds-1',
    },
  ],
};

const digdirHost = 'https://langfuse.digdir.cloud';

const own = {
  ...digdir,
  id: 'etaten',
  host: 'https://langfuse.etaten.example.no',
  publicKey: 'pk-lf-etaten',
  secretKey: 'secret://tenant/999888777/langfuse-etaten',
  services: ['postsortering'],
  residency: 'eu',
  instance: false,
  residencySetBy: 'tenant',
  datasets: [],
};

const renderTracing = async (
  options: {
    connections?: Record<string, unknown>[];
    instance?: { host: string; content: boolean } | null;
    /** The agency's services, or a failure to read them; the portal's mock otherwise. */
    services?: { id: string; name: string; lifecycle?: string }[] | 'fail';
  } = {},
) => {
  const calls: Call[] = [];
  const saved: Record<string, unknown>[] = [...(options.connections ?? [digdir])];
  const instance =
    options.instance === null
      ? undefined
      : (options.instance ?? { host: digdirHost, content: false });
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
    if (/\/tenants\/[^/]+\/services$/.test(path) && method === 'GET' && options.services)
      return options.services === 'fail'
        ? Response.json({ title: 'Internal error' }, { status: 500 })
        : Response.json({
            data: options.services.map((x) => ({ lifecycle: 'active', ...x })),
          });
    if (/\/tracing\/connections$/.test(path) && method === 'GET')
      return Response.json({ data: saved, ...(instance ? { instance } : {}) });
    const put = /\/tracing\/connections\/([^/]+)$/.exec(path);
    if (put && method === 'PUT') {
      const onInstance = body?.host === instance?.host;
      const connection = {
        residency: 'global',
        ...body,
        id: put[1],
        instance: onInstance,
        residencySetBy: onInstance ? 'operator' : 'tenant',
      };
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

  it("lists the connection's Langfuse datasets under their own heading, one per test set", async () => {
    const { section } = await renderTracing();
    await within(section).findByText('https://langfuse.digdir.cloud');

    expect(within(section).getByRole('heading', { name: 'Datasett i Langfuse' })).toBeTruthy();
    const list = within(section).getByRole('list', { name: 'Datasett i Langfuse' });
    expect(within(list).getByText('genki/rapportassistenten/rapport-kjerne')).toBeTruthy();
    expect(
      within(section).getByText(
        /^Ett datasett per testsett i tjenestene koblingen dekker\. Hver testkjøring som sendes til Langfuse, knyttes til datasettet til sitt testsett\./,
      ),
    ).toBeTruthy();
    await expectAccessible(section);
  });

  it("tells agencies to pick the test set's dataset in a judge's filter in Langfuse", async () => {
    const { section } = await renderTracing();
    await within(section).findByText('https://langfuse.digdir.cloud');

    expect(
      within(section).getByText(
        /For å la en dommer vurdere ett testsett, velg datasettet i filteret til dommeren i Langfuse, sammen med isExperimentItemRootSpan = true\./,
      ),
    ).toBeTruthy();
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
    fill('Langfuse', 'own');
    fill('Id for koblingen', 'etaten');
    fill('Adresse', 'https://langfuse.etaten.example.no');
    fill('Offentlig nøkkel', 'pk-lf-etaten');
    fill('Hemmelig nøkkel', 'sk-lf-etaten');
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Postsortering' }));
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Møtereferat' }));
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
        services: ['postsortering', 'motereferat'],
        residency: 'norway',
        content: false,
        erasureDeclared: false,
      },
    });
  });

  it('brings labels back from a tracing connection only while its labels switch is on', async () => {
    const { calls, section } = await renderTracing();
    const card = (await within(section).findByText('https://langfuse.digdir.cloud')).closest(
      'li',
    ) as HTMLElement;
    expect(within(card).queryByText('Henter etiketter')).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Endre' }));
    const form = within(section).getByRole('form');
    const labels = within(form).getByRole('switch', {
      name: /Hent etiketter fra Langfuse som kalibreringsetiketter/,
    }) as HTMLInputElement;
    expect(labels.checked).toBe(false);
    expect(
      within(form).getByText(
        /En operatør henter dem i driftskonsollen, og de teller først når operatøren godtar dem/,
      ),
    ).toBeTruthy();
    fireEvent.click(labels);
    fireEvent.change(within(form).getByLabelText(/Begrunnelse/), {
      target: { value: 'Teamet merker svar i Langfuse' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(await within(section).findByText('Henter etiketter')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: expect.stringMatching(/\/tracing\/connections\/digdir$/),
      reason: 'Teamet merker svar i Langfuse',
      body: { labels: true },
    });
  });

  it('asks for another name rather than replacing a connection that has it', async () => {
    const { calls, section } = await renderTracing();
    await within(section).findByText('https://langfuse.digdir.cloud');

    fireEvent.click(within(section).getByRole('button', { name: 'Koble til Langfuse' }));
    const form = within(section).getByRole('form', { name: 'Ny Langfuse-kobling' });
    const fill = (label: string, value: string) =>
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    fill('Langfuse', 'own');
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

  it('shows a connection being removed as such, without letting anyone edit it', async () => {
    const removing = {
      ...digdir,
      id: 'etaten',
      host: 'https://langfuse.etaten.example.no',
      removing: true,
    };
    const auth = mockAnsattporten({ name: 'Kari Nordmann', organisations: exampleOrganisations });
    await auth.login();
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return /\/tracing\/connections$/.test(new URL(url, 'http://localhost').pathname)
        ? Response.json({ data: [removing] })
        : base(input, init);
    };
    window.location.hash = '#/integrations?tab=tracing';
    render(<App auth={auth} fetch={fetch} live />);
    const section = await screen.findByRole('region', { name: 'Langfuse' });

    expect(await within(section).findByText('Fjernes: sletter det som er sendt')).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'Endre' })).toBeNull();
  });

  it('refuses an id with anything but small letters, digits and hyphens, in the language of the portal', async () => {
    const { calls, section } = await renderTracing();
    await within(section).findByText('https://langfuse.digdir.cloud');

    fireEvent.click(within(section).getByRole('button', { name: 'Koble til Langfuse' }));
    const form = within(section).getByRole('form', { name: 'Ny Langfuse-kobling' });
    const fill = (label: string, value: string) =>
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    fill('Langfuse', 'own');
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
    fireEvent.click(within(first.form).getByRole('checkbox', { name: 'Postsortering' }));
    fireEvent.click(within(first.form).getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText('Koblingen digdir er lagret.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT')).toMatchObject([
      { body: { secretKey: 'secret://tenant/999888777/langfuse-digdir' } },
    ]);

    const second = edit();
    second.fill('Langfuse', 'own');
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

describe('Integrasjoner: Langfuse, picked from lists', () => {
  const newForm = async (options?: Parameters<typeof renderTracing>[0]) => {
    const rendered = await renderTracing(options);
    await within(rendered.section).findByRole('button', { name: 'Koble til Langfuse' });
    fireEvent.click(within(rendered.section).getByRole('button', { name: 'Koble til Langfuse' }));
    const form = within(rendered.section).getByRole('form', { name: 'Ny Langfuse-kobling' });
    const fill = (label: string, value: string) =>
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    const reason = (value = 'Teamet bruker Langfuse til dommere') =>
      fireEvent.change(within(form).getByLabelText(/Begrunnelse/), { target: { value } });
    return { ...rendered, form, fill, reason };
  };
  const editForm = async (id: string, options?: Parameters<typeof renderTracing>[0]) => {
    const rendered = await renderTracing(options);
    const card = (await within(rendered.section).findByRole('heading', { name: id })).closest(
      'li',
    ) as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Endre' }));
    const form = within(rendered.section).getByRole('form', { name: 'Endre Langfuse-koblingen' });
    const reason = (value = 'Teamet rydder i Langfuse-koblingen') =>
      fireEvent.change(within(form).getByLabelText(/Begrunnelse/), { target: { value } });
    return { ...rendered, form, reason };
  };
  const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT');

  it("connects to Digdir's Langfuse without typing its address", async () => {
    const { calls, form, fill, reason, section } = await newForm({ connections: [] });

    expect((within(form).getByLabelText('Langfuse') as HTMLSelectElement).value).toBe('instance');
    expect(
      within(form).getByText('Digdirs Langfuse er https://langfuse.digdir.cloud.'),
    ).toBeTruthy();
    fill('Offentlig nøkkel', 'pk-lf-digdir');
    fill('Hemmelig nøkkel', 'sk-lf-digdir');
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Rapportassistenten' }));
    reason();
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(await screen.findByText('Koblingen digdir-langfuse er lagret.')).toBeTruthy();
    expect(await within(section).findByText(digdirHost)).toBeTruthy();
    expect(puts(calls)).toMatchObject([
      {
        url: expect.stringMatching(/\/secrets\/langfuse-digdir-langfuse$/),
        body: { value: 'sk-lf-digdir', allowedHosts: [digdirHost] },
      },
      {
        url: expect.stringMatching(/\/tracing\/connections\/digdir-langfuse$/),
        body: { host: digdirHost, publicKey: 'pk-lf-digdir', services: ['rapportassistenten'] },
      },
    ]);
  });

  it("asks for the address only for the agency's own Langfuse", async () => {
    const { form, fill } = await newForm();

    expect(within(form).queryByLabelText('Adresse')).toBeNull();
    fill('Langfuse', 'own');
    expect((within(form).getByLabelText('Adresse') as HTMLInputElement).value).toBe('');
    fill('Langfuse', 'instance');
    expect(within(form).queryByLabelText('Adresse')).toBeNull();
  });

  it("picks the services from the agency's own services, by name", async () => {
    const { calls, form, fill, reason } = await newForm({ connections: [] });

    const group = within(form).getByRole('group', { name: /^Tjenester/ });
    for (const name of [
      'Rapportassistenten',
      'Postsortering',
      'Møtereferat',
      'Vedtaksutkast',
      'Nettsider på nynorsk',
    ])
      expect(within(group).getByRole('checkbox', { name })).toBeTruthy();
    expect(within(form).queryByRole('textbox', { name: 'Tjenester' })).toBeNull();
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Nettsider på nynorsk' }));
    fill('Offentlig nøkkel', 'pk-lf-digdir');
    fill('Hemmelig nøkkel', 'sk-lf-digdir');
    reason();
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(await screen.findByText('Koblingen digdir-langfuse er lagret.')).toBeTruthy();
    expect(puts(calls)[1]).toMatchObject({ body: { services: ['nettsider-nynorsk'] } });
  });

  it('shows a service another connection covers as taken, naming that connection', async () => {
    const { form } = await newForm();

    const taken = within(form).getByRole('checkbox', {
      name: 'Rapportassistenten',
    }) as HTMLInputElement;
    expect(taken.disabled).toBe(true);
    expect(taken.checked).toBe(false);
    expect(within(form).getByText('Koblet til digdir')).toBeTruthy();
    expect(
      (within(form).getByRole('checkbox', { name: 'Postsortering' }) as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it('shows a stored service id that is not a service, ticked, so it can be unticked', async () => {
    const typo = { ...own, services: ['postsortering', 'fqa'] };
    const { calls, form, reason } = await editForm('etaten', { connections: [digdir, typo] });

    const unknown = within(form).getByRole('checkbox', {
      name: 'fqa (finnes ikke)',
    }) as HTMLInputElement;
    expect(unknown.checked).toBe(true);
    fireEvent.click(unknown);
    reason();
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(await screen.findByText('Koblingen etaten er lagret.')).toBeTruthy();
    expect(puts(calls)).toMatchObject([{ body: { services: ['postsortering'] } }]);
  });

  it("shows Digdir's residency as set by Digdir and leaves it out of the save", async () => {
    const { calls, form, fill, reason } = await newForm({ connections: [] });

    expect(within(form).queryByRole('combobox', { name: 'Lagringssted' })).toBeNull();
    expect(
      within(form).getByText('Lagringssted: ikke avklart (global), satt av Digdir'),
    ).toBeTruthy();
    fill('Offentlig nøkkel', 'pk-lf-digdir');
    fill('Hemmelig nøkkel', 'sk-lf-digdir');
    reason();
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(await screen.findByText('Koblingen digdir-langfuse er lagret.')).toBeTruthy();
    expect(puts(calls)[1]?.body).not.toHaveProperty('residency');
    cleanup();

    const edited = await editForm('digdir', {
      connections: [{ ...digdir, residency: 'eu' }],
    });
    expect(within(edited.form).getByText('Lagringssted: i EU/EØS, satt av Digdir')).toBeTruthy();
  });

  it("offers Send tekst for Digdir's Langfuse only when it may receive text, or already does", async () => {
    const closed = await newForm({ connections: [] });
    expect(within(closed.form).queryByRole('switch', { name: /Send tekst/ })).toBeNull();
    closed.fill('Langfuse', 'own');
    expect(within(closed.form).getByRole('switch', { name: /Send tekst/ })).toBeTruthy();
    cleanup();

    const open = await newForm({ connections: [], instance: { host: digdirHost, content: true } });
    expect(within(open.form).getByRole('switch', { name: /Send tekst/ })).toBeTruthy();
    cleanup();

    const already = await editForm('digdir', { connections: [{ ...digdir, content: true }] });
    const sends = within(already.form).getByRole('switch', {
      name: /Send tekst/,
    }) as HTMLInputElement;
    expect(sends.checked).toBe(true);
    fireEvent.click(sends);
    already.reason();
    fireEvent.click(within(already.form).getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText('Koblingen digdir er lagret.')).toBeTruthy();
    expect(puts(already.calls)).toMatchObject([{ body: { content: false } }]);
  });

  it("asks for the erasure declaration only for the agency's own Langfuse, and only with text on", async () => {
    const declaration = /Vi bekrefter at vår Langfuse sletter det genki sletter/;
    const { form, fill } = await newForm({
      connections: [],
      instance: { host: digdirHost, content: true },
    });

    fireEvent.click(within(form).getByRole('switch', { name: /Send tekst/ }));
    expect(within(form).queryByRole('checkbox', { name: declaration })).toBeNull();
    fill('Langfuse', 'own');
    expect(within(form).getByRole('checkbox', { name: declaration })).toBeTruthy();
    fireEvent.click(within(form).getByRole('switch', { name: /Send tekst/ }));
    expect(within(form).queryByRole('checkbox', { name: declaration })).toBeNull();
  });

  it('fills in the id from the Langfuse chosen, with -2 when taken, until the person types one', async () => {
    const taken = { ...own, id: 'egen-langfuse' };
    const { form, fill } = await newForm({ connections: [digdir, taken] });
    const id = () => (within(form).getByLabelText('Id for koblingen') as HTMLInputElement).value;

    expect(id()).toBe('digdir-langfuse');
    fill('Langfuse', 'own');
    expect(id()).toBe('egen-langfuse-2');
    fill('Id for koblingen', 'etatens-langfuse');
    fill('Langfuse', 'instance');
    expect(id()).toBe('etatens-langfuse');
  });

  it('shows only the address field where there is no Digdir Langfuse', async () => {
    const { form } = await newForm({ connections: [], instance: null });

    expect(within(form).queryByLabelText('Langfuse')).toBeNull();
    expect(within(form).getByLabelText('Adresse')).toBeTruthy();
    expect(within(form).getByRole('combobox', { name: 'Lagringssted' })).toBeTruthy();
    expect((within(form).getByLabelText('Id for koblingen') as HTMLInputElement).value).toBe(
      'egen-langfuse',
    );
  });

  it("edits a connection to Digdir's Langfuse and one to the agency's own with the right choice made", async () => {
    const digdirs = await editForm('digdir', { connections: [digdir, own] });
    expect((within(digdirs.form).getByLabelText('Langfuse') as HTMLSelectElement).value).toBe(
      'instance',
    );
    expect(within(digdirs.form).queryByLabelText('Adresse')).toBeNull();
    expect(
      (
        within(digdirs.form).getByRole('checkbox', {
          name: 'Rapportassistenten',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    cleanup();

    const owns = await editForm('etaten', { connections: [digdir, own] });
    expect((within(owns.form).getByLabelText('Langfuse') as HTMLSelectElement).value).toBe('own');
    expect((within(owns.form).getByLabelText('Adresse') as HTMLInputElement).value).toBe(
      'https://langfuse.etaten.example.no',
    );
    expect(
      (within(owns.form).getByRole('combobox', { name: 'Lagringssted' }) as HTMLSelectElement)
        .value,
    ).toBe('eu');
    owns.reason();
    fireEvent.click(within(owns.form).getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText('Koblingen etaten er lagret.')).toBeTruthy();
    expect(puts(owns.calls)).toMatchObject([
      {
        body: {
          host: 'https://langfuse.etaten.example.no',
          residency: 'eu',
          services: ['postsortering'],
        },
      },
    ]);
  });

  it("keeps the address a connection to Digdir's Langfuse was saved with", async () => {
    const slash = { ...digdir, host: `${digdirHost}/` };
    const { calls, form, reason } = await editForm('digdir', { connections: [slash] });

    reason();
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(await screen.findByText('Koblingen digdir er lagret.')).toBeTruthy();
    expect(puts(calls)).toMatchObject([{ body: { host: `${digdirHost}/` } }]);
  });

  it('lets a service two connections cover be unticked, so either can be saved', async () => {
    const twice = { ...own, services: ['rapportassistenten'] };
    const { calls, form, reason } = await editForm('etaten', { connections: [digdir, twice] });

    const box = within(form).getByRole('checkbox', {
      name: 'Rapportassistenten',
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    fireEvent.click(box);
    reason();
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(await screen.findByText('Koblingen etaten er lagret.')).toBeTruthy();
    expect(puts(calls)).toMatchObject([{ body: { services: [] } }]);
  });

  it("does not show a connection's own services as taken by itself", async () => {
    const { form } = await editForm('digdir', { connections: [digdir] });

    const box = within(form).getByRole('checkbox', {
      name: 'Rapportassistenten',
    }) as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(within(form).queryByText('Koblet til digdir')).toBeNull();
  });

  it("sends no text and no declaration when Digdir's Langfuse is chosen after the agency's own", async () => {
    const { calls, form, fill, reason } = await newForm({ connections: [] });

    fill('Langfuse', 'own');
    fireEvent.click(within(form).getByRole('switch', { name: /Send tekst/ }));
    fireEvent.click(
      within(form).getByRole('checkbox', {
        name: /Vi bekrefter at vår Langfuse sletter det genki sletter/,
      }),
    );
    fill('Langfuse', 'instance');
    fill('Offentlig nøkkel', 'pk-lf-digdir');
    fill('Hemmelig nøkkel', 'sk-lf-digdir');
    reason();
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(await screen.findByText('Koblingen digdir-langfuse er lagret.')).toBeTruthy();
    expect(puts(calls)[1]).toMatchObject({ body: { content: false, erasureDeclared: false } });
  });

  it('still lists the connections when the services cannot be read, and keeps the ones saved', async () => {
    const { form, section } = await editForm('digdir', { services: 'fail' });

    expect(within(section).getByText(digdirHost)).toBeTruthy();
    expect(within(form).getByText('Fikk ikke hentet tjenestene.')).toBeTruthy();
    expect(
      (within(form).getByRole('checkbox', { name: 'rapportassistenten' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('leaves archived services out unless the connection already has them', async () => {
    const services = [
      { id: 'rapportassistenten', name: 'Rapportassistenten', lifecycle: 'archived' },
      { id: 'postsortering', name: 'Postsortering', lifecycle: 'archived' },
      { id: 'motereferat', name: 'Møtereferat' },
    ];
    const { form } = await editForm('digdir', { connections: [digdir], services });

    expect(within(form).getByRole('checkbox', { name: 'Rapportassistenten' })).toBeTruthy();
    expect(within(form).queryByRole('checkbox', { name: 'Postsortering' })).toBeNull();
    expect(within(form).getByRole('checkbox', { name: 'Møtereferat' })).toBeTruthy();
  });
});
