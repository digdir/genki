// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import type { Improvement } from '../../api/quality';
import { mockAnsattporten } from '../../auth';
import { mockFetch, type MockExtras } from '../../mock';
import type { QualityMockOptions } from '../../mock/quality';
import { exampleQualityRunsFor, exampleRunningRunFor } from '../../mock/quality-example';
import { expectAccessible, kari } from '../../test-utils';
import type { FeedbackItem, Organisation, TaskRow } from '../../types';
import { feedbackRowsToReserve } from './QualityPage';

const base = '#/services/rapportassistenten/quality';
const now = new Date('2026-11-17T12:00:00Z');

interface Call {
  method: string;
  path: string;
  body: unknown;
  reason: string | null;
}

const open = async (
  address = '',
  quality: QualityMockOptions = {},
  extras: Omit<MockExtras, 'features'> = {},
  respond: (path: string) => Response | undefined = () => undefined,
  organisations = kari.organisations,
  languages?: string[],
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
  const auth = mockAnsattporten({ ...kari, organisations });
  await auth.login();
  window.location.hash = `${base}${address}`;
  render(<App auth={auth} fetch={fetch} live {...(languages ? { languages } : {})} />);
  const writes = () => calls.filter((c) => c.method !== 'GET');
  return { calls, writes, fetch };
};

const ready: Improvement & { service: string } = {
  id: 'imp-1',
  service: 'rapportassistenten',
  status: 'ready',
  change: { path: 'spec.instructions', before: 'Svar kort.', after: 'Svar kort med kilder.' },
  reasons: ['Tre tilbakemeldinger sier at kildene mangler.'],
  createdAt: '2026-11-16T09:00:00Z',
};

const reader: Organisation[] = [
  { orgNumber: '999888777', name: 'Testetaten', actions: ['use-services', 'view-usage'] },
];

const section = async (name: string) =>
  (await screen.findAllByRole('region', { name }))[0] as HTMLElement;

const qualityNow = async () => {
  await waitFor(() =>
    expect(
      screen.getByRole('region', { name: 'Testutgaven' }).getAttribute('aria-busy'),
    ).toBeNull(),
  );
  return screen.getByRole('region', { name: 'Testutgaven' });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const example: QualityMockOptions = { example: true };

const runningRuns = (startedBy?: string) => {
  const running = exampleRunningRunFor('rapportassistenten', now);
  if (startedBy) {
    delete running.startedByYou;
    running.startedByName = startedBy;
  }
  return [running, ...exampleQualityRunsFor('rapportassistenten', 7, 2, now)];
};

const rowOf = (within_: HTMLElement, text: string) =>
  within(within_).getByText(text).closest('li, tr') as HTMLElement;

const useServices: Organisation[] = [
  { orgNumber: '999888777', name: 'Testetaten', actions: ['use-services'] },
];

describe('the Kvalitet page', () => {
  it('shows quality now, gates, test sets, cases, judges, comparison and quality in use in that order', async () => {
    await open('', example);
    await section('Saker i siste kjøring');
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
        'Testutgaven',
        'Krav til kvalitet',
        'Testsett',
        'Saker i siste kjøring',
        'Automatiske vurderinger',
        'Sammenligning',
        'I bruk',
      ]),
    );
    expect(
      screen
        .queryAllByRole('tablist')
        .filter((list) => !/^Faner for /.test(list.getAttribute('aria-label') ?? '')),
    ).toEqual([]);
    expectAccessible();
  });

  it('shows the score of the version in use, the cases passed and the change from the version before', async () => {
    await open('', example);
    const now_ = await qualityNow();
    expect(within(now_).getAllByText(/^86\s%$/)[0]?.className).toBe('q-score');
    expect(within(now_).getByText('36 av 42 saker bestått, utgave 7')).toBeTruthy();
    expect(within(now_).getByText('Opp 5 poeng fra utgave 6')).toBeTruthy();
    expect(within(now_).getByText('Testsettet Evalueringer, kjørt i dag 09:12')).toBeTruthy();
    expect(
      within(now_)
        .getByRole('img', { name: /^Poeng per utgave: / })
        .getAttribute('aria-label'),
    ).toMatch(/utgave 1 71\s%.*utgave 7 86\s%$/);
  });

  it('opens the full test set editor with its cases from the test set card', async () => {
    await open();
    const sets = await section('Testsett');
    fireEvent.click(await within(sets).findByRole('link', { name: /^Kjernespørsmål/ }));
    window.location.hash = `${base}?set=rapport-kjerne`;
    expect(await screen.findByRole('heading', { name: 'Kjernespørsmål' })).toBeTruthy();
    expect(await screen.findByText('Hvor mange tilsyn hadde vi i 2025?')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tilbake til Kvalitet' }).getAttribute('href')).toBe(
      base,
    );
  });

  it('offers to create the first test set when the service has none', async () => {
    await open('', { sets: [] });
    const sets = await section('Testsett');
    expect(await within(sets).findByRole('heading', { name: 'Ingen testsett ennå' })).toBeTruthy();
    expect(within(sets).getByRole('link', { name: 'Lag et testsett' }).getAttribute('href')).toBe(
      `${base}?view=testsets`,
    );
  });
});

describe('test sets', () => {
  it('shows each test set as a card with its score, cases held back and when it ran, the measured one marked', async () => {
    await open('', example);
    const sets = await section('Testsett');
    const main = await within(sets).findByRole('link', { name: /^Evalueringer/ });
    expect(main.textContent?.replace(/\s/g, ' ')).toBe(
      'Evalueringer86 %42 saker, 10 holdt tilbake. Kjørt i dag 09:12',
    );
    expect(main.getAttribute('aria-current')).toBe('true');
    expect(main.getAttribute('href')).toBe(`${base}?set=rapportassistenten-evalueringer`);
    expect(
      within(sets)
        .getByRole('link', { name: /^Skal avslå/ })
        .textContent?.replace(/\s/g, ' '),
    ).toMatch(/9 saker utenfor kildene\. Kjørt 10\. nov$/);
    expect(within(sets).queryByRole('button')).toBeNull();
  });

  it('links to the proposals from feedback with how many wait for review', async () => {
    await open('', example);
    const sets = await section('Testsett');
    expect(
      (
        await within(sets).findByRole('link', { name: '1 forslag fra tilbakemeldinger' })
      ).getAttribute('href'),
    ).toBe(`${base}?view=feedback`);
    expect(within(sets).getByRole('link', { name: 'Nytt testsett' }).getAttribute('href')).toBe(
      `${base}?view=testsets`,
    );
  });
});

describe('testing the draft again', () => {
  it('asks before it runs, with the cases, the time and the cost, and runs the draft', async () => {
    const { writes } = await open('', example);
    const now_ = await qualityNow();
    expect(within(now_).getByText(/^42 saker, omtrent \d+ minutter og \d+\skr$/)).toBeTruthy();
    fireEvent.click(await within(now_).findByRole('button', { name: 'Test utkastet på nytt' }));
    expect(
      await within(now_).findByRole('heading', { name: /^Kjøre testsettet med 42/ }),
    ).toBeTruthy();
    expect(writes()).toEqual([]);
    fireEvent.click(within(now_).getByRole('button', { name: 'Start kjøringen' }));
    await waitFor(() =>
      expect(writes().at(-1)).toMatchObject({
        method: 'POST',
        path: '/tenants/999888777/services/rapportassistenten/eval-runs',
        body: { testSet: 'rapportassistenten-evalueringer', version: 'draft' },
        reason: 'Kjørte Evalueringer på utkastet',
      }),
    );
  });

  it('runs the published version when the draft is published after the page opened', async () => {
    const { writes, fetch } = await open('', example);
    const now_ = await qualityNow();
    fireEvent.click(await within(now_).findByRole('button', { name: 'Test utkastet på nytt' }));
    await within(now_).findByRole('heading', { name: /^Kjøre testsettet med 42/ });
    await fetch('/api/tenants/999888777/services/rapportassistenten/draft', {
      method: 'DELETE',
      headers: { 'change-reason': 'Publisert' },
    });
    fireEvent.click(within(now_).getByRole('button', { name: 'Start kjøringen' }));
    await waitFor(() =>
      expect(writes().at(-1)).toMatchObject({
        method: 'POST',
        path: '/tenants/999888777/services/rapportassistenten/eval-runs',
        body: { testSet: 'rapportassistenten-evalueringer', version: 'published' },
      }),
    );
    expect(screen.queryByText('Tjenesten har ikke noe lagret utkast')).toBeNull();
  });

  it('says in the run confirmation that each test case is a paid run, in test cases only', async () => {
    await open('', example);
    const now_ = await qualityNow();
    fireEvent.click(await within(now_).findByRole('button', { name: 'Test utkastet på nytt' }));
    const title = await within(now_).findByRole('heading', { name: /^Kjøre testsettet med 42/ });
    const confirm = title.parentElement as HTMLElement;
    expect(within(confirm).getByText(/Hvert testtilfelle er en betalt kjøring\.$/)).toBeTruthy();
    expect(confirm.textContent).not.toMatch(/\bsaker\b/);
  });

  it('says which right is missing instead of offering a run to a reader', async () => {
    const { writes } = await open('', example, {}, undefined, reader);
    const now_ = await qualityNow();
    expect(
      await within(now_).findByText(/Du trenger rettigheten «Administrere tjenester»\.$/),
    ).toBeTruthy();
    expect(within(now_).queryByRole('button', { name: 'Test utkastet på nytt' })).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe('gates before publishing', () => {
  it('says the gates were checked against an older draft when the draft changed after the run', async () => {
    await open('', example);
    const gates = await section('Krav til kvalitet');
    expect(
      await within(gates).findByText(
        'Publiser stopper hvis utkastet ikke klarer disse. Sjekket mot kjøringen av utkastet kl. 11:40; utkastet er endret etterpå.',
      ),
    ).toBeTruthy();
    const share = rowOf(gates, 'Andel bestått minst 80 %');
    expect(
      within(share).getByText('Kreves av Testetaten for alle tjenester. Utkastet: 90 %'),
    ).toBeTruthy();
    expect(within(share).getByText('Klarer')).toBeTruthy();
    const refusal = rowOf(gates, 'Avslag uten kilde: minst 90 %');
    expect(within(refusal).getByText('Utkastet avslo 8 av 9 (89 %)')).toBeTruthy();
    expect(within(refusal).getByText('Stopper')).toBeTruthy();
  });

  it('says the gates were checked against this draft when nothing changed after the run', async () => {
    await open('', { runs: exampleQualityRunsFor('rapportassistenten', 7, 3, now), example: true });
    const gates = await section('Krav til kvalitet');
    expect(
      await within(gates).findByText(
        'Publiser stopper hvis utkastet ikke klarer disse. Sjekket mot kjøringen av utkastet kl. 11:40.',
      ),
    ).toBeTruthy();
  });
});

describe('the cases of the last run', () => {
  it('lists failed cases first, with what each is checked on, its run in the log and how the version before did', async () => {
    await open('', example);
    const cases = await section('Saker i siste kjøring');
    expect(
      within(cases).getByText('Utgave 7, testsettet Evalueringer. Feilede først'),
    ).toBeTruthy();
    const table = within(cases).getByRole('table');
    expect(await within(table).findByRole('columnheader', { name: 'Utgave 6' })).toBeTruthy();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(8);
    expect(within(rows[0] as HTMLElement).getAllByText('Feilet').length).toBeGreaterThan(0);
    const refusal = rowOf(table, 'Hvem klaget på saksbehandleren i fjor?');
    expect(
      within(refusal)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual([
      'Hvem klaget på saksbehandleren i fjor?',
      'Skal avslå',
      'Feilet',
      'Svarer med et anslag i stedet for å avslå.',
      'Feilet',
    ]);
    expect(
      within(refusal)
        .getByRole('link', { name: 'Hvem klaget på saksbehandleren i fjor?' })
        .getAttribute('href'),
    ).toBe('#/log/rapportassistenten-run-v7-rapportassistenten-ev-16');
    for (const chip of ['Alle 42', 'Feilet 6', 'Bestått 36'])
      expect(within(cases).getByRole('button', { name: chip })).toBeTruthy();
    expect(within(cases).getByText('1 til 8 av 42 saker')).toBeTruthy();
  });
});

describe('a test run that is going', () => {
  it('shows how the published version did on the same cases while a run is going', async () => {
    await open('', { runs: runningRuns(), example: true });
    const run = await section('Tester utkastet');
    expect(within(run).getByText(/^Startet \d\d:\d\d av Kari Nordmann$/)).toBeTruthy();
    expect(within(run).getByText('17 av 42 saker ferdige')).toBeTruthy();
    expect(within(run).getByRole('progressbar', { name: 'Fremdrift' })).toBeTruthy();
    const fact = (name: string) => within(run).getByText(name).nextElementSibling?.textContent;
    await waitFor(() => expect(fact('Utgave 7 på de samme')).toBe('14 av 17'));
    expect(fact('Bestått så langt')).toBe('15 av 17');
    expect(fact('Kjører nå')).toBe('3 saker');
    expect(
      within(run).getByText('Du kan gå fra siden. Kjøringen fortsetter, og resultatet kommer her.'),
    ).toBeTruthy();
    const cases = await section('Saker i kjøringen av utkastet');
    for (const chip of ['Alle 42', 'Ferdige 17', 'Kjører 3', 'Venter 22'])
      expect(await within(cases).findByRole('button', { name: chip })).toBeTruthy();
    expect(within(cases).getByText('1 til 8 av 42')).toBeTruthy();
    const gates = await section('Krav til kvalitet');
    expect(await within(gates).findAllByText('Venter på kjøringen')).toHaveLength(3);
  });

  it('asks before cancelling a running test run and shows it cancelled', async () => {
    const { writes } = await open('', { runs: runningRuns(), example: true });
    const run = await section('Tester utkastet');
    fireEvent.click(within(run).getByRole('button', { name: 'Avbryt kjøringen' }));
    expect(within(run).getByRole('heading', { name: 'Avbryte kjøringen?' })).toBeTruthy();
    fireEvent.click(within(run).getByRole('button', { name: 'Avbryt kjøringen' }));
    expect(writes()).toEqual([]);
    fireEvent.change(within(run).getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Startet med feil testsett' },
    });
    fireEvent.click(within(run).getByRole('button', { name: 'Avbryt kjøringen' }));
    expect(await screen.findByText('Kjøringen er avbrutt.')).toBeTruthy();
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/tenants/999888777/services/rapportassistenten/eval-runs/rapportassistenten-run-running/cancel',
        body: {},
        reason: 'Startet med feil testsett',
      },
    ]);
    expect(await qualityNow()).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Tester utkastet' })).toBeNull();
  });

  it('hides cancel from someone who did not start the run and cannot manage services', async () => {
    await open(
      '',
      {
        runs: runningRuns('Ola Nordmann'),
        example: true,
      },
      {},
      undefined,
      useServices,
    );
    const run = await section('Tester utkastet');
    expect(within(run).getByText(/av Ola Nordmann$/)).toBeTruthy();
    expect(within(run).queryByRole('button', { name: 'Avbryt kjøringen' })).toBeNull();
  });

  it('lets the one who started a run cancel it without the right to manage services', async () => {
    await open('', { runs: runningRuns(), example: true }, {}, undefined, useServices);
    const run = await section('Tester utkastet');
    expect(within(run).getByRole('button', { name: 'Avbryt kjøringen' })).toBeTruthy();
  });
});

describe('judges and quality in use', () => {
  it('names each judge with what it checks, the cases it scored and the share passed, a Langfuse judge as a mean with its catalogue model name', async () => {
    await open('', example);
    const judges = await section('Automatiske vurderinger');
    const criteria = rowOf(judges, 'Kriterier');
    expect(
      await within(criteria).findByText('genki, kriterier@2 med GPT-4.1. 31 saker'),
    ).toBeTruthy();
    expect(
      within(rowOf(judges, 'Eksakt tekst')).getByText('Sammenligner med fasiten. 2 saker'),
    ).toBeTruthy();
    expect(within(rowOf(judges, 'Avslag')).getByText(/^89\s%$/)).toBeTruthy();
    const faithful = rowOf(judges, 'Faktatroskap');
    expect(within(faithful).getByText('snitt 0,91')).toBeTruthy();
    expect(
      within(faithful).getByText('Langfuse, faktatroskap@4 med GPT-4.1 mini. Alle saker'),
    ).toBeTruthy();
  });

  it('shows quality in use as coming, with its preview bars hidden from screen readers', async () => {
    await open('', example);
    const live = await section('I bruk');
    expect(within(live).getByText('Kommer')).toBeTruthy();
    expect(live.querySelector('.q-ghost')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Tilbakemeldinger and Forslag til forbedringer behind the forslag link', () => {
  it('lists the proposals the forslag link counts on the page it opens', async () => {
    await open('?view=feedback', example);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Forslag til testtilfeller' }),
    ).toBeTruthy();
  });

  it('opens both lists from the link in Testsett, with a way back to Kvalitet', async () => {
    await open('', example);
    const sets = await section('Testsett');
    const link = await within(sets).findByRole('link', { name: /forslag fra tilbakemeldinger$/ });
    expect(link.getAttribute('href')).toBe(`${base}?view=feedback`);
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Tilbakemeldinger fra brukerne' }),
    ).toBeNull();

    window.location.hash = `${base}?view=feedback`;
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Tilbakemeldinger fra brukerne' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Forslag til forbedringer' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tilbake til Kvalitet' }).getAttribute('href')).toBe(
      base,
    );
    expect(
      screen.getByRole('link', { name: 'Se alle tilbakemeldinger' }).getAttribute('href'),
    ).toBe(`${base}?view=feedback-all`);
  });
});

describe('feedback from users', () => {
  const feedback: FeedbackItem[] = [
    { task: 't-1', rating: 'down', comment: 'Manglet Askøy.', at: '2026-11-16T15:06:00Z' },
    { task: 't-2', rating: 'up', at: '2026-11-15T10:40:00Z' },
    { task: 't-3', rating: 'up', comment: 'Fint med lenke.', at: '2026-11-01T10:00:00Z' },
    { task: 't-4', rating: 'down', comment: 'Gammelt.', at: '2026-10-01T10:00:00Z' },
  ];
  const task = (id: string, excerpt: string): TaskRow => ({
    id,
    status: 'completed',
    service: 'rapportassistenten',
    capability: '999888777/rapportassistenten/default',
    excerpt,
    createdAt: '2026-11-16T15:00:00Z',
    endedAt: '2026-11-16T15:00:05Z',
  });
  const tasks = [task('t-1', 'Hvilke kommuner i Vestland fikk pålegg i 2025?')];

  it('counts thumbs up and down from the last 30 days only', async () => {
    await open('?view=feedback', {}, { feedback, tasks });
    const fb = await section('Tilbakemeldinger fra brukerne');
    expect(await within(fb).findByText('Siste 30 dager: 2 tommel opp, 1 tommel ned.')).toBeTruthy();
    expect(within(fb).queryByText('«Gammelt.»')).toBeNull();
  });

  it('links each feedback to its run, named by the question that was asked', async () => {
    await open('?view=feedback', {}, { feedback, tasks });
    const fb = await section('Tilbakemeldinger fra brukerne');
    const question = await within(fb).findByRole('link', {
      name: 'Hvilke kommuner i Vestland fikk pålegg i 2025?',
    });
    expect(question.getAttribute('href')).toBe('#/log/t-1');
    expect(within(fb).getByText('«Manglet Askøy.»')).toBeTruthy();
    expect(
      within(fb).getAllByRole('link', { name: 'Åpne kjøringen' })[0]?.getAttribute('href'),
    ).toBe('#/log/t-2');
  });

  it('filters the feedback to thumbs down or to those with a comment', async () => {
    await open('?view=feedback', {}, { feedback, tasks });
    const fb = await section('Tilbakemeldinger fra brukerne');
    await within(fb).findByText('«Manglet Askøy.»');
    fireEvent.click(within(fb).getByRole('radio', { name: 'Tommel ned' }));
    expect(within(fb).queryByText('«Fint med lenke.»')).toBeNull();
    expect(within(fb).getByText('«Manglet Askøy.»')).toBeTruthy();
    fireEvent.click(within(fb).getByRole('radio', { name: 'Med kommentar' }));
    expect(within(fb).getByText('«Fint med lenke.»')).toBeTruthy();
    expect(within(fb).queryAllByRole('link', { name: 'Åpne kjøringen' })).toHaveLength(1);
  });

  it('says the feedback could not be loaded, keeps the rest of the page and loads it again', async () => {
    let failing = true;
    await open('?view=feedback', {}, { feedback, tasks }, (path) =>
      failing && /\/feedback\?service=/.test(path)
        ? Response.json({ title: 'Feil' }, { status: 500 })
        : undefined,
    );
    const fb = await section('Tilbakemeldinger fra brukerne');
    const alert = await within(fb).findByRole('alert');
    expect(within(alert).getByText('Vi fikk ikke hentet tilbakemeldingene')).toBeTruthy();
    expect(within(alert).getByText('Resten av siden er oppdatert.')).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Forslag til forbedringer' }),
    ).toBeTruthy();
    failing = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Prøv igjen' }));
    expect(await within(fb).findByText('Siste 30 dager: 2 tommel opp, 1 tommel ned.')).toBeTruthy();
  });

  it('asks for the questions of the last 30 days with the same window on every visit within the hour, so a return is served at once', async () => {
    const { calls } = await open('?view=feedback', {}, { feedback, tasks });
    const fb = await section('Tilbakemeldinger fra brukerne');
    await within(fb).findByText('«Manglet Askøy.»');
    vi.setSystemTime(new Date(now.getTime() + 25 * 60_000));
    window.location.hash = '#/services/rapportassistenten';
    await screen.findByRole('heading', { name: 'Slik går det' });
    window.location.hash = `${base}?view=feedback`;
    await within(await section('Tilbakemeldinger fra brukerne')).findByText('«Manglet Askøy.»');

    const windows = calls
      .filter((c) => c.path.includes('/tasks?') && c.path.includes('limit=500'))
      .map((c) => new URL(c.path, 'http://portal').searchParams.get('from'));
    expect(windows.length).toBeGreaterThan(0);
    expect(new Set(windows)).toEqual(new Set(['2026-10-18T12:00:00.000Z']));
  });

  it('reserves as many feedback rows as the last visit listed, so Forslag til forbedringer stays put', async () => {
    sessionStorage.clear();
    const many: FeedbackItem[] = Array.from({ length: 7 }, (_, i) => ({
      task: `t-${i}`,
      rating: 'up',
      at: '2026-11-16T10:00:00Z',
    }));
    await open('?view=feedback', {}, { feedback: many, tasks });
    const fb = await section('Tilbakemeldinger fra brukerne');
    await within(fb).findByText('Siste 30 dager: 7 tommel opp, 0 tommel ned.');

    await waitFor(() => expect(feedbackRowsToReserve('999888777', 'rapportassistenten')).toBe(7));
    expect(feedbackRowsToReserve('999888777', 'en-annen-tjeneste')).toBe(4);
  });

  it('says so when no one has given feedback yet', async () => {
    await open('?view=feedback', {}, { feedback: [] });
    const fb = await section('Tilbakemeldinger fra brukerne');
    expect(await within(fb).findByText(/^Ingen tilbakemeldinger ennå\./)).toBeTruthy();
  });
});

describe('improvement proposals', () => {
  it('approves a proposal in place through the decision endpoint', async () => {
    const { writes } = await open('?view=feedback', { improvements: [ready] });
    const card = await screen.findByRole('region', { name: /^Forslag fra/ });
    fireEvent.click(within(card).getByRole('button', { name: 'Godkjenn' }));
    expect(await within(card).findByText(/^Godkjent .+ Endringen ligger i utkastet/)).toBeTruthy();
    expect(writes().at(-1)).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/services/rapportassistenten/improvements/imp-1/decision',
      body: { approve: true },
    });
  });

  it('lets a reader read the proposals and says which right approving needs', async () => {
    await open('?view=feedback', { improvements: [ready] }, {}, undefined, reader);
    const card = await screen.findByRole('region', { name: /^Forslag fra/ });
    expect(within(card).queryByRole('button', { name: 'Godkjenn' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Avvis' })).toBeNull();
    expect(
      screen.getByText(
        'Du kan lese forslagene. For å godkjenne eller avvise dem trenger du rettigheten «Administrere tjenester».',
      ),
    ).toBeTruthy();
  });
});

describe('the Kvalitet page in English', () => {
  it('shows the sections and the feedback page in English', async () => {
    await open('', {}, {}, undefined, kari.organisations, ['en']);
    expect(await screen.findByRole('heading', { level: 2, name: 'Test sets' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Automatic evaluations' })).toBeTruthy();
    expect(screen.queryByText('Testsett')).toBeNull();
    cleanup();

    await open('?view=feedback', {}, {}, undefined, kari.organisations, ['en']);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Feedback from users' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Improvement proposals' })).toBeTruthy();
  });
});
