// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantTurnRequest } from '../../api/assistant';
import type { PlaygroundRunRequest, TestCaseCandidateRequest } from '../../api/playground';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { assistantStates } from '../../data/services';
import { exampleTestSets, mockFetch } from '../../mock';
import type { AssistantMockOptions } from '../../mock/assistant';
import { expectAccessible, go, renderAt } from '../../test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const slow = { timeout: 4000 };

const stored = (id: string, level: 2 | 3 | 4) => ({
  id,
  level,
  createdBy: 'assistant' as const,
  forService: { id: 'soknadsuttrekk', name: 'Søknadsuttrekk' },
  createdAt: '2026-10-07T08:00:00Z',
  permissions: [],
  tests: [],
  state: 'pending' as const,
});

const withAssistant = (assistant: AssistantMockOptions = {}) =>
  mockFetch(undefined, undefined, undefined, undefined, {
    features: {
      assistant,
      buildingBlocks: {
        proposals: [
          stored('cp-kobling-fagsystem', 2),
          stored('cp-risikoscore', 3),
          stored('cp-signering', 4),
        ],
      },
    },
  });

const recorded = (fetch: typeof globalThis.fetch) => {
  const posts: { url: string; body: unknown }[] = [];
  const wrapped: typeof globalThis.fetch = (input, init) => {
    if (init?.method === 'POST')
      posts.push({ url: String(input), body: JSON.parse(String(init.body ?? '{}')) });
    return fetch(input, init);
  };
  return { posts, fetch: wrapped };
};

const open = async (hash: string, fetch = withAssistant()) => {
  await renderAt(hash, fetch);
  await screen.findByRole('heading', { level: 1, name: 'Søknadsuttrekk' });
  return screen.getByRole('complementary', { name: 'Byggeassistent' });
};

const say = (panel: HTMLElement, text: string) => {
  fireEvent.change(within(panel).getByLabelText('Skriv til assistenten'), {
    target: { value: text },
  });
  fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
};

const instructions = () =>
  screen.getByLabelText('Instruksjoner til tjenesten') as HTMLTextAreaElement;

const openInstructions = () => {
  const toggle = screen.getByRole('button', { name: /^Instruksjoner/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
};

const settled = (panel: HTMLElement) =>
  waitFor(() => expect(panel.querySelector('.stream-cursor')).toBeNull(), slow);

describe('builder assistant', () => {
  it('streaming sets aria-live off and announces completed paragraphs', async () => {
    const panel = await open('#/services/soknadsuttrekk/setup?assistent=strommer');
    const log = panel.querySelector('[aria-live]') as HTMLElement;
    const announcer = panel.querySelector('.visually-hidden[role="status"]') as HTMLElement;
    await waitFor(() => expect(log.getAttribute('aria-live')).toBe('off'), slow);
    expect(panel.querySelector('.stream-cursor')).toBeTruthy();
    await waitFor(
      () => expect(announcer.textContent).toBe('Tjenesten finner omsøkt beløp i tre trinn.'),
      slow,
    );
    await waitFor(() => expect(announcer.textContent).toMatch(/^Først ser den etter/), slow);
    await waitFor(() => expect(log.getAttribute('aria-live')).toBe('polite'), slow);
    expect(panel.querySelector('.stream-cursor')).toBeNull();
    expect(within(log).getByText(/Til slutt sjekker den/)).toBeTruthy();
  });

  it('keeps the last announcement after streaming and clears it when a new turn starts', async () => {
    const panel = await open('#/services/soknadsuttrekk/setup?assistent=strommer');
    const announcer = panel.querySelector('.visually-hidden[role="status"]') as HTMLElement;
    await waitFor(() => expect(announcer.textContent).toMatch(/^Først ser den etter/), slow);
    await settled(panel);
    expect(announcer.textContent).not.toBe('');

    say(panel, 'Lag en tjeneste som sorterer klager.');
    expect(announcer.textContent).toBe('');
  });

  it('questions need all answers before Send svarene', async () => {
    const turns: AssistantTurnRequest[] = [];
    const panel = await open('#/services/soknadsuttrekk/setup', withAssistant({ turns }));
    say(panel, 'Lag en tjeneste som sorterer klager.');
    const first = await within(panel).findByRole(
      'group',
      { name: '1. Hvor kommer klagene inn?' },
      slow,
    );
    const send = within(panel).getByRole('button', { name: 'Send svarene' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(within(panel).getByText('Svar på alle tre først.')).toBeTruthy();

    const chip = within(first).getByRole('button', { name: 'Skjema på nettsiden' });
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(
      within(
        within(panel).getByRole('group', { name: '2. Hva skal skje med en klage etterpå?' }),
      ).getByRole('button', { name: 'Opprette sak' }),
    );
    fireEvent.click(
      within(
        within(panel).getByRole('group', {
          name: '3. Skal en person godkjenne før noe sendes videre?',
        }),
      ).getByRole('button', { name: 'Annet' }),
    );
    fireEvent.click(send);
    expect(turns).toHaveLength(1);
    fireEvent.change(within(panel).getByLabelText('Skriv eget svar'), {
      target: { value: 'Bare klager om tilskudd' },
    });
    expect(send.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(send);

    expect(
      await within(panel).findByText('Satte start, inn og ut for klagesortering', {}, slow),
    ).toBeTruthy();
    expect(turns[1]?.answers).toEqual({
      source: 'Skjema på nettsiden',
      after: 'Opprette sak',
      approval: 'Bare klager om tilskudd',
    });
    expect(turns[0]?.previousTurn).toBeUndefined();
    expect(turns[1]?.previousTurn).toMatch(/\S/);
    expect(within(panel).queryByRole('button', { name: 'Send svarene' })).toBeNull();
    expectAccessible();
  });

  it('a rejected card has no apply action', async () => {
    const panel = await open('#/services/soknadsuttrekk/setup?assistent=validering-feilet');
    const tag = await within(panel).findByText('Avvist av plattformen, ikke brukt', {}, slow);
    const card = tag.closest('.ax-card') as HTMLElement;
    expect(within(card).getByText('VALIDATION_MAXIMUM')).toBeTruthy();
    expect(within(card).getByText('tools.enhetsregisteret.timeout_s = 300')).toBeTruthy();
    expect(within(card).getByRole('status').textContent).toMatch(
      /Assistenten prøver igjen innenfor grensen/,
    );
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
    expect(
      await within(panel).findByText(
        'Satte tidsavbrudd for Enhetsregisteret til 60 sekunder',
        {},
        slow,
      ),
    ).toBeTruthy();
    expect(within(card).queryByRole('status')).toBeNull();
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
    openInstructions();
    expect(instructions().value).not.toContain('300');
  });

  it('a level-1 change is applied to the draft and Angre restores it', async () => {
    const panel = await open('#/services/soknadsuttrekk/setup');
    openInstructions();
    const before = instructions().value;
    say(panel, 'Legg til sjekk av om søkeren er slettet i Enhetsregisteret.');
    const title = await within(panel).findByText(
      'La til sjekk av status i Enhetsregisteret',
      {},
      slow,
    );
    const card = title.closest('.ax-card') as HTMLElement;
    expect(within(card).getByText('Endring').getAttribute('data-color')).toBe('accent');
    expect(within(card).queryByText('Fra assistenten')).toBeNull();
    await waitFor(() => expect(instructions().value).toContain('Slå opp søkeren'));
    expect(
      within(screen.getByRole('button', { name: /^Instruksjoner/ })).getByText('Fra assistenten'),
    ).toBeTruthy();
    fireEvent.click(
      within(panel).getByRole('button', {
        name: 'Angre: La til sjekk av status i Enhetsregisteret',
      }),
    );
    expect(instructions().value).toBe(before);
    expect(within(card).getByText('Angret').getAttribute('data-color')).toBe('neutral');
    fireEvent.click(
      within(panel).getByRole('button', {
        name: 'Gjør om: La til sjekk av status i Enhetsregisteret',
      }),
    );
    expect(instructions().value).toContain('Slå opp søkeren');
  });

  it('a variant proposal with a new step flow publishes the flow, then adds the variant to the draft', async () => {
    const flow = {
      apiVersion: 'genai/v1',
      kind: 'StepFlow',
      metadata: { tenant: '999888777', id: 'soknadsuttrekk-kort', name: 'Kort svar' },
      spec: { purpose: 'Søk og svar kort', steps: [{ id: 'finn', block: 'retrieve@1' }] },
    };
    const variant = {
      id: 'kort',
      title: { nb: 'Kort svar', en: 'Short answer' },
      strategy: { id: 'step-flow', version: 1, config: { flow: 'soknadsuttrekk-kort@1' } },
    };
    const { posts, fetch } = recorded(
      withAssistant({
        reply: (draft) => ({
          turnId: 't-variant',
          status: 'completed',
          message: 'Her er varianten.',
          proposals: [
            {
              id: 'p-variant',
              level: 1,
              kind: 'change',
              title: 'Ny variant «Kort svar»',
              detail: 'Søker og svarer kort.',
              section: 'variants',
              patch: [{ op: 'add', path: '/spec/variants', value: ['default', variant] }],
              after: {
                ...draft,
                spec: { ...(draft.spec as object), variants: ['default', variant] },
              },
              validation: { ok: true },
              requiresApproval: false,
              appliedToDraft: false,
              flows: [flow],
            },
          ],
          usage: { tokens: 10, budgetLeftToday: 1000, dailyBudget: 1000 },
        }),
      }),
    );
    const panel = await open('#/services/soknadsuttrekk/setup', fetch);

    say(panel, 'Lag en variant som svarer kort');

    const title = await within(panel).findByText('Ny variant «Kort svar»', {}, slow);
    const card = title.closest('.ax-card') as HTMLElement;
    expect(
      within(card).getByText(
        'Lager også stegflyten soknadsuttrekk-kort og publiserer den i biblioteket.',
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        posts.find((p) => /\/definitions$/.test(p.url))?.body as { definition?: unknown },
      ).toMatchObject({ definition: flow }),
    );
    const toggle = screen.getByRole('button', { name: /^Varianter/ });
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    expect(await screen.findByRole('heading', { level: 3, name: 'Kort svar' })).toBeTruthy();
  });

  it('Forbedre instruksjonene changes the draft only after Bruk forslaget', async () => {
    await open('#/services/soknadsuttrekk/setup');
    openInstructions();
    const before = instructions().value;
    fireEvent.click(screen.getByRole('button', { name: 'Forbedre instruksjonene' }));
    const apply = await screen.findByRole('button', { name: 'Bruk forslaget' }, slow);
    expect(screen.getByText('Før')).toBeTruthy();
    expect(screen.getByText('Etter')).toBeTruthy();
    expect(instructions().value).toBe(before);
    fireEvent.click(apply);
    expect(instructions().value).toMatch(/^Du hjelper Testetaten med å hente opplysninger/);
    expect(screen.getByText('Brukt i utkastet. Ingenting er publisert.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Angre' }));
    expect(instructions().value).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Forkast' }));
    expect(screen.queryByRole('button', { name: 'Bruk forslaget' })).toBeNull();
    expect(instructions().value).toBe(before);
  });

  it('suggested test cases are accepted or rejected with a live summary', async () => {
    await renderAt('#/services/soknadsuttrekk/test?assistent=testforslag', withAssistant());
    const section = await screen.findByRole('region', { name: 'Foreslåtte testtilfeller' }, slow);
    fireEvent.click(
      within(section).getByRole('button', { name: 'Godta: Søknad med beløp bare i budsjettet' }),
    );
    fireEvent.click(
      within(section).getByRole('button', { name: 'Avvis: Skannet søknad uten tekstlag' }),
    );
    expect(await within(section).findByText('1 sendt til testsettet · 1 avvist')).toBeTruthy();
    fireEvent.click(
      within(section).getByRole('button', { name: 'Angre: Skannet søknad uten tekstlag' }),
    );
    expect(within(section).getByText('1 sendt til testsettet · 0 avvist')).toBeTruthy();
    expectAccessible();
  });

  const suggestions = (candidates: TestCaseCandidateRequest[], fail = false) => {
    const base = mockFetch(undefined, undefined, undefined, undefined, {
      features: { assistant: {}, playground: { candidates } },
      testSets: [
        ...exampleTestSets,
        {
          metadata: { tenant: '999888777', id: 'soknader-2025', name: 'Søknader 2025', version: 1 },
          spec: { service: 'soknadsuttrekk', cases: [] },
        },
      ],
    });
    const fetch: typeof globalThis.fetch = (input, init) =>
      fail && String(input).includes('/testcase-candidates')
        ? Promise.resolve(
            new Response(JSON.stringify({ title: 'Feil', status: 500 }), {
              status: 500,
              headers: { 'content-type': 'application/problem+json' },
            }),
          )
        : base(input, init);
    return fetch;
  };

  it("an accepted suggestion is sent as a candidate to the service's test set", async () => {
    const candidates: TestCaseCandidateRequest[] = [];
    await renderAt('#/services/soknadsuttrekk/test?assistent=testforslag', suggestions(candidates));
    const section = await screen.findByRole('region', { name: 'Foreslåtte testtilfeller' }, slow);
    fireEvent.click(
      within(section).getByRole('button', { name: 'Godta: Søknad med beløp bare i budsjettet' }),
    );
    await waitFor(() => expect(candidates).toHaveLength(1));
    expect(candidates[0]).toEqual({
      task: 'trn_t1',
      question: 'Søknad med beløp bare i budsjettet',
      answer: 'Omsøkt beløp hentes fra budsjettet og merkes usikkert',
      testSet: 'soknader-2025',
      service: 'soknadsuttrekk',
      origin: 'assistant',
    });
    expect(
      await within(section).findByText(
        /Det blir et testtilfelle når eieren av testsettet godtar det/,
      ),
    ).toBeTruthy();
    expect(within(section).getByText('Sendt til testsettet')).toBeTruthy();
    expect(
      within(section).queryByRole('button', { name: 'Angre: Søknad med beløp bare i budsjettet' }),
    ).toBeNull();
    expectAccessible();
  });

  it('a rejected suggestion is never sent', async () => {
    const candidates: TestCaseCandidateRequest[] = [];
    await renderAt('#/services/soknadsuttrekk/test?assistent=testforslag', suggestions(candidates));
    const section = await screen.findByRole('region', { name: 'Foreslåtte testtilfeller' }, slow);
    fireEvent.click(
      within(section).getByRole('button', { name: 'Avvis: Skannet søknad uten tekstlag' }),
    );
    fireEvent.click(within(section).getByRole('button', { name: 'Godta: Søknad på nynorsk' }));
    await waitFor(() => expect(candidates).toHaveLength(1));
    expect(await within(section).findByText('1 sendt til testsettet · 1 avvist')).toBeTruthy();
    expect(candidates.map((c) => c.question)).toEqual(['Søknad på nynorsk']);
  });

  it('a failed send keeps the suggestion and says so', async () => {
    const candidates: TestCaseCandidateRequest[] = [];
    await renderAt(
      '#/services/soknadsuttrekk/test?assistent=testforslag',
      suggestions(candidates, true),
    );
    const section = await screen.findByRole('region', { name: 'Foreslåtte testtilfeller' }, slow);
    fireEvent.click(
      within(section).getByRole('button', { name: 'Godta: Søknad med beløp bare i budsjettet' }),
    );
    expect(
      await within(section).findByText('Vi kunne ikke sende forslaget. Prøv igjen.'),
    ).toBeTruthy();
    expect(within(section).getByText('Søknad med beløp bare i budsjettet')).toBeTruthy();
    expect(
      within(section).getByRole('button', {
        name: 'Prøv igjen: Søknad med beløp bare i budsjettet',
      }),
    ).toBeTruthy();
    fireEvent.click(
      within(section).getByRole('button', { name: 'Angre: Søknad med beløp bare i budsjettet' }),
    );
    expect(
      within(section).getByRole('button', { name: 'Godta: Søknad med beløp bare i budsjettet' }),
    ).toBeTruthy();
    expect(within(section).queryByText('Vi kunne ikke sende forslaget. Prøv igjen.')).toBeNull();
    expectAccessible();
  });

  it('a level-3 proposal needs the register right; others see Send til godkjenning', async () => {
    const { posts, fetch } = recorded(withAssistant());
    const panel = await open('#/services/soknadsuttrekk/setup?assistent=plattform-3', fetch);
    await within(panel).findByText('Byggekloss: Risikoscore for tilskudd', {}, slow);
    const current = panel.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain('Ny byggekloss foreslått');
    expect(within(panel).getByText('3 av 4: Ny byggekloss foreslått')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Godkjenn og ta i bruk' }));
    const confirm = within(panel).getByRole('button', { name: 'Bekreft og ta i bruk' });
    fireEvent.click(confirm);
    expect(within(panel).getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('Begrunnelse'), {
      target: { value: 'Modellen er kontrollert av fagmiljøet' },
    });
    fireEvent.click(confirm);
    expect(
      await within(panel).findByText(/Endret av Kari Nordmann i dag kl\. \d\d\.\d\d/),
    ).toBeTruthy();
    expect(posts.at(-1)).toEqual({
      url: '/api/tenants/999888777/proposals/cp-risikoscore/approve',
      body: { reason: 'Modellen er kontrollert av fagmiljøet' },
    });
    cleanup();

    const auth = mockAnsattporten({
      name: 'Erik Larsen',
      organisations: [
        {
          orgNumber: '999888777',
          name: 'Testetaten',
          actions: ['Bruke tjenester', 'Administrere tjenester'],
        },
      ],
    });
    await auth.login();
    window.location.hash = '#/services/soknadsuttrekk/setup?assistent=plattform-3';
    const second = recorded(withAssistant());
    render(<App auth={auth} fetch={second.fetch} />);
    const other = await screen.findByRole('complementary', { name: 'Byggeassistent' });
    const card = (
      await within(other).findByText('Byggekloss: Risikoscore for tilskudd', {}, slow)
    ).closest('.ax-card') as HTMLElement;
    expect(within(other).queryByRole('button', { name: 'Godkjenn og ta i bruk' })).toBeNull();
    expect(
      within(other).getByText(/Du har ikke rettigheten til å registrere byggeklosser/),
    ).toBeTruthy();
    fireEvent.click(within(other).getByRole('button', { name: 'Send til godkjenning' }));
    fireEvent.change(within(other).getByLabelText('Begrunnelse'), {
      target: { value: 'Trenger risikoscore i vurderingen' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    expect(await within(other).findByText(/Sendt til godkjenning hos dem som har/)).toBeTruthy();
    expect(second.posts.at(-1)?.url).toBe(
      '/api/tenants/999888777/proposals/cp-risikoscore/send-for-approval',
    );
  });

  it('a level-4 proposal shows its case id and status', async () => {
    const panel = await open('#/services/soknadsuttrekk/setup?assistent=plattform-4');
    await within(panel).findByText('Forslag til Digdir: signering av dokumenter', {}, slow);
    expect(within(panel).getByText(/sak KI-2026-0042/)).toBeTruthy();
    const status = within(panel).getByRole('list', { name: 'Status hos Digdir' });
    expect(status.querySelector('[aria-current="step"]')?.textContent).toContain('Under vurdering');
    expect(within(panel).queryByRole('button', { name: /Godkjenn/ })).toBeNull();
    expect(
      within(panel).queryByText('Satte ut til PDF levert til saksbehandlingssystemet'),
    ).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Sett opp det i stedet' }));
    expect(
      within(panel).getByText('Satte ut til PDF levert til saksbehandlingssystemet'),
    ).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Satt opp' })).toBeTruthy();
    cleanup();

    const rejected = await open('#/services/soknadsuttrekk/setup?assistent=plattform-4-avslatt');
    await within(rejected).findByText(/Avslått av Digdir/, {}, slow);
    expect(within(rejected).getByText(/Sak KI-2026-0042/)).toBeTruthy();
    const steps = within(rejected).getByRole('list', { name: 'Status hos Digdir' });
    expect(steps.querySelector('[aria-current="step"]')?.textContent).toContain('Avslått');
  });

  it('budget used up keeps the form working', async () => {
    const panel = await open(
      '#/services/soknadsuttrekk/setup',
      withAssistant({ status: 'budget_exhausted' }),
    );
    say(panel, 'Hva koster dette?');
    expect(
      await within(panel).findByText('Assistentens budsjett for i dag er brukt opp', {}, slow),
    ).toBeTruthy();
    expect(within(panel).getByText(/200\s000 tokens per dag hos Testetaten/)).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Se forbruket' })).toBeTruthy();
    expect(
      (within(panel).getByLabelText('Skriv til assistenten') as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(within(panel).queryByRole('button', { name: 'Hva koster dette?' })).toBeNull();
    openInstructions();
    fireEvent.change(instructions(), { target: { value: 'Skrevet for hånd.' } });
    expect(instructions().value).toBe('Skrevet for hånd.');
    expect(
      screen.getByRole('button', { name: 'Forbedre instruksjonene' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expectAccessible();
  });

  it('shows unavailable with Prøv igjen and turned off with a link to Innstillinger', async () => {
    const panel = await open(
      '#/services/soknadsuttrekk/setup',
      withAssistant({ status: 'unavailable' }),
    );
    say(panel, 'Hva koster dette?');
    await within(panel).findByText('Byggeassistenten er ikke tilgjengelig', {}, slow);
    fireEvent.click(within(panel).getByRole('button', { name: 'Prøv igjen' }));
    expect(within(panel).queryByText('Byggeassistenten er ikke tilgjengelig')).toBeNull();
    cleanup();

    const off = await open(
      '#/services/soknadsuttrekk/setup',
      withAssistant({ status: 'disabled' }),
    );
    say(off, 'Hva koster dette?');
    await within(off).findByText('Byggeassistenten er slått av', {}, slow);
    expect(
      within(off).getByRole('link', { name: 'Gå til innstillingen' }).getAttribute('href'),
    ).toBe('#/settings');
  });

  it('shows the API call for an assistant message with proposals', async () => {
    const panel = await open('#/services/soknadsuttrekk/setup?assistent=api-kall');
    await within(panel).findByText('La til sjekk av status i Enhetsregisteret', {}, slow);
    await settled(panel);
    const calls = within(panel).getAllByRole('button', { name: 'Vis API-kall' });
    fireEvent.click(calls[calls.length - 1] as HTMLElement);
    const dialog = screen.getByRole('dialog', {
      name: /\/tenants\/999888777\/services\/soknadsuttrekk\/assistant\/turns/,
    });
    expect(dialog.getAttribute('style')).toContain('520px');
    const response = within(dialog).getByLabelText('Svar');
    expect(response.textContent).toContain('"proposals"');
    expect(response.textContent).toContain('"appliedToDraft": false');
    expect(within(dialog).getByLabelText('Forespørsel (curl)').textContent).toContain(
      '"stream": true',
    );
  });

  it('the Test tab is the shared playground panel with the draft', async () => {
    const runs: PlaygroundRunRequest[] = [];
    const fetch = mockFetch(undefined, undefined, undefined, undefined, {
      features: { playground: { runs } },
    });
    await renderAt('#/services/rapportassistenten/setup', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
    openInstructions();
    fireEvent.change(instructions(), { target: { value: 'Svar kort, med kilder.' } });
    go('#/services/rapportassistenten/test');
    const region = await screen.findByRole('region', { name: 'Prøv et oppsett' });
    const question = await within(region).findByLabelText('Spørsmål');
    fireEvent.change(question, { target: { value: 'Hva sier evalueringene om tilskudd?' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(runs).toHaveLength(1));
    const service = runs[0]?.setup.service;
    expect(service).toMatchObject({ id: 'rapportassistenten', version: 'draft' });
    const definition = service?.definition as {
      metadata: { id: string };
      spec: { strategy: { config: { instructions: string } } };
    };
    expect(definition.metadata.id).toBe('rapportassistenten');
    expect(definition.spec.strategy.config.instructions).toBe('Svar kort, med kilder.');
  });

  it.each(assistantStates.filter((s) => s !== 'testforslag'))(
    'is accessible in the %s state',
    async (state) => {
      const panel = await open(`#/services/soknadsuttrekk/setup?assistent=${state}`);
      await waitFor(() => expect(panel.querySelector('.msg')).toBeTruthy(), slow);
      await settled(panel);
      expectAccessible();
    },
  );
});
