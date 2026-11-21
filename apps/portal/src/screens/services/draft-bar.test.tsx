// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { logTimelines } from '../../data/log';
import { exampleDatasets, exampleOrganisations, exampleServices, mockFetch } from '../../mock';
import type { ModelOption } from '../../types';
import { openArea } from './setup-areas.test-utils';

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
  vi.useRealTimers();
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

const found = exampleServices.find((s) => s.id === 'rapportassistenten');
const published = found?.latest.definition as {
  spec: { strategy: { config: Record<string, unknown> }; model: Record<string, unknown> };
};
const publishedInstructions = String(published.spec.strategy.config.instructions ?? '');

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Reply = (url: string, method: string) => Response | undefined;

const openService = async (
  hash: string,
  { draft, reply }: { draft?: Record<string, unknown>; reply?: Reply } = {},
) => {
  const calls: Call[] = [];
  const base = mockFetch(exampleServices, logTimelines, liveModels, exampleDatasets, {
    features: {
      quality: draft ? { drafts: { rapportassistenten: { definition: draft } } } : {},
    },
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ url, method, body });
    return reply?.(url, method) ?? base(input, init);
  };
  const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
  await auth.login();
  window.location.hash = hash;
  render(<App auth={auth} fetch={fetch} live />);
  await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
  return calls;
};

const withSpec = (spec: Record<string, unknown>) => ({
  ...published,
  spec: { ...published.spec, ...spec },
});

const withInstructions = (text: string) =>
  withSpec({
    strategy: {
      ...published.spec.strategy,
      config: { ...published.spec.strategy.config, instructions: text },
    },
  });

const bar = () => screen.getByRole('region', { name: 'Utkast' });
const instructions = () =>
  screen.getByLabelText('Instruksjoner til tjenesten') as HTMLTextAreaElement;
const draftWrites = (calls: Call[], method: string) =>
  calls.filter((c) => c.method === method && c.url.endsWith('/rapportassistenten/draft'));

describe('the draft bar on Oppsett for an existing service', () => {
  it('says there are no changes while the service matches the edition in use', async () => {
    await openService('#/services/rapportassistenten/setup');
    expect(
      await within(await screen.findByRole('region', { name: 'Utkast' })).findByText(
        'Ingen endringer',
      ),
    ).toBeTruthy();
    expect(within(bar()).getByText('Det du ser er utgave 7, som er i bruk.')).toBeTruthy();
    expect(within(bar()).queryByRole('button', { name: 'Forkast endringer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Publiser ...' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('gives the date with the time of a draft saved on an earlier day', async () => {
    await openService('#/services/rapportassistenten/setup', {
      draft: withInstructions('Svar kort.'),
    });

    expect(
      await within(await screen.findByRole('region', { name: 'Utkast' })).findByText(
        'Utkast lagret 7. okt. 2026 kl. 12:00.',
      ),
    ).toBeTruthy();
  });

  it('autosaves after a short pause, not on every keystroke, and then counts the changes', async () => {
    const calls = await openService('#/services/rapportassistenten/setup/purpose');
    await screen.findByLabelText('Instruksjoner til tjenesten');

    fireEvent.change(instructions(), { target: { value: 'Svar kort.' } });
    fireEvent.change(instructions(), { target: { value: 'Svar kort og høflig.' } });
    expect(within(bar()).getByText('Ulagrede endringer')).toBeTruthy();
    expect(draftWrites(calls, 'PUT')).toHaveLength(0);

    await waitFor(() => expect(within(bar()).getByText(/^Utkast lagret/)).toBeTruthy(), {
      timeout: 3000,
    });
    expect(draftWrites(calls, 'PUT')).toHaveLength(1);
    expect(draftWrites(calls, 'PUT')[0]?.body).toMatchObject({
      definition: { spec: { strategy: { config: { instructions: 'Svar kort og høflig.' } } } },
    });
    expect(within(bar()).getByText('1 endring siden utgave 7.')).toBeTruthy();
    expect(within(bar()).getByText('Utgave 7 er i bruk til du publiserer.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publiser ...' })).toBeTruthy();
  });

  it('says Ikke lagret when an autosave fails, keeps the edit, and Lagre tries again', async () => {
    let failing = true;
    const calls = await openService('#/services/rapportassistenten/setup/purpose', {
      reply: (url, method) =>
        failing && method === 'PUT' && url.endsWith('/rapportassistenten/draft')
          ? new Response(JSON.stringify({ title: 'Nede', status: 503 }), {
              status: 503,
              headers: { 'content-type': 'application/problem+json' },
            })
          : undefined,
    });
    await screen.findByLabelText('Instruksjoner til tjenesten');
    fireEvent.change(instructions(), { target: { value: 'Svar kort.' } });

    expect(await within(bar()).findByText('Ikke lagret', {}, { timeout: 3000 })).toBeTruthy();
    expect(within(bar()).getByText(/^Vi fikk ikke kontakt med genki kl\. /)).toBeTruthy();
    expect(instructions().value).toBe('Svar kort.');

    failing = false;
    fireEvent.click(within(bar()).getByRole('button', { name: 'Lagre' }));
    expect(await within(bar()).findByText(/^Utkast lagret/, {}, { timeout: 3000 })).toBeTruthy();
    expect(draftWrites(calls, 'PUT').length).toBeGreaterThanOrEqual(2);
  });

  it('asks before discarding, and Behold endringene keeps the draft', async () => {
    const calls = await openService('#/services/rapportassistenten/setup/purpose', {
      draft: withInstructions('Svar kort.'),
    });
    await waitFor(() => expect(instructions().value).toBe('Svar kort.'));
    fireEvent.click(await within(bar()).findByRole('button', { name: 'Forkast endringer' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('heading', { name: 'Forkaste 1 endring?' })).toBeTruthy();
    expect(within(dialog).getByText(/^Instruksjonene er (endret|skrevet)$/)).toBeTruthy();
    expect(within(dialog).getByText(/går tilbake til utgave 7, som er i bruk/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Behold endringene' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(instructions().value).toBe('Svar kort.');
    expect(draftWrites(calls, 'DELETE')).toHaveLength(0);
  });

  it('discarding deletes the draft and restores the edition in use', async () => {
    const calls = await openService('#/services/rapportassistenten/setup/purpose', {
      draft: withInstructions('Svar kort.'),
    });
    await waitFor(() => expect(instructions().value).toBe('Svar kort.'));
    fireEvent.click(await within(bar()).findByRole('button', { name: 'Forkast endringer' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forkast 1 endring' }));

    expect(await screen.findByText(/^Endringene er forkastet\. Du ser nå utgave 7/)).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(instructions().value).toBe(publishedInstructions);
    expect(within(bar()).getByText('Ingen endringer')).toBeTruthy();
    expect(draftWrites(calls, 'DELETE')).toHaveLength(1);
    expect(draftWrites(calls, 'DELETE')[0]?.body).toMatchObject({ revision: 1 });
  });

  it('a tab switch sends no request for the definition', async () => {
    const calls = await openService('#/services/rapportassistenten/setup');
    await screen.findByText('Utgave 7 i bruk');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reads = () =>
      calls.filter(
        (c) => c.method === 'GET' && c.url.endsWith('/definitions/services/rapportassistenten'),
      ).length;
    const before = reads();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    window.location.hash = '#/services/rapportassistenten/interface';
    await new Promise((resolve) => setTimeout(resolve, 50));
    window.location.hash = '#/services/rapportassistenten/setup';
    await screen.findByRole('navigation', { name: 'Deler av oppsettet' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads()).toBe(before);
  });
});

describe('the publish page', () => {
  const checksOf =
    (body: Record<string, unknown>): Reply =>
    (url, method) =>
      method === 'GET' && url.endsWith('/rapportassistenten/draft/checks')
        ? Response.json({ service: 'rapportassistenten', revision: 1, ...body })
        : undefined;

  it('shows the instructions sentence by sentence and the model change against the edition in use', async () => {
    await openService('#/services/rapportassistenten/setup/publish', {
      draft: withSpec({
        model: { ...published.spec.model, primary: 'foundry-openai/gpt-4.1' },
        strategy: {
          ...published.spec.strategy,
          config: {
            ...published.spec.strategy.config,
            instructions: `${publishedInstructions}\nSvar alltid på bokmål.`,
          },
        },
      }),
      reply: checksOf({ ready: true, problems: [] }),
    });
    await screen.findByRole('heading', {
      level: 1,
      name: 'Publiser Rapportassistenten, utgave 8',
    });
    expect(screen.getByText('2 endringer')).toBeTruthy();
    expect(screen.getByText('Svar alltid på bokmål.')).toBeTruthy();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Utgave 7, i bruk' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: 'Utgave 8, utkast' })).toBeTruthy();
    expect(within(table).getByRole('rowheader', { name: 'Modell' })).toBeTruthy();
    expect(within(table).getByText('EU/EØS')).toBeTruthy();
    expect(
      await screen.findByText('Utkastet består sjekkene som kjøres ved publisering.'),
    ).toBeTruthy();
    expect(screen.getByText(/Modellen er byttet\. Kjør testsettet/)).toBeTruthy();
  });

  it('locks Publiser while the draft checks find problems and says so in the header', async () => {
    await openService('#/services/rapportassistenten/setup', {
      draft: withInstructions('Svar kort.'),
      reply: checksOf({
        ready: false,
        problems: [{ path: 'spec.riskConfirmation', message: 'må bekreftes' }],
      }),
    });
    const publish = await screen.findByRole('button', { name: 'Publiser ...' });
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBe('true'));
    expect(screen.getByText(/mangler før publisering$/)).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Deler av oppsettet' });
    const advanced = within(nav).getByRole('button', { name: /^Avansert/ });
    expect(within(advanced).getByText('Én mangler')).toBeTruthy();
    fireEvent.click(advanced);
    expect(within(nav).getByRole('button', { name: /^Risiko og KI-forordningen/ })).toBeTruthy();
    expect(
      within(within(nav).getByRole('button', { name: /^Risiko og KI-forordningen/ })).getByText(
        'Mangler',
      ),
    ).toBeTruthy();
  });

  it('says honestly that publish hooks were not checked when the API skipped them', async () => {
    await openService('#/services/rapportassistenten/setup/publish', {
      draft: withInstructions('Svar kort.'),
      reply: checksOf({ ready: true, problems: [], hooksSkipped: true }),
    });
    expect(
      await screen.findByText(
        'Kjøringspunkter som kjører ved publisering, er ikke sjekket her. De kan fortsatt stoppe publiseringen.',
      ),
    ).toBeTruthy();
  });

  it('publishes with a default reason when none is written and returns to Oppsett', async () => {
    const calls = await openService('#/services/rapportassistenten/setup', {
      draft: withInstructions('Svar kort.'),
      reply: checksOf({ ready: true, problems: [] }),
    });
    openArea(/^Risiko og KI-forordningen/);
    fireEvent.click(await screen.findByRole('button', { name: 'Bekreft risikonivå' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publiser ...' }));
    await screen.findByRole('heading', {
      level: 1,
      name: 'Publiser Rapportassistenten, utgave 8',
    });
    const button = screen.getByRole('button', { name: 'Publiser' });
    await waitFor(() => expect(button.getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(button);
    expect(await screen.findByText('Utgave 8 er publisert.')).toBeTruthy();
    expect(window.location.hash).toBe('#/services/rapportassistenten/setup');
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/definitions'));
    expect(post).toBeTruthy();
  });
});

describe('a new service', () => {
  it('keeps the new-service flow without a draft bar or the section list', async () => {
    const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = '#/services/new';
    render(
      <App auth={auth} fetch={mockFetch([], logTimelines, liveModels, exampleDatasets)} live />,
    );
    await screen.findByRole('heading', { name: 'Lag med KI' });
    fireEvent.change(screen.getByLabelText('Hva skal tjenesten gjøre?'), {
      target: { value: 'Svar på spørsmål om permisjon' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start med byggeassistenten' }));
    expect(await screen.findByRole('complementary', { name: 'Byggeassistent' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bekreft risikonivå' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Utkast' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Deler av oppsettet' })).toBeNull();
  });
});

describe('Oppsett wired to the draft, dataset and input API', () => {
  it('says who saved the draft last when it was someone else, in the bar and the discard dialog', async () => {
    await openService('#/services/rapportassistenten/setup', {
      draft: withInstructions('Svar kort.'),
    });
    expect(await within(bar()).findByText(/Lagret av Per Hansen\./)).toBeTruthy();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Forkast endringer' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/^Sist endret av Per Hansen, /)).toBeTruthy();
  });

  it('names who saved over the draft and shows the difference on a conflict', async () => {
    await openService('#/services/rapportassistenten/setup/purpose', {
      draft: withInstructions('Svar kort.'),
      reply: (url, method) =>
        method === 'PUT' && url.endsWith('/rapportassistenten/draft')
          ? Response.json(
              { type: 'about:blank', title: 'Conflict', status: 409 },
              { status: 409, headers: { 'content-type': 'application/problem+json' } },
            )
          : undefined,
    });
    await within(bar()).findByText(/Lagret av Per Hansen\./);
    fireEvent.change(instructions(), { target: { value: 'Svar langt.' } });
    expect(
      await within(bar()).findByText(/^Per Hansen lagret kl\. /, {}, { timeout: 3000 }),
    ).toBeTruthy();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Se forskjellen' }));
    expect(within(bar()).getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('lists datasets from the dataset list with their document count, update date and owner', async () => {
    await openService('#/services/rapportassistenten/setup/sources');
    fireEvent.change(await screen.findByLabelText('Dokumentsamlinger'), { target: { value: 'e' } });
    const hits = await screen.findByRole('list', { name: 'Treff' });
    const row = (name: string) => within(hits).getByText(name).closest('li') as HTMLElement;
    await waitFor(() => expect(within(hits).getByText('Veiledere og rundskriv')).toBeTruthy());
    expect(
      within(row('Kudos-rapporter')).getByText(
        '48 312 dokumenter · fra Digitaliseringsdirektoratet',
      ),
    ).toBeTruthy();
    expect(within(row('Kudos-rapporter')).getByText('Felles dokumentsamling')).toBeTruthy();
    expect(
      within(row('Veiledere og rundskriv')).getByText('6 dokumenter · oppdatert 7. oktober 2026'),
    ).toBeTruthy();
    expect(
      within(row('Nettsidene til Testetaten')).getByText(
        '1 240 dokumenter · ingen innlesing registrert i genki',
      ),
    ).toBeTruthy();
  });

  it('says so when the dataset list does not know the owner or the document count', async () => {
    await openService('#/services/rapportassistenten/setup/sources', {
      reply: (url, method) =>
        method === 'GET' && /\/tenants\/[^/]+\/datasets$/.test(url)
          ? Response.json({
              data: [
                {
                  id: 'ukjent',
                  fullId: '123456789/ukjent',
                  name: 'Ukjent eier',
                  scope: '123456789',
                  source: 'upload',
                  documents: null,
                  chunks: null,
                  lastExecution: null,
                  nextRunAt: null,
                  updatedAt: null,
                  owner: { tenant: '123456789', name: null },
                },
              ],
            })
          : undefined,
    });
    fireEvent.change(await screen.findByLabelText('Dokumentsamlinger'), {
      target: { value: 'ukjent' },
    });
    const hits = await screen.findByRole('list', { name: 'Treff' });
    expect(
      await within(hits).findByText(
        'Antall dokumenter ukjent · fra en virksomhet genki ikke har navnet til',
      ),
    ).toBeTruthy();
  });

  it('shows the file limits the platform reports for the draft under Inndata', async () => {
    const calls = await openService('#/services/rapportassistenten/setup/input');
    fireEvent.click(await screen.findByRole('checkbox', { name: /^Filer/ }));
    expect(await screen.findByRole('combobox', { name: 'Største fil' })).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole('combobox', { name: 'Største fil' }) as HTMLSelectElement)
          .selectedOptions[0]?.textContent,
      ).toBe('2 MB'),
    );
    expect(
      (screen.getByRole('combobox', { name: 'Antall filer' }) as HTMLSelectElement)
        .selectedOptions[0]?.textContent,
    ).toBe('Opptil 5');
    expect(
      calls.some((c) => c.method === 'POST' && c.url.endsWith('/definitions/input-fields')),
    ).toBe(true);
  });

  it('offers only the file types the platform reads at run time under Inndata', async () => {
    await openService('#/services/rapportassistenten/setup/input');
    fireEvent.click(await screen.findByRole('checkbox', { name: /^Filer/ }));
    const types = (await screen.findByRole('combobox', { name: 'Filtyper' })) as HTMLSelectElement;
    expect([...types.options].map((o) => o.textContent)).toEqual(['Tekst, Markdown, CSV og JSON']);
  });

  it('says which model the edition in use has when the draft changes it', async () => {
    await openService('#/services/rapportassistenten/setup/model', {
      draft: withSpec({ model: { ...published.spec.model, primary: 'foundry-openai/gpt-4.1' } }),
    });
    expect(await screen.findByText(/^Endret i utkastet\. Utgave 7 i bruk har /)).toBeTruthy();
  });

  it('shows Grenser og logging as rows, with the full settings behind Endre grenser', async () => {
    await openService('#/services/rapportassistenten/setup/limits');
    expect(await screen.findByText('Logging av spørsmål')).toBeTruthy();
    const edit = screen.getByRole('button', { name: 'Endre begrensninger' });
    expect(edit.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(edit);
    expect(edit.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the empty Byggeassistent on Oppsett without suggestion chips', async () => {
    await openService('#/services/rapportassistenten/setup');
    const assistant = await screen.findByRole('complementary', { name: 'Byggeassistent' });
    expect(within(assistant).getByText(/Spør om endringer i oppsettet/)).toBeTruthy();
    expect(within(assistant).queryByRole('button', { name: 'Hva koster dette?' })).toBeNull();
    expect(within(assistant).queryByRole('button', { name: 'Test tjenesten' })).toBeNull();
  });

  it('asks for the file limits only on Inndata', async () => {
    const calls = await openService('#/services/rapportassistenten/setup');
    await screen.findByRole('navigation', { name: 'Deler av oppsettet' });
    expect(calls.some((c) => c.url.endsWith('/definitions/input-fields'))).toBe(false);
  });
});

describe('the Prøv pane on Oppsett', () => {
  const runs = (calls: Call[]) =>
    calls.filter((c) => c.method === 'POST' && c.url.endsWith('/playground/runs'));
  const ask = async (question: string) => {
    fireEvent.click(await screen.findByRole('tab', { name: 'Prøv' }));
    const field = screen.getByLabelText('Spørsmål til utkastet');
    fireEvent.change(field, { target: { value: question } });
    fireEvent.keyDown(field, { key: 'Enter' });
  };

  it('takes a narrow screen from the form to Prøv with one button, as the pane sits below the form there', async () => {
    await openService('#/services/rapportassistenten/setup/purpose');
    fireEvent.click(await screen.findByRole('button', { name: 'Prøv tjenesten' }));

    const side = screen.getByRole('region', { name: 'Byggeassistent og prøving' });
    expect(within(side).getByRole('tab', { name: 'Prøv', selected: true })).toBeTruthy();
    expect(document.activeElement).toBe(side);
    expect(within(side).getByLabelText('Spørsmål til utkastet')).toBeTruthy();
  });

  it('runs the edited draft, not the edition in use, and shows the answer with its sources', async () => {
    const calls = await openService('#/services/rapportassistenten/setup/purpose', {
      reply: (url, method) =>
        method === 'POST' && url.endsWith('/playground/runs')
          ? Response.json({
              runId: 'run-1',
              text: 'Seks uker.',
              sources: [{ chunkId: 'c1', title: 'Personalhåndboka, Ferie' }],
              searchNotes: [],
              timeMs: 10,
              tokensIn: 1,
              tokensOut: 1,
              costNok: null,
              dataLocation: null,
              quota: { usedPercent: 0, monthlyTokens: 0 },
            })
          : undefined,
    });
    fireEvent.change(await screen.findByLabelText('Instruksjoner til tjenesten'), {
      target: { value: 'Svar på rim.' },
    });
    await ask('Hvor mye ferie har jeg?');

    expect(await screen.findByText('Seks uker.')).toBeTruthy();
    expect(screen.getByText('Personalhåndboka, Ferie')).toBeTruthy();
    const body = runs(calls)[0]?.body as {
      setup: { service: { version: unknown; definition: unknown } };
      input: unknown;
    };
    expect(body.setup.service.version).toBe('draft');
    expect(body.setup.service.definition).toMatchObject({
      spec: { strategy: { config: { instructions: 'Svar på rim.' } } },
    });
    expect(body.input).toEqual({ text: 'Hvor mye ferie har jeg?' });
  });

  it('shows the error when the run fails and keeps the question', async () => {
    await openService('#/services/rapportassistenten/setup/purpose', {
      reply: (url, method) =>
        method === 'POST' && url.endsWith('/playground/runs')
          ? Response.json(
              { type: 'about:blank', title: 'The run failed', status: 502 },
              { status: 502, headers: { 'content-type': 'application/problem+json' } },
            )
          : undefined,
    });
    await ask('Hvor mye ferie har jeg?');
    expect(await screen.findByText('Kunne ikke hente dataene')).toBeTruthy();
    expect(screen.getByText('Hvor mye ferie har jeg?')).toBeTruthy();
  });
});
