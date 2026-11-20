// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../mock';
import { expectAccessible, failingFetch, go, renderAt, renderLive } from '../test-utils';
import { parseYaml } from '../yaml';
import { openArea, setupNav } from './services/setup-areas.test-utils';

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
  within(screen.getByRole('tablist', { name: /^Faner for/ })).getByRole('tab', { name });

const subLink = (tab: string, name: string) =>
  within(screen.getByRole('tablist', { name: tab })).getByRole('tab', {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  });

const yamlField = () => screen.getByLabelText('Tjenestedefinisjon (YAML)') as HTMLTextAreaElement;

describe('service list', () => {
  it('lists services from the design and the live API, with filters and search', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/services', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Tjenester' });
    expect(
      (await screen.findByRole('link', { name: 'Rapportassistenten' })).getAttribute('href'),
    ).toBe('#/services/rapportassistenten');
    expect(calls.some((c) => /\/tenants\/[^/]+\/definitions$/.test(c.url))).toBe(true);
    expect(screen.getByRole('link', { name: 'Postsortering' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ny tjeneste' })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /^I test/ }));
    expect(screen.queryByRole('link', { name: 'Rapportassistenten' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Søknadsuttrekk' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Søk i tjenester'), { target: { value: 'zzz' } });
    expect(screen.getByText('Ingen tjenester passer søket')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill søk og filter' }));
    expect(screen.getByRole('link', { name: 'Rapportassistenten' })).toBeTruthy();
    expectAccessible();
  });

  it('names the model of each service in the list, from the service summary', async () => {
    const summary = {
      id: 'tolk',
      name: 'Tolk',
      purpose: 'Tolker tekst.',
      outputKind: 'answer',
      channels: [],
      model: { id: 'aivar/borealis-27b', residency: 'norway' },
      latestVersion: 1,
      status: 'active',
      statusReason: null,
      lifecycle: 'active',
      updatedAt: '2026-10-07T10:00:00Z',
      updatedBy: 'kari.nordmann@testetaten.example.no',
      warnings: [],
      runsThisWeek: 3,
    };
    await renderLive('#/services', {}, (url, method) =>
      method === 'GET' && /\/tenants\/[^/]+\/services$/.test(url)
        ? Response.json({ data: [summary] })
        : undefined,
    );

    const row = (await screen.findByRole('link', { name: 'Tolk' })).closest('li') as HTMLElement;
    const model = within(row).getByText('Modell', { selector: 'dt' }).nextElementSibling;
    expect(model?.textContent).toMatch(/borealis/i);
  });

  it('shows an error with retry when the list cannot be loaded', async () => {
    await renderAt('#/services', failingFetch(/\/definitions$/));
    expect(await screen.findByRole('button', { name: /Prøv igjen/ })).toBeTruthy();
  });
});

describe('the service page against the mock', () => {
  it('offers Mer with pause and archive, as users see it on the platform', async () => {
    await openBuilder('#/services/rapportassistenten', 'Rapportassistenten');

    fireEvent.click(await screen.findByRole('button', { name: 'Mer' }));
    expect(screen.getByRole('button', { name: 'Sett på pause', hidden: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Arkiver', hidden: true })).toBeTruthy();
  });
});

describe('new service', () => {
  it('opens Ny tjeneste straight in the shared Oppsett, with no job to pick first', async () => {
    await renderAt('#/services/new');
    const nav = await screen.findByRole('navigation', { name: 'Deler av oppsettet' });
    expect(within(nav).getByRole('button', { name: /^Formål og målgruppe/ })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Byggeassistent' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Lag med KI' })).toBeNull();
    expect(screen.queryByText(/^Satte jobb/)).toBeNull();
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
    const nav = screen.getByRole('tablist', { name: /^Faner for/ });
    const links = within(nav).getAllByRole('tab');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Oversikt', '#/services/rapportassistenten'],
      ['Oppsett', '#/services/rapportassistenten/setup'],
      ['Grensesnitt', '#/services/rapportassistenten/interface'],
      ['Kvalitet', '#/services/rapportassistenten/quality'],
      ['Utviklerverktøy', '#/services/rapportassistenten/versions'],
    ]);
    expect(navLink('Oversikt').getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { level: 2, name: 'Slik går det' })).toBeTruthy();
    expect(screen.getByText('Utkast basert på versjon 7 · lagres automatisk')).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Byggeassistent' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Brødsmuler' })).toBeNull();
    expectAccessible();

    go('#/services/rapportassistenten/versions');
    expect(await screen.findByText('Versjon 7')).toBeTruthy();
    expect(navLink('Utviklerverktøy').getAttribute('aria-selected')).toBe('true');
    expect(subLink('Utviklerverktøy', 'Versjoner').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Versjon 6')).toBeTruthy();
    expect(screen.getByText('«Strammere krav til kilder»')).toBeTruthy();
    expectAccessible();
  });

  it.each([
    ['/setup', 'Oppsett', undefined, /^Formål og målgruppe/],
    ['/quality', 'Kvalitet', undefined, /Testsett/],
    ['/log', 'Utviklerverktøy', 'Logg', /Logg/],
    ['/channels', 'Utviklerverktøy', 'Nøkler og kanaler', /Start og kanaler/],
  ])('deep-links %s inside the same page', async (path, label, sub, content) => {
    await openBuilder(`#/services/rapportassistenten${path}`, 'Rapportassistenten');
    expect(navLink(label).getAttribute('aria-selected')).toBe('true');
    if (sub) expect(subLink(label, sub).getAttribute('aria-selected')).toBe('true');
    expect((await screen.findAllByText(content)).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it.each([
    ['/how-it-works', '#/services/rapportassistenten/setup/how'],
    ['?tab=oppsett', '#/services/rapportassistenten/setup'],
    ['?tab=test', '#/services/rapportassistenten/test'],
    ['?tab=yaml', '#/services/rapportassistenten/definition'],
    ['/versions?view=yaml', '#/services/rapportassistenten/definition'],
    ['?tab=versjoner', '#/services/rapportassistenten/versions'],
    ['/unknown', '#/services/rapportassistenten'],
  ])('redirects the old route %s', async (old, target) => {
    await openBuilder(`#/services/rapportassistenten${old}`, 'Rapportassistenten');
    await waitFor(() => expect(window.location.hash).toBe(target));
  });

  it('opens the old settings address in Oppsett under Grenser og logging', async () => {
    await openBuilder('#/services/rapportassistenten/settings', 'Rapportassistenten');
    await waitFor(() => expect(navLink('Oppsett').getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByRole('heading', { name: 'Grenser og logging' })).toBeTruthy();
  });

  it('opens the shared playground for the conversation service tweak', async () => {
    await renderAt('#/services?visning=samtaletjeneste');
    await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
    await waitFor(() => expect(navLink('Oppsett').getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByRole('region', { name: 'Prøv et oppsett' })).toBeTruthy();
    expect(await screen.findByText(/Tjeneste: Rapportassistenten, utkast/)).toBeTruthy();
    expectAccessible();
  });

  it.each([
    ['uttrekk-samtale', 'Oppsett'],
    ['uttrekk-inn-og-ut', 'Oppsett'],
    ['uttrekk-prove', 'Oppsett'],
    ['uttrekk-yaml', 'Utviklerverktøy'],
  ])('reaches the %s tweak', async (tweak, tab) => {
    await renderAt(`#/services?visning=${tweak}`);
    await screen.findByRole('heading', { level: 1, name: 'Søknadsuttrekk' });
    await waitFor(() => expect(navLink(tab).getAttribute('aria-selected')).toBe('true'));
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
    fireEvent.change(screen.getByLabelText('Skriv til assistenten'), {
      target: { value: 'Hva koster dette?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/kr per 1000 kjøringer/, {}, { timeout: 2000 })).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Vis endring: Valgte modell: Qwen3.8-27B' }),
    );
    expect(
      within(setupNav())
        .getByRole('button', { name: /^Modell/ })
        .getAttribute('aria-current'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Angre: Valgte modell: Qwen3.8-27B' }));
    expect(
      screen.getByRole('button', { name: 'Gjør om: Valgte modell: Qwen3.8-27B' }),
    ).toBeTruthy();
  });
});

describe('risk level and v3 checks', () => {
  const openRisk = async () => {
    await openBuilder('#/services/soknadsuttrekk/setup', 'Søknadsuttrekk');
    openArea(/^Risiko og KI-forordningen/);
  };

  it('offers only the audiences the platform supports under Formål og målgruppe', async () => {
    await openBuilder('#/services/soknadsuttrekk/setup', 'Søknadsuttrekk');
    openArea(/^Formål og målgruppe/);
    const audience = screen.getByLabelText(/Innbyggere og næringsliv · Kommer senere/);
    expect(audience.getAttribute('aria-disabled')).toBe('true');
  });

  it('lets the user confirm the proposed risk level', async () => {
    await openRisk();
    expect(screen.getAllByText('Begrenset risiko').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Ansatte bruker resultatene, men tjenesten tar ikke beslutninger om folk\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bekreft risikonivå' }));
    expect(screen.getByText('Bekreftet av Kari Nordmann i dag')).toBeTruthy();
    expectAccessible();
  });

  it('stops the service when a prohibited use is ticked', async () => {
    await openRisk();
    fireEvent.click(screen.getByRole('button', { name: 'Velg et annet nivå' }));
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
    const table = () =>
      screen.getByRole('radio', { name: /Tabell med kilder/ }) as HTMLInputElement;
    const way = () => {
      const open = screen.queryByRole('combobox', { name: 'Arbeidsmåte' });
      if (open) return open as HTMLSelectElement;
      fireEvent.click(screen.getByRole('button', { name: /^Bytt (arbeidsmåte|stegflyt)$/ }));
      return screen.getByRole('combobox', { name: 'Arbeidsmåte' }) as HTMLSelectElement;
    };
    openArea(/^Sluttresultat/);
    expect(table().disabled).toBe(true);
    openArea(/^Arbeidsmåte/);
    fireEvent.change(way(), { target: { value: 'step-flow' } });
    openArea(/^Sluttresultat/);
    expect(table().disabled).toBe(false);
    fireEvent.click(table());
    expect(table().checked).toBe(true);
    expect(screen.queryByText(/Bare en fast stegflyt kan lage en tabell/)).toBeNull();
    openArea(/^Arbeidsmåte/);
    fireEvent.change(way(), { target: { value: 'single-call' } });
    openArea(/^Sluttresultat/);
    expect(screen.getByText(/Bare en fast stegflyt kan lage en tabell/)).toBeTruthy();
  });

  it('warns when an output field would be emptied by the PII filter', async () => {
    await openBuilder('#/services/soknadsuttrekk/setup', 'Søknadsuttrekk');
    openArea(/^Sluttresultat/);
    expect(screen.getByText(/Feltet blir da tomt/)).toBeTruthy();
  });
});

describe('developer view', () => {
  it('shows the definition as YAML and checks it against the schema through the API', async () => {
    const { calls, fetch } = recording();
    await openBuilder(
      '#/services/rapportassistenten/versions?view=yaml',
      'Rapportassistenten',
      fetch,
    );
    const editor = (await screen.findByLabelText('Definisjonen')) as HTMLTextAreaElement;
    const text = editor.value;
    expect(text).toContain('kind: Service');
    expect(text).toMatch(
      /metadata:\n {2}tenant: '\d+'\n {2}id: rapportassistenten\n {2}name: Rapportassistenten/,
    );
    expect(text).toContain('id: agent-loop');
    expect(text).toContain('- dataset: digdir/kudos');
    expectAccessible();

    expect(await screen.findByText('Gyldig.', {}, { timeout: 3000 })).toBeTruthy();
    const call = calls.find((c) => c.url.endsWith('/definitions/validate'));
    expect((call?.body as { definition: unknown }).definition).toBe(text);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/definitions'))).toBe(false);
  });

  it('applies and discards YAML edits', async () => {
    await renderAt('#/services/new');
    await screen.findByRole('navigation', { name: 'Deler av oppsettet' });
    go('#/services/new/definition');
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
    await renderAt('#/services/new');
    await screen.findByRole('navigation', { name: 'Deler av oppsettet' });
    go('#/services/new/definition');
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
  it('compares a version with the one before and publishes it again as a new version', async () => {
    const { calls, fetch } = recording();
    await openBuilder('#/services/rapportassistenten/versions', 'Rapportassistenten', fetch);
    fireEvent.click(await screen.findByRole('button', { name: /^Versjon 6/ }));
    expect(await screen.findByRole('heading', { name: 'Versjon 6, første versjon' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk igjen' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Publiser versjon 6 på nytt' });
    expect(within(confirm).getByText(/publiseres som versjon 8/)).toBeTruthy();
    fireEvent.change(within(confirm).getByLabelText('Begrunnelse'), {
      target: { value: 'Versjon 7 avslår for sjelden' },
    });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Publiser som versjon 8' }));
    expect(await screen.findByText('Versjon 6 er publisert på nytt som versjon 8.')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/rapportassistenten/versions/6'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/definitions'))).toBe(true);
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
    openArea(/^Risiko og KI-forordningen/);
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
  it('shows the sections of an existing service first and the assistant below them', async () => {
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
      expect(screen.queryByRole('tab', { name: 'Tjenesten' })).toBeNull();
      const nav = setupNav();
      const side = screen.getByRole('region', { name: 'Byggeassistent og prøving' });
      expect(within(nav).getByRole('button', { name: /^Formål og målgruppe/ })).toBeTruthy();
      expect(nav.compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(
        within(side).getByRole('tab', { name: 'Assistent' }).getAttribute('aria-selected'),
      ).toBe('true');
      expectAccessible();
    } finally {
      window.matchMedia = original;
    }
  });
});
