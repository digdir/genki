// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logTimelines } from '../data/log';
import { translator } from '../i18n';
import { mockFetch } from '../mock';
import type { TaskTimeline } from '../types';
import { expectAccessible, failingFetch, renderAt } from '../test-utils';
import { trialLabel, trialPlace } from './log/RunsTab';

vi.hoisted(() => {
  vi.useFakeTimers({ now: new Date('2026-11-17T13:00:00Z'), toFake: ['Date'] });
});

const tab = (name: string) =>
  within(screen.getByRole('tablist', { name: 'Logg' })).getByRole('tab', { name });
const steps = () => screen.findByRole('list', { name: 'Steg i kjøringen' });
const table = () => screen.findByRole('table', { name: 'Kjøringer' });
const rowOf = (name: RegExp) =>
  within(screen.getByRole('table', { name: 'Kjøringer' }))
    .getByRole('link', { name })
    .closest('tr') as HTMLElement;

const recording = () => {
  const calls: string[] = [];
  const base = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    return base(input, init);
  };
  return { calls, fetch, tasks: () => calls.filter((c) => /\/tasks\?/.test(c)) };
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Logg: Kjøringer', () => {
  it('lists the runs of today in a table with time, run, status, duration and cost', async () => {
    await renderAt('#/log');

    expect(await screen.findByRole('heading', { level: 1, name: 'Logg' })).toBeTruthy();
    expect(tab('Kjøringer').getAttribute('aria-selected')).toBe('true');
    const headers = within(await table())
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Tid', 'Kjøring', 'Status', 'Varighet', 'Kostnad']);
    const row = rowOf(/^Rapportassistenten: Hva sier evalueringer/);
    expect(within(row).getByRole('link').getAttribute('href')).toBe('#/log/t1');
    expect(within(row).getByText('I dag kl. 10.41')).toBeTruthy();
    expect(within(row).getByText('Fullført')).toBeTruthy();
    expect(within(row).getByText('4,7 s')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Kunnskapsassistenten/ })).toBeNull();
    expectAccessible();
  });

  it('shows the cost of a run in kroner, not in øre', async () => {
    await renderAt('#/log');
    await table();

    expect(within(rowOf(/^Rapportassistenten/)).getByText('0,02 kr')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Kjøringer' }).textContent).not.toMatch(/\d øre/);
  });

  it('opens a failures link from Oversikt on the failed runs of that service on that day', async () => {
    const api = recording();
    await renderAt('#/log/runs?status=failed&service=klarsprak&date=2026-11-12', api.fetch);
    await waitFor(() =>
      expect(
        api
          .tasks()
          .some(
            (c) =>
              c.includes('service=klarsprak') &&
              c.includes('status=failed') &&
              c.includes('from=2026-11-11T23%3A00%3A00.000Z&to=2026-11-12T22%3A59%3A59.999Z'),
          ),
      ).toBe(true),
    );
    expect(((await screen.findByLabelText('Periode')) as HTMLSelectElement).value).toBe('custom');
  });

  it('sends the start and the end of the chosen period to the API', async () => {
    const api = recording();
    await renderAt('#/log', api.fetch);
    await table();
    expect(
      api
        .tasks()
        .some((c) =>
          c.includes('from=2026-11-16T23%3A00%3A00.000Z&to=2026-11-17T22%3A59%3A59.999Z'),
        ),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('Periode'), { target: { value: '7' } });
    await waitFor(() =>
      expect(
        api
          .tasks()
          .some((c) =>
            c.includes('from=2026-11-10T23%3A00%3A00.000Z&to=2026-11-17T22%3A59%3A59.999Z'),
          ),
      ).toBe(true),
    );

    fireEvent.change(screen.getByLabelText('Periode'), { target: { value: 'custom' } });
    fireEvent.change(await screen.findByLabelText('Fra og med'), {
      target: { value: '01.11.2026' },
    });
    fireEvent.change(screen.getByLabelText('Til og med'), { target: { value: '05.11.2026' } });
    await waitFor(() =>
      expect(
        api
          .tasks()
          .some((c) =>
            c.includes('from=2026-10-31T23%3A00%3A00.000Z&to=2026-11-05T22%3A59%3A59.999Z'),
          ),
      ).toBe(true),
    );
    expect(window.location.hash).toBe('#/log?period=custom&from=2026-11-01&to=2026-11-05');
  });

  it('picks a custom period in the calendar', async () => {
    await renderAt('#/log?period=custom&from=2026-11-10&to=2026-11-17');
    await table();

    fireEvent.click(screen.getByRole('button', { name: 'Velg i kalenderen' }));
    const calendar = screen.getByRole('dialog', { name: 'Velg periode i november 2026' });
    expect(
      within(calendar).getByRole('button', { name: '18. november, ikke tilgjengelig' }),
    ).toBeTruthy();
    fireEvent.click(within(calendar).getByRole('button', { name: '3. november' }));
    fireEvent.click(within(calendar).getByRole('button', { name: '9. november' }));

    await waitFor(() =>
      expect(window.location.hash).toBe('#/log?period=custom&from=2026-11-03&to=2026-11-09'),
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Fra og med') as HTMLInputElement).value).toBe('03.11.2026'),
    );
  });

  it('the Prøvekjøringer option lists only the runs from the playground and operation tries', async () => {
    const api = recording();
    await renderAt('#/log', api.fetch);
    await table();
    expect(
      within(screen.getByRole('table', { name: 'Kjøringer' })).queryByRole('link', {
        name: /^Prøveområdet/,
      }),
    ).toBeNull();

    fireEvent.change(screen.getByLabelText('Tjeneste'), { target: { value: 'trial' } });

    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Kjøringer' })).getAllByRole('link', {
          name: /^Prøveområdet: Hva er omsøkt beløp/,
        }),
      ).toHaveLength(1),
    );
    expect(screen.getByRole('link', { name: /^Byggeren: Hva er omsøkt beløp/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Rapportassistenten/ })).toBeNull();
    expect(api.tasks().some((c) => c.includes('origin=playground'))).toBe(true);
    expect(window.location.hash).toBe('#/log?service=trial');
  });

  it('groups the test runs below the table when all services are shown', async () => {
    await renderAt('#/log');
    await table();

    const trials = screen.getByText(/^Prøvekjøringer fra prøveområdet og byggeren: 2$/);
    const group = trials.closest('details') as HTMLElement;
    expect(within(group).getByText(/^Per Hansen i prøveområdet · /)).toBeTruthy();
    expect(within(group).getByText(/^Kari Nordmann i byggeren · /)).toBeTruthy();
    expect(
      within(group).getByRole('link', { name: 'Vis alle prøvekjøringene' }).getAttribute('href'),
    ).toBe('#/log?service=trial');
  });

  it('filters by status with the chips and keeps the choice in the address', async () => {
    const api = recording();
    await renderAt('#/log', api.fetch);
    await table();

    fireEvent.click(screen.getByRole('radio', { name: 'Feilet' }));

    await waitFor(() => expect(window.location.hash).toBe('#/log?status=failed'));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /^Rapportassistenten/ })).toBeNull(),
    );
    expect(api.tasks().some((c) => c.includes('status=failed'))).toBe(true);
    expect(screen.getByRole('link', { name: /^Nettsider på nynorsk/ })).toBeTruthy();
  });

  it('searches in the questions and keeps the search in the address', async () => {
    await renderAt('#/log');
    await table();

    fireEvent.change(screen.getByLabelText('Søk i spørsmål'), {
      target: { value: 'evalueringer' },
    });

    await waitFor(() => expect(window.location.hash).toBe('#/log?q=evalueringer'));
    expect(
      within(screen.getByRole('table', { name: 'Kjøringer' })).getAllByRole('link'),
    ).toHaveLength(1);
    expect(screen.getByText('Viser 1 av 5 kjøringer')).toBeTruthy();
  });

  it('says so when nothing matches and resets the filters', async () => {
    await renderAt('#/log?q=finnes-ikke&period=7');
    expect(
      await screen.findByRole('heading', { name: 'Ingen kjøringer passer filtrene' }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Nullstill filtrene' }));

    await waitFor(() => expect(window.location.hash).toBe('#/log'));
    expect(await table()).toBeTruthy();
    expect((screen.getByLabelText('Søk i spørsmål') as HTMLInputElement).value).toBe('');
  });

  it('shows an error with retry when the runs cannot be fetched', async () => {
    await renderAt('#/log', failingFetch(/\/tasks\?/));
    expect(
      await screen.findByRole('heading', { name: 'Vi fikk ikke hentet kjøringene' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
  });

  it('the run list marks erased runs with a tag', async () => {
    await renderAt('#/log?period=7');
    await table();

    expect(within(rowOf(/^Kunnskapsassistenten/)).getByText('Innhold slettet')).toBeTruthy();
    expect(within(rowOf(/^Vedtaksutkast/)).queryByText('Innhold slettet')).toBeNull();
  });

  it('a failed-runs link from Oversikt opens Logg filtered to failed runs', async () => {
    await renderAt('#/log?status=failed');
    await table();

    expect((screen.getByRole('radio', { name: 'Feilet' }) as HTMLInputElement).checked).toBe(true);
  });

  it('keeps the run filters in the address when switching to Endringer and back', async () => {
    await renderAt('#/log?status=failed&period=7');
    await table();

    fireEvent.click(tab('Endringer'));
    await waitFor(() => expect(window.location.hash).toBe('#/log/changes?status=failed&period=7'));
    await waitFor(() => expect(tab('Endringer').getAttribute('aria-selected')).toBe('true'));
    fireEvent.click(tab('Kjøringer'));
    await waitFor(() => expect(window.location.hash).toBe('#/log?status=failed&period=7'));

    expect(((await screen.findByLabelText('Periode')) as HTMLSelectElement).value).toBe('7');
  });
});

describe('opening a run', () => {
  it('keeps the filters in the address when a run is opened', async () => {
    await renderAt('#/log?status=failed&period=7');
    await table();

    fireEvent.click(screen.getByRole('link', { name: /^Nettsider på nynorsk/ }));

    await waitFor(() => expect(window.location.hash).toBe('#/log/t4?status=failed&period=7'));
    expect(
      (await screen.findByRole('link', { name: 'Kjøringer: feilet, siste 7 dager' })).getAttribute(
        'href',
      ),
    ).toBe('#/log?status=failed&period=7');
  });

  it('keeps the filters when going back to the list', async () => {
    await renderAt('#/log/t4?status=failed&period=7');
    fireEvent.click(await screen.findByRole('link', { name: 'Kjøringer: feilet, siste 7 dager' }));

    await waitFor(() => expect(window.location.hash).toBe('#/log?status=failed&period=7'));
    await table();
    expect((screen.getByRole('radio', { name: 'Feilet' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Periode') as HTMLSelectElement).value).toBe('7');
  });

  it('a reload of the list address restores every filter', async () => {
    const api = recording();
    await renderAt(
      '#/log?q=evalueringer&service=rapportassistenten&status=completed&period=30',
      api.fetch,
    );
    await table();

    expect((screen.getByLabelText('Søk i spørsmål') as HTMLInputElement).value).toBe(
      'evalueringer',
    );
    expect((screen.getByLabelText('Tjeneste') as HTMLSelectElement).value).toBe(
      'rapportassistenten',
    );
    expect((screen.getByRole('radio', { name: 'Fullført' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByLabelText('Periode') as HTMLSelectElement).value).toBe('30');
    expect(
      api
        .tasks()
        .some(
          (c) =>
            c.includes('status=completed') &&
            c.includes('service=rapportassistenten') &&
            c.includes('from=2026-10-18T22%3A00%3A00.000Z'),
        ),
    ).toBe(true);
  });

  it('a reload of a run address keeps the filters for the way back', async () => {
    await renderAt(
      '#/log/t1?service=rapportassistenten&period=custom&from=2026-11-01&to=2026-11-17',
    );

    expect(
      (
        await screen.findByRole('link', {
          name: 'Kjøringer: Rapportassistenten, 01.11.2026 til 17.11.2026',
        })
      ).getAttribute('href'),
    ).toBe('#/log?service=rapportassistenten&period=custom&from=2026-11-01&to=2026-11-17');
  });

  it('the run page shows the full question, the answer and its sources', async () => {
    await renderAt('#/log/t1');

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Rapportassistenten: Hva sier evalueringer om digital veiledning siden 2020?',
      }),
    ).toBeTruthy();
    const question = screen.getByRole('region', { name: 'Spørsmålet' });
    expect(question.textContent).toContain(
      'Hva sier evalueringer om digital veiledning siden 2020?',
    );
    const answer = screen.getByRole('region', { name: 'Svaret' });
    expect(answer.textContent).toContain('Evalueringene peker på tre ting:');
    const sources = within(answer)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(sources).toEqual([
      'Evaluering av digital veiledning i Testetaten (2023)',
      'Sluttrapport fra veiledningsprosjektet (2024)',
      'Kartlegging av brukerreiser i staten (2021)',
    ]);
    expect(screen.getByText('0,02 kr')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Rapportassistenten, versjon 7' }).getAttribute('href'),
    ).toBe('#/services/rapportassistenten');
    expect(screen.getByRole('link', { name: 'Åpne tjenesten' }).getAttribute('href')).toBe(
      '#/services/rapportassistenten',
    );
    expectAccessible();
  });

  it('a failed run shows its cause under the answer', async () => {
    await renderAt('#/log/t4');

    const answer = await screen.findByRole('region', { name: 'Svaret' });
    expect(within(answer).getByText('Kjøringen feilet')).toBeTruthy();
    expect(
      within(answer).getByText('Publiseringssystemet svarte ikke (503) ved side 13'),
    ).toBeTruthy();
  });

  it('offers Kopier sporings-id without a trace and copies the run id, saying why', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderAt('#/log/t1');

    fireEvent.click(await screen.findByRole('button', { name: 'Kopier sporings-id' }));

    expect(
      await screen.findByText(
        'Kjøringen har ingen egen sporings-id, så kjørings-id-en er kopiert. Søk etter den i sporingsverktøyet.',
      ),
    ).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('t1');
  });

  it('keeps the run id, tokens and model under a collapsed Teknisk', async () => {
    const base = mockFetch();
    await renderAt('#/log/t1', async (input, init) => {
      const response = await base(input, init);
      if (!/\/tasks\/t1\/timeline$/.test(String(input))) return response;
      return Response.json({
        ...((await response.json()) as object),
        stats: { byModel: [{ model: 'gpt-4o-mini' }] },
      });
    });

    const summary = await screen.findByText('Teknisk');
    const technical = summary.closest('details') as HTMLDetailsElement;
    expect(technical.open).toBe(false);
    expect(within(technical).getByText('t1')).toBeTruthy();
    expect(within(technical).getByText('4 120 inn, 350 ut')).toBeTruthy();
    expect(within(technical).getByText(/gpt-4o-mini/)).toBeTruthy();
  });

  it('says Ikke priset when the run has no price, not 0 kr', async () => {
    const base = mockFetch();
    await renderAt('#/log/t1', async (input, init) => {
      const response = await base(input, init);
      if (!/\/tasks\/t1$/.test(String(input))) return response;
      const row = (await response.json()) as { usage: object };
      return Response.json({ ...row, usage: { ...row.usage, costMicroNok: null } });
    });
    await steps();

    expect(screen.getByText('Ikke priset')).toBeTruthy();
    expect(screen.queryByText('0,00 kr')).toBeNull();
  });

  it('says when the run is not found', async () => {
    await renderAt('#/log/t1', failingFetch(/\/timeline$/, 404));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fant ikke kjøringen' }),
    ).toBeTruthy();
  });

  it('says when the run cannot be fetched and offers to try again', async () => {
    await renderAt('#/log/t1', failingFetch(/\/timeline$/, 503));
    expect(
      await screen.findByRole('heading', { name: 'Vi fikk ikke hentet kjøringen' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
  });

  it('an erased run says in an info note that its content was erased, when and why', async () => {
    await renderAt('#/log/t8');

    const note = await screen.findByRole('note', {
      name: 'Innholdet i denne kjøringen er slettet',
    });
    expect(note.textContent).toMatch(/Samtalen ble slettet \d+\. \p{L}+ \d{4} kl\. 18\.41\./u);
    expect(note.textContent).toContain('Bare status, tid, tokens og kostnad er tatt vare på.');
    expect(within(await steps()).getByText('Svaret er slettet')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Spørsmålet' })).toBeNull();
    expectAccessible();
  });

  it('says an erased run was removed after the retention period when that is why', async () => {
    const [first] = logTimelines;
    const kept = {
      ...(first as TaskTimeline),
      id: 'tr1',
      erasure: { reason: 'retention' as const },
    };
    await renderAt('#/log/tr1', mockFetch(undefined, [...logTimelines, kept]));

    const note = await screen.findByRole('note', {
      name: 'Innholdet i denne kjøringen er slettet',
    });
    expect(note.textContent).toContain('Slettet etter lagringstiden.');
  });

  it('collapsed steps open all at once', async () => {
    await renderAt('#/log/t1');
    const toggles = within(await steps()).getAllByRole('button', { expanded: false });
    expect(toggles).toHaveLength(9);
    fireEvent.click(screen.getByRole('button', { name: 'Åpne alle steg' }));
    expect(within(await steps()).getAllByRole('button', { expanded: true })).toHaveLength(9);
    expect(screen.getByRole('button', { name: 'Lukk alle steg' })).toBeTruthy();
  });

  it('t2: a waiting approval shows its details and no approve or reject the portal cannot send', async () => {
    await renderAt('#/log/t2');
    await steps();

    expect(
      screen.getByText(
        'Kjøringen venter på godkjenning. Portalen kan ikke godkjenne eller avvise ennå.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Godkjenn' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Avvis/ })).toBeNull();
    expect(screen.queryByLabelText('Kommentar')).toBeNull();
  });

  it('t3: shows extracted fields when the result step is opened', async () => {
    await renderAt('#/log/t3');
    const list = await steps();
    fireEvent.click(within(list).getByRole('button', { name: /Felter hentet ut/ }));
    expect(within(list).getByText('Elvebakken Musikkorps')).toBeTruthy();
  });

  it('t4: a failed run offers no Kjør på nytt, since nothing can start it again', async () => {
    await renderAt('#/log/t4');
    await steps();
    expect(screen.queryByRole('button', { name: 'Kjør på nytt' })).toBeNull();
  });

  it('t5: a batch run opens as a plain run, with no invented batch view or pseudonym reveal', async () => {
    await renderAt('#/log/t5');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Vis hvem' })).toBeNull();
    expect(screen.queryByText(/Langfuse \(Testetaten\)|utvalget på 25/)).toBeNull();
  });

  it('t6: a cancelled run shows dashed cancelled steps', async () => {
    await renderAt('#/log/t6');
    await steps();
    expect(screen.getAllByText('Avbrutt').length).toBeGreaterThan(1);
    expect(screen.getByText('Avbrutt av Ola Nordmann')).toBeTruthy();
  });

  it('t7: a loop item that was skipped, the partial loop and a retried step', async () => {
    await renderAt('#/log/t7');
    const list = await steps();
    const items = within(list).getAllByRole('listitem');
    const loop = items.find((li) => li.textContent?.includes('For hvert dokument')) as HTMLElement;
    expect(within(loop).getByText('Delvis')).toBeTruthy();
    const skipped = items.find((li) => li.textContent?.includes('Skogverket')) as HTMLElement;
    expect(skipped.className).toContain('depth-1');
    expect(within(skipped).getByText('Hoppet over')).toBeTruthy();
    expect(
      within(skipped).getByText('Hoppet over: skannet PDF uten tekst. Kunne ikke leses.'),
    ).toBeTruthy();
    expect(within(list).getByText('Fullført etter nytt forsøk')).toBeTruthy();
    expectAccessible();
  });
});

const playgroundRun: TaskTimeline = {
  id: 'tp1',
  service: 'platform/draft/playground/tp1',
  serviceName: 'Prøveområdet',
  status: 'completed',
  trigger: 'Prøveområde',
  caller: 'employee',
  startedAt: new Date().toISOString(),
  durationSeconds: 3.4,
  inputTokens: 4380,
  outputTokens: 410,
  costOre: 43,
  steps: [
    {
      id: 'tp1-1',
      type: 'search',
      title: 'Søk',
      summary: '«digital veiledning evaluering» · 14 treff',
      at: 0.2,
      blocks: [],
    },
    {
      id: 'tp1-2',
      type: 'searchnote',
      title: 'Søkemerknad',
      summary: '3 dokumenter hoppet over',
      at: 0.5,
      blocks: [
        {
          kind: 'list',
          label: 'Søkemotoren hoppet over',
          items: [
            ['Evaluering av veiledningstjenesten (2019).pdf', 'Skannet PDF uten tekst'],
            ['Brukerundersøkelse 2021 – vedlegg.xlsx', 'Filtypen kan ikke søkes i'],
            ['Notat om chatbot (2022)', 'Utenfor tilgangen til tjenesten'],
          ],
        },
      ],
    },
  ],
};

describe('search notes and links to a run', () => {
  it('the log opens a run from ?oppgave=', async () => {
    await renderAt('#/log?oppgave=t2');

    expect(await screen.findByRole('heading', { level: 1, name: /^Vedtaksutkast/ })).toBeTruthy();
  });

  it('opens a run started in the playground, without a link to a service', async () => {
    await renderAt('#/log?oppgave=tp7');

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Prøveområdet: Hva er omsøkt beløp i søknadene?',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Åpne tjenesten' })).toBeNull();
    const note = within(await steps()).getByRole('button', { name: /Søkemerknad/ });
    expect(within(note).getByText('3 dokumenter hoppet over')).toBeTruthy();
  });

  it('a searchnote step lists documents with their reason', async () => {
    await renderAt('#/log?oppgave=tp1', mockFetch(undefined, [...logTimelines, playgroundRun]));

    const note = within(await steps()).getByRole('button', { name: /Søkemerknad/ });
    expect(within(note).getByText('3 dokumenter hoppet over')).toBeTruthy();
    fireEvent.click(note);

    const body = document.getElementById(note.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(within(body).getByText('Søkemotoren hoppet over')).toBeTruthy();
    const items = within(body).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Evaluering av veiledningstjenesten (2019).pdf · Skannet PDF uten tekst',
      'Brukerundersøkelse 2021 – vedlegg.xlsx · Filtypen kan ikke søkes i',
      'Notat om chatbot (2022) · Utenfor tilgangen til tjenesten',
    ]);
    expect(within(note).queryByText(/Ukjent steg/)).toBeNull();
    expectAccessible();
  });
});

describe('Logg: Endringer', () => {
  it('the mock shows the live Endringer, read from the audit log, with area, person and Digdir filters', async () => {
    await renderAt('#/log/changes');
    const list = await screen.findByRole('list', { name: 'Endringer' });
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.getByRole('radio', { name: 'Alle' })).toBeTruthy();
    expect(screen.getByLabelText('Person')).toBeTruthy();
    expect(screen.getByRole('switch', { name: /Vis endringer fra Digdir/ })).toBeTruthy();
    expect(screen.queryByText(/Lise Dahl, Digdir, åpnet portalen/)).toBeNull();
    expectAccessible();
  });
});

const rewriting =
  (
    match: RegExp,
    change: (body: Record<string, unknown>, url: string) => unknown,
  ): typeof globalThis.fetch =>
  async (input, init) => {
    const response = await mockFetch()(input, init);
    const url = String(input);
    if (!match.test(url) || !response.ok) return response;
    return Response.json(change((await response.json()) as Record<string, unknown>, url));
  };

describe('Logg: the run crumb names the list it came from', () => {
  it('reads a 7d period in the address as the last 7 days, in the crumb and its link', async () => {
    await renderAt('#/log/t4?status=failed&period=7d');

    expect(
      (await screen.findByRole('link', { name: 'Kjøringer: feilet, siste 7 dager' })).getAttribute(
        'href',
      ),
    ).toBe('#/log?status=failed&period=7');
  });

  it('names a one-day address as that day, not as a range from the day to itself', async () => {
    await renderAt('#/log/t4?status=failed&date=2026-11-17');

    expect(await screen.findByRole('link', { name: 'Kjøringer: feilet, i dag' })).toBeTruthy();
  });
});

describe('Logg: tabs', () => {
  it('the Kjøringer and Endringer tabs are the shared link tabs, and the arrow keys move between them', async () => {
    await renderAt('#/log');
    await table();

    tab('Kjøringer').focus();
    fireEvent.keyDown(tab('Kjøringer'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Endringer'));
    fireEvent.keyDown(tab('Endringer'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Kjøringer'));
    fireEvent.keyDown(tab('Kjøringer'), { key: 'End' });
    expect(document.activeElement).toBe(tab('Endringer'));
  });
});

describe('Logg: run rows', () => {
  it('a failed run shows the reason it failed under its title', async () => {
    await renderAt(
      '#/log?status=failed&period=7',
      rewriting(/\/tasks\?/, (body) => ({
        ...body,
        data: (body.data as Record<string, unknown>[]).map((r) =>
          r.status === 'failed'
            ? {
                ...r,
                failure: { code: 'deadline_exceeded', reason: 'Modellen svarte ikke i tide.' },
              }
            : r,
        ),
      })),
    );

    const row = (await screen.findByRole('link', { name: /^Nettsider på nynorsk/ })).closest('tr');
    expect(within(row as HTMLElement).getByText('Modellen svarte ikke i tide.')).toBeTruthy();
  });

  it('with no runs at all, the list says so and points to the playground instead of the filters', async () => {
    await renderAt(
      '#/log',
      rewriting(/\/tasks(\?|$)/, () => ({ data: [], total: 0 })),
    );

    expect(await screen.findByRole('heading', { name: 'Ingen kjøringer ennå' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Åpne prøveområdet' }).getAttribute('href')).toBe(
      '#/playground',
    );
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('with no runs today but runs before, the list keeps its filters and says none match', async () => {
    await renderAt(
      '#/log',
      rewriting(/\/tasks(\?|$)/, (body, url) =>
        url.includes('from=') ? { data: [], total: 0 } : body,
      ),
    );

    expect(
      await screen.findByRole('heading', { name: 'Ingen kjøringer passer filtrene' }),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Ingen kjøringer ennå' })).toBeNull();
    expect(screen.getByRole('search')).toBeTruthy();
  });
});

describe('Logg: the run trace', () => {
  it('copies the trace id and links Langfuse when the timeline names a trace', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderAt(
      '#/log/t1',
      rewriting(/\/tasks\/t1\/timeline$/, (body) => ({
        ...body,
        trace: { id: '4f2a9c71e0b84d3a', url: 'https://langfuse.example/trace/4f2a9c71e0b84d3a' },
      })),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Kopier sporings-id' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('4f2a9c71e0b84d3a'));
    expect(await screen.findByText('Sporings-id-en er kopiert.')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Åpne i Langfuse (åpnes i ny fane)' }).getAttribute('href'),
    ).toBe('https://langfuse.example/trace/4f2a9c71e0b84d3a');
  });

  it('shows no Sporings-id under Teknisk while the timeline names no trace', async () => {
    await renderAt('#/log/t1');

    expect(await screen.findByRole('button', { name: 'Kopier sporings-id' })).toBeTruthy();
    expect(screen.queryByText('Sporings-id')).toBeNull();
  });
});

describe('Logg: no wasted calls', () => {
  it.each(['#/log/runs', '#/log/changes'])(
    'never asks for the tab name as a run when %s opens',
    async (hash) => {
      const urls: string[] = [];
      const base = mockFetch();
      const fetch: typeof globalThis.fetch = (input, init) => {
        urls.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        return base(input, init);
      };
      await renderAt(hash, fetch);
      await screen.findByRole('heading', { level: 1, name: 'Logg' });
      await new Promise((r) => setTimeout(r, 50));
      expect(urls.filter((u) => /\/tasks\/(runs|changes)(\/timeline)?$/.test(u))).toEqual([]);
    },
  );
});

describe('Logg: where a trial run comes from', () => {
  const nb = translator('nb');
  const en = translator('en');

  it('names a trial run from the builder, origin trial, as the builder in nb and en', () => {
    const row = { capability: 'platform/draft/trial/t9' };
    expect(trialLabel(row, nb)).toBe('Byggeren');
    expect(trialPlace(row, nb)).toBe('i byggeren');
    expect(trialLabel(row, en)).toBe('Builder');
    expect(trialPlace(row, en)).toBe('in the builder');
  });
});
