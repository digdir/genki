// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const bar = () => screen.getByRole('region', { name: 'Lagring' });
const statusLine = () =>
  screen.getByText((_, el) => el?.classList.contains('service-status') ?? false);
const instructions = () =>
  screen.getByLabelText('Instruksjoner til tjenesten') as HTMLTextAreaElement;
const draftWrites = (calls: Call[], method: string) =>
  calls.filter((c) => c.method === method && c.url.endsWith('/rapportassistenten/draft'));

describe('the draft bar on Oppsett for an existing service', () => {
  it('says everything is published, with no bar, while the test edition matches the edition in use', async () => {
    await openService('#/services/rapportassistenten/setup');
    await waitFor(() => expect(statusLine().textContent).toContain('Alt er publisert.'));
    expect(statusLine().textContent).toContain(
      'Lagres i testutgaven med en gang. Brukerne har det ikke før du publiserer.',
    );
    expect(screen.queryByRole('region', { name: 'Lagring' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Publiser' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('autosaves after a short pause, not on every keystroke, and then counts the changes', async () => {
    const calls = await openService('#/services/rapportassistenten/setup/purpose');
    await screen.findByLabelText('Instruksjoner til tjenesten');

    fireEvent.change(instructions(), { target: { value: 'Svar kort.' } });
    fireEvent.change(instructions(), { target: { value: 'Svar kort og høflig.' } });
    expect(draftWrites(calls, 'PUT')).toHaveLength(0);

    await waitFor(() => expect(draftWrites(calls, 'PUT')).toHaveLength(1), { timeout: 3000 });
    const unpublished = screen.getByRole('link', { name: 'Én endring er ikke publisert' });
    expect(unpublished.getAttribute('href')).toBe('#/services/rapportassistenten/setup/publish');
    expect(draftWrites(calls, 'PUT')[0]?.body).toMatchObject({
      definition: { spec: { strategy: { config: { instructions: 'Svar kort og høflig.' } } } },
    });
    expect(screen.queryByRole('region', { name: 'Lagring' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Publiser' })).toBeTruthy();
  });

  it('saves the last edit when the owner switches to I bruk before the pause is over', async () => {
    const calls = await openService('#/services/rapportassistenten/setup/purpose');
    await screen.findByLabelText('Instruksjoner til tjenesten');

    fireEvent.change(instructions(), { target: { value: 'Svar kort og høflig.' } });
    fireEvent.click(screen.getByRole('link', { name: 'I bruk' }));

    await waitFor(() => expect(draftWrites(calls, 'PUT')).toHaveLength(1));
    expect(draftWrites(calls, 'PUT')[0]?.body).toMatchObject({
      definition: { spec: { strategy: { config: { instructions: 'Svar kort og høflig.' } } } },
    });
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

    const failed = await screen.findByRole('region', { name: 'Lagring' }, { timeout: 3000 });
    expect(within(failed).getByText('Ikke lagret')).toBeTruthy();
    expect(within(bar()).getByText(/^Vi fikk ikke kontakt med genki kl\. /)).toBeTruthy();
    expect(instructions().value).toBe('Svar kort.');

    failing = false;
    fireEvent.click(within(bar()).getByRole('button', { name: 'Lagre' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Lagring' })).toBeNull(), {
      timeout: 3000,
    });
    expect(draftWrites(calls, 'PUT').length).toBeGreaterThanOrEqual(2);
  });

  it('offers to discard when a save fails, and Behold endringene keeps the draft', async () => {
    const calls = await openService('#/services/rapportassistenten/setup/purpose', {
      draft: withInstructions('Svar kort.'),
      reply: (url, method) =>
        method === 'PUT' && url.endsWith('/rapportassistenten/draft')
          ? new Response(JSON.stringify({ title: 'Nede', status: 503 }), {
              status: 503,
              headers: { 'content-type': 'application/problem+json' },
            })
          : undefined,
    });
    await waitFor(() => expect(instructions().value).toBe('Svar kort.'));
    fireEvent.change(instructions(), { target: { value: 'Svar kort.!' } });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Forkast endringer' }, { timeout: 3000 }),
    );

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('heading', { name: 'Forkaste 1 endring?' })).toBeTruthy();
    expect(within(dialog).getByText(/^Instruksjonene er (endret|skrevet)$/)).toBeTruthy();
    expect(within(dialog).getByText(/går tilbake til utgave 7, som er i bruk/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Behold endringene' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(instructions().value).toBe('Svar kort.!');
    expect(draftWrites(calls, 'DELETE')).toHaveLength(0);
  });

  it('discarding deletes the draft and restores the edition in use', async () => {
    const calls = await openService('#/services/rapportassistenten/setup/purpose', {
      draft: withInstructions('Svar kort.'),
      reply: (url, method) =>
        method === 'PUT' && url.endsWith('/rapportassistenten/draft')
          ? new Response(JSON.stringify({ title: 'Nede', status: 503 }), {
              status: 503,
              headers: { 'content-type': 'application/problem+json' },
            })
          : undefined,
    });
    await waitFor(() => expect(instructions().value).toBe('Svar kort.'));
    fireEvent.change(instructions(), { target: { value: 'Svar kort.!' } });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Forkast endringer' }, { timeout: 3000 }),
    );
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forkast 1 endring' }));

    expect(await screen.findByText(/^Endringene er forkastet\. Du ser nå utgave 7/)).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(instructions().value).toBe(publishedInstructions);
    expect(statusLine().textContent).toContain('Alt er publisert.');
    expect(draftWrites(calls, 'DELETE')).toHaveLength(1);
    expect(draftWrites(calls, 'DELETE')[0]?.body).toMatchObject({ revision: 1 });
  });

  it('a tab switch sends no request for the definition', async () => {
    const calls = await openService('#/services/rapportassistenten/setup');
    await waitFor(() => expect(statusLine().textContent).toContain('Alt er publisert.'));
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
    await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });
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

  it('lists each change against the edition in use, with the real line diff behind Vis linje for linje', async () => {
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
    await screen.findByRole('heading', { level: 1, name: 'Publiser Rapportassistenten' });
    expect(screen.getByRole('heading', { level: 2, name: '2 endringer' })).toBeTruthy();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'I bruk nå' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: 'Etter publisering' })).toBeTruthy();
    expect(within(table).getByRole('rowheader', { name: 'Modell' })).toBeTruthy();
    expect(screen.queryByText(/Svar alltid på bokmål\./)).toBeNull();

    const lines = screen.getByRole('button', { name: 'Vis linje for linje' });
    fireEvent.click(lines);
    expect(lines.getAttribute('aria-expanded')).toBe('true');
    const diff = screen.getByRole('region', { name: 'Endringer' });
    expect(diff.textContent).toContain('Svar alltid på bokmål.');
  });

  it('puts the one warning box under Krav til kvalitet when the score was measured before the last change', async () => {
    await openService('#/services/rapportassistenten/setup/publish', {
      draft: withSpec({ model: { ...published.spec.model, primary: 'foundry-openai/gpt-4.1' } }),
      reply: checksOf({ ready: true, problems: [] }),
    });
    const box = await screen.findByText('Målt før siste endring. Du kan publisere likevel.');
    expect(box.closest('[role="status"]')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Kjør testsettet' })).toBeTruthy();
    expect(screen.queryByText('Alle krav er nådd.')).toBeNull();
  });

  it('locks Publiser while the draft checks find problems and says so in the header', async () => {
    await openService('#/services/rapportassistenten/setup', {
      draft: withInstructions('Svar kort.'),
      reply: checksOf({
        ready: false,
        problems: [{ path: 'spec.knowledge.datasets[0].dataset', message: 'finnes ikke' }],
      }),
    });
    const publish = await screen.findByRole('button', { name: 'Publiser' });
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBe('true'));
    expect(screen.getByText('Kunnskap mangler før publisering')).toBeTruthy();
  });

  it('leaves Publiser open when only the risk confirmation is missing, since the publish page asks for it', async () => {
    const calls = await openService('#/services/rapportassistenten/setup', {
      draft: withInstructions('Svar kort.'),
      reply: checksOf({
        ready: false,
        problems: [{ path: 'spec.riskConfirmation', message: 'må bekreftes' }],
      }),
    });
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/rapportassistenten/draft/checks'))).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      screen.getByRole('button', { name: 'Publiser' }).getAttribute('aria-disabled'),
    ).toBeNull();
    expect(screen.queryByText(/mangler før publisering$/)).toBeNull();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Publiser' }));
    await screen.findByRole('heading', { level: 1, name: 'Publiser Rapportassistenten' });
    fireEvent.click(await screen.findByRole('button', { name: 'Bekreft risikonivå' }));
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
    await screen.findByRole('heading', { level: 2, name: 'Grunnleggende' });
    expect(window.location.hash).toMatch(/^#\/services\/utkast-[0-9a-f]{8}\/setup$/);
    expect(screen.getByRole('region', { name: 'Byggeassistent og prøving' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Lagring' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Deler av oppsettet' })).toBeNull();
  });
});

describe('Oppsett wired to the draft, dataset and input API', () => {
  it('names who saved the draft last in the discard dialog when it was someone else', async () => {
    await openService('#/services/rapportassistenten/setup/purpose', {
      draft: withInstructions('Svar kort.'),
      reply: (url, method) =>
        method === 'PUT' && url.endsWith('/rapportassistenten/draft')
          ? new Response(JSON.stringify({ title: 'Nede', status: 503 }), {
              status: 503,
              headers: { 'content-type': 'application/problem+json' },
            })
          : undefined,
    });
    await waitFor(() => expect(instructions().value).toBe('Svar kort.'));
    fireEvent.change(instructions(), { target: { value: 'Svar kort.!' } });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Forkast endringer' }, { timeout: 3000 }),
    );
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
    await waitFor(() => expect(instructions().value).toBe('Svar kort.'));
    fireEvent.change(instructions(), { target: { value: 'Svar langt.' } });
    const conflict = await screen.findByRole('region', { name: 'Lagring' }, { timeout: 3000 });
    expect(within(conflict).getByText(/^Per Hansen lagret kl\. /)).toBeTruthy();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Se forskjellen' }));
    expect(within(bar()).getAllByRole('listitem').length).toBeGreaterThan(0);
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
    expect(await screen.findByText(/^Endret i testutgaven\. I bruk har .+\.$/)).toBeTruthy();
  });

  it('shows Grenser og logging as rows, with the full settings behind Endre grenser', async () => {
    await openService('#/services/rapportassistenten/setup/limits');
    expect(await screen.findByText('Logging av spørsmål')).toBeTruthy();
    const edit = screen.getByRole('button', { name: 'Endre begrensninger' });
    expect(edit.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(edit);
    expect(edit.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the empty Byggeassistent beside the Oppsett form without suggestion chips', async () => {
    await openService('#/services/rapportassistenten/setup');
    const assistant = await screen.findByRole('complementary', { name: 'Byggeassistent' });
    expect(within(assistant).getByText(/hjelpe med å fylle ut skjemaet/)).toBeTruthy();
    expect(within(assistant).queryByRole('button', { name: 'Hva koster dette?' })).toBeNull();
    expect(within(assistant).queryByRole('button', { name: 'Test tjenesten' })).toBeNull();
  });
});
