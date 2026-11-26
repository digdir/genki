// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../mock';
import { expectAccessible, failingFetch, go, renderAt, renderLive } from '../test-utils';
import { parseYaml } from '../yaml';
import { openArea } from './services/setup-areas.test-utils';

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

const yamlField = () =>
  screen.getByRole('textbox', { name: 'Oppsettet som YAML' }) as HTMLTextAreaElement;

/** Opens a new service in the example portal at its YAML, under Avansert. */
const openNewYaml = async (fetch?: typeof globalThis.fetch) => {
  await renderAt('#/services/new', fetch);
  await screen.findByRole('heading', { level: 1, name: 'Ny tjeneste' });
  go('#/services/new/definition');
  await waitFor(() => expect(window.location.hash).toBe('#/services/new/advanced/yaml'));
  await screen.findByRole('textbox', { name: 'Oppsettet som YAML' });
};

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
  it('opens a new service straight in its Oppsett, as one form with every basic area', async () => {
    await renderAt('#/services/new');
    await screen.findByRole('heading', { level: 1, name: 'Ny tjeneste' });
    expect(screen.queryByRole('heading', { name: 'Lag med KI' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Grunnleggende' })).toBeTruthy();
    for (const area of ['Formål og målgruppe', 'Kunnskap', 'Inndata', 'Resultat', 'Modell'])
      expect(screen.getByRole('heading', { level: 3, name: area })).toBeTruthy();
    expect(screen.getByText(/^Lagres i testutgaven med en gang\./)).toBeTruthy();
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
      ['Utforming', '#/services/rapportassistenten/interface'],
      ['Kvalitet', '#/services/rapportassistenten/quality'],
      ['Historikk', '#/services/rapportassistenten/versions'],
      ['Teknisk', '#/services/rapportassistenten/log'],
      ['Avansert', '#/services/rapportassistenten/advanced'],
    ]);
    expect(navLink('Oversikt').getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { level: 2, name: 'Slik går det' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Byggeassistent' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Brødsmuler' })).toBeNull();
    expectAccessible();

    go('#/services/rapportassistenten/versions');
    expect(await screen.findByText('Strammere krav til kilder')).toBeTruthy();
    expect(navLink('Historikk').getAttribute('aria-selected')).toBe('true');
    expectAccessible();
  });

  it.each([
    ['/setup', 'Oppsett', undefined, /^Formål og målgruppe/],
    ['/quality', 'Kvalitet', undefined, /Testsett/],
    ['/log', 'Teknisk', 'Logg', /Logg/],
    ['/advanced/channels', 'Avansert', undefined, /^Lag API-nøkkel$/],
  ])('deep-links %s inside the same page', async (path, label, sub, content) => {
    await openBuilder(`#/services/rapportassistenten${path}`, 'Rapportassistenten');
    expect(navLink(label).getAttribute('aria-selected')).toBe('true');
    if (sub) expect(subLink(label, sub).getAttribute('aria-selected')).toBe('true');
    expect((await screen.findAllByText(content)).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it.each([
    ['/how-it-works', '#/services/rapportassistenten/advanced/how'],
    ['/channels', '#/services/rapportassistenten/advanced/channels'],
    ['?tab=oppsett', '#/services/rapportassistenten/setup'],
    ['?tab=test', '#/services/rapportassistenten/test'],
    ['?tab=yaml', '#/services/rapportassistenten/advanced/yaml'],
    ['/versions?view=yaml', '#/services/rapportassistenten/advanced/yaml'],
    ['?tab=versjoner', '#/services/rapportassistenten/versions'],
    ['/unknown', '#/services/rapportassistenten'],
  ])('redirects the old route %s', async (old, target) => {
    await openBuilder(`#/services/rapportassistenten${old}`, 'Rapportassistenten');
    await waitFor(() => expect(window.location.hash).toBe(target));
  });

  it('opens the old settings address under Avansert → Begrensninger og loggføring', async () => {
    await openBuilder('#/services/rapportassistenten/settings', 'Rapportassistenten');
    await waitFor(() => expect(navLink('Avansert').getAttribute('aria-selected')).toBe('true'));
    expect(
      await screen.findByRole('heading', { name: 'Begrensninger og loggføring' }),
    ).toBeTruthy();
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
    ['uttrekk-yaml', 'Avansert'],
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
    expect(window.location.hash).toBe('#/services/soknadsuttrekk/setup/model');
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
    const audience = screen.getByRole('radio', { name: /^Innbyggere og næringsliv\s*Kommer$/ });
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
    openArea(/^Resultat/);
    expect(table().disabled).toBe(true);
    openArea(/^Arbeidsmåte/);
    fireEvent.change(way(), { target: { value: 'step-flow' } });
    openArea(/^Resultat/);
    expect(table().disabled).toBe(false);
    fireEvent.click(table());
    expect(table().checked).toBe(true);
    expect(screen.queryByText(/Bare en fast arbeidsflyt kan lage en tabell/)).toBeNull();
    openArea(/^Arbeidsmåte/);
    fireEvent.change(way(), { target: { value: 'single-call' } });
    openArea(/^Resultat/);
    expect(screen.getByText(/Bare en fast arbeidsflyt kan lage en tabell/)).toBeTruthy();
  });

  it('warns when an output field would be emptied by the PII filter', async () => {
    await openBuilder('#/services/soknadsuttrekk/setup', 'Søknadsuttrekk');
    openArea(/^Resultat/);
    expect(screen.getByText(/Feltet blir da tomt/)).toBeTruthy();
  });
});

describe('developer view', () => {
  it('shows the definition of a published service as YAML under Avansert and checks it against the schema through the API', async () => {
    const { calls, fetch } = recording();
    await openBuilder('#/services/rapportassistenten/advanced/yaml', 'Rapportassistenten', fetch);
    const text = (
      (await screen.findByRole('textbox', { name: 'Oppsettet som YAML' })) as HTMLTextAreaElement
    ).value;
    expect(text).toContain('kind: Service');
    expect(text).toContain('id: agent-loop');
    expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Sjekk mot skjemaet' }));
    expect(await screen.findByText('Den tekniske teksten følger skjemaet.')).toBeTruthy();
    const call = calls.find((c) => c.url.endsWith('/definitions/validate'));
    expect((call?.body as { definition: unknown }).definition).toBe(text);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/definitions'))).toBe(false);
  });

  it('refuses YAML the schema rejects in Avansert → YAML and writes nothing to the draft', async () => {
    const base = mockFetch();
    const drafts: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = String(init?.body ?? '');
      if (url.endsWith('/definitions/validate') && body.includes('veldig-hoy'))
        return new Response(
          JSON.stringify({
            title: 'Ugyldig',
            status: 422,
            errors: [{ path: 'spec.riskClass', message: 'Invalid option' }],
          }),
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        );
      if (init?.method === 'PUT' && url.endsWith('/draft')) drafts.push(body);
      return base(input, init);
    };
    await openNewYaml(fetch);
    const saved = drafts.length;
    const before = yamlField().value;
    fireEvent.change(yamlField(), {
      target: {
        value: before
          .replace('name: ny-tjeneste', 'name: Ødelagt')
          .replace(/^spec:\n/m, 'spec:\n  riskClass: veldig-hoy\n'),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));
    expect(await screen.findByText('spec.riskClass', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText('Endringene er brukt i oppsettet.')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Ny tjeneste' })).toBeTruthy();
    expect(drafts.slice(saved).some((d) => d.includes('veldig-hoy'))).toBe(false);
  });

  it('applies and discards YAML edits', async () => {
    await openNewYaml();
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
    await openNewYaml();
    fireEvent.change(yamlField(), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));
    expect(await screen.findByText('Endringene er brukt i oppsettet.')).toBeTruthy();
    const { metadata } = parseYaml(text) as { metadata: { name: string } };
    expect(screen.getByRole('heading', { level: 1, name: metadata.name })).toBeTruthy();
    expect(screen.queryByText(/^Linje \d+/)).toBeNull();
  });
});

describe('versions', () => {
  it('restores the edition before the one in use by publishing it again', async () => {
    const { calls, fetch } = recording();
    await openBuilder('#/services/rapportassistenten/versions', 'Rapportassistenten', fetch);
    const [restore] = await screen.findAllByRole('button', { name: 'Gjenopprett denne utgaven' });
    fireEvent.click(restore as HTMLElement);
    const confirm = await screen.findByRole('dialog', { name: /^Gjenopprette utgaven fra / });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Gjenopprett denne utgaven' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/rapportassistenten/versions/6'))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/definitions'))).toBe(true);
    expectAccessible();
  });
});

describe('publishing', () => {
  const publishPage = async (name: string) =>
    screen.findByRole('heading', { level: 1, name: `Publiser ${name}` });

  it('lists an unconfirmed risk level as left on the publish page of a published service, and confirms it there', async () => {
    await renderAt('#/services?visning=uttrekk-publiser');
    await publishPage('Søknadsuttrekk');
    await waitFor(() =>
      expect(window.location.hash).toBe('#/services/soknadsuttrekk/setup/publish'),
    );
    expect(screen.getByText(/Publiser erstatter utgaven som er i bruk/)).toBeTruthy();
    expect(screen.getByText('Dette gjenstår før du kan publisere')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Bekreft risikonivået' })).toBeTruthy();
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Bekreft risikonivå' }));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Bekreft risikonivået' })).toBeNull(),
    );
  });

  it('publishes with a reason through the API', async () => {
    const { calls, fetch } = recording();
    await openBuilder('#/services/rapportassistenten/setup', 'Rapportassistenten', fetch);
    fireEvent.click(screen.getAllByRole('button', { name: 'Publiser' })[0] as HTMLElement);
    await publishPage('Rapportassistenten');
    fireEvent.click(screen.getByRole('button', { name: 'Bekreft risikonivå' }));
    // The draft is checked against the platform first; Publiser waits for it.
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/definitions/validate'))).toBe(true),
    );
    const publish = screen.getByRole('button', { name: 'Publiser' });
    fireEvent.click(publish);
    expect(screen.getByText(/minst 10 tegn/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Bekreftet risikonivå før lansering' },
    });
    fireEvent.click(publish);
    expect(await screen.findByText('Utgave 8 er publisert.')).toBeTruthy();
    expect(window.location.hash).toBe('#/services/rapportassistenten/setup');
    expect(screen.queryByRole('dialog')).toBeNull();
    const call = calls.find((c) => c.method === 'POST' && c.url.endsWith('/definitions'));
    expect(decodeURIComponent(call?.headers.get('change-reason') ?? '')).toBe(
      'Bekreftet risikonivå før lansering',
    );
    const definition = (call?.body as { definition: Record<string, Record<string, unknown>> })
      .definition;
    expect(definition.metadata?.version).toBe(8);
    expect(definition.spec?.riskConfirmation).toBeTruthy();
    go('#/services/rapportassistenten/versions');
    expect(await screen.findByText('Bekreftet risikonivå før lansering')).toBeTruthy();
  });

  it('publishes nothing and returns to Oppsett when the person cancels on the publish page', async () => {
    const { calls, fetch } = recording();
    await openBuilder('#/services/rapportassistenten/setup', 'Rapportassistenten', fetch);
    fireEvent.click(screen.getAllByRole('button', { name: 'Publiser' })[0] as HTMLElement);
    await publishPage('Rapportassistenten');
    fireEvent.change(screen.getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Prøver publisering' },
    });

    fireEvent.click(screen.getByRole('link', { name: 'Avbryt' }));
    await waitFor(() => expect(window.location.hash).toBe('#/services/rapportassistenten/setup'));
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Publiser Rapportassistenten' }),
      ).toBeNull(),
    );
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/definitions'))).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Publiser' })[0] as HTMLElement);
    await publishPage('Rapportassistenten');
    expect((screen.getByLabelText('Hva er endret, og hvorfor?') as HTMLTextAreaElement).value).toBe(
      '',
    );
  });
});

describe('narrow screens', () => {
  it("shows a published service's Oppsett form on a narrow screen, with no Assistent and Tjenesten tabs", async () => {
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
      expect(screen.getByRole('heading', { level: 3, name: 'Formål og målgruppe' })).toBeTruthy();
      expect(screen.getByRole('region', { name: 'Byggeassistent og prøving' })).toBeTruthy();
      expectAccessible();
    } finally {
      window.matchMedia = original;
    }
  });
});
