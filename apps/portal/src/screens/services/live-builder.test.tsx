// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
afterEach(cleanup);

const liveModels: ModelOption[] = [
  { id: 'foundry-openai/gpt-4.1-mini', residency: 'global', capabilities: ['stream'] },
  { id: 'foundry-openai/gpt-4.1', residency: 'eu', capabilities: ['stream'] },
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

const startBuilder = async (fetch: typeof globalThis.fetch) => {
  const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
  await auth.login();
  window.location.hash = '#/services/new';
  render(<App auth={auth} fetch={fetch} live />);
  await screen.findByRole('heading', { name: 'Lag med KI' });
  fireEvent.change(screen.getByLabelText('Hva skal tjenesten gjøre?'), {
    target: { value: 'Svar på spørsmål om permisjon' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start med assistenten' }));
  return screen.findByRole('complementary', { name: 'Byggeassistent' });
};

const openSection = async (name: RegExp) => {
  fireEvent.click(await screen.findByRole('button', { name }));
};

type Spec = {
  model: { primary: string };
  tools: string[];
  knowledge: { datasets: { dataset: string }[] };
  guardrails: Record<string, { categories?: string[] }>;
  riskConfirmation?: Record<string, unknown>;
};

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
    expect(await within(panel).findByText('Ingrid Berg')).toBeTruthy();
    expect(within(panel).queryByText('Kari Nordmann')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
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

  it('lists only live models with residency in words and no invented cost or speed', async () => {
    const { fetch } = recorded();
    await startBuilder(fetch);
    await openSection(/^Modell/);

    const models = screen.getByRole('group', { name: 'Modeller Digdir tillater' });
    expect(within(models).getAllByRole('radio')).toHaveLength(2);
    expect(within(models).getByText(/Data behandles i EU/)).toBeTruthy();
    expect(within(models).getAllByText('Kostnad: ikke priset')).toHaveLength(2);
    expect(within(models).queryByText(/Borealis|Fart:|Kostnad: høy/)).toBeNull();
  });

  it('picks datasets from the catalog, writes the full id and removes them again', async () => {
    const { calls, fetch } = recorded();
    await startBuilder(fetch);
    await openSection(/^Kunnskap/);

    fireEvent.click(screen.getByRole('button', { name: 'Legg til datasett' }));
    expect(await screen.findByText('Delt med dere')).toBeTruthy();
    expect(screen.queryByText('Statsbudsjettet 2026')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til Kudos-rapporter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Legg til Veiledere og rundskriv' }));
    expect(screen.queryByText('612 dokumenter')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Fjern datasettet Veiledere og rundskriv' }),
    );
    expect(
      screen.queryByRole('button', { name: 'Fjern datasettet Veiledere og rundskriv' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/validate'))).toBe(true));
    expect(lastValidated(calls).knowledge.datasets).toEqual([{ dataset: 'digdir/kudos' }]);
  });

  it('adds tools from the connected tool servers with their versioned reference', async () => {
    const { calls, fetch } = recorded();
    await startBuilder(fetch);
    await openSection(/^Verktøy/);

    fireEvent.click(screen.getByRole('button', { name: 'Legg til verktøy fra katalogen' }));
    expect(await screen.findByRole('button', { name: 'Legg til arkiv.hent' })).toBeTruthy();
    expect(screen.queryByText(/klarsprak|Enhetsregisteret|lovdata/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til arkiv.sok' }));

    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/validate'))).toBe(true));
    expect(lastValidated(calls).tools).toEqual(['arkiv.sok@1.2']);
  });

  it('shows validation errors by section, locks Publiser and never sends who confirmed the risk', async () => {
    const { calls, fetch } = recorded(
      () =>
        new Response(
          JSON.stringify({
            title: 'Invalid definition',
            status: 422,
            errors: [
              { path: 'spec.model', message: 'model x runs in global, outside norway' },
              { path: 'spec.riskConfirmation', message: 'a limited service needs a confirmation' },
            ],
          }),
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
    );
    await startBuilder(fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Bekreft risikonivå' }));

    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Modell:')).toBeTruthy();
    expect(within(dialog).getByText(/Modellen behandler data i global region/)).toBeTruthy();
    expect(within(dialog).getByText('Formål og målgruppe:')).toBeTruthy();
    expect(within(dialog).queryByText('Alle krav er bestått.')).toBeNull();
    expect(within(dialog).getByRole('heading', { name: 'Versjon 1, første versjon' })).toBeTruthy();
    expect(within(dialog).queryByText('Ingen endringer siden forrige versjon')).toBeNull();

    fireEvent.change(within(dialog).getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Første versjon av tjenesten' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publiser' }));
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/definitions'))).toBe(
      false,
    );

    const confirmation = lastValidated(calls).riskConfirmation;
    expect(confirmation).toMatchObject({ riskClass: 'limited' });
    expect(confirmation).not.toHaveProperty('by');
  });

  it('opens the published service with its status in the header right after the first publish', async () => {
    const { calls, fetch } = recorded();
    await startBuilder(fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Bekreft risikonivå' }));
    const header = document.querySelector('.service-head') as HTMLElement;
    expect(within(header).getByText('Utkast')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Første versjon av tjenesten' },
    });
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Publiser' }).getAttribute('aria-disabled'),
      ).not.toBe('true'),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publiser' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/definitions'))).toBe(
        true,
      ),
    );
    await waitFor(() => expect(window.location.hash).toBe('#/services/ny-tjeneste'));
    const published = await waitFor(() => {
      const head = document.querySelector('.service-head') as HTMLElement;
      expect(within(head).getByText('I bruk')).toBeTruthy();
      return head;
    });
    expect(within(published).queryByText('Utkast')).toBeNull();
  });

  it('drops the risk confirmation when the risk level changes', async () => {
    const { fetch } = recorded();
    await startBuilder(fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Bekreft risikonivå' }));
    expect(await screen.findByText('Bekreftet av Ingrid Berg i dag')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^Høy/ }));
    expect(screen.queryByText('Bekreftet av Ingrid Berg i dag')).toBeNull();
  });

  const openPublish = async (runs: unknown[], testSets: unknown[]) => {
    const base = mockFetch(exampleServices, logTimelines, liveModels, exampleDatasets);
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
    return screen.findByRole('dialog');
  };

  it('shows the latest test run from the API in the publish dialog, not an example score', async () => {
    const dialog = await openPublish(
      [
        {
          id: 'r1',
          status: 'succeeded',
          testSet: 'ts',
          version: 'draft',
          startedAt: '2026-10-07T10:00:00Z',
          total: 10,
          passed: 8,
        },
      ],
      [{ id: 'ts', name: 'Spørsmål', cases: 10 }],
    );
    const fact = await within(dialog).findByText('8 av 10 (80 %)');
    expect(fact).toBeTruthy();
    expect(within(dialog).queryByText(/Uten testsett/)).toBeNull();
  });

  it('warns about a missing test set from the API and says Ikke kjørt without runs', async () => {
    const dialog = await openPublish([], []);
    expect(await within(dialog).findByText(/Uten testsett ser du ikke/)).toBeTruthy();
    expect(within(dialog).getByText('Ikke laget')).toBeTruthy();
    cleanup();

    const withSet = await openPublish([], [{ id: 'ts', name: 'Spørsmål', cases: 3 }]);
    expect(await within(withSet).findByText('Ikke kjørt')).toBeTruthy();
  });
});

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
    fireEvent.click(within(card).getByRole('button', { name: 'Godta i utkastet' }));
    await within(card).findByText('Godtatt i utkastet');

    window.location.hash = '#/services/rapportassistenten/setup/instructions';
    await waitFor(() => expect(instructions().value).toBe(after));
    window.location.hash = '#/services/rapportassistenten/setup/purpose';
    fireEvent.click(await screen.findByRole('button', { name: 'Bekreft risikonivå' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Endringer i utkastet som ikke er publisert')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Tar i bruk forbedringsforslaget' },
    });
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Publiser' }).getAttribute('aria-disabled'),
      ).not.toBe('true'),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publiser' }));

    await waitFor(() => expect(draftWrites(calls, 'DELETE')).toHaveLength(1));
    const published = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/definitions'));
    expect(published?.body).toMatchObject({
      definition: { spec: { strategy: { config: { instructions: after } } } },
    });
    expect(draftWrites(calls, 'DELETE')[0]?.body).toEqual({ revision: 1 });
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

  it('shows the latest published version in the header, also after a publish elsewhere', async () => {
    const { fetch } = await openService('#/services/rapportassistenten/setup');
    const header = (
      await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' })
    ).closest('header') as HTMLElement;
    expect(await within(header).findByText(/^Versjon 7 · publisert/)).toBeTruthy();

    const found = exampleServices.find((s) => s.id === 'rapportassistenten');
    await fetch('/api/definitions', {
      method: 'POST',
      headers: { 'change-reason': 'Ny innstilling' },
      body: JSON.stringify({ definition: found?.latest.definition, files: {} }),
    });
    window.location.hash = '#/services/rapportassistenten/quality';

    expect(await screen.findByText(/^Versjon 8 · publisert/)).toBeTruthy();
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
    window.location.hash = '#/services/rapportassistenten/setup/purpose';
    fireEvent.click(await screen.findByRole('button', { name: 'Bekreft risikonivå' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Kortere svar til brukerne' },
    });
    return { calls, dialog };
  };

  const publishIn = async (dialog: HTMLElement) => {
    const button = within(dialog).getByRole('button', { name: 'Publiser' });
    await waitFor(() => expect(button.getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(button);
  };
  const publishes = (calls: Call[]) =>
    calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/definitions'));

  const instructionsField = () =>
    screen.getByLabelText('Instruksjoner til tjenesten') as HTMLTextAreaElement;

  it('a draft based on an older version opens rebased onto the latest by the API, not the portal', async () => {
    const { calls } = await startOutdated(
      {
        ...published,
        spec: { ...published.spec, model: { ...published.spec.model, primary: 'aivar/qwen3-8' } },
      },
      false,
    );
    expect(await screen.findByText('Utkastet er oppdatert til versjon 8.')).toBeTruthy();
    expect(instructionsField().value).toBe('Svar kort.');
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/draft?rebase=clean'))).toBe(
      true,
    );
    expect(calls.some((c) => c.url.endsWith('/draft/rebase'))).toBe(false);
    expect(screen.queryByText('Utkastet bygger på en eldre versjon')).toBeNull();
  });

  it('conflicting fields are shown, not silently overwritten', async () => {
    await startOutdated(withInstructions('Svar utfyllende.'), false);
    const alert = (await screen.findByText('Utkastet bygger på en eldre versjon')).closest(
      '[role="alert"]',
    ) as HTMLElement;
    const group = within(alert).getByRole('group', { name: /Instruksjoner/ });
    expect(within(group).getByText('Svar kort.')).toBeTruthy();
    expect(within(group).getByText('Svar utfyllende.')).toBeTruthy();
    expect(screen.queryByText(/Utkastet er oppdatert til versjon/)).toBeNull();
  });

  it('names what changed since the draft, updates it and publishes again', async () => {
    const { calls, dialog } = await openOutdated({
      ...published,
      spec: { ...published.spec, model: { ...published.spec.model, primary: 'aivar/qwen3-8' } },
    });
    await publishIn(dialog);
    const warning = await within(dialog).findByText('Utkastet bygger på en eldre versjon');
    const alert = warning.closest('[role="alert"]') as HTMLElement;
    expect(within(alert).getByText('Modell')).toBeTruthy();
    expect(publishes(calls)[0]?.body).toMatchObject({ draftRevision: 1 });

    fireEvent.click(within(alert).getByRole('button', { name: 'Oppdater utkastet' }));
    expect(await within(dialog).findByText(/Utkastet er oppdatert/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/draft/rebase'))).toBe(true);
    await publishIn(dialog);
    await waitFor(() => expect(publishes(calls)).toHaveLength(2));
    expect(publishes(calls)[1]?.body).toMatchObject({
      draftRevision: 2,
      definition: {
        spec: {
          model: { primary: 'aivar/qwen3-8' },
          strategy: { config: { instructions: 'Svar kort.' } },
        },
      },
    });
    expect(await screen.findByText('Versjon 9 er publisert.')).toBeTruthy();
  });

  it('lets the user pick the published value when both changed the same setting', async () => {
    const { calls, dialog } = await openOutdated(withInstructions('Svar utfyllende.'));
    await publishIn(dialog);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Oppdater utkastet' }));

    const group = await within(dialog).findByRole('group', { name: /Instruksjoner/ });
    expect(within(group).getByText('Svar kort.')).toBeTruthy();
    expect(within(group).getByText('Svar utfyllende.')).toBeTruthy();
    fireEvent.click(within(group).getByLabelText(/Bruk publisert versjon/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre valgene i utkastet' }));

    expect(await within(dialog).findByText(/Utkastet er oppdatert/)).toBeTruthy();
    const saved = calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/draft')).at(-1);
    expect(saved?.body).toMatchObject({
      revision: 2,
      definition: { spec: { strategy: { config: { instructions: 'Svar utfyllende.' } } } },
    });
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

  it('saves nothing while nothing has changed, and saves the first change the person makes', async () => {
    const { calls, fetch } = quiet();
    const panel = await startBuilder(fetch);
    await within(panel).findAllByText('Jeg venter på mer fra deg.');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(calls.filter((c) => c.url.includes('/draft'))).toEqual([]);

    await rename('Permisjonssvar');
    await savedAs(calls, 'Permisjonssvar');
    expect(revisions(calls)).toEqual([0]);
  });

  it('saves the work as a draft under its own id from the first change, and moves the address there', async () => {
    const { calls, fetch } = recorded();
    await startBuilder(fetch);

    await waitFor(() => expect(draftWrites(calls, 'PUT').length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    const id = idOf(draftWrites(calls, 'PUT')[0]);
    expect(revisions(calls)[0]).toBe(0);
    await waitFor(() => expect(window.location.hash).toBe(`#/services/${id}`));
    expect(screen.getByText('Ikke publisert · lagres automatisk')).toBeTruthy();
  });

  it('keeps the conversation when the address moves, saves every change to the same draft and never reloads it', async () => {
    const { calls, panel, id } = await startNamed('Permisjonssvar');
    await waitFor(() => expect(window.location.hash).toBe(`#/services/${id}`));

    expect(screen.getByRole('complementary', { name: 'Byggeassistent' })).toBe(panel);
    expect(within(panel).getByText('Svar på spørsmål om permisjon')).toBeTruthy();
    await rename('Permisjonssvar for ledere');
    await savedAs(calls, 'Permisjonssvar for ledere');
    expect(new Set(draftWrites(calls, 'PUT').map(idOf))).toEqual(new Set([id]));
    expect(revisions(calls)).toEqual(revisions(calls).map((_, i) => i));
    expect(calls.filter((c) => c.url.endsWith(`/services/${id}/draft?rebase=clean`))).toEqual([]);
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
    expect(screen.getByText('Ikke publisert · lagres automatisk')).toBeTruthy();
    await rename('Permisjonssvar for ledere');
    await savedAs(calls, 'Permisjonssvar for ledere');
    expect(revisions(calls).at(-1)).toBe(saved);
  });

  it('opens a draft-only service at its setup when the address names a section it does not have', async () => {
    const { fetch, id } = await startNamed('Permisjonssvar');

    await elsewhere(fetch, `#/services/${id}/quality`);

    expect(((await screen.findByLabelText('Navn')) as HTMLInputElement).value).toBe(
      'Permisjonssvar',
    );
    expect(screen.getByRole('link', { name: 'Oppsett', current: 'page' })).toBeTruthy();
  });

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

  it('offers to delete only a saved draft of a service never published', async () => {
    const published = exampleServices.find((s) => s.id === 'rapportassistenten');
    const { fetch } = quiet(undefined, {
      rapportassistenten: { definition: published?.latest.definition ?? {} },
    });
    await startBuilder(fetch);
    await screen.findByRole('button', { name: 'Publiser' });
    expect(screen.queryByRole('button', { name: 'Slett utkastet' })).toBeNull();

    await rename('Permisjonssvar');
    expect(await screen.findByRole('button', { name: 'Slett utkastet' })).toBeTruthy();

    window.location.hash = '#/services/rapportassistenten';
    await screen.findByText(/upublisert utkast/);
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
    expect(window.location.hash).toBe(`#/services/${id}`);
    await rename('Permisjonssvar for ledere');
    await savedAs(calls, 'Permisjonssvar for ledere');
  });

  it('publishing clears the draft, opens the published service and drops the draft from the list', async () => {
    const { calls, id } = await startNamed('Permisjonssvar');
    fireEvent.click(await screen.findByRole('button', { name: 'Bekreft risikonivå' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Første versjon av tjenesten' },
    });
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Publiser' }).getAttribute('aria-disabled'),
      ).not.toBe('true'),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publiser' }));

    await waitFor(() => expect(window.location.hash).toBe('#/services/permisjonssvar'));
    expect(draftWrites(calls, 'DELETE').map(idOf)).toEqual([id]);
    window.location.hash = '#/services';
    const link = await screen.findByRole('link', { name: 'Permisjonssvar' });
    expect(link.getAttribute('href')).toBe('#/services/permisjonssvar');
    expect(within(link.closest('li') as HTMLElement).queryByText('Utkast')).toBeNull();
  });
});
