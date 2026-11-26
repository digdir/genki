// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { logTimelines } from '../../data/log';
import { exampleDatasets, exampleOrganisations, exampleServices, mockFetch } from '../../mock';
import type { ModelOption } from '../../types';

document.getAnimations ??= () => [];
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const liveModels: ModelOption[] = [
  { id: 'foundry-openai/gpt-4.1-mini', residency: 'global', capabilities: ['stream'] },
  {
    id: 'foundry-openai/gpt-4.1',
    residency: 'eu',
    capabilities: ['stream'],
    price: { inputPerThousand: 0.02, outputPerThousand: 0.08 },
  },
];

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const recorded = (validate?: (body: unknown) => Response | undefined) => {
  const calls: Call[] = [];
  const base = mockFetch([], logTimelines, liveModels, exampleDatasets);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url.endsWith('/definitions/validate') && validate) {
      const reply = validate(body);
      if (reply) return reply;
    }
    return base(input, init);
  };
  return { calls, fetch };
};

/** Starts a new service, which opens in its Oppsett, and returns the builder assistant beside it. */
const startBuilder = async (fetch: typeof globalThis.fetch) => {
  const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
  await auth.login();
  window.location.hash = '#/services/new';
  render(<App auth={auth} fetch={fetch} live />);
  await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });
  return screen.getByRole('complementary', { name: 'Byggeassistent' });
};

const tellAssistant = (panel: HTMLElement, text: string) => {
  fireEvent.change(within(panel).getByLabelText('Skriv til assistenten'), {
    target: { value: text },
  });
  fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
};

/** Goes from the Oppsett of a new service to its first publish page. */
const toFirstPublish = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
  return (await screen.findByRole('heading', { level: 1, name: /^Publiser / })).closest(
    '.first-publish',
  ) as HTMLElement;
};

const leftHeading = 'Dette gjenstår før du kan publisere';

/** Opens the publish page from the header and confirms the risk level there, where it is set. */
const publishPage = async (reason: string) => {
  fireEvent.click(await screen.findByRole('button', { name: 'Publiser' }));
  await screen.findByRole('heading', { level: 1, name: 'Publiser Rapportassistenten' });
  fireEvent.click(await screen.findByRole('button', { name: 'Bekreft risikonivå' }));
  fireEvent.change(screen.getByLabelText(/^Hva er endret, og hvorfor\?/), {
    target: { value: reason },
  });
  return document.body;
};

const publishOnPage = async (page: HTMLElement) => {
  const button = within(page).getByRole('button', { name: 'Publiser' });
  await waitFor(() => expect(button.getAttribute('aria-disabled')).not.toBe('true'));
  fireEvent.click(button);
};

type Spec = {
  model: { primary: string };
  tools: string[];
  knowledge: { datasets: { dataset: string }[] };
  guardrails: Record<string, { categories?: string[] }>;
  riskConfirmation?: Record<string, unknown>;
};

const lastDraft = (calls: Call[]) =>
  (
    calls
      .filter((c) => c.method === 'PUT' && /\/services\/utkast-[0-9a-f]{8}\/draft$/.test(c.url))
      .at(-1)?.body as { definition: { spec: Spec } } | undefined
  )?.definition.spec;

const lastValidated = (calls: Call[]) =>
  (
    calls.filter((c) => c.url.endsWith('/definitions/validate')).at(-1)?.body as {
      definition: { spec: Spec };
    }
  ).definition.spec;

describe('the live builder', () => {
  it('starts from the platform template and labels the chat with the signed-in user', async () => {
    const { calls, fetch } = recorded();
    const panel = await startBuilder(fetch);

    expect(calls.some((c) => /\/definitions\/template\?kind=Service$/.test(c.url))).toBe(true);
    tellAssistant(panel, 'Svar på spørsmål om permisjon');
    expect(await within(panel).findByText('Ingrid Berg')).toBeTruthy();
    expect(within(panel).queryByText('Kari Nordmann')).toBeNull();

    await toFirstPublish();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/validate'))).toBe(true));
    const spec = lastValidated(calls);
    expect(spec.model.primary).toBe('foundry-openai/gpt-4.1-mini');
    expect(spec.tools).toEqual([]);
    expect(spec.guardrails['pii-before-model']?.categories).toEqual([
      'national-id',
      'd-number',
      'phone',
      'email',
    ]);
  });

  it('shows the price per 1M tokens the API returns and "Ikke priset" only for a model without one', async () => {
    const { fetch } = recorded();
    await startBuilder(fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Bytt modell' }));
    const picker = screen.getByRole('dialog', { name: 'Velg modell' });
    expect(within(picker).getByText('inn 20,00 / ut 80,00 kr per 1M tokens')).toBeTruthy();
    expect(within(picker).getAllByText('Ikke priset')).toHaveLength(1);
  });

  it('lists only live models with residency in words and no invented cost or speed', async () => {
    const { fetch } = recorded();
    await startBuilder(fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Bytt modell' }));
    const picker = screen.getByRole('dialog', { name: 'Velg modell' });
    expect(within(picker).getAllByRole('radio')).toHaveLength(2);
    expect(within(picker).getByText('Data i EU/EØS')).toBeTruthy();
    expect(within(picker).queryByText(/Borealis|Fart:|Kostnad: høy/)).toBeNull();
  });

  it('picks datasets from the catalog, writes the full id and removes them again', async () => {
    const { calls, fetch } = recorded();
    await startBuilder(fetch);
    const sources = screen.getByRole('region', { name: 'Kunnskap' });
    const datasets = within(sources).getByRole('combobox', { name: 'Dokumentsamlinger' });
    // jsdom has no popover support, so the open list counts as hidden to the accessibility tree.
    const option = (name: string) => within(sources).findByRole('option', { name, hidden: true });
    fireEvent.click(datasets);
    expect(
      within(sources).queryByRole('option', { name: 'Statsbudsjettet 2026', hidden: true }),
    ).toBeNull();
    fireEvent.click(await option('Kudos-rapporter'));
    fireEvent.click(await option('Veiledere og rundskriv'));
    await waitFor(() =>
      expect(
        within(sources)
          .getByRole('option', { name: 'Veiledere og rundskriv', hidden: true })
          .getAttribute('aria-selected'),
      ).toBe('true'),
    );
    fireEvent.click(await option('Veiledere og rundskriv'));
    await waitFor(() =>
      expect(
        within(sources)
          .getByRole('option', { name: 'Veiledere og rundskriv', hidden: true })
          .getAttribute('aria-selected'),
      ).toBe('false'),
    );

    await toFirstPublish();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/validate'))).toBe(true));
    expect(lastValidated(calls).knowledge.datasets).toEqual([{ dataset: 'digdir/kudos' }]);
  });

  it('adds tools from the connected tool servers with their versioned reference', async () => {
    const { calls, fetch } = recorded();
    await startBuilder(fetch);
    const tools = window.location.hash.replace(/\/setup$/, '/advanced/tools');
    window.location.hash = tools;
    await screen.findByRole('heading', { level: 2, name: 'Verktøy' });

    fireEvent.click(screen.getByRole('button', { name: 'Legg til verktøy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Legg til verktøy fra katalogen' }));
    expect(await screen.findByRole('button', { name: 'Legg til arkiv.hent' })).toBeTruthy();
    expect(screen.queryByText(/klarsprak|Enhetsregisteret|lovdata/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til arkiv.sok' }));

    await toFirstPublish();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/validate'))).toBe(true));
    expect(lastValidated(calls).tools).toEqual(['arkiv.sok@1.2']);
  });

  it('lists validation errors by area on the publish page, refuses to publish and never sends who confirmed the risk', async () => {
    const { calls, fetch } = recorded(
      () =>
        new Response(
          JSON.stringify({
            title: 'Invalid definition',
            status: 422,
            errors: [
              { path: 'spec.model', message: 'model x runs in global, outside norway' },
              { path: 'spec.purpose', message: 'a service needs a purpose' },
            ],
          }),
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
    );
    await startBuilder(fetch);
    const page = await toFirstPublish();
    fireEvent.click(within(page).getByRole('button', { name: 'Bekreft risikonivå' }));

    expect(
      await within(page).findByRole('link', {
        name: /^Modell: Modellen behandler data i global region/,
      }),
    ).toBeTruthy();
    expect(within(page).getByRole('link', { name: /^Formål og målgruppe: / })).toBeTruthy();
    expect(within(page).getByRole('heading', { name: 'Utgave 1, første utgave' })).toBeTruthy();

    fireEvent.change(within(page).getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Første versjon av tjenesten' },
    });
    fireEvent.click(within(page).getByRole('button', { name: 'Publiser' }));
    expect(within(page).getByText(/^Du kan ikke publisere ennå\./)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/definitions'))).toBe(
      false,
    );

    await waitFor(() =>
      expect(lastDraft(calls)?.riskConfirmation).toMatchObject({ riskClass: 'limited' }),
    );
    expect(lastDraft(calls)?.riskConfirmation).not.toHaveProperty('by');
  });

  it('opens the published service with its status in the header right after the first publish', async () => {
    const { calls, fetch } = recorded();
    await startBuilder(fetch);
    const header = document.querySelector('.service-head') as HTMLElement;
    expect(
      within(header).queryByRole('navigation', { name: 'Testutgave eller i bruk' }),
    ).toBeNull();

    const page = await toFirstPublish();
    fireEvent.click(within(page).getByRole('button', { name: 'Bekreft risikonivå' }));
    fireEvent.change(within(page).getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Første versjon av tjenesten' },
    });
    await waitFor(() => expect(within(page).queryByText(leftHeading)).toBeNull());
    fireEvent.click(within(page).getByRole('button', { name: 'Publiser' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/definitions'))).toBe(
        true,
      ),
    );
    await waitFor(() => expect(window.location.hash).toBe('#/services/ny-tjeneste'));
    const published = await waitFor(() => {
      const head = document.querySelector('.service-head') as HTMLElement;
      expect(
        within(head).getByRole('navigation', { name: 'Testutgave eller i bruk' }),
      ).toBeTruthy();
      return head;
    });
    expect(within(published).getByText(/^Lagres i testutgaven med en gang\./)).toBeTruthy();
  });

  it('checks the definition again when the risk level is fixed on the first publish page, and then publishes', async () => {
    const riskError = 'a service that decides about people needs the high risk class';
    const { calls, fetch } = recorded((body) =>
      (body as { definition: { spec: { riskClass?: string } } }).definition.spec.riskClass ===
      'high'
        ? undefined
        : new Response(
            JSON.stringify({
              title: 'Invalid definition',
              status: 422,
              errors: [{ path: 'spec.riskClass', message: riskError }],
            }),
            { status: 422, headers: { 'content-type': 'application/problem+json' } },
          ),
    );
    await startBuilder(fetch);
    const page = await toFirstPublish();
    expect(await within(page).findByText(new RegExp(riskError))).toBeTruthy();

    fireEvent.click(within(page).getByRole('button', { name: 'Velg et annet nivå' }));
    fireEvent.click(within(page).getByRole('radio', { name: /^Høy/ }));
    fireEvent.click(
      (
        await within(page).findAllByRole('button', { name: 'Bekreft risikonivå' })
      )[0] as HTMLElement,
    );
    fireEvent.change(within(page).getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Første versjon av tjenesten' },
    });
    await waitFor(() => expect(within(page).queryByText(leftHeading)).toBeNull(), {
      timeout: 3000,
    });
    fireEvent.click(within(page).getByRole('button', { name: 'Publiser' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/definitions'))).toBe(
        true,
      ),
    );
  });

  it('drops the risk confirmation when the risk level changes', async () => {
    const { fetch } = recorded();
    await startBuilder(fetch);
    const page = await toFirstPublish();
    fireEvent.click(within(page).getByRole('button', { name: 'Bekreft risikonivå' }));
    expect(await within(page).findByText('Bekreftet av Ingrid Berg i dag')).toBeTruthy();
    fireEvent.click(within(page).getByRole('button', { name: 'Velg et annet nivå' }));
    fireEvent.click(within(page).getByRole('radio', { name: /^Høy/ }));
    expect(within(page).queryByText('Bekreftet av Ingrid Berg i dag')).toBeNull();
  });

  const openPublish = async (runs: unknown[], testSets: unknown[]) => {
    const found = exampleServices.find((x) => x.id === 'rapportassistenten');
    const definition = found?.latest.definition as {
      spec: { strategy: { config: Record<string, unknown> } };
    };
    const base = mockFetch(exampleServices, logTimelines, liveModels, exampleDatasets, {
      features: {
        quality: {
          drafts: {
            rapportassistenten: {
              definition: {
                ...definition,
                spec: {
                  ...definition.spec,
                  strategy: {
                    ...definition.spec.strategy,
                    config: { ...definition.spec.strategy.config, instructions: 'Svar kort.' },
                  },
                },
              },
            },
          },
        },
      },
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (/\/services\/rapportassistenten\/eval-runs$/.test(url))
        return Response.json({ data: runs });
      if (/\/services\/rapportassistenten\/test-sets$/.test(url))
        return Response.json({ data: testSets });
      return base(input, init);
    };
    const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = '#/services/rapportassistenten/setup?publiser=1';
    render(<App auth={auth} fetch={fetch} live />);
    await screen.findByRole('heading', { level: 1, name: 'Publiser Rapportassistenten' });
    return document.body;
  };

  it('opens the publish page from ?publiser=1 and says nothing about tests once the draft has a newer test run', async () => {
    const page = await openPublish(
      [
        {
          id: 'r1',
          status: 'completed',
          testSet: 'ts',
          version: 'draft',
          draftRevision: 1,
          startedAt: '2099-01-01T10:00:00Z',
          total: 10,
          passed: 8,
        },
      ],
      [{ id: 'ts', name: 'Spørsmål', cases: 10 }],
    );
    expect(window.location.hash).toBe('#/services/rapportassistenten/setup/publish');
    await waitFor(() =>
      expect(
        within(page).queryByText('Målt før siste endring. Du kan publisere likevel.'),
      ).toBeNull(),
    );
    expect(within(page).queryByText('Ikke målt ennå.')).toBeNull();
  });

  it('counts a draft test run only when it ran the saved revision of the draft', async () => {
    const page = await openPublish(
      [
        {
          id: 'r1',
          status: 'completed',
          testSet: 'ts',
          version: 'draft',
          draftRevision: 99,
          startedAt: '2099-01-01T10:00:00Z',
          total: 10,
          passed: 8,
        },
      ],
      [{ id: 'ts', name: 'Spørsmål', cases: 10 }],
    );
    expect(
      await within(page).findByText('Målt før siste endring. Du kan publisere likevel.'),
    ).toBeTruthy();
  });

  it('says when the quality is not measured, or measured before the last change', async () => {
    const page = await openPublish([], []);
    expect(await within(page).findByText('Ikke målt ennå.')).toBeTruthy();
    cleanup();

    const withSet = await openPublish([], [{ id: 'ts', name: 'Spørsmål', cases: 3 }]);
    expect(
      await within(withSet).findByText('Målt før siste endring. Du kan publisere likevel.'),
    ).toBeTruthy();
    expect(within(withSet).getByRole('link', { name: 'Kjør testsettet' })).toBeTruthy();
  });
});

const instructionsField = () =>
  screen.getByLabelText('Instruksjoner til tjenesten') as HTMLTextAreaElement;

describe('the live builder and the server draft', () => {
  const after =
    'Svar kort og vis til kildene.\nBruk tall fra den nyeste rapporten når spørsmålet gjelder et bestemt år.';
  const ready = {
    id: 'imp-1',
    service: 'rapportassistenten',
    status: 'ready' as const,
    change: { path: 'spec.strategy.config.instructions', before: '', after },
    createdAt: '2026-10-07T10:00:00Z',
  };

  const openService = async (hash: string, quality = {}) => {
    const calls: Call[] = [];
    const base = mockFetch(exampleServices, logTimelines, liveModels, exampleDatasets, {
      features: { quality },
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      calls.push({ url, method: init?.method ?? 'GET', body });
      return base(input, init);
    };
    const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = hash;
    render(<App auth={auth} fetch={fetch} live />);
    return { calls, fetch };
  };

  const instructions = () =>
    screen.getByLabelText('Instruksjoner til tjenesten') as HTMLTextAreaElement;
  const draftWrites = (calls: Call[], method: string) =>
    calls.filter((c) => c.method === method && c.url.endsWith('/rapportassistenten/draft'));

  it('shows an approved improvement in the builder, publishes it and clears the draft', async () => {
    const { calls } = await openService('#/services/rapportassistenten/quality?tab=proposals', {
      improvements: [ready],
    });
    const card = await screen.findByRole('region', { name: /^Forslag fra/ });
    fireEvent.click(within(card).getByRole('button', { name: 'Godkjenn' }));
    await within(card).findByText('Godtatt i utkastet');

    window.location.hash = '#/services/rapportassistenten/setup/instructions';
    await waitFor(() => expect(instructions().value).toBe(after));
    const page = await publishPage('Tar i bruk forbedringsforslaget');
    expect(within(page).getByRole('rowheader', { name: 'Instruksjoner' })).toBeTruthy();
    await publishOnPage(page);

    await waitFor(() => expect(draftWrites(calls, 'DELETE')).toHaveLength(1));
    const published = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/definitions'));
    expect(published?.body).toMatchObject({
      definition: { spec: { strategy: { config: { instructions: after } } } },
    });
    // The risk level is confirmed on the publish page, which publishes what the page holds.
    expect(draftWrites(calls, 'DELETE')[0]?.body).toEqual({ revision: 1 });
  });

  it('publishes a service in use from the publish page, saves a new edition and returns to Oppsett', async () => {
    const { calls } = await openService('#/services/rapportassistenten/setup/instructions');
    await screen.findByLabelText('Instruksjoner til tjenesten');
    fireEvent.change(instructions(), { target: { value: 'Svar kort.' } });
    await waitFor(() => expect(draftWrites(calls, 'PUT').length).toBeGreaterThan(0));

    const page = await publishPage('Kortere svar til brukerne');
    expect(screen.queryByRole('dialog')).toBeNull();
    await publishOnPage(page);

    await waitFor(() => expect(window.location.hash).toBe('#/services/rapportassistenten/setup'));
    const published = calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('/api/definitions'),
    );
    expect(published).toHaveLength(1);
    expect(published[0]?.body).toMatchObject({
      definition: { spec: { strategy: { config: { instructions: 'Svar kort.' } } } },
    });
  });

  it('publishes nothing when the person cancels on the publish page of a service in use', async () => {
    const { calls } = await openService('#/services/rapportassistenten/setup/instructions');
    await screen.findByLabelText('Instruksjoner til tjenesten');
    fireEvent.change(instructions(), { target: { value: 'Svar kort.' } });
    await waitFor(() => expect(draftWrites(calls, 'PUT').length).toBeGreaterThan(0));

    const page = await publishPage('Kortere svar til brukerne');
    fireEvent.click(within(page).getByRole('link', { name: 'Avbryt' }));

    await waitFor(() => expect(window.location.hash).toBe('#/services/rapportassistenten/setup'));
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/definitions'))).toBe(
      false,
    );
    expect(draftWrites(calls, 'DELETE')).toEqual([]);
  });

  it('saves edits to the server draft with the revision it last saw', async () => {
    const { calls } = await openService('#/services/rapportassistenten/setup/instructions');
    await screen.findByLabelText('Instruksjoner til tjenesten');

    fireEvent.change(instructions(), { target: { value: 'Svar kort.' } });
    await waitFor(() => expect(draftWrites(calls, 'PUT')).toHaveLength(1), { timeout: 3000 });
    fireEvent.change(instructions(), { target: { value: 'Svar kort og høflig.' } });
    await waitFor(() => expect(draftWrites(calls, 'PUT')).toHaveLength(2), { timeout: 3000 });

    expect(draftWrites(calls, 'PUT').map((c) => (c.body as { revision: number }).revision)).toEqual(
      [0, 1],
    );
    expect(draftWrites(calls, 'PUT')[1]?.body).toMatchObject({
      definition: { spec: { strategy: { config: { instructions: 'Svar kort og høflig.' } } } },
    });
  });

  it('lets the service allow instruction proposals from Arbeidsmåte', async () => {
    const { calls } = await openService('#/services/rapportassistenten/setup/how');
    fireEvent.click(await screen.findByRole('button', { name: /^Bytt (arbeidsmåte|stegflyt)$/ }));
    const toggle = await screen.findByRole('switch', {
      name: /La plattformen foreslå endringer i instruksjonene/,
    });
    expect((toggle as HTMLInputElement).checked).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => expect(draftWrites(calls, 'PUT')).toHaveLength(1), { timeout: 3000 });
    expect(draftWrites(calls, 'PUT')[0]?.body).toMatchObject({
      definition: { spec: { improve: { allow: ['instructions'] } } },
    });
  });

  const olderInUse = (urls: string[] = []) => {
    const base = mockFetch(exampleServices, logTimelines, liveModels, exampleDatasets, {
      features: {
        environments: { initial: { rapportassistenten: { prod: { version: 6 }, test: {} } } },
      },
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      const response = await base(input, init);
      if (!url.endsWith('/rapportassistenten/versions/6')) return response;
      const old = (await response.json()) as {
        definition: { spec: { strategy: { config: Record<string, unknown> } } };
      };
      const spec = old.definition.spec;
      return Response.json({
        ...old,
        definition: {
          ...old.definition,
          spec: {
            ...spec,
            strategy: {
              ...spec.strategy,
              config: { ...spec.strategy.config, instructions: 'Svar kort.' },
            },
          },
        },
      });
    };
    return fetch;
  };

  const openWith = async (fetch: typeof globalThis.fetch, hash: string) => {
    const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = hash;
    render(<App auth={auth} fetch={fetch} live />);
    return (await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' })).closest(
      'header',
    ) as HTMLElement;
  };

  it('shows the edition users have in the in use view, not the latest published one, without opening the test edition', async () => {
    const urls: string[] = [];
    const header = await openWith(
      olderInUse(urls),
      '#/services/rapportassistenten/setup/purpose?edition=in-use',
    );
    expect(await within(header).findByText(/^Det brukerne har nå/)).toBeTruthy();
    await waitFor(() => expect(instructionsField().value).toBe('Svar kort.'));
    expect(urls.some((u) => u.includes('/rapportassistenten/draft'))).toBe(false);
  });

  it('offers no way to publish from the in use view, even from a publish link', async () => {
    const header = await openWith(
      olderInUse(),
      '#/services/rapportassistenten/setup?edition=in-use&publiser=1',
    );
    await within(header).findByText(/^Det brukerne har nå/);
    expect(within(header).queryByRole('button', { name: 'Publiser' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens no publish page for the in use view, even at the address of the publish page', async () => {
    const header = await openWith(
      olderInUse(),
      '#/services/rapportassistenten/setup/publish?edition=in-use',
    );
    await within(header).findByText(/^Det brukerne har nå/);
    expect(screen.queryByRole('heading', { level: 1, name: /^Publiser / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publiser' })).toBeNull();
  });

  it('offers no Byggeassistent in the in use view, which cannot be changed', async () => {
    const header = await openWith(
      olderInUse(),
      '#/services/rapportassistenten/setup/purpose?edition=in-use',
    );
    await within(header).findByText(/^Det brukerne har nå/);
    await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });
    expect(screen.queryByRole('textbox', { name: 'Skriv til assistenten' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Byggeassistent' })).toBeNull();
  });

  it('offers no Publiser on Historikk, which shows what users have', async () => {
    const header = await openWith(olderInUse(), '#/services/rapportassistenten/versions');
    await within(header).findByText(/^Det brukerne har nå/);
    expect(within(header).queryByRole('button', { name: 'Publiser' })).toBeNull();
  });

  it('counts the changes users do not have yet and lets the owner publish them', async () => {
    const header = await openWith(olderInUse(), '#/services/rapportassistenten/setup');
    expect(
      await within(header).findByRole('link', { name: 'Én endring er ikke publisert' }),
    ).toBeTruthy();
    const publish = within(header).getByRole('button', { name: 'Publiser' });
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBeNull());
  });

  it('opening a service opens its draft once', async () => {
    const { calls } = await openService('#/services/rapportassistenten/setup');
    await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
    await screen.findByRole('navigation', { name: 'Testutgave eller i bruk' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((c) => c.url.endsWith('/draft?rebase=clean'))).toHaveLength(1);
  });

  it('switching tabs does not open the draft again and keeps the whole header line in place', async () => {
    const calls: Call[] = [];
    const base = mockFetch(exampleServices, logTimelines, liveModels, exampleDatasets);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, method: init?.method ?? 'GET', body: undefined });
      const response = await base(input, init);
      if (!url.endsWith('/definitions/services/rapportassistenten')) return response;
      const found = (await response.json()) as { latest: Record<string, unknown> };
      return Response.json({
        ...found,
        latest: { ...found.latest, publishedByName: 'Kari Nordmann' },
      });
    };
    const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = '#/services/rapportassistenten/setup';
    render(<App auth={auth} fetch={fetch} live />);
    const header = (
      await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' })
    ).closest('header') as HTMLElement;
    await within(header).findByText(/^Lagres i testutgaven med en gang\./);

    for (const [section, tab] of [
      ['interface', 'Utforming'],
      ['versions', 'Historikk'],
      ['quality', 'Kvalitet'],
      ['settings', 'Avansert'],
      ['log', 'Teknisk'],
      ['setup', 'Oppsett'],
    ] as const) {
      window.location.hash = `#/services/rapportassistenten/${section}`;
      await waitFor(() =>
        expect(
          within(screen.getByRole('tablist', { name: /^Faner for/ })).getByRole('tab', {
            selected: true,
          }).textContent,
        ).toBe(tab),
      );
      expect(
        within(header).getByRole('heading', { level: 1, name: 'Rapportassistenten' }),
      ).toBeTruthy();
    }
    expect(header.isConnected).toBe(true);
    expect(
      calls.filter((c) => c.url.endsWith('/rapportassistenten/draft?rebase=clean')),
    ).toHaveLength(1);
  });

  it('switching tabs while the definition is fresh sends no request for it again', async () => {
    const { calls } = await openService('#/services/rapportassistenten/setup');
    await screen.findByRole('navigation', { name: 'Testutgave eller i bruk' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const definitionReads = () =>
      calls.filter(
        (c) => c.method === 'GET' && c.url.endsWith('/definitions/services/rapportassistenten'),
      ).length;
    const before = definitionReads();

    for (const section of ['interface', 'quality', 'settings', 'setup']) {
      window.location.hash = `#/services/rapportassistenten/${section}`;
      await waitFor(() =>
        expect(window.location.hash).toBe(`#/services/rapportassistenten/${section}`),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(definitionReads()).toBe(before);
  });

  it('offers Test tjenesten in the header of a new service, leading to its preview in Utforming', async () => {
    await startBuilder(mockFetch(exampleServices, logTimelines, liveModels, exampleDatasets));
    const header = screen
      .getAllByRole('heading', { level: 1 })[0]
      ?.closest('header') as HTMLElement;
    expect(
      within(header).getByRole('link', { name: 'Test tjenesten' }).getAttribute('href'),
    ).toMatch(/^#\/services\/utkast-[0-9a-f]{8}\/interface\/preview$/);
    expect(within(header).queryByRole('link', { name: 'Prøv' })).toBeNull();
    expect(within(header).queryByRole('button', { name: 'Prøv' })).toBeNull();
  });

  it('makes a copy as a new draft named Kopi av, with the files, and opens it at Oppsett', async () => {
    const { calls } = await openService('#/services/rapportassistenten');
    fireEvent.click(await screen.findByRole('button', { name: 'Mer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lag en kopi', hidden: true }));

    const copyPath = /\/services\/(utkast-[0-9a-f]{8})\/draft$/;
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PUT' && copyPath.test(c.url))).toBe(true),
    );
    const saved = calls.find((c) => c.method === 'PUT' && copyPath.test(c.url));
    const copyId = copyPath.exec(saved?.url ?? '')?.[1];
    expect(saved?.body).toMatchObject({
      revision: 0,
      definition: { metadata: { name: 'Kopi av Rapportassistenten', version: 1 } },
    });
    expect(draftWrites(calls, 'PUT')).toEqual([]);
    await waitFor(() => expect(window.location.hash).toBe(`#/services/${copyId}/setup`));
    expect(((await screen.findByLabelText('Navn')) as HTMLInputElement).value).toBe(
      'Kopi av Rapportassistenten',
    );
  });

  it('a tab switch sends no request for the definition, even once the cache has gone stale', async () => {
    const { calls, fetch } = await openService('#/services/rapportassistenten/setup');
    const header = (
      await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' })
    ).closest('header') as HTMLElement;
    expect(await within(header).findByText(/^Lagres i testutgaven med en gang\./)).toBeTruthy();

    const found = exampleServices.find((s) => s.id === 'rapportassistenten');
    await fetch('/api/definitions', {
      method: 'POST',
      headers: { 'change-reason': 'Ny innstilling' },
      body: JSON.stringify({ definition: found?.latest.definition, files: {} }),
    });
    const definitionReads = () =>
      calls.filter(
        (c) => c.method === 'GET' && c.url.endsWith('/definitions/services/rapportassistenten'),
      ).length;
    const before = definitionReads();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    window.location.hash = '#/services/rapportassistenten/quality';
    await new Promise((resolve) => setTimeout(resolve, 50));
    window.location.hash = '#/services/rapportassistenten/setup';
    await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(definitionReads()).toBe(before);
    expect(within(header).getByText(/^Lagres i testutgaven med en gang\./)).toBeTruthy();
  });
});

describe('the live builder when the draft is outdated', () => {
  const found = exampleServices.find((s) => s.id === 'rapportassistenten');
  const published = found?.latest.definition as {
    spec: { strategy: { config: Record<string, unknown> }; model: Record<string, unknown> };
  };
  const withInstructions = (text: string) => ({
    ...published,
    spec: {
      ...published.spec,
      strategy: {
        ...published.spec.strategy,
        config: { ...published.spec.strategy.config, instructions: text },
      },
    },
  });

  const startOutdated = async (elsewhere: Record<string, unknown>, whileOpen: boolean) => {
    const calls: Call[] = [];
    const base = mockFetch(exampleServices, logTimelines, liveModels, exampleDatasets, {
      features: {
        quality: { drafts: { rapportassistenten: { definition: withInstructions('Svar kort.') } } },
      },
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      calls.push({ url, method: init?.method ?? 'GET', body });
      return base(input, init);
    };
    const publishElsewhere = () =>
      base('/api/definitions', {
        method: 'POST',
        headers: { 'change-reason': 'Endret direkte' },
        body: JSON.stringify({ definition: elsewhere, files: {} }),
      });
    if (!whileOpen) await publishElsewhere();
    const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = '#/services/rapportassistenten/setup/instructions';
    render(<App auth={auth} fetch={fetch} live />);
    await screen.findByLabelText('Instruksjoner til tjenesten');
    return { calls, publishElsewhere };
  };

  const openOutdated = async (elsewhere: Record<string, unknown>) => {
    const { calls, publishElsewhere } = await startOutdated(elsewhere, true);
    await publishElsewhere();
    const dialog = await publishPage('Kortere svar til brukerne');
    return { calls, dialog };
  };

  const publishIn = publishOnPage;
  const publishes = (calls: Call[]) =>
    calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/definitions'));

  const instructionsField = () =>
    screen.getByLabelText('Instruksjoner til tjenesten') as HTMLTextAreaElement;

  it('a draft based on an older edition opens rebased onto the latest by the API, not the portal', async () => {
    const { calls } = await startOutdated(
      {
        ...published,
        spec: { ...published.spec, model: { ...published.spec.model, primary: 'aivar/qwen3-8' } },
      },
      false,
    );
    expect(await screen.findByText('Testutgaven er oppdatert til utgave 8.')).toBeTruthy();
    expect(instructionsField().value).toBe('Svar kort.');
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/draft?rebase=clean'))).toBe(
      true,
    );
    expect(calls.some((c) => c.url.endsWith('/draft/rebase'))).toBe(false);
    expect(screen.queryByText('Testutgaven bygger på en eldre utgave')).toBeNull();
  });

  it('conflicting fields are shown, not silently overwritten', async () => {
    await startOutdated(withInstructions('Svar utfyllende.'), false);
    const alert = (await screen.findByText('Testutgaven bygger på en eldre utgave')).closest(
      '[role="alert"]',
    ) as HTMLElement;
    const group = within(alert).getByRole('group', { name: /Instruksjoner/ });
    expect(within(group).getByText('Svar kort.')).toBeTruthy();
    expect(within(group).getByText('Svar utfyllende.')).toBeTruthy();
    expect(screen.queryByText(/Testutgaven er oppdatert til utgave/)).toBeNull();
  });

  it('names what changed since the draft, updates it and publishes again', async () => {
    const { calls, dialog } = await openOutdated({
      ...published,
      spec: { ...published.spec, model: { ...published.spec.model, primary: 'aivar/qwen3-8' } },
    });
    await publishIn(dialog);
    const warning = await within(dialog).findByText('Testutgaven bygger på en eldre utgave');
    const alert = warning.closest('[role="alert"]') as HTMLElement;
    expect(within(alert).getByText('Modell')).toBeTruthy();
    expect(publishes(calls)[0]?.body).toMatchObject({ draftRevision: 1 });

    fireEvent.click(within(alert).getByRole('button', { name: 'Oppdater testutgaven' }));
    expect(await within(dialog).findByText(/Testutgaven er oppdatert/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/draft/rebase'))).toBe(true);
    await publishIn(dialog);
    await waitFor(() => expect(publishes(calls)).toHaveLength(2));
    expect(publishes(calls)[1]?.body).toMatchObject({
      draftRevision: 3,
      definition: {
        spec: {
          model: { primary: 'aivar/qwen3-8' },
          strategy: { config: { instructions: 'Svar kort.' } },
        },
      },
    });
    expect(await screen.findByText('Utgave 9 er publisert.')).toBeTruthy();
  });

  it('lets the user pick the published value when both changed the same setting', async () => {
    const { calls, dialog } = await openOutdated(withInstructions('Svar utfyllende.'));
    await publishIn(dialog);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Oppdater testutgaven' }));

    const group = await within(dialog).findByRole('group', { name: /Instruksjoner/ });
    expect(within(group).getByText('Svar kort.')).toBeTruthy();
    expect(within(group).getByText('Svar utfyllende.')).toBeTruthy();
    fireEvent.click(within(group).getByLabelText(/Bruk publisert utgave/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre valgene' }));

    expect(await within(dialog).findByText(/Testutgaven er oppdatert/)).toBeTruthy();
    const saved = calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/draft')).at(-1);
    expect(saved?.body).toMatchObject({
      revision: 3,
      definition: { spec: { strategy: { config: { instructions: 'Svar utfyllende.' } } } },
    });
    fireEvent.click(within(dialog).getByRole('link', { name: 'Avbryt' }));
    await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Instruksjoner til tjenesten') as HTMLTextAreaElement).value,
      ).toBe('Svar utfyllende.'),
    );
  });
});

describe('a new service saved as a draft on the server', () => {
  const draftPath = /\/services\/(utkast-[0-9a-f]{8})\/draft$/;
  const draftWrites = (calls: Call[], method: string) =>
    calls.filter((c) => c.method === method && draftPath.test(c.url));
  const idOf = (call: Call | undefined) => draftPath.exec(call?.url ?? '')?.[1] ?? '';
  const nameIn = (call: Call | undefined) =>
    (call?.body as { definition?: { metadata?: { name?: string } } } | undefined)?.definition
      ?.metadata?.name;
  const revisions = (calls: Call[]) =>
    draftWrites(calls, 'PUT').map((c) => (c.body as { revision: number }).revision);
  const rename = async (name: string) =>
    fireEvent.change(await screen.findByLabelText('Navn'), { target: { value: name } });
  const savedAs = (calls: Call[], name: string) =>
    waitFor(() => expect(nameIn(draftWrites(calls, 'PUT').at(-1))).toBe(name), { timeout: 3000 });

  const quiet = (
    refuse?: (method: string, url: string) => Response | undefined,
    drafts: Record<string, { definition: Record<string, unknown> }> = {},
  ) => {
    const calls: Call[] = [];
    const base = mockFetch(exampleServices, logTimelines, liveModels, exampleDatasets, {
      features: {
        quality: { drafts },
        assistant: {
          reply: () => ({
            turnId: 'trn_quiet',
            status: 'completed',
            message: 'Jeg venter på mer fra deg.',
            proposals: [],
            usage: { tokens: 10, budgetLeftToday: 1000, dailyBudget: 1000 },
          }),
        },
      },
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      calls.push({ url, method, body });
      return refuse?.(method, url) ?? base(input, init);
    };
    return { calls, fetch };
  };

  const startNamed = async (name: string) => {
    const recording = recorded();
    const panel = await startBuilder(recording.fetch);
    await rename(name);
    await savedAs(recording.calls, name);
    return { ...recording, panel, id: idOf(draftWrites(recording.calls, 'PUT')[0]) };
  };

  const elsewhere = async (fetch: typeof globalThis.fetch, hash: string) => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = hash;
    render(<App auth={auth} fetch={fetch} live />);
  };

  it('saves an empty draft from the platform template under its own id at once, and opens its Oppsett', async () => {
    const { calls, fetch } = quiet();
    await startBuilder(fetch);

    const [first, ...more] = draftWrites(calls, 'PUT');
    expect(more).toEqual([]);
    expect(first?.body).toMatchObject({ revision: 0 });
    expect(nameIn(first)).toBe('');
    expect(window.location.hash).toBe(`#/services/${idOf(first)}/setup`);
    expect(screen.getByText(/^Lagres i testutgaven med en gang\./)).toBeTruthy();
  });

  it('saves one draft, not two, when React runs the start twice in StrictMode', async () => {
    const { calls, fetch } = quiet();
    const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = '#/services/new';
    render(
      <StrictMode>
        <App auth={auth} fetch={fetch} live />
      </StrictMode>,
    );
    await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });

    const puts = draftWrites(calls, 'PUT');
    expect(puts).toHaveLength(1);
    expect(window.location.hash).toBe(`#/services/${idOf(puts[0])}/setup`);
  });

  it('saves no draft in the organisation the person switches to while a new service is being saved', async () => {
    const { calls, fetch: base } = quiet();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === 'PUT' && url.includes('/tenants/999888777/') && draftPath.test(url)) {
        calls.push({ url, method: 'PUT', body: undefined });
        return new Promise<Response>(() => undefined);
      }
      if (url.includes('/tenants/999777666/definitions/template'))
        await new Promise((resolve) => setTimeout(resolve, 50));
      return base(input, init);
    };
    const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = '#/services/new';
    render(<App auth={auth} fetch={fetch} live />);
    await waitFor(() => expect(draftWrites(calls, 'PUT')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Brukermeny for Ingrid Berg, Testetaten' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Prøvekommunen/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/overview?org=999777666'));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(draftWrites(calls, 'PUT').filter((c) => c.url.includes('/tenants/999777666/'))).toEqual(
      [],
    );
  });

  it('saves the draft again on Prøv igjen after the first save failed, and opens its Oppsett', async () => {
    let refused = 0;
    const { calls, fetch } = quiet((method, url) =>
      method === 'PUT' && draftPath.test(url) && refused++ === 0
        ? new Response(JSON.stringify({ title: 'Feil' }), { status: 500 })
        : undefined,
    );
    const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = '#/services/new';
    render(<App auth={auth} fetch={fetch} live />);

    fireEvent.click(await screen.findByRole('button', { name: 'Prøv igjen' }));
    await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });
    const puts = draftWrites(calls, 'PUT');
    expect(puts).toHaveLength(2);
    expect(window.location.hash).toBe(`#/services/${idOf(puts[1])}/setup`);
  });

  it('saves nothing more while nothing has changed, and saves the first change the person makes', async () => {
    const { calls, fetch } = quiet();
    await startBuilder(fetch);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(revisions(calls)).toEqual([0]);

    await rename('Permisjonssvar');
    await savedAs(calls, 'Permisjonssvar');
    expect(revisions(calls)).toEqual([0, 1]);
  });

  it('keeps the conversation, saves every change to the same draft and never reloads it', async () => {
    const { calls, panel, id } = await startNamed('Permisjonssvar');
    const opened = () => calls.filter((c) => c.url.includes(`/services/${id}/draft?`)).length;
    const openedAtStart = opened();
    tellAssistant(panel, 'Svar på spørsmål om permisjon');
    expect(await within(panel).findByText('Svar på spørsmål om permisjon')).toBeTruthy();

    await rename('Permisjonssvar for ledere');
    await savedAs(calls, 'Permisjonssvar for ledere');
    expect(screen.getByRole('complementary', { name: 'Byggeassistent' })).toBe(panel);
    expect(within(panel).getByText('Svar på spørsmål om permisjon')).toBeTruthy();
    expect(window.location.hash).toBe(`#/services/${id}/setup`);
    expect(new Set(draftWrites(calls, 'PUT').map(idOf))).toEqual(new Set([id]));
    expect(revisions(calls)).toEqual(revisions(calls).map((_, i) => i));
    expect(opened()).toBe(openedAtStart);
  });

  it('lists the draft under Tjenester as Utkast and resumes it in another browser', async () => {
    const { calls, fetch, id } = await startNamed('Permisjonssvar');
    const saved = draftWrites(calls, 'PUT').length;

    await elsewhere(fetch, '#/services');
    const link = await screen.findByRole('link', { name: 'Permisjonssvar' });
    expect(link.getAttribute('href')).toBe(`#/services/${id}`);
    const row = link.closest('li') as HTMLElement;
    expect(within(row).getByText('Utkast')).toBeTruthy();
    expect(within(row).getByText(/av Kari Nordmann/)).toBeTruthy();

    window.location.hash = `#/services/${id}`;
    expect(((await screen.findByLabelText('Navn')) as HTMLInputElement).value).toBe(
      'Permisjonssvar',
    );
    expect(screen.getByText(/^Lagres i testutgaven med en gang\./)).toBeTruthy();
    await rename('Permisjonssvar for ledere');
    await savedAs(calls, 'Permisjonssvar for ledere');
    expect(revisions(calls).at(-1)).toBe(saved);
  });

  it('tells on the setup of a draft that Oversikt and Kvalitet arrive once it is published', async () => {
    const { fetch, id } = await startNamed('Permisjonssvar');

    await elsewhere(fetch, `#/services/${id}/setup`);

    expect(
      await screen.findByText('Oversikt og Kvalitet kommer når tjenesten er publisert.'),
    ).toBeTruthy();
  });

  it('opens a saved draft-only service in the one-form Oppsett, with the assistant beside it', async () => {
    const { fetch, id } = await startNamed('Permisjonssvar');

    await elsewhere(fetch, `#/services/${id}/setup`);

    expect(await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Deler av oppsettet' })).toBeNull();
    const side = screen.getByRole('region', { name: 'Byggeassistent og prøving' });
    expect(side.contains(screen.getByRole('complementary', { name: 'Byggeassistent' }))).toBe(true);
  });

  it('opens the first publish page of a draft-only service from /setup/publish', async () => {
    const { fetch, id } = await startNamed('Permisjonssvar');

    await elsewhere(fetch, `#/services/${id}/setup/publish`);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Publiser Permisjonssvar' }),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.hash).toBe(`#/services/${id}/setup/publish`);
  });

  it('opens a draft-only service at its setup when the address names a section it does not have', async () => {
    const { fetch, id } = await startNamed('Permisjonssvar');

    await elsewhere(fetch, `#/services/${id}/quality`);

    expect(((await screen.findByLabelText('Navn')) as HTMLInputElement).value).toBe(
      'Permisjonssvar',
    );
    expect(screen.getByRole('tab', { name: 'Oppsett', selected: true })).toBeTruthy();
  });

  it('moves the address of a draft-only service from /settings to its limits under Avansert', async () => {
    const { fetch, id } = await startNamed('Permisjonssvar');

    await elsewhere(fetch, `#/services/${id}/settings`);

    await waitFor(() => expect(window.location.hash).toBe(`#/services/${id}/advanced/limits`));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Begrensninger og loggføring' }),
    ).toBeTruthy();
  });

  it.each(['quality', 'log', 'bogus'])(
    'moves the address of a draft-only service from /%s to Oppsett, the section it shows',
    async (section) => {
      const { fetch, id } = await startNamed('Permisjonssvar');

      await elsewhere(fetch, `#/services/${id}/${section}`);

      await screen.findByLabelText('Navn');
      await waitFor(() => expect(window.location.hash).toBe(`#/services/${id}/setup`));
    },
  );

  const deleteQuestion = /^Vil du slette utkastet til Permisjonssvar\?/;
  const confirmBox = async () =>
    (await screen.findByText(deleteQuestion)).parentElement as HTMLElement;

  it('deletes a draft-only service after a confirmation on the page, and the list no longer shows it', async () => {
    const { calls, id } = await startNamed('Permisjonssvar');

    fireEvent.click(await screen.findByRole('button', { name: 'Slett utkastet' }));
    fireEvent.click(within(await confirmBox()).getByRole('button', { name: 'Avbryt' }));
    expect(screen.queryByText(deleteQuestion)).toBeNull();
    expect(draftWrites(calls, 'DELETE')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Slett utkastet' }));
    fireEvent.click(within(await confirmBox()).getByRole('button', { name: 'Slett utkastet' }));

    await waitFor(() => expect(window.location.hash).toBe('#/services'));
    expect(draftWrites(calls, 'DELETE').map((c) => [idOf(c), c.body])).toEqual([
      [id, { revision: revisions(calls).length }],
    ]);
    expect(await screen.findByText('Ingen tjenester ennå')).toBeTruthy();
  });

  it('offers to delete the draft of a service never published, and not the draft of a published one', async () => {
    const published = exampleServices.find((s) => s.id === 'rapportassistenten');
    const { fetch } = quiet(undefined, {
      rapportassistenten: { definition: published?.latest.definition ?? {} },
    });
    await startBuilder(fetch);
    expect(await screen.findByRole('button', { name: 'Slett utkastet' })).toBeTruthy();

    window.location.hash = '#/services/rapportassistenten';
    await screen.findByRole('navigation', { name: 'Testutgave eller i bruk' });
    expect(screen.queryByRole('button', { name: 'Slett utkastet' })).toBeNull();
  });

  it('says so when the draft could not be deleted, keeps the page and goes on saving', async () => {
    const { calls, fetch } = quiet((method, url) =>
      method === 'DELETE' && draftPath.test(url) ? new Response(null, { status: 500 }) : undefined,
    );
    await startBuilder(fetch);
    await rename('Permisjonssvar');
    await savedAs(calls, 'Permisjonssvar');
    const id = idOf(draftWrites(calls, 'PUT')[0]);

    fireEvent.click(await screen.findByRole('button', { name: 'Slett utkastet' }));
    fireEvent.click(within(await confirmBox()).getByRole('button', { name: 'Slett utkastet' }));

    expect(await screen.findByText('Kunne ikke slette utkastet. Prøv igjen om litt.')).toBeTruthy();
    expect(window.location.hash).toBe(`#/services/${id}/setup`);
    await rename('Permisjonssvar for ledere');
    await savedAs(calls, 'Permisjonssvar for ledere');
  });

  it('publishing clears the draft, opens the published service and drops the draft from the list', async () => {
    const { calls, id } = await startNamed('Permisjonssvar');
    const page = await toFirstPublish();
    fireEvent.click(within(page).getByRole('button', { name: 'Bekreft risikonivå' }));
    fireEvent.change(within(page).getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Første versjon av tjenesten' },
    });
    await waitFor(() => expect(within(page).queryByText(leftHeading)).toBeNull());
    fireEvent.click(within(page).getByRole('button', { name: 'Publiser' }));

    await waitFor(() => expect(window.location.hash).toBe('#/services/permisjonssvar'));
    expect(draftWrites(calls, 'DELETE').map(idOf)).toEqual([id]);
    window.location.hash = '#/services';
    const link = await screen.findByRole('link', { name: 'Permisjonssvar' });
    expect(link.getAttribute('href')).toBe('#/services/permisjonssvar');
    expect(within(link.closest('li') as HTMLElement).queryByText('Utkast')).toBeNull();
  });
});
