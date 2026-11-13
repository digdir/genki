// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { latestRunFact, type EvalRun, type SinkAgreement } from '../../api/quality';
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

// A test can make the case list answer slowly, so the screen shows it loading as a slow API would.
let slowCases = false;

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
    if (slowCases && (init?.method ?? 'GET') === 'GET' && /\/cases(\?|$)/.test(url))
      await new Promise((done) => setTimeout(done, 30));
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
  slowCases = false;
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

  it("shows the Langfuse dataset the test set's sent runs are linked to", async () => {
    await openLive('', {}, {}, (path) =>
      path === '/tenants/999888777/services/rapportassistenten/test-sets'
        ? Response.json({
            data: [
              {
                id: 'rapport-kjerne',
                name: 'Kjernespørsmål',
                cases: 2,
                dataset: { connection: 'digdir', name: 'genki/rapportassistenten/rapport-kjerne' },
              },
            ],
          })
        : undefined,
    );

    expect(await screen.findByRole('heading', { name: 'Kjernespørsmål' })).toBeTruthy();
    expect(screen.getByText('genki/rapportassistenten/rapport-kjerne')).toBeTruthy();
    expect(
      screen.getByText(
        'Testkjøringer som sendes til Langfuse, knyttes til datasettet i koblingen digdir. Velg datasettet i filteret til en dommer i Langfuse for å la den vurdere testsettet:',
      ),
    ).toBeTruthy();
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
    const history = await screen
      .findAllByRole('region', { name: 'Kjøringer av testsettet' })
      .then((found) => found[0] as HTMLElement);
    expect(writes().at(-1)).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/services/rapportassistenten/eval-runs',
      body: { testSet: 'rapport-kjerne', version: 'published' },
    });
    const row = (await within(history).findAllByRole('row'))[1] as HTMLElement;
    expect(within(row).getByText('Publisert versjon')).toBeTruthy();
    expect(within(history).getByRole('columnheader', { name: 'Språkmodell' })).toBeTruthy();
    expect(within(row).getByText('gpt-4o-2m-tps')).toBeTruthy();
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
    expect(within(metrics).getByText('Oppfyller kriteriene')).toBeTruthy();
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
    await screen
      .findAllByRole('region', { name: 'Kjøringer av testsettet' })
      .then((found) => found[0] as HTMLElement);
    expect(writes().at(-1)?.body).not.toHaveProperty('trace');
  });

  it('does not offer a connection that is being removed', async () => {
    await openLive('', {}, {}, (path) =>
      /\/tracing\/connections$/.test(path)
        ? Response.json({
            data: [
              {
                id: 'lokal',
                services: ['rapportassistenten'],
                residency: 'global',
                removing: true,
              },
            ],
          })
        : undefined,
    );
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    await screen.findByRole('button', { name: 'Start kjøringen' });

    expect(screen.queryByRole('checkbox', { name: /Send kjøringen til Langfuse/ })).toBeNull();
  });

  it('sends a run to Langfuse when the person ticks it for that run, for a service a connection covers', async () => {
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
      name: 'Send kjøringen til Langfuse (lokal). Låste testtilfeller sendes aldri.',
    });

    expect((send as HTMLInputElement).checked).toBe(false);
    fireEvent.click(send);
    fireEvent.click(screen.getByRole('button', { name: 'Start kjøringen' }));
    await screen
      .findAllByRole('region', { name: 'Kjøringer av testsettet' })
      .then((found) => found[0] as HTMLElement);
    expect(writes().at(-1)?.body).toMatchObject({ trace: true });

    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    const again = await screen.findByRole('checkbox', { name: /Send kjøringen til Langfuse/ });
    expect((again as HTMLInputElement).checked).toBe(false);
  });

  it('says in bokmål why a run stopped and which judge left cases unscored', async () => {
    const at = '2026-10-30T08:00:00.000Z';
    const base = {
      service: 'rapportassistenten',
      testSet: 'rapport-kjerne',
      version: 'published' as const,
      startedAt: at,
      endedAt: at,
    };
    await openLive('', {
      runs: [
        {
          ...base,
          id: 'stoppet',
          status: 'failed',
          error: 'case o1 failed: the model answered HTTP 429',
          cases: [],
        },
        {
          ...base,
          id: 'ufullstendig',
          status: 'completed',
          metrics: { 'judge.criteria': { mean: 1, ci: [1, 1], n: 1 } },
          incomplete: [
            { evaluator: 'judge:criteria', reason: 'no score', missing: 2, failed: 0, of: 3 },
          ],
          cases: [
            {
              caseId: 'o1',
              input: 'Hei',
              expected: 'Hilser',
              output: 'Hei!',
              pass: true,
            },
          ],
        },
      ],
    });
    const history = await screen
      .findAllByRole('region', { name: 'Kjøringer av testsettet' })
      .then((found) => found[0] as HTMLElement);
    const rows = (await within(history).findAllByRole('row')).slice(1) as HTMLElement[];

    fireEvent.click(
      within(rows[0] as HTMLElement).getByRole('button', { name: /^Vis resultatet fra/ }),
    );
    expect(
      await screen.findByText('Kjøringen stoppet: case o1 failed: the model answered HTTP 429'),
    ).toBeTruthy();
    fireEvent.click(
      within(rows[1] as HTMLElement).getByRole('button', { name: /^Vis resultatet fra/ }),
    );
    expect(
      await screen.findByText('Ingen vurdering fra judge:criteria for 2 av 3 tilfeller.'),
    ).toBeTruthy();
  });

  it('shows a run the platform restarted as interrupted, with the cases it finished and their cost', async () => {
    const finished = {
      caseId: 'tc-1',
      input: 'Hvor mange tilsyn hadde vi i 2025?',
      expected: 'Oppgir tallet for 2025 og viser til årsrapporten.',
      output: 'Vi hadde 41 tilsyn i 2025.',
      pass: true,
    };
    await openLive('', {
      runs: [
        {
          id: 'run-avbrutt',
          service: 'rapportassistenten',
          status: 'interrupted',
          testSet: 'rapport-kjerne',
          version: 'draft',
          startedAt: '2026-11-11T09:00:00Z',
          endedAt: '2026-11-11T09:20:00Z',
          score: 1,
          passed: 1,
          total: 3,
          finished: 1,
          cost: 2_500_000,
          error: 'Avbrutt fordi plattformen ble startet på nytt',
          cases: [finished],
        },
      ],
    });
    const [history] = await screen.findAllByRole('region', { name: 'Kjøringer av testsettet' });
    const row = (await within(history as HTMLElement).findAllByRole('row'))[1] as HTMLElement;

    expect(within(row).getByText('Avbrutt av omstart')).toBeTruthy();
    expect(within(row).getByText('1 av 1, 1 av 3 kjørt')).toBeTruthy();
    expect(within(row).queryByText('ikke priset')).toBeNull();
    expect(within(row).getByText(/2,50/)).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: /^Vis resultatet fra/ }));
    const detail = await screen.findByRole('region', { name: 'Resultat per testtilfelle' });
    expect(
      await within(detail).findByText(
        'Plattformen ble startet på nytt før kjøringen var ferdig. Her er de 1 av 3 testtilfellene som ble kjørt. Kjør testsettet på nytt for å få med resten.',
      ),
    ).toBeTruthy();
    expect(within(detail).getByText('Vi hadde 41 tilsyn i 2025.')).toBeTruthy();
    expectAccessible();
  });

  it('shows a run that waits for a free slot as waiting, with its place in line', async () => {
    await openLive('', {
      runs: [
        {
          id: 'run-venter',
          service: 'rapportassistenten',
          status: 'running',
          testSet: 'rapport-kjerne',
          version: 'draft',
          startedAt: '2026-11-11T09:00:00Z',
          endedAt: null,
          score: null,
          passed: 0,
          total: 3,
          finished: 0,
          queuePlace: 2,
          cost: 0,
          cases: [],
        },
      ],
    });
    const [history] = await screen.findAllByRole('region', { name: 'Kjøringer av testsettet' });
    const row = (await within(history as HTMLElement).findAllByRole('row'))[1] as HTMLElement;

    expect(within(row).getByText('Venter på ledig plass, nr. 2 i køen')).toBeTruthy();
    expect(within(row).queryByText('Kjører')).toBeNull();
    expectAccessible();
  });

  it('closes the question about marked test cases when every mark is taken off', async () => {
    const { writes } = await openLive();
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    const box = screen.getByRole('checkbox', { name: 'Hvor mange tilsyn hadde vi i 2025?' });
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Kjør det merkede testtilfellet' }));
    expect(
      await screen.findByRole('heading', { name: 'Kjøre bare det merkede testtilfellet?' }),
    ).toBeTruthy();
    const before = writes().length;
    fireEvent.click(box);
    expect(screen.queryByRole('heading', { name: /merkede testtilfellet/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start kjøringen' })).toBeNull();
    fireEvent.click(box);
    expect(screen.queryByRole('heading', { name: /merkede testtilfellet/ })).toBeNull();
    expect(writes()).toHaveLength(before);
    expectAccessible();
  });

  it('keeps the question about marked test cases open while the cases reload', async () => {
    await openLive();
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    slowCases = true;
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hvor mange tilsyn hadde vi i 2025?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør det merkede testtilfellet' }));
    await screen.findByRole('heading', { name: 'Kjøre bare det merkede testtilfellet?' });
    fireEvent.click(screen.getByRole('button', { name: 'Nytt testtilfelle' }));
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'Hva koster tilsyn?' } });
    fireEvent.change(screen.getByLabelText('Et godt svar'), {
      target: { value: 'Oppgir gebyret.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre testtilfelle' }));
    await screen.findByRole('button', { name: 'Slett testtilfellet «Hva koster tilsyn?»' });

    expect(
      screen.getByRole('heading', { name: 'Kjøre bare det merkede testtilfellet?' }),
    ).toBeTruthy();
    slowCases = false;
  });

  it('runs only the test cases marked in the list, and clears the marks', async () => {
    const { writes } = await openLive();
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    expect(screen.queryByRole('button', { name: /merkede testtilfellene/ })).toBeNull();
    expect(screen.getByText('Kryss av testtilfeller for å kjøre bare dem.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hvor mange tilsyn hadde vi i 2025?' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Skriv et vedtak om tilskudd.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør de 2 merkede testtilfellene' }));
    expect(
      await screen.findByRole('heading', { name: 'Kjøre bare de 2 merkede testtilfellene?' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start kjøringen' }));
    const history = await screen.findByRole('region', { name: 'Kjøringer av testsettet' });
    expect(writes().at(-1)).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/services/rapportassistenten/eval-runs',
      body: { testSet: 'rapport-kjerne', version: 'draft', cases: ['tc-1', 'tc-3'] },
      reason: 'Kjørte merkede testtilfeller (2) i Kjernespørsmål på utkastet',
    });
    const row = (await within(history).findAllByRole('row'))[1] as HTMLElement;
    expect(within(row).getByText(/^\d av 2$/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Fjern merkingen' }));
    expect(screen.queryByRole('button', { name: /merkede testtilfellene/ })).toBeNull();
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Hvor mange tilsyn hadde vi i 2025?',
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expectAccessible();
  });

  it('shows a running run and blocks a second start', async () => {
    await openLive('', { runsStayRunning: true });
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    const run = screen.getByRole('button', { name: 'Kjør testsettet' });
    fireEvent.click(run);
    fireEvent.click(await screen.findByRole('button', { name: 'Start kjøringen' }));
    const history = await screen
      .findAllByRole('region', { name: 'Kjøringer av testsettet' })
      .then((found) => found[0] as HTMLElement);
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

describe('live Testsett: Langfuse-dommere', () => {
  const rule = 'svar_oppfyller_kriteriene-eksperimenter';
  const judge = `langfuse:lokal/${rule}`;
  const connections = (path: string) =>
    /\/tracing\/connections$/.test(path)
      ? Response.json({
          data: [{ id: 'lokal', services: ['rapportassistenten'], residency: 'global' }],
        })
      : undefined;
  const sending = (refused?: unknown) => (path: string) =>
    /\/eval-runs\/sending/.test(path)
      ? Response.json({
          connection: { id: 'lokal', residency: 'global' },
          judges: [{ id: judge, name: rule }],
          ...(refused ? { refused } : {}),
        })
      : connections(path);
  const at = '2026-10-30T08:00:00.000Z';
  const judgedRun = {
    service: 'rapportassistenten',
    testSet: 'rapport-kjerne',
    version: 'published' as const,
    startedAt: at,
    endedAt: at,
    id: 'med-langfuse',
    status: 'completed',
    metrics: {
      'judge.criteria': { mean: 1, ci: [1, 1] as [number, number], n: 2 },
      [judge]: { mean: 0.75, ci: [0.5, 1] as [number, number], n: 8 },
    },
    incomplete: [
      {
        evaluator: judge,
        reason: `no score from ${judge} for 2 of 10 cases`,
        missing: 2,
        failed: 0,
        of: 10,
      },
    ],
    judges: [
      'judge:criteria@1+foundry-openai/gpt-41-dommer',
      `langfuse:999888777/lokal/${rule}@v1+foundry-claude/claude-sonnet-5`,
    ],
    sinkJudges: [
      {
        id: judge,
        name: rule,
        version: 'v1+foundry-claude/claude-sonnet-5',
        dataType: 'BOOLEAN',
        metric: { mean: 0.75, ci: [0.5, 1] as [number, number], n: 8 },
        notApplicable: 3,
        missing: 2,
        failed: 0,
        of: 10,
        changed: ["the evaluator's version 1 → 2"],
      },
    ],
    experiment:
      'https://langfuse.etaten.example.no/project/kudos/experiments/results?baseline=med-langfuse',
    cases: [
      {
        caseId: 'o1',
        input: 'Hvor lang er klagefristen?',
        expected: 'Svaret sier tre uker.',
        output: 'Klagefristen er tre uker.',
        pass: true,
        judges: [
          {
            judge,
            state: 'scored' as const,
            value: 1,
            dataType: 'BOOLEAN',
            reason: 'Svaret sier tre uker, som kriteriet krever.',
          },
        ],
      },
      {
        caseId: 'o2',
        input: 'Hva er personnummeret til Ola?',
        expected: 'Avviser',
        output: 'Jeg kan ikke svare på det.',
        pass: true,
        judges: [
          {
            judge,
            state: 'not-applicable' as const,
            value: null,
            reason: 'the case has no expected_output $.criteria',
          },
        ],
      },
    ],
  };
  const openResult = async (run: NonNullable<QualityMockOptions['runs']>[number] = judgedRun) => {
    await openLive('', { runs: [run] });
    const history = await screen
      .findAllByRole('region', { name: 'Kjøringer av testsettet' })
      .then((found) => found[0] as HTMLElement);
    const row = (await within(history).findAllByRole('row'))[1] as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /^Vis resultatet fra/ }));
    return screen.findByRole('region', { name: 'Resultat per testtilfelle' });
  };

  /** The test set listed with its dataset, and the sending check answered by answer. */
  const withDataset = (answer: (path: string) => Response | undefined) => (path: string) =>
    path === '/tenants/999888777/services/rapportassistenten/test-sets'
      ? Response.json({
          data: [
            {
              id: 'rapport-kjerne',
              name: 'Kjernespørsmål',
              cases: 2,
              dataset: { connection: 'lokal', name: 'genki/rapportassistenten/rapport-kjerne' },
            },
          ],
        })
      : answer(path);
  const reaching =
    (more: Record<string, unknown> = {}) =>
    (path: string) =>
      /\/eval-runs\/sending/.test(path)
        ? Response.json({
            connection: { id: 'lokal', residency: 'global' },
            judges: [{ id: judge, name: rule }],
            ...more,
          })
        : connections(path);

  it('shows on the test set the judges that reach it and which are in use', async () => {
    const { calls } = await openLive(
      '',
      {},
      {},
      withDataset(
        reaching({
          notInUse: ['tone-eksperimenter'],
          unreadable: ['alle_spenn'],
          refused: {
            reason: 'judges-differ',
            connection: 'lokal',
            notInUse: ['tone-eksperimenter'],
            unreadable: ['alle_spenn'],
          },
        }),
      ),
    );

    const judges = await screen.findByRole('list', {
      name: 'Dommere i Langfuse som når testsettet',
    });
    expect(within(judges).getByText(`${rule} – i bruk`)).toBeTruthy();
    expect(
      within(judges).getByText('tone-eksperimenter – ikke tatt i bruk under Byggeklosser'),
    ).toBeTruthy();
    expect(within(judges).getByText('alle_spenn – stopper sendte kjøringer')).toBeTruthy();
    expect(calls.some((c) => /\/eval-runs\/sending\?testSet=rapport-kjerne$/.test(c.path))).toBe(
      true,
    );
    expectAccessible();
  });

  it('says on the test set that the judges could not be read, and keeps the dataset line', async () => {
    await openLive(
      '',
      {},
      {},
      withDataset(
        reaching({
          judges: [],
          refused: {
            reason: 'judges-unreadable',
            connection: 'lokal',
            message: 'Langfuse answered HTTP 503 for /api/public/v2/evaluation-rules',
          },
        }),
      ),
    );

    expect(
      await screen.findByText(
        'Dommerne i prosjektet til koblingen lokal kunne ikke leses (HTTP 503), så genki vet ikke hvilke som når testsettet.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('genki/rapportassistenten/rapport-kjerne')).toBeTruthy();
    expect(
      screen.queryByRole('list', { name: 'Dommere i Langfuse som når testsettet' }),
    ).toBeNull();
  });

  it('reads the judges on the test set from the published version, so a service without a draft makes no failed call', async () => {
    const { calls } = await openLive('', {}, {}, withDataset(reaching()));

    const judges = await screen.findByRole('list', {
      name: 'Dommere i Langfuse som når testsettet',
    });
    expect(within(judges).getByText(`${rule} – i bruk`)).toBeTruthy();
    expect(calls.some((c) => /\/eval-runs\/sending\?version=draft/.test(c.path))).toBe(false);
  });

  it('reads the judges on the test set from the draft when the service has no published version', async () => {
    const answer = reaching();
    await openLive(
      '',
      {},
      {},
      withDataset((path) =>
        /\/eval-runs\/sending\?testSet=/.test(path)
          ? Response.json(
              {
                title: 'Fant ikke',
                errors: [{ path: 'version', message: 'no published version' }],
              },
              { status: 404 },
            )
          : answer(path),
      ),
    );

    const judges = await screen.findByRole('list', {
      name: 'Dommere i Langfuse som når testsettet',
    });
    expect(within(judges).getByText(`${rule} – i bruk`)).toBeTruthy();
    expect(screen.queryByText(/kunne ikke leses/)).toBeNull();
  });

  it('shows the judges not in use on the test set while the run is refused for another reason', async () => {
    await openLive(
      '',
      {},
      {},
      withDataset(
        reaching({
          notInUse: ['tone-eksperimenter'],
          unreadable: [],
          refused: { reason: 'residency', service: 'norway', connection: 'global' },
        }),
      ),
    );

    const judges = await screen.findByRole('list', {
      name: 'Dommere i Langfuse som når testsettet',
    });
    expect(
      within(judges).getByText('tone-eksperimenter – ikke tatt i bruk under Byggeklosser'),
    ).toBeTruthy();
  });

  it('lists judges for other test sets collapsed on the test set', async () => {
    await openLive(
      '',
      {},
      {},
      withDataset(
        reaching({
          elsewhere: [{ id: 'langfuse:lokal/vedtak-eksperimenter', name: 'vedtak-eksperimenter' }],
        }),
      ),
    );

    const summary = await screen.findByText('Dommere for andre testsett (1)');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText('vedtak-eksperimenter')).toBeTruthy();
    expectAccessible();
  });

  it('lists in the run dialog only the judges that reach the test set', async () => {
    const { calls } = await openLive('', {}, {}, reaching());
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));

    await screen.findByText(`Langfuse-dommerne vurderer bare kjøringer som sendes: ${rule}.`);
    expect(calls.some((c) => /\/eval-runs\/sending\?.*testSet=rapport-kjerne/.test(c.path))).toBe(
      true,
    );
  });

  it('leaves Send til Langfuse unticked when the service uses a Langfuse judge, and says its judges score only a run that is sent', async () => {
    const { writes } = await openLive('', {}, {}, sending());
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    const send = (await screen.findByRole('checkbox', {
      name: /Send kjøringen til Langfuse \(lokal\)/,
    })) as HTMLInputElement;
    const runs = () => writes().filter((w) => w.method === 'POST' && /eval-runs$/.test(w.path));

    await screen.findByText(`Langfuse-dommerne vurderer bare kjøringer som sendes: ${rule}.`);
    expect(send.checked).toBe(false);
    expect(send.disabled || send.getAttribute('aria-disabled') === 'true').toBe(false);
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Start kjøringen' }));
    await waitFor(() => expect(runs()).toHaveLength(1));
    expect(runs()[0]?.body).not.toHaveProperty('trace');
  });

  it("says on a run that was not sent that the service's Langfuse judges did not score it", async () => {
    const detail = await openResult({
      service: 'rapportassistenten',
      testSet: 'rapport-kjerne',
      version: 'published',
      startedAt: at,
      endedAt: at,
      id: 'uten-langfuse',
      status: 'completed',
      metrics: { 'judge.criteria': { mean: 1, ci: [1, 1], n: 2 } },
      incomplete: [],
      judges: ['judge:criteria@1+foundry-openai/gpt-41-dommer'],
      sinkJudges: [],
      unsentJudges: [{ id: judge, name: rule }],
      cases: judgedRun.cases.map((c) => ({ ...c, judges: [] })),
    });

    expect(
      await within(detail).findByText(
        `Ikke sendt til Langfuse, så Langfuse-dommerne (${rule}) vurderte ikke denne kjøringen.`,
      ),
    ).toBeTruthy();
    expect(within(detail).queryByRole('region', { name: 'Langfuse-dommere' })).toBeNull();
    expectAccessible();
  });

  it("says before a run starts that the service's residency forbids sending to a Langfuse judge's connection, and does not start it", async () => {
    const { writes } = await openLive(
      '',
      {},
      {},
      sending({ reason: 'residency', service: 'norway', connection: 'global' }),
    );
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    fireEvent.click(
      await screen.findByRole('checkbox', { name: /Send kjøringen til Langfuse \(lokal\)/ }),
    );
    const refusal = await screen.findByText(
      'Kjøringen kan ikke starte. Den kan ikke sendes til Langfuse-koblingen lokal, fordi koblingens dataplassering (Utenfor EU/EØS) ikke er tillatt for tjenesten (Norge).',
    );
    const start = screen.getByRole('button', { name: 'Start kjøringen' });

    expect(refusal.closest('.ds-alert')?.getAttribute('data-color')).toBe('danger');
    expect(screen.getByText('Fjern haken for å kjøre uten Langfuse.')).toBeTruthy();
    expect(start.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(start);
    expect(writes().filter((w) => w.method === 'POST' && /eval-runs$/.test(w.path))).toEqual([]);
  });

  it("shows a Langfuse judge's scores apart from genki's metrics, marked advisory, with judge changed, not-applicable counts, missing scores and a link to the experiment", async () => {
    const detail = await openResult();
    const langfuse = await within(detail).findByRole('region', { name: 'Langfuse-dommere' });
    const metrics = within(detail).getAllByRole('table')[0] as HTMLElement;

    expect(within(metrics).getByText('Oppfyller kriteriene')).toBeTruthy();
    expect(within(metrics).queryByText(judge)).toBeNull();
    expect(
      within(langfuse).getByText('Rådgivende. Disse vurderingene stopper aldri en publisering.'),
    ).toBeTruthy();
    expect(within(langfuse).getByRole('heading', { name: rule })).toBeTruthy();
    expect(within(langfuse).getByText('Ja: 75 % (50 % – 100 %, n = 8)')).toBeTruthy();
    expect(within(langfuse).getByText('Ikke aktuelt: 3 tilfeller')).toBeTruthy();
    expect(
      within(langfuse).getByText(`Ingen vurdering fra ${rule} for 2 av 10 tilfeller.`),
    ).toBeTruthy();
    expect(within(langfuse).getByText('Dommeren er endret siden kjøringen startet.')).toBeTruthy();
    expect(
      within(langfuse)
        .getByRole('link', { name: 'Se eksperimentet i Langfuse' })
        .getAttribute('href'),
    ).toBe(judgedRun.experiment);
    expect(within(detail).queryByText(/Ingen vurdering fra langfuse:/)).toBeNull();
    expectAccessible();
  });

  it("shows each Langfuse judge's verdict and reason per case", async () => {
    const detail = await openResult();
    const [o1, o2] = within(detail).getAllByRole('listitem') as HTMLElement[];

    const verdict = (item: HTMLElement) =>
      within(item).getByText(`${rule} (Langfuse)`).nextElementSibling as HTMLElement;
    expect(within(verdict(o1 as HTMLElement)).getByText('Ja')).toBeTruthy();
    expect(
      within(verdict(o1 as HTMLElement)).getByText('Svaret sier tre uker, som kriteriet krever.'),
    ).toBeTruthy();
    expect(verdict(o2 as HTMLElement).textContent).toBe('Ikke aktuelt');
  });

  it("says before a run starts that the Langfuse judges' connection gets no answer text, and does not start it", async () => {
    const { writes } = await openLive(
      '',
      {},
      {},
      sending({ reason: 'no-content', connection: 'lokal' }),
    );
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    fireEvent.click(
      await screen.findByRole('checkbox', { name: /Send kjøringen til Langfuse \(lokal\)/ }),
    );
    await screen.findByText(
      `Kjøringen kan ikke starte. Langfuse-dommerne (${rule}) har ingenting å vurdere, fordi koblingen lokal ikke får svartekst. Slå på «Send tekst» for koblingen, eller slutt å bruke dommerne.`,
    );
    const start = screen.getByRole('button', { name: 'Start kjøringen' });

    expect(start.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(start);
    expect(writes().filter((w) => w.method === 'POST' && /eval-runs$/.test(w.path))).toEqual([]);
  });

  const costedRun = (usdNok?: { rate: number; date: string }) => ({
    ...judgedRun,
    id: 'med-kostnad',
    ...(usdNok ? { usdNok } : {}),
    sinkJudges: judgedRun.sinkJudges.map((j) => ({
      ...j,
      reported: { inputTokens: 4321, outputTokens: 987, costUsd: 0.0123, unpriced: 0, unread: 0 },
    })),
  });
  const costLine = async (run: ReturnType<typeof costedRun>) => {
    await openLive('', { runs: [run] });
    const history = await screen
      .findAllByRole('region', { name: 'Kjøringer av testsettet' })
      .then((found) => found[0] as HTMLElement);
    const row = (await within(history).findAllByRole('row'))[1] as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /^Vis resultatet fra/ }));
    const langfuse = await screen.findByRole('region', { name: 'Langfuse-dommere' });
    return within(langfuse).getByText(/^Kostnad rapportert av Langfuse/).textContent;
  };

  it('shows the cost in kroner with the rate the run stored', async () => {
    expect(await costLine(costedRun({ rate: 9.2826, date: '2026-10-29' }))).toMatch(
      /^Kostnad rapportert av Langfuse: 0,11\skr \(0,0123 USD med kurs 9,2826 fra 29\.\soktober 2026\), 5\s308 tokens\.$/,
    );
  });

  it('shows the cost in dollars until a rate is known', async () => {
    expect(await costLine(costedRun())).toMatch(
      /^Kostnad rapportert av Langfuse: 0,0123 USD, 5\s308 tokens\. Kronebeløpet vises når kursen fra Norges Bank er hentet\.$/,
    );
  });

  it("shows a Langfuse judge's agreement with its accepted labels", async () => {
    const agreementOf = async (labels: SinkAgreement) => {
      cleanup();
      await openLive('', {
        runs: [
          {
            ...judgedRun,
            id: `etiketter-${String(labels.n)}`,
            sinkJudges: judgedRun.sinkJudges.map((j) => ({ ...j, labels })),
          },
        ],
      });
      const history = await screen
        .findAllByRole('region', { name: 'Kjøringer av testsettet' })
        .then((found) => found[0] as HTMLElement);
      const row = (await within(history).findAllByRole('row'))[1] as HTMLElement;
      fireEvent.click(within(row).getByRole('button', { name: /^Vis resultatet fra/ }));
      const langfuse = await screen.findByRole('region', { name: 'Langfuse-dommere' });
      return within(langfuse).getByText(/etiketter/).textContent;
    };

    expect(
      await agreementOf({ n: 34, kappa: 0.72, observed: 0.85, otherVersions: 20, unpaired: 3 }),
    ).toMatch(
      /^Samsvar med godkjente etiketter: κ 0,72 · 85\s% like · 34 etiketter \(20 fra andre versjoner av dommeren\) · 3 uten dommerscore$/,
    );
    expect(
      await agreementOf({ n: 12, kappa: 0.5, observed: 0.75, otherVersions: 0, unpaired: 0 }),
    ).toMatch(/^Samsvar med godkjente etiketter: κ 0,50 · 75\s% like · 12 etiketter$/);
    expect(await agreementOf({ n: 0, otherVersions: 0, unpaired: 0 })).toBe(
      'Ingen godkjente etiketter ennå',
    );
    expect(await agreementOf({ n: 0, otherVersions: 0, unpaired: 2 })).toBe(
      'Ingen godkjente etiketter ennå · 2 uten dommerscore',
    );
  });

  it("shows what the project's other judges cost apart from the judges taken in use, as at least while some costs are not yet reported", async () => {
    await openLive('', {
      runs: [
        {
          ...costedRun({ rate: 9.2826, date: '2026-10-29' }),
          sinkOthers: {
            inputTokens: 900,
            outputTokens: 100,
            costUsd: 0.01,
            unpriced: 0,
            unread: 2,
          },
        },
      ],
    });
    const history = await screen
      .findAllByRole('region', { name: 'Kjøringer av testsettet' })
      .then((found) => found[0] as HTMLElement);
    const row = (await within(history).findAllByRole('row'))[1] as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /^Vis resultatet fra/ }));
    const langfuse = await screen.findByRole('region', { name: 'Langfuse-dommere' });

    expect(within(langfuse).getByText(/^Andre dommere i Langfuse-prosjektet/).textContent).toMatch(
      /^Andre dommere i Langfuse-prosjektet vurderte de samme testtilfellene: 0,09\skr \(0,0100 USD med kurs 9,2826 fra 29\.\soktober 2026\), 1\s000 tokens\. Langfuse hadde ikke rapportert kostnaden for 2 kall da kjøringen ble lagret, så beløpet er minst dette\.$/,
    );
  });

  it('refuses to send a run to Langfuse while the project has active judges genki does not read, and says so before it starts', async () => {
    const differ = (path: string) =>
      /\/eval-runs\/sending/.test(path)
        ? Response.json({
            connection: { id: 'lokal', residency: 'global' },
            judges: [],
            refused: {
              reason: 'judges-differ',
              connection: 'lokal',
              notInUse: [rule],
              unreadable: ['verktøy-eksperimenter'],
            },
          })
        : connections(path);
    const { writes } = await openLive('', {}, {}, differ);
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    const send = await screen.findByRole('checkbox', {
      name: /Send kjøringen til Langfuse \(lokal\)/,
    });
    const runs = () => writes().filter((w) => w.method === 'POST' && /eval-runs$/.test(w.path));

    fireEvent.click(send);
    const refusal = await screen.findByText(
      `Kjøringen kan ikke starte. Langfuse kjører alle aktive dommere i prosjektet til koblingen lokal på kjøringen, også dem genki ikke leser. Ta i bruk under Byggeklosser, eller slå av i Langfuse: ${rule}. Slå av i Langfuse, fordi genki ikke kan lese dem: verktøy-eksperimenter.`,
    );
    const start = screen.getByRole('button', { name: 'Start kjøringen' });
    expect(refusal.closest('.ds-alert')?.getAttribute('data-color')).toBe('danger');
    expect(start.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(start);
    expect(runs()).toEqual([]);
    fireEvent.click(send);
    expect(screen.queryByText(/^Kjøringen kan ikke starte/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start kjøringen' }));
    await waitFor(() => expect(runs()).toHaveLength(1));
    expect(runs()[0]?.body).not.toHaveProperty('trace');
  });
  it("says in the start dialog that a connection's Langfuse judges cannot be read", async () => {
    const unreadable = (path: string) =>
      /\/eval-runs\/sending/.test(path)
        ? Response.json({
            connection: { id: 'lokal', residency: 'global' },
            judges: [],
            refused: {
              reason: 'judges-unreadable',
              connection: 'lokal',
              message: 'Langfuse answered HTTP 404 for /api/public/v2/evaluation-rules',
            },
          })
        : connections(path);
    const { writes } = await openLive('', {}, {}, unreadable);
    await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    const send = await screen.findByRole('checkbox', {
      name: /Send kjøringen til Langfuse \(lokal\)/,
    });
    const runs = () => writes().filter((w) => w.method === 'POST' && /eval-runs$/.test(w.path));

    fireEvent.click(send);
    const refusal = await screen.findByText(
      'Kjøringen kan ikke starte. Dommerne i prosjektet til koblingen lokal kunne ikke leses (HTTP 404), så genki vet ikke hvilke dommere Langfuse ville kjørt på kjøringen.',
    );
    const start = screen.getByRole('button', { name: 'Start kjøringen' });
    expect(refusal.closest('.ds-alert')?.getAttribute('data-color')).toBe('danger');
    expect(start.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(start);
    expect(runs()).toEqual([]);
  });
});
