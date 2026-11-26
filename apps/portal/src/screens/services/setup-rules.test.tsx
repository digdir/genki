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
  vi.restoreAllMocks();
});

const liveModels: ModelOption[] = [
  {
    id: 'foundry-openai/gpt-4.1',
    residency: 'eu',
    capabilities: ['stream'],
    price: { inputPerThousand: 0.02, outputPerThousand: 0.08 },
  },
];

const found = exampleServices.find((s) => s.id === 'rapportassistenten');
const published = found?.latest.definition as {
  spec: Record<string, unknown> & {
    strategy: { config: Record<string, unknown> };
    model: Record<string, unknown>;
  };
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Reply = (url: string, method: string) => Response | undefined;

const openService = async (
  hash: string,
  {
    draft,
    files,
    reply,
  }: { draft?: Record<string, unknown>; files?: Record<string, string>; reply?: Reply } = {},
) => {
  const calls: Call[] = [];
  const base = mockFetch(exampleServices, logTimelines, liveModels, exampleDatasets, {
    features: {
      quality: draft
        ? { drafts: { rapportassistenten: { definition: draft, ...(files ? { files } : {}) } } }
        : {},
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

const checks =
  (problems: { path: string; message: string }[]): Reply =>
  (url, method) =>
    method === 'GET' && url.endsWith('/rapportassistenten/draft/checks')
      ? Response.json({
          service: 'rapportassistenten',
          revision: 1,
          ready: problems.length === 0,
          problems,
        })
      : undefined;

const failingSave: Reply = (url, method) =>
  method === 'PUT' && url.endsWith('/rapportassistenten/draft')
    ? new Response(JSON.stringify({ title: 'Nede', status: 503 }), {
        status: 503,
        headers: { 'content-type': 'application/problem+json' },
      })
    : undefined;
const pressPubliser = async () =>
  fireEvent.click(await screen.findByRole('button', { name: 'Publiser' }));
const instructions = () =>
  screen.getByLabelText('Instruksjoner til tjenesten') as HTMLTextAreaElement;

describe('what Oppsett says is missing', () => {
  it('shows the reason a check marks an area as missing inside that area', async () => {
    await openService('#/services/rapportassistenten/setup', {
      draft: withSpec({ riskConfirmation: { riskClass: published.spec.riskClass } }),
      reply: checks([
        {
          path: 'spec.knowledge.datasets[0].dataset',
          message:
            'Dokumentsamlingen kudos lagres utenfor EU/EØS. Tjenesten krever at data behandles i EU/EØS.',
        },
      ]),
    });
    expect(await screen.findByText('Kunnskap mangler før publisering')).toBeTruthy();
    await pressPubliser();
    const alert = await screen.findByText(/Dokumentsamlingen kudos lagres utenfor EU\/EØS/);
    expect(alert.closest('section')?.getAttribute('aria-labelledby')).toBe('omrade-sources-h');
    expect(screen.getByRole('heading', { name: 'Dette mangler før publisering' })).toBeTruthy();
  });

  it('leaves Publiser open for an unconfirmed limited risk, and asks for it on the publish page', async () => {
    await openService('#/services/rapportassistenten/setup', {
      draft: withSpec({ riskClass: 'limited', riskConfirmation: undefined }),
      reply: checks([]),
    });
    const publish = await screen.findByRole('button', { name: 'Publiser' });
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBeNull());
    expect(screen.queryByText('Risikonivået må bekreftes før publisering')).toBeNull();
    fireEvent.click(publish);
    const risk = await screen.findByRole('region', { name: 'Risiko og KI-forordningen' });
    expect(within(risk).getByRole('button', { name: 'Bekreft risikonivå' })).toBeTruthy();
  });

  it('asks for an unconfirmed risk on the publish page as one required checkbox, and stamps it on publish', async () => {
    const calls = await openService('#/services/rapportassistenten/setup/publish', {
      draft: withSpec({ riskClass: 'limited', riskConfirmation: undefined }),
      reply: checks([]),
    });
    const risk = await screen.findByRole('checkbox', {
      name: 'Begrenset risiko er fortsatt riktig',
    });
    const publish = screen.getByRole('button', { name: 'Publiser' });
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(publish);
    expect(await screen.findByText('Må fylles ut.')).toBeTruthy();
    const posts = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/definitions'));
    expect(posts()).toHaveLength(0);

    fireEvent.click(risk);
    fireEvent.click(publish);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toMatchObject({
      definition: { spec: { riskConfirmation: { riskClass: 'limited' } } },
    });
  });

  it('keeps the unmasked input on the risk confirmation it stamps on publish', async () => {
    const unmaskedInput = [{ mediaType: 'text/plain', reason: 'Innsendte skjemaer må leses' }];
    const calls = await openService('#/services/rapportassistenten/setup/publish', {
      draft: withSpec({
        riskClass: 'limited',
        riskConfirmation: {
          by: 'employee:ansattporten:kari',
          at: '2026-11-10T09:30:00Z',
          reasons: [],
          riskClass: 'minimal',
          unmaskedInput,
        },
      }),
      reply: checks([]),
    });
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Begrenset risiko er fortsatt riktig' }),
    );
    const publish = screen.getByRole('button', { name: 'Publiser' });
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(publish);
    const posts = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/definitions'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toMatchObject({
      definition: { spec: { riskConfirmation: { riskClass: 'limited', unmaskedInput } } },
    });
  });

  it('keeps Publiser locked by a risk problem the checkbox cannot answer', async () => {
    await openService('#/services/rapportassistenten/setup', {
      draft: withSpec({ riskClass: undefined, riskConfirmation: undefined }),
      reply: checks([{ path: 'spec.riskClass', message: 'Required' }]),
    });
    const publish = await screen.findByRole('button', { name: 'Publiser' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBe('true'));
  });

  it('counts an unconfirmed high risk the check already reports as one missing thing, listed once', async () => {
    await openService('#/services/rapportassistenten/setup', {
      draft: withSpec({ riskClass: 'high', riskConfirmation: undefined }),
      reply: checks([
        {
          path: 'spec.riskConfirmation',
          message:
            'risk class high must be confirmed by a person with the publish right before publishing',
        },
      ]),
    });
    const publish = await screen.findByRole('button', { name: 'Publiser' });
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBeNull());
    expect(screen.queryByText('Risiko og KI-forordningen mangler før publisering')).toBeNull();
    expect(screen.queryByText(/ting mangler før publisering/)).toBeNull();
  });

  it('leaves a minimal risk without a confirmation as done', async () => {
    await openService('#/services/rapportassistenten/setup', {
      draft: withSpec({ riskClass: 'minimal', riskConfirmation: undefined }),
      reply: checks([]),
    });
    const publish = await screen.findByRole('button', { name: 'Publiser' });
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBeNull());
    expect(screen.queryByText('Risikonivået må bekreftes før publisering')).toBeNull();
    fireEvent.click(publish);
    const risk = await screen.findByRole('region', { name: 'Risiko og KI-forordningen' });
    expect(within(risk).getByText('Minimal risiko')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /er fortsatt riktig$/ })).toBeNull();
  });
});

describe('the draft bar and the discard dialog', () => {
  it('says what is not published in the header on every tab of the service', async () => {
    await openService('#/services/rapportassistenten', { draft: withInstructions('Svar kort.') });
    expect(await screen.findByRole('link', { name: 'Én endring er ikke publisert' })).toBeTruthy();
    window.location.hash = '#/services/rapportassistenten/quality';
    await waitFor(() => expect(window.location.hash).toBe('#/services/rapportassistenten/quality'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('link', { name: 'Én endring er ikke publisert' })).toBeTruthy();
  });

  it('returns focus to Forkast endringer when the dialog is closed with Behold endringene', async () => {
    await openService('#/services/rapportassistenten/setup/purpose', {
      draft: withInstructions('Svar kort.'),
      reply: failingSave,
    });
    await waitFor(() => expect(instructions().value).toBe('Svar kort.'));
    fireEvent.change(instructions(), { target: { value: 'Svar kort.!' } });
    const trigger = await screen.findByRole(
      'button',
      { name: 'Forkast endringer' },
      { timeout: 3000 },
    );
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('alertdialog');
    const keep = within(dialog).getByRole('button', { name: 'Behold endringene' });
    keep.focus();
    fireEvent.click(keep);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('moves focus to the confirmation after discarding and drops it on another tab', async () => {
    await openService('#/services/rapportassistenten/setup/purpose', {
      draft: withInstructions('Svar kort.'),
      reply: failingSave,
    });
    await waitFor(() => expect(instructions().value).toBe('Svar kort.'));
    fireEvent.change(instructions(), { target: { value: 'Svar kort.!' } });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Forkast endringer' }, { timeout: 3000 }),
    );
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forkast 1 endring' }));
    const done = await screen.findByText(/^Endringene er forkastet\./);
    await waitFor(() => expect(document.activeElement).toBe(done.closest('[role="status"]')));

    window.location.hash = '#/services/rapportassistenten';
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 2, name: 'Grunnleggende' })).toBeNull(),
    );
    expect(screen.queryByText(/^Endringene er forkastet\./)).toBeNull();
  });
});

describe('Formål og målgruppe', () => {
  it('shows the text of a prompt file in Instruksjoner and saves edits to the file', async () => {
    const calls = await openService('#/services/rapportassistenten/setup/purpose', {
      draft: withInstructions('prompts/rapport.nb.md'),
      files: { 'prompts/rapport.nb.md': 'Svar kort og med kilder.' },
    });
    await waitFor(() => expect(instructions().value).toBe('Svar kort og med kilder.'));
    // No count of characters: the instructions have no limit to keep to.
    expect(screen.queryByText(/^\d+ tegn$/)).toBeNull();

    fireEvent.change(instructions(), { target: { value: 'Svar alltid kort.' } });
    await waitFor(
      () =>
        expect(
          calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/rapportassistenten/draft')),
        ).toHaveLength(1),
      { timeout: 3000 },
    );
    const saved = calls.find(
      (c) => c.method === 'PUT' && c.url.endsWith('/rapportassistenten/draft'),
    );
    expect(saved?.body).toMatchObject({
      definition: { spec: { strategy: { config: { instructions: 'prompts/rapport.nb.md' } } } },
      files: { 'prompts/rapport.nb.md': 'Svar alltid kort.' },
    });
  });

  it('sums up Språk og eksempler when closed and offers no Nynorsk tab', async () => {
    await openService('#/services/rapportassistenten/setup/purpose');
    const more = (await screen.findByText('Språk og eksempler')).closest('details') as HTMLElement;
    expect(within(more).getByText('Språk: bokmål, engelsk')).toBeTruthy();
    expect(within(more).getByText(/^Eksempler på godt resultat: \d+$/)).toBeTruthy();
    expect(within(more).getByText(/^Innebygde instruksjoner: \d$/)).toBeTruthy();
    fireEvent.click(within(more).getByText('Språk og eksempler'));
    (more as HTMLDetailsElement).open = true;
    expect(within(more).queryByRole('tab', { name: 'Nynorsk' })).toBeNull();
    expect(within(more).getByRole('tab', { name: 'Bokmål' })).toBeTruthy();
  });
});

describe('Arbeidsmåte', () => {
  it('shows the chosen step flow as one row, keeps the picker behind Bytt and links to the editor with the service', async () => {
    await openService('#/services/rapportassistenten/setup/how', {
      draft: withSpec({
        strategy: { id: 'step-flow', version: 1, config: { flow: 'postsortering-flyt@1' } },
      }),
    });
    const change = await screen.findByRole('button', { name: 'Bytt arbeidsflyt' });
    expect(screen.queryByRole('combobox', { name: 'Arbeidsmåte' })).toBeNull();
    expect(screen.queryByText(/@1$/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Rediger arbeidsflyten' }).getAttribute('href')).toBe(
      '#/developer/step-flows/postsortering-flyt?service=rapportassistenten',
    );
    fireEvent.click(change);
    expect(screen.getByRole('combobox', { name: 'Arbeidsmåte' })).toBeTruthy();
  });
});

describe('the publish page', () => {
  it('points to Kvalitet to make a test set when the service has none', async () => {
    await openService('#/services/rapportassistenten/setup/publish', {
      draft: withSpec({ riskConfirmation: { riskClass: published.spec.riskClass } }),
      reply: (url, method) =>
        checks([])(url, method) ??
        (method === 'GET' && url.endsWith('/rapportassistenten/test-sets')
          ? Response.json({ data: [] })
          : undefined),
    });
    await screen.findByRole('heading', { level: 1, name: /^Publiser Rapportassistenten/ });
    expect(await screen.findByText(/^Ikke målt ennå\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Lag testsett' }).getAttribute('href')).toBe(
      '#/services/rapportassistenten/quality',
    );
  });
  it('shows a new model with the one in use now and the one after publishing', async () => {
    await openService('#/services/rapportassistenten/setup/publish', {
      draft: withSpec({
        riskConfirmation: { riskClass: published.spec.riskClass },
        model: { ...published.spec.model, primary: 'foundry-openai/gpt-4.1' },
      }),
      reply: checks([]),
    });
    const row = await screen.findByRole('row', { name: /^Modell/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells[0]?.textContent).not.toBe('');
    expect(cells[1]?.textContent).toMatch(/gpt-4\.1/i);
  });
});

describe('Prøveområdet opened from a service', () => {
  it('starts from the service it was opened from', async () => {
    await openService('#/services/rapportassistenten/setup');
    window.location.hash = '#/playground?service=soknadsuttrekk';
    const start = (await screen.findByRole(
      'combobox',
      { name: 'Start fra' },
      { timeout: 3000 },
    )) as HTMLSelectElement;
    await waitFor(() => expect(start.value).toMatch(/^soknadsuttrekk\//));
  });
});

describe('a redirect to an area of Oppsett', () => {
  it('keeps the area in the address after the redirect', async () => {
    await openService('#/services/rapportassistenten/settings');
    await waitFor(() =>
      expect(window.location.hash).toBe('#/services/rapportassistenten/advanced/limits'),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.hash).toBe('#/services/rapportassistenten/advanced/limits');
  });
});

describe('Oversikt of a service', () => {
  it('fetches the strategies, the service drafts and the datasets once when the page loads', async () => {
    const calls = await openService('#/services/rapportassistenten');
    await screen.findByRole('navigation', { name: 'Testutgave eller i bruk' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const gets = (suffix: string) =>
      calls.filter((c) => c.method === 'GET' && c.url.endsWith(suffix)).length;
    expect([gets('/definitions/strategies'), gets('/service-drafts'), gets('/datasets')]).toEqual([
      1, 1, 1,
    ]);
  });
});

describe('Inndata', () => {
  it('fetches no dataset values for its fields until one of them is opened', async () => {
    const field = (id: string, facet: string) => ({
      id,
      label: id,
      kind: 'choice',
      required: false,
      optionsFrom: { dataset: 'digdir/kudos', facet },
    });
    const calls = await openService('#/services/rapportassistenten/setup/input', {
      draft: withSpec({
        riskConfirmation: { riskClass: published.spec.riskClass },
        knowledge: { datasets: [{ dataset: 'digdir/kudos' }], runtimeDocuments: false },
        input: {
          ...(published.spec.input as Record<string, unknown>),
          fields: [field('type', 'type'), field('virksomhet', 'orgs_long'), field('art', 'type')],
        },
      }),
    });
    await screen.findAllByRole('button', { name: /^Endre/ }, { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls.filter((c) => c.url.includes('/api/facets'))).toEqual([]);
  });
});
