// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../mock';
import { expectAccessible, failingFetch, go, renderAt } from '../test-utils';
import { parseYaml } from '../yaml';

const serviceExamples = Object.entries(
  import.meta.glob<string>('../../../../packages/definitions/examples/*.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
).filter(([, text]) => /^kind: Service$/m.test(text));

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
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
}

const recording = () => {
  const calls: Call[] = [];
  const base = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    });
    return base(input, init);
  };
  return { calls, fetch };
};

const openBuilder = async (hash: string, name: string, fetch?: typeof globalThis.fetch) => {
  await renderAt(hash, fetch);
  await screen.findByRole('heading', { level: 1, name });
};

const navLink = (name: string) =>
  within(screen.getByRole('navigation', { name: 'Tjenesten' })).getByRole('link', { name });

const yamlField = () => screen.getByLabelText('Tjenestedefinisjon (YAML)') as HTMLTextAreaElement;

describe('service list', () => {
  it('lists services from the design and the live API, with filters and search', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/services', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Tjenester' });
    expect(calls.some((c) => /\/tenants\/[^/]+\/definitions$/.test(c.url))).toBe(true);
    expect(screen.getByRole('link', { name: 'Rapportassistenten' }).getAttribute('href')).toBe(
      '#/services/rapportassistenten',
    );
    expect(screen.getByRole('link', { name: 'Postsortering' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ny tjeneste' })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'I test' }));
    expect(screen.queryByRole('link', { name: 'Rapportassistenten' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Søknadsuttrekk' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Søk i tjenester'), { target: { value: 'zzz' } });
    expect(screen.getByText('Ingen tjenester passer søket')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill søk og filter' }));
    expect(screen.getByRole('link', { name: 'Rapportassistenten' })).toBeTruthy();
    expectAccessible();
  });

  it('shows an error with retry when the list cannot be loaded', async () => {
    await renderAt('#/services', failingFetch(/\/definitions$/));
    expect(await screen.findByRole('button', { name: /Prøv igjen/ })).toBeTruthy();
  });
});

describe('new service', () => {
  it('opens the builder with the form and the assistant straight away', async () => {
    await renderAt('#/services/new');
    await screen.findByRole('heading', { level: 1, name: 'Ny tjeneste' });
    expect(screen.queryByRole('heading', { name: 'Lag med KI' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Formål og målgruppe' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Byggeassistent' })).toBeTruthy();
    expectAccessible();
  });
});

describe('builder', () => {
  it('loads a service with one header and one navigation covering every section', async () => {
    const { calls, fetch } = recording();
    await openBuilder('#/services/rapportassistenten', 'Rapportassistenten', fetch);
    expect(calls.some((c) => c.url.endsWith('/definitions/services/rapportassistenten'))).toBe(
      true,
    );
    const nav = screen.getByRole('navigation', { name: 'Tjenesten' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Oversikt', '#/services/rapportassistenten'],
      ['Oppsett', '#/services/rapportassistenten/setup'],
      ['Test', '#/services/rapportassistenten/test'],
      ['Kanaler og frontend', '#/services/rapportassistenten/channels'],
      ['Innstillinger', '#/services/rapportassistenten/settings'],
      ['Kvalitet', '#/services/rapportassistenten/quality'],
      ['Samlet jobb', '#/services/rapportassistenten/batch'],
      ['Versjoner', '#/services/rapportassistenten/versions'],
      ['Logg', '#/services/rapportassistenten/log'],
    ]);
    expect(navLink('Oversikt').getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 2, name: 'Hva tjenesten gjør' })).toBeTruthy();
    expect(screen.getByText('Utkast basert på versjon 7 · lagres automatisk')).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Byggeassistent' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Brødsmuler' })).toBeNull();
    expectAccessible();

    go('#/services/rapportassistenten/versions');
    expect(await screen.findByText('Versjon 7')).toBeTruthy();
    expect(navLink('Versjoner').getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Versjon 6')).toBeTruthy();
    expect(screen.getByText('Begrunnelse: Strammere krav til kilder')).toBeTruthy();
    expectAccessible();
  });

  it.each([
    ['/setup', 'Oppsett', /^Formål og målgruppe/],
    ['/settings', 'Innstillinger', /Eksporter og importer/],
    ['/quality', 'Kvalitet', /Testsett/],
    ['/log', 'Logg', /Kjøringer/],
    ['/channels', 'Kanaler og frontend', /Start og kanaler/],
  ])('deep-links %s inside the same page', async (path, label, content) => {
    await openBuilder(`#/services/rapportassistenten${path}`, 'Rapportassistenten');
    expect(navLink(label).getAttribute('aria-current')).toBe('page');
    expect((await screen.findAllByText(content)).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it.each([
    ['/how-it-works', '#/services/rapportassistenten/setup/how'],
    ['?tab=oppsett', '#/services/rapportassistenten/setup'],
    ['?tab=test', '#/services/rapportassistenten/test'],
    ['?tab=yaml', '#/services/rapportassistenten/versions?view=yaml'],
    ['?tab=versjoner', '#/services/rapportassistenten/versions'],
    ['/unknown', '#/services/rapportassistenten'],
  ])('redirects the old route %s', async (old, target) => {
    await openBuilder(`#/services/rapportassistenten${old}`, 'Rapportassistenten');
    await waitFor(() => expect(window.location.hash).toBe(target));
  });

  it('opens the shared playground for the conversation service tweak', async () => {
    await renderAt('#/services?visning=samtaletjeneste');
    await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
    await waitFor(() => expect(navLink('Test').getAttribute('aria-current')).toBe('page'));
    expect(await screen.findByRole('region', { name: 'Prøv et oppsett' })).toBeTruthy();
    expect(await screen.findByText(/Tjeneste: Rapportassistenten, utkast/)).toBeTruthy();
    expectAccessible();
  });

  it.each([
    ['uttrekk-samtale', 'Oppsett'],
    ['uttrekk-inn-og-ut', 'Oppsett'],
    ['uttrekk-prove', 'Test'],
    ['uttrekk-yaml', 'Versjoner'],
  ])('reaches the %s tweak', async (tweak, tab) => {
    await renderAt(`#/services?visning=${tweak}`);
    await screen.findByRole('heading', { level: 1, name: 'Søknadsuttrekk' });
    await waitFor(() => expect(navLink(tab).getAttribute('aria-current')).toBe('page'));
    expectAccessible();
  });

  it('reaches the list and new tweaks', async () => {
    await renderAt('#/services/rapportassistenten?visning=ny');
    expect(await screen.findByRole('heading', { level: 1, name: 'Ny tjeneste' })).toBeTruthy();
    go('#/services?visning=liste');
    expect(await screen.findByRole('heading', { level: 1, name: 'Tjenester' })).toBeTruthy();
  });

  it('shows not found for an unknown service and an error when loading fails', async () => {
    await renderAt('#/services/finnes-ikke');
    expect(await screen.findByText('Fant ikke tjenesten')).toBeTruthy();
    cleanup();
    await renderAt(
      '#/services/rapportassistenten',
      failingFetch(/definitions\/services\/rapportassistenten/),
    );
    expect(await screen.findByRole('button', { name: /Prøv igjen/ })).toBeTruthy();
  });

  it('answers in the assistant and shows the change in the setup', async () => {
    await openBuilder('#/services/soknadsuttrekk/setup', 'Søknadsuttrekk');
    fireEvent.click(screen.getByRole('button', { name: 'Hva koster dette?' }));
    expect(await screen.findByText(/kr per 1000 kjøringer/, {}, { timeout: 2000 })).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Vis endring: Valgte modell: Qwen3.8-27B' }),
    );
    expect(screen.getByRole('button', { name: /^Modell/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Angre: Valgte modell: Qwen3.8-27B' }));
    expect(
      screen.getByRole('button', { name: 'Gjør om: Valgte modell: Qwen3.8-27B' }),
    ).toBeTruthy();
  });
});

describe('risk level and v3 checks', () => {
  const openPurpose = async () => {
    await openBuilder('#/services/soknadsuttrekk/setup', 'Søknadsuttrekk');
    fireEvent.click(screen.getByRole('button', { name: /^Risiko og KI-forordningen/ }));
  };

  it('lets the user confirm the proposed risk level', async () => {
    await openPurpose();
    expect(screen.getByText('Assistenten foreslår: Begrenset risiko')).toBeTruthy();
    expect(
      screen.getByText('Ansatte bruker resultatene, men tjenesten tar ikke beslutninger om folk.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Formål og målgruppe/ }));
    const audience = screen.getByLabelText(/Innbyggere og næringsliv · Kommer senere/);
    expect(audience.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Bekreft risikonivå' }));
    expect(screen.getByText('Bekreftet av Kari Nordmann i dag')).toBeTruthy();
    expectAccessible();
  });

  it('stops the service when a prohibited use is ticked', async () => {
    await openPurpose();
    const legend = screen.getByText('Først: skal tjenesten gjøre noe av dette?');
    const box = within(legend.closest('fieldset') as HTMLElement).getAllByRole('checkbox')[0];
    fireEvent.click(box as HTMLElement);
    expect(screen.getByText(/Tjenesten kan ikke lages slik/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Bekreft risikonivå' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(confirm);
    expect(screen.queryByText('Bekreftet av Kari Nordmann i dag')).toBeNull();
  });

  it('offers a table output only when the service runs a fixed step flow', async () => {
    await openBuilder('#/services/soknadsuttrekk/setup', 'Søknadsuttrekk');
    const open = (section: RegExp) => {
      const toggle = screen.getAllByRole('button', { name: section })[0] as HTMLElement;
      if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
    };
    const table = () =>
      screen.getByRole('radio', { name: /Tabell med kilder/ }) as HTMLInputElement;
    open(/^Inn og ut/);
    expect(table().disabled).toBe(true);
    open(/^Arbeidsmåte/);
    const way = () => screen.getByLabelText('Arbeidsmåte') as HTMLSelectElement;
    fireEvent.change(way(), { target: { value: 'step-flow' } });
    expect(table().disabled).toBe(false);
    fireEvent.click(table());
    expect(table().checked).toBe(true);
    expect(screen.queryByText(/Bare en fast stegflyt kan lage en tabell/)).toBeNull();
    fireEvent.change(way(), { target: { value: 'single-call' } });
    expect(screen.getByText(/Bare en fast stegflyt kan lage en tabell/)).toBeTruthy();
  });

  it('warns when an output field would be emptied by the PII filter', async () => {
    await openBuilder('#/services/soknadsuttrekk/setup', 'Søknadsuttrekk');
    expect(screen.getByText(/Feltet blir da tomt/)).toBeTruthy();
  });
});

describe('developer view', () => {
  it('shows the shared schema YAML and validates it against the API', async () => {
    const { calls, fetch } = recording();
    await openBuilder('#/services/soknadsuttrekk/versions?view=yaml', 'Søknadsuttrekk', fetch);
    const text = yamlField().value;
    expect(text).toContain('kind: Service');
    expect(text).toMatch(
      /metadata:\n {2}tenant: '\d+'\n {2}id: soknadsuttrekk\n {2}name: Søknadsuttrekk\n {2}version: 2/,
    );
    expect(text).toContain('id: single-call');
    expect(text).toContain('- enhetsregisteret@1');
    expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Sjekk mot skjemaet' }));
    expect(await screen.findByText('Definisjonen følger skjemaet.')).toBeTruthy();
    const call = calls.find((c) => c.url.endsWith('/definitions/validate'));
    expect((call?.body as { definition: unknown }).definition).toBe(text);

    fireEvent.change(yamlField(), { target: { value: `${text}steps: []\n` } });
    fireEvent.click(screen.getByRole('button', { name: 'Sjekk mot skjemaet' }));
    expect(await screen.findByText('Definisjonen følger ikke skjemaet:')).toBeTruthy();
    expect(screen.getByText('spec.steps')).toBeTruthy();
  });

  it('applies and discards YAML edits', async () => {
    await renderAt('#/services/new/versions');
    await screen.findByLabelText('Tjenestedefinisjon (YAML)');
    const apply = screen.getByRole('button', { name: 'Bruk endringene' });
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(yamlField(), {
      target: {
        value: yamlField().value.replace('name: ny-tjeneste', 'name: Ny test'),
      },
    });
    fireEvent.click(apply);
    expect(await screen.findByRole('heading', { level: 1, name: 'Ny test' })).toBeTruthy();
    expect(screen.getByText('Endringene er brukt i oppsettet.')).toBeTruthy();

    fireEvent.change(yamlField(), { target: { value: 'kind: [' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forkast' }));
    expect(screen.getByText('Endringene er forkastet.')).toBeTruthy();
    expect(yamlField().value).toContain('kind: Service');
  });
});

describe('pasting the example definitions', () => {
  it.each(serviceExamples)('applies %s in the builder YAML tab', async (_, text) => {
    await renderAt('#/services/new/versions');
    await screen.findByLabelText('Tjenestedefinisjon (YAML)');
    fireEvent.change(yamlField(), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));
    expect(await screen.findByText('Endringene er brukt i oppsettet.')).toBeTruthy();
    const { metadata } = parseYaml(text) as { metadata: { name: string } };
    expect(screen.getByRole('heading', { level: 1, name: metadata.name })).toBeTruthy();
    expect(screen.queryByText(/^Linje \d+/)).toBeNull();
  });
});

describe('versions', () => {
  it('compares and rolls back to a live version', async () => {
    const { calls, fetch } = recording();
    await openBuilder('#/services/rapportassistenten/versions', 'Rapportassistenten', fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Sammenlign med utkastet, versjon 6' }));
    expect(screen.getByText('Endret i utkastet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rull tilbake hit, versjon 6' }));
    expect(screen.getByText(/Utkastet får de samme innstillingene som versjon 6/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rull tilbake' }));
    expect(
      await screen.findByText('Utkastet er tilbakestilt til versjon 6. Ingenting er publisert.'),
    ).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/rapportassistenten/versions/6'))).toBe(true);
    expectAccessible();
  });
});

describe('publishing', () => {
  it('blocks publishing until the risk level is confirmed', async () => {
    await openBuilder('#/services?visning=uttrekk-publiser', 'Søknadsuttrekk');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Publiser Søknadsuttrekk' })).toBeTruthy();
    expect(within(dialog).getByText(/Publiser erstatter versjonen som er i bruk/)).toBeTruthy();
    expect(within(dialog).getByText(/Uten testsett ser du ikke/)).toBeTruthy();
    expect(within(dialog).getByText('Risikonivå bekreftet')).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Publiser' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gå til risikonivå' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Bekreft risikonivå' })).toBeTruthy();
  });

  it('publishes with a reason through the API', async () => {
    const { calls, fetch } = recording();
    await openBuilder('#/services/rapportassistenten/setup', 'Rapportassistenten', fetch);
    fireEvent.click(screen.getByRole('button', { name: /^Risiko og KI-forordningen/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Bekreft risikonivå' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Publiser' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    const publish = within(dialog).getByRole('button', { name: 'Publiser' });
    fireEvent.click(publish);
    expect(within(dialog).getByText(/minst 10 tegn/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Bekreftet risikonivå før lansering' },
    });
    fireEvent.click(publish);
    expect(await screen.findByText('Versjon 8 er publisert.')).toBeTruthy();
    const call = calls.find((c) => c.method === 'POST' && c.url.endsWith('/definitions'));
    expect(decodeURIComponent(call?.headers.get('change-reason') ?? '')).toBe(
      'Bekreftet risikonivå før lansering',
    );
    const definition = (call?.body as { definition: Record<string, Record<string, unknown>> })
      .definition;
    expect(definition.metadata?.version).toBe(8);
    expect(definition.spec?.riskConfirmation).toBeTruthy();
    go('#/services/rapportassistenten/versions');
    expect(await screen.findByText('Versjon 8')).toBeTruthy();
  });

  it('publishes to test without changing the live version', async () => {
    await openBuilder('#/services/rapportassistenten', 'Rapportassistenten');
    fireEvent.click(screen.getByRole('button', { name: 'Publiser til test' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Publiser til test gjør versjonen tilgjengelig/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publiser til test' }));
    expect(await screen.findByText('Versjon 8 er publisert til test.')).toBeTruthy();
  });
});

describe('narrow screens', () => {
  it('switches between the assistant and the service', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      await openBuilder('#/services/soknadsuttrekk/setup', 'Søknadsuttrekk');
      expect(screen.getByRole('tab', { name: 'Assistent' }).getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(screen.queryByRole('button', { name: /^Formål og målgruppe/ })).toBeNull();
      fireEvent.click(screen.getByRole('tab', { name: 'Tjenesten' }));
      expect(await screen.findByRole('button', { name: /^Formål og målgruppe/ })).toBeTruthy();
      expectAccessible();
    } finally {
      window.matchMedia = original;
    }
  });
});
