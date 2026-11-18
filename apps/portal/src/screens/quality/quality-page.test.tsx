// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import type { EvalRunDetail, Improvement } from '../../api/quality';
import { mockAnsattporten } from '../../auth';
import { mockFetch, type MockExtras } from '../../mock';
import type { QualityMockOptions } from '../../mock/quality';
import { expectAccessible, kari } from '../../test-utils';
import type { FeedbackItem, Organisation, TaskRow } from '../../types';

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
  return { calls, writes };
};

const run = (
  over: Partial<EvalRunDetail> & { id: string },
): EvalRunDetail & { service: string } => ({
  service: 'rapportassistenten',
  status: 'completed',
  testSet: 'rapport-kjerne',
  version: 'published',
  startedAt: '2026-11-10T08:00:00Z',
  endedAt: '2026-11-10T08:05:00Z',
  passed: 2,
  total: 3,
  score: 2 / 3,
  cases: [],
  ...over,
});

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

const section = (name: string) => screen.findByRole('region', { name });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the Kvalitet page', () => {
  it('shows one page with test sets, automatic assessment, feedback and proposals, without sub-tabs', async () => {
    await open();
    const headings = await screen.findAllByRole('heading', { level: 2 });
    await waitFor(() =>
      expect(headings.map((h) => h.textContent)).toEqual(
        expect.arrayContaining([
          'Testsett',
          'Automatisk vurdering',
          'Tilbakemeldinger fra brukerne',
          'Forslag til forbedringer',
        ]),
      ),
    );
    const order = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
      .filter((text) =>
        [
          'Testsett',
          'Automatisk vurdering',
          'Tilbakemeldinger fra brukerne',
          'Forslag til forbedringer',
        ].includes(text ?? ''),
      );
    expect(order).toEqual([
      'Testsett',
      'Automatisk vurdering',
      'Tilbakemeldinger fra brukerne',
      'Forslag til forbedringer',
    ]);
    expect(screen.queryByRole('tablist')).toBeNull();
    expectAccessible();
  });

  it('shows each test set with its question count, when it last ran and the last result', async () => {
    await open('', { runs: [run({ id: 'r1' })] });
    const sets = await section('Testsett');
    expect(await within(sets).findByText('2 av 3 bestått')).toBeTruthy();
    expect(within(sets).getByText(/^3 spørsmål · sist kjørt /)).toBeTruthy();
    expect(within(sets).getByRole('link', { name: 'Kjernespørsmål' }).getAttribute('href')).toBe(
      `${base}?set=rapport-kjerne`,
    );
  });

  it('opens the full test set editor with its cases from the test set name', async () => {
    await open();
    const sets = await section('Testsett');
    fireEvent.click(await within(sets).findByRole('link', { name: 'Kjernespørsmål' }));
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

describe('running a test set from the page', () => {
  it('asks for confirmation with a cost estimate before it starts a run', async () => {
    const { writes } = await open('', { runs: [run({ id: 'r1' })] });
    const sets = await section('Testsett');
    fireEvent.click(await within(sets).findByRole('button', { name: 'Kjør testsettet' }));
    expect(
      await within(sets).findByRole('heading', { name: /^Kjøre testsettet med 3/ }),
    ).toBeTruthy();
    expect(writes()).toEqual([]);
    fireEvent.click(within(sets).getByRole('button', { name: 'Avbryt' }));
    expect(within(sets).queryByRole('button', { name: 'Start kjøringen' })).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('runs the draft when the service has one and shows the new result against the last one', async () => {
    const { writes } = await open('', {
      runs: [run({ id: 'r1', passed: 1 })],
      drafts: { rapportassistenten: { definition: { kind: 'Service', spec: {} } } },
    });
    const sets = await section('Testsett');
    await within(sets).findByText('1 av 3 bestått');
    fireEvent.click(within(sets).getByRole('button', { name: 'Kjør testsettet' }));
    fireEvent.click(await within(sets).findByRole('button', { name: 'Start kjøringen' }));
    expect(await within(sets).findByText('2 av 3 bestått nå (var 1).')).toBeTruthy();
    expect(writes().at(-1)).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/services/rapportassistenten/eval-runs',
      body: { testSet: 'rapport-kjerne', version: 'draft' },
      reason: 'Kjørte Kjernespørsmål på utkastet',
    });
  });

  it('runs the published version when the service has no draft', async () => {
    const { writes } = await open();
    const sets = await section('Testsett');
    fireEvent.click(await within(sets).findByRole('button', { name: 'Kjør testsettet' }));
    fireEvent.click(await within(sets).findByRole('button', { name: 'Start kjøringen' }));
    await waitFor(() => expect(writes().at(-1)).toMatchObject({ body: { version: 'published' } }));
  });

  it('shows the progress of a running run and blocks a second start', async () => {
    await open('', { runsStayRunning: true });
    const sets = await section('Testsett');
    fireEvent.click(await within(sets).findByRole('button', { name: 'Kjør testsettet' }));
    fireEvent.click(await within(sets).findByRole('button', { name: 'Start kjøringen' }));
    expect(await within(sets).findByText('Kjører 0 av 3 spørsmål ...')).toBeTruthy();
    expect(
      within(sets).getByRole('progressbar', { name: 'Fremdrift for Kjernespørsmål' }),
    ).toBeTruthy();
    const button = within(sets).getByRole('button', { name: 'Kjører ...' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  it('says which right is missing instead of starting a run for a reader', async () => {
    const { writes } = await open('', {}, {}, undefined, reader);
    const sets = await section('Testsett');
    const button = await within(sets).findByRole('button', { name: 'Kjør testsettet' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Du trenger rettigheten «Administrere tjenester».');
    fireEvent.click(button);
    expect(within(sets).queryByRole('button', { name: 'Start kjøringen' })).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe('automatic assessment', () => {
  const older = run({
    id: 'old',
    startedAt: '2026-11-01T08:00:00Z',
    endedAt: '2026-11-01T08:05:00Z',
    metrics: { 'judge.criteria': { mean: 0.5, ci: [0.3, 0.7], n: 8 } },
  });
  const newest = run({
    id: 'new',
    metrics: {
      'judge.criteria': { mean: 0.75, ci: [0.5, 0.9], n: 8 },
      refusal: { mean: 1, ci: [1, 1], n: 2 },
      'langfuse:lokal/tone': { mean: 0.2, ci: [0.1, 0.3], n: 8 },
    },
    sinkJudges: [
      {
        id: 'langfuse:lokal/tone',
        name: 'tone',
        version: 'v1',
        notApplicable: 0,
        missing: 0,
        failed: 0,
        of: 8,
        changed: [],
      },
    ],
    cases: [
      {
        caseId: 'tc-2',
        input: 'Hva sier evalueringene om digital veiledning?',
        expected: 'Oppsummerer funnene med kilder.',
        output: 'Svaret bruker tall fra et eldre år.',
        pass: false,
      },
    ],
  });

  it('shows the pass share per rule from the latest completed run, without Langfuse judges', async () => {
    await open('', { runs: [older, newest] });
    const rules = await section('Automatisk vurdering');
    const criteria = (await within(rules).findByText('Oppfyller kriteriene')).closest(
      'li',
    ) as HTMLElement;
    expect(within(criteria).getByText('75 %')).toBeTruthy();
    expect(
      within(criteria).getByRole('link', { name: 'Se de 2 som ikke besto' }).getAttribute('href'),
    ).toBe(`${base}?set=rapport-kjerne&run=new`);
    const refusal = within(rules).getByText('Avviser').closest('li') as HTMLElement;
    expect(within(refusal).getByText('100 %')).toBeTruthy();
    expect(within(refusal).getByText('Alle besto')).toBeTruthy();
    expect(within(rules).queryByText(/tone/)).toBeNull();
    expect(within(rules).queryByText('50 %')).toBeNull();
  });

  it('opens the run with the answers that did not pass from Se de N som ikke besto', async () => {
    await open('', { runs: [older, newest] });
    const rules = await section('Automatisk vurdering');
    await within(rules).findByRole('link', { name: 'Se de 2 som ikke besto' });
    window.location.hash = `${base}?set=rapport-kjerne&run=new`;
    const detail = await screen.findByRole('region', { name: 'Resultat per testtilfelle' });
    expect(await within(detail).findByText('Svaret bruker tall fra et eldre år.')).toBeTruthy();
  });

  it('says there is no assessment before any test set has run', async () => {
    await open();
    const rules = await section('Automatisk vurdering');
    expect(await within(rules).findByText(/^Ingen vurdering ennå\. Kjør et testsett/)).toBeTruthy();
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
    await open('', {}, { feedback, tasks });
    const fb = await section('Tilbakemeldinger fra brukerne');
    expect(await within(fb).findByText('Siste 30 dager: 2 tommel opp, 1 tommel ned.')).toBeTruthy();
    expect(within(fb).queryByText('«Gammelt.»')).toBeNull();
  });

  it('links each feedback to its run, named by the question that was asked', async () => {
    await open('', {}, { feedback, tasks });
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
    await open('', {}, { feedback, tasks });
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
    await open('', {}, { feedback, tasks }, (path) =>
      failing && /\/feedback\?service=/.test(path)
        ? Response.json({ title: 'Feil' }, { status: 500 })
        : undefined,
    );
    const fb = await section('Tilbakemeldinger fra brukerne');
    const alert = await within(fb).findByRole('alert');
    expect(within(alert).getByText('Vi fikk ikke hentet tilbakemeldingene')).toBeTruthy();
    expect(within(alert).getByText('Resten av siden er oppdatert.')).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Kjernespørsmål' })).toBeTruthy();
    failing = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Prøv igjen' }));
    expect(await within(fb).findByText('Siste 30 dager: 2 tommel opp, 1 tommel ned.')).toBeTruthy();
  });

  it('asks for the questions of the last 30 days with the same window on every visit within the hour, so a return is served at once', async () => {
    const { calls } = await open('', {}, { feedback, tasks });
    const fb = await section('Tilbakemeldinger fra brukerne');
    await within(fb).findByText('«Manglet Askøy.»');
    vi.setSystemTime(new Date(now.getTime() + 25 * 60_000));
    window.location.hash = '#/services/rapportassistenten';
    await screen.findByRole('heading', { name: 'Hva tjenesten gjør' });
    window.location.hash = base;
    await within(await section('Tilbakemeldinger fra brukerne')).findByText('«Manglet Askøy.»');

    const windows = calls
      .filter((c) => c.path.includes('/tasks?') && c.path.includes('limit=500'))
      .map((c) => new URL(c.path, 'http://portal').searchParams.get('from'));
    expect(windows.length).toBeGreaterThan(0);
    expect(new Set(windows)).toEqual(new Set(['2026-10-18T12:00:00.000Z']));
  });

  it('says so when no one has given feedback yet', async () => {
    await open('', {}, { feedback: [] });
    const fb = await section('Tilbakemeldinger fra brukerne');
    expect(await within(fb).findByText(/^Ingen tilbakemeldinger ennå\./)).toBeTruthy();
  });
});

describe('improvement proposals', () => {
  it('approves a proposal in place through the decision endpoint', async () => {
    const { writes } = await open('', { improvements: [ready] });
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
    await open('', { improvements: [ready] }, {}, undefined, reader);
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
  it('shows the four sections in English', async () => {
    await open('', {}, {}, undefined, kari.organisations, ['en']);
    expect(await screen.findByRole('heading', { level: 2, name: 'Test sets' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Automatic assessment' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Feedback from users' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Improvement proposals' })).toBeTruthy();
    expect(screen.queryByText('Testsett')).toBeNull();
  });
});
