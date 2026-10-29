// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { latestRunFact, type EvalRun } from '../../api/quality';
import { mockAnsattporten } from '../../auth';
import { mockFetch, type MockExtras } from '../../mock';
import type { QualityMockOptions } from '../../mock/quality';
import { expectAccessible, kari } from '../../test-utils';

interface Call {
  method: string;
  path: string;
  body: unknown;
  reason: string | null;
}

const base = '#/services/rapportassistenten/quality';

const openLive = async (
  tab = '',
  quality: QualityMockOptions = {},
  extras: Omit<MockExtras, 'features'> = {},
  respond: (path: string) => Response | undefined = () => undefined,
) => {
  const calls: Call[] = [];
  const inner = mockFetch(undefined, undefined, undefined, undefined, {
    ...extras,
    features: { quality },
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const reason = new Headers(init?.headers).get('change-reason');
    calls.push({
      method: init?.method ?? 'GET',
      path: url.replace(/^\/api/, ''),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      reason: reason === null ? null : decodeURIComponent(reason),
    });
    return respond(url.replace(/^\/api/, '')) ?? inner(input, init);
  };
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = `${base}${tab}`;
  render(<App auth={auth} fetch={fetch} live />);
  await screen.findByRole('tablist', { name: 'Kvalitet' });
  const writes = () => calls.filter((c) => c.method !== 'GET');
  return { calls, writes };
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('live Testsett', () => {
  it('lists the service test set and its cases without example data', async () => {
    await openLive();
    expect(await screen.findByRole('heading', { name: 'Kjernespørsmål' })).toBeTruthy();
    expect(await screen.findByText('Hvor mange tilsyn hadde vi i 2025?')).toBeTruthy();
    expect(screen.getByText('Testsettet er ikke kjørt ennå.')).toBeTruthy();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).queryByText(/T-014|T-149|Kari Nordmann|Poeng per emne/)).toBeNull();
    expectAccessible();
  });

  it('adds a locked case with a reason and deletes a case after confirming', async () => {
    const { writes } = await openLive();
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('button', { name: 'Nytt testtilfelle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lagre testtilfelle' }));
    expect(screen.getByText('Skriv inputen tjenesten skal få.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'Hva koster tilsyn?' } });
    fireEvent.change(screen.getByLabelText('Et godt svar'), {
      target: { value: 'Oppgir gebyret.' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Nøyaktig svar' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Låst (brukes bare til sluttsjekk)' }));
    expect(screen.getByRole('radio', { name: 'Åpen (kan brukes til forbedring)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lagre testtilfelle' }));
    const remove = await screen.findByRole('button', {
      name: 'Slett testtilfellet «Hva koster tilsyn?»',
    });
    expect(writes().at(-1)).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/test-sets/rapport-kjerne/cases',
      body: {
        input: 'Hva koster tilsyn?',
        expected: 'Oppgir gebyret.',
        type: 'exact',
        split: 'locked',
      },
      reason: 'Nytt testtilfelle i Kjernespørsmål',
    });

    fireEvent.click(remove);
    fireEvent.click(screen.getByRole('button', { name: 'Ja, slett testtilfellet' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Slett testtilfellet «Hva koster tilsyn?»' }),
      ).toBeNull(),
    );
    expect(writes().at(-1)).toMatchObject({
      method: 'DELETE',
      path: expect.stringMatching(/^\/tenants\/999888777\/test-sets\/rapport-kjerne\/cases\//),
      reason: 'Slettet testtilfelle fra Kjernespørsmål',
    });
  });

  it('runs the test set on the published version and shows the history and per-case detail', async () => {
    const { writes } = await openLive();
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('radio', { name: 'Publisert versjon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start kjøringen' }));
    const history = await screen.findByRole('region', { name: 'Kjøringer av testsettet' });
    expect(writes().at(-1)).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/services/rapportassistenten/eval-runs',
      body: { testSet: 'rapport-kjerne', version: 'published' },
    });
    const row = (await within(history).findAllByRole('row'))[1] as HTMLElement;
    expect(within(row).getByText('Publisert versjon')).toBeTruthy();
    expect(within(row).getByText('2 av 3')).toBeTruthy();
    expect(within(row).getByText('67 %')).toBeTruthy();
    expect(within(row).getByText('ikke priset')).toBeTruthy();
    expect(within(row).getByText('Ferdig')).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: /^Vis resultatet fra/ }));
    const detail = await screen.findByRole('region', { name: 'Resultat per testtilfelle' });
    await within(detail).findAllByText('Bestått');
    expect(within(detail).getByText('Ikke bestått')).toBeTruthy();
    expect(within(detail).getByText('Svaret oppgir ikke riktig år.')).toBeTruthy();
    expect(within(detail).getByText('Svaret bruker tall fra et eldre år.')).toBeTruthy();
    const metrics = within(detail).getByRole('table');
    expect(within(metrics).getByText('judge.criteria')).toBeTruthy();
    expect(within(metrics).getByText('47 % – 77 %')).toBeTruthy();
    expect(
      within(detail).getByText('Dommer: judge:criteria@1+foundry-openai/gpt-41-dommer'),
    ).toBeTruthy();
    expectAccessible();
  });

  it('offers to send a run to Langfuse only when a connection covers the service, unticked by default', async () => {
    const { writes } = await openLive('', {}, {});
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    await screen.findByRole('button', { name: 'Start kjøringen' });

    expect(screen.queryByRole('checkbox', { name: /Send kjøringen til Langfuse/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start kjøringen' }));
    await screen.findByRole('region', { name: 'Kjøringer av testsettet' });
    expect(writes().at(-1)?.body).not.toHaveProperty('trace');
  });

  it('sends a run to Langfuse when the person ticks it, for a service a connection covers', async () => {
    const { writes } = await openLive('', {}, {}, (path) =>
      /\/tracing\/connections$/.test(path)
        ? Response.json({
            data: [{ id: 'lokal', services: ['rapportassistenten'], residency: 'global' }],
          })
        : undefined,
    );
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    const send = await screen.findByRole('checkbox', {
      name: 'Send kjøringen til Langfuse (lokal). Holdout-tilfeller sendes aldri.',
    });

    expect((send as HTMLInputElement).checked).toBe(false);
    fireEvent.click(send);
    fireEvent.click(screen.getByRole('button', { name: 'Start kjøringen' }));
    await screen.findByRole('region', { name: 'Kjøringer av testsettet' });
    expect(writes().at(-1)?.body).toMatchObject({ trace: true });
  });

  it('shows a running run and blocks a second start', async () => {
    await openLive('', { runsStayRunning: true });
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    const run = screen.getByRole('button', { name: 'Kjør testsettet' });
    fireEvent.click(run);
    fireEvent.click(await screen.findByRole('button', { name: 'Start kjøringen' }));
    const history = await screen.findByRole('region', { name: 'Kjøringer av testsettet' });
    expect(await within(history).findByText('Kjører')).toBeTruthy();
    await waitFor(() => expect(run.getAttribute('aria-disabled')).toBe('true'));
  });

  it('replaces the running message when the run is done and keeps it out of other tabs', async () => {
    await openLive();
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start kjøringen' }));
    expect(await screen.findByText('Kjøringen er ferdig. Resultatet vises i listen.')).toBeTruthy();
    expect(screen.queryByText('Testsettet kjører. Resultatet vises i listen.')).toBeNull();

    window.location.hash = `${base}?tab=proposals`;
    expect(await screen.findByText('Ingen forslag ennå')).toBeTruthy();
    expect(screen.queryByText('Kjøringen er ferdig. Resultatet vises i listen.')).toBeNull();
  });

  it('creates the first test set when the service has none', async () => {
    const { writes } = await openLive('', { sets: [], candidates: [] });
    expect(await screen.findByText('Tjenesten har ikke testsett ennå')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Navn på testsettet'), {
      target: { value: 'Grunnsett' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lag testsettet' }));
    expect(await screen.findByRole('heading', { name: 'Grunnsett' })).toBeTruthy();
    expect(writes().at(-1)).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/test-sets',
      body: {
        id: 'rapportassistenten-grunnsett',
        name: 'Grunnsett',
        service: 'rapportassistenten',
      },
    });
    expect(screen.getByText('Ingen testtilfeller ennå')).toBeTruthy();
  });

  it('derives a valid test set id from a name with spaces and Norwegian letters', async () => {
    const { writes } = await openLive('', { sets: [], candidates: [] });
    await screen.findByText('Tjenesten har ikke testsett ennå');
    fireEvent.change(screen.getByLabelText('Navn på testsettet'), {
      target: { value: 'Kudos utkast for høsten' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lag testsettet' }));
    expect(await screen.findByRole('heading', { name: 'Kudos utkast for høsten' })).toBeTruthy();
    expect(writes().at(-1)).toMatchObject({
      body: { id: 'rapportassistenten-kudos-utkast-for-hosten' },
    });
  });
});

describe('live candidates', () => {
  it('accepts a candidate into a chosen test set with edited expected and type', async () => {
    const { writes } = await openLive();
    const section = await screen.findByRole('region', { name: 'Forslag til testtilfeller' });
    const item = (await within(section).findByText('Hva var ventetiden på telefon i fjor?'))
      .parentElement as HTMLElement;
    expect(within(item).getByText('Fra tilbakemeldinger')).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: 'Godta' }));
    fireEvent.change(within(item).getByLabelText('Et godt svar'), {
      target: { value: 'Oppgir 4 minutter for 2025.' },
    });
    fireEvent.change(within(item).getByLabelText('Type'), { target: { value: 'exact' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Legg til i testsettet' }));
    expect(await within(section).findByText('Ingen forslag venter.')).toBeTruthy();
    expect(writes().at(-1)).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/testcase-candidates/fb-1a2b3c4d/review',
      body: {
        decision: 'accept',
        testSet: 'rapport-kjerne',
        expected: 'Oppgir 4 minutter for 2025.',
        type: 'exact',
      },
    });
    expect(await screen.findByText('Hva var ventetiden på telefon i fjor?')).toBeTruthy();
  });

  it('rejects a candidate', async () => {
    const { writes } = await openLive();
    const section = await screen.findByRole('region', { name: 'Forslag til testtilfeller' });
    await within(section).findByText('Hva var ventetiden på telefon i fjor?');
    fireEvent.click(within(section).getByRole('button', { name: 'Avvis' }));
    expect(await within(section).findByText('Ingen forslag venter.')).toBeTruthy();
    expect(writes().at(-1)).toMatchObject({
      path: '/tenants/999888777/testcase-candidates/fb-1a2b3c4d/review',
      body: { decision: 'reject' },
    });
  });
});

describe('live Tilbakemeldinger', () => {
  it('Legg til i testsett creates a candidate through the API instead of a local T-149', async () => {
    const feedback = Array.from({ length: 5 }, (_, i) => ({
      rating: 'down' as const,
      comment: 'Bruker gamle tall',
      at: `2026-10-0${i + 1}`,
    }));
    const { writes } = await openLive('?tab=feedback', {}, { feedback });
    const [first] = await screen.findAllByRole('button', { name: 'Lag testtilfelle' });
    fireEvent.click(first as HTMLElement);
    expect(screen.queryByText('Anonymiser')).toBeNull();
    expect((screen.getByLabelText('Input') as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Legg til i testsett' }));
    expect(screen.getByText('Skriv spørsmålet tjenesten fikk.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Input'), {
      target: { value: 'Hvor mange tilsyn hadde vi i fjor?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til i testsett' }));
    expect(await screen.findByText(/Forslaget er sendt til Testsett/)).toBeTruthy();
    expect(screen.getByText('Sendt som forslag')).toBeTruthy();
    expect(screen.queryByText(/T-149/)).toBeNull();
    expect(writes().at(-1)).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/testcase-candidates',
      body: {
        service: 'rapportassistenten',
        input: 'Hvor mange tilsyn hadde vi i fjor?',
        expected: 'Svaret skal: bruker gamle tall.',
        origin: 'feedback',
      },
      reason: 'Forslag til testtilfelle fra en tilbakemelding',
    });
  });
});

describe('live Forbedringsforslag', () => {
  it('starts a proposal and shows the diff, scores, examples and reasons', async () => {
    const { writes } = await openLive('?tab=proposals');
    expect(await screen.findByText('Ingen forslag ennå')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Foreslå forbedring' }));
    const card = await screen.findByRole('region', { name: /^Forslag fra/ });
    expect(writes().at(-1)).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/services/rapportassistenten/improvements',
    });
    const diff = within(card).getByRole('list', { name: 'Endringer i instruksjoner' });
    expect(within(diff).getByText('Legges til')).toBeTruthy();
    expect(within(diff).getByText('Uendret')).toBeTruthy();
    expect(within(card).getByText('67 % → 100 %')).toBeTruthy();
    expect(within(card).getByText(/2 av 3 bestått før, 3 av 3 med forslaget/)).toBeTruthy();
    expect(
      within(card).getByText('Den låste delen av testsettet er aldri brukt til å lage forslaget.'),
    ).toBeTruthy();
    expect(within(card).getByText('Hvor mange tilsyn hadde vi i 2025?')).toBeTruthy();
    expect(within(card).getByText(/Tre tilbakemeldinger sier/)).toBeTruthy();
    expectAccessible();
  });

  it('asks for a proposal for one language only when a language is chosen', async () => {
    const { writes } = await openLive('?tab=proposals');
    await screen.findByText('Ingen forslag ennå');
    fireEvent.change(screen.getByLabelText('Hva skal forbedres'), { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Foreslå forbedring' }));

    await screen.findByRole('region', { name: /^Forslag fra/ });
    expect(writes().at(-1)).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/services/rapportassistenten/improvements',
      body: { language: 'en' },
    });
  });

  it('explains a refused proposal in plain words and links to the setting that allows it', async () => {
    await openLive('?tab=proposals', { improveRefused: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Foreslå forbedring' }));

    expect(
      await screen.findByText(
        'Tjenesten tillater ikke forslag til instruksjonene. Slå det på under Oppsett › Arbeidsmåte.',
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Gå til innstillingen for forbedring' })
        .getAttribute('href'),
    ).toBe('#/services/rapportassistenten/setup/how');
    expect(screen.queryByText(/spec\.improve/)).toBeNull();
  });

  it('needs a comment to reject, approves into the draft and points to Publiser', async () => {
    const { writes } = await openLive('?tab=proposals');
    fireEvent.click(await screen.findByRole('button', { name: 'Foreslå forbedring' }));
    const card = await screen.findByRole('region', { name: /^Forslag fra/ });
    fireEvent.click(within(card).getByRole('button', { name: 'Avvis' }));
    expect(within(card).getByText('Skriv hvorfor du avviser forslaget.')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Godta i utkastet' }));
    expect(await within(card).findByText('Godtatt i utkastet')).toBeTruthy();
    expect(within(card).getByText(/Tjenesten bruker den først når du publiserer/)).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Gå til Publiser' }).getAttribute('href')).toBe(
      '#/services/rapportassistenten/setup',
    );
    expect(writes().at(-1)).toMatchObject({
      method: 'POST',
      path: expect.stringMatching(
        /^\/tenants\/999888777\/services\/rapportassistenten\/improvements\/[^/]+\/decision$/,
      ),
      body: { approve: true },
    });
  });
});

describe('latestRunFact', () => {
  const run = (over: Partial<EvalRun>): EvalRun => ({
    id: 'r',
    status: 'completed',
    testSet: 's',
    version: 'draft',
    startedAt: '2026-10-01T10:00:00Z',
    passed: 7,
    total: 10,
    ...over,
  });

  it('says Ikke kjørt without a finished run and uses the newest finished run otherwise', () => {
    expect(latestRunFact([])).toBe('Ikke kjørt');
    expect(latestRunFact([run({ status: 'running', passed: null, total: null })])).toBe(
      'Ikke kjørt',
    );
    expect(
      latestRunFact([
        run({}),
        run({ id: 'n', startedAt: '2026-10-02T10:00:00Z', passed: 9, total: 10 }),
      ]),
    ).toBe('9 av 10 (90 %)');
  });
});
