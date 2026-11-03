// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { logTimelines } from '../data/log';
import { mockFetch } from '../mock';
import type { TaskTimeline } from '../types';
import { expectAccessible, failingFetch, kari, renderAt } from '../test-utils';

const steps = () => screen.findByRole('list', { name: 'Steg i kjøringen' });

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Logg: Kjøringer', () => {
  it('lists recent runs from the API with service, status and trigger and opens the first', async () => {
    await renderAt('#/log');

    expect(await screen.findByRole('heading', { level: 1, name: 'Logg' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Kjøringer' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const list = await screen.findByRole('region', { name: 'Siste kjøringer' });
    const vedtak = within(list).getByRole('link', { name: /Vedtaksutkast/ });
    expect(vedtak.getAttribute('href')).toBe('#/log/t2');
    expect(within(vedtak).getByText('Venter på godkjenning')).toBeTruthy();
    expect(within(vedtak).getByText('Fra fagsystem')).toBeTruthy();
    expect(
      within(list)
        .getByRole('link', { name: /Rapportassistenten/ })
        .getAttribute('aria-current'),
    ).toBe('true');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Rapportassistenten' }),
    ).toBeTruthy();
    await steps();
    expectAccessible();
  });

  it('offers no trigger filter in live mode, where runs carry no trigger', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/log';
    render(<App auth={auth} fetch={mockFetch()} live />);
    await screen.findByRole('heading', { level: 1, name: 'Logg' });
    expect(screen.getByRole('tablist', { name: 'Logg' })).toBeTruthy();
    expect(screen.queryByLabelText('Utløser')).toBeNull();
  });

  it('searches by service through the API and shows the first hit', async () => {
    const calls: string[] = [];
    const base = mockFetch();
    await renderAt('#/log', async (input, init) => {
      calls.push(String(input));
      return base(input, init);
    });
    await screen.findByRole('region', { name: 'Siste kjøringer' });

    fireEvent.change(screen.getByLabelText('Tjeneste'), { target: { value: 'nettsider-nynorsk' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Søk' }));

    expect(
      (await screen.findByText('1 kjøring passer. Viser den første.')).getAttribute('role'),
    ).toBe('status');
    expect(
      calls.some((c) => c.includes('status=failed') && c.includes('service=nettsider-nynorsk')),
    ).toBe(true);
    await waitFor(() => expect(window.location.hash).toBe('#/log/t4'));
  });

  const withTotal = (total: number): typeof fetch => {
    const base = mockFetch();
    return async (input, init) => {
      const response = await base(input, init);
      if (!/\/tasks(\?|$)/.test(String(input))) return response;
      const body = (await response.json()) as { data: unknown[] };
      return new Response(JSON.stringify({ ...body, total }), {
        headers: { 'content-type': 'application/json' },
      });
    };
  };

  it('the match count is the total the API reports, not the length of the page', async () => {
    await renderAt('#/log', withTotal(480));
    await screen.findByRole('region', { name: 'Siste kjøringer' });
    fireEvent.click(screen.getByRole('button', { name: 'Søk' }));
    expect(await screen.findByText('480 kjøringer passer. Viser den første.')).toBeTruthy();
  });

  it('a text search over a cut-off page says at least, not an exact count', async () => {
    await renderAt('#/log', withTotal(480));
    await screen.findByRole('region', { name: 'Siste kjøringer' });
    fireEvent.change(screen.getByLabelText('Kjørings-ID eller tjeneste'), {
      target: { value: 'Rapportassistenten' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Søk' }));
    expect(
      await screen.findByText(
        /^Minst \d+ kjøring(er)? passer blant de \d+ siste\. Viser den første\.$/,
      ),
    ).toBeTruthy();
  });

  it('says so when nothing matches the search', async () => {
    await renderAt('#/log');
    await screen.findByRole('region', { name: 'Siste kjøringer' });

    fireEvent.change(screen.getByLabelText('Kjørings-ID eller tjeneste'), {
      target: { value: 'finnes-ikke' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Søk' }));

    expect(await screen.findByText(/Ingen kjøringer passer søket/)).toBeTruthy();
  });

  it('shows an error with retry when the runs cannot be fetched', async () => {
    await renderAt('#/log', failingFetch(/\/tasks(\?|$)/));
    expect(await screen.findByText('Kunne ikke hente dataene')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
  });
});

describe('run timeline', () => {
  it('t1: header facts, pseudonym, trace lines and collapsed steps that open all at once', async () => {
    await renderAt('#/log/t1');
    await steps();

    expect(screen.getByText('Chat · Ansatt i Testetaten (A-4K7Q) · I dag kl. 10.41')).toBeTruthy();
    expect(screen.getByText('4,7 s')).toBeTruthy();
    expect(screen.getByText('4 470')).toBeTruthy();
    expect(screen.getByText('4 120 inn, 350 ut')).toBeTruthy();
    expect(screen.getByText('2,1 øre')).toBeTruthy();
    const traces = screen.getByRole('list', { name: 'Sporing i eksterne verktøy' });
    expect(
      within(traces).getByText('Sendt til Langfuse (Testetaten), fullt innhold, maskert.'),
    ).toBeTruthy();
    expect(within(traces).getByRole('link', { name: 'Åpne i Langfuse' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('Per Hansen');

    const toggles = within(await steps()).getAllByRole('button', { expanded: false });
    expect(toggles).toHaveLength(9);
    fireEvent.click(screen.getByRole('button', { name: 'Åpne alle steg' }));
    expect(within(await steps()).getAllByRole('button', { expanded: true })).toHaveLength(9);
    expect(
      screen.getByText('«Hva sier evalueringer om digital veiledning siden 2020?»'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Lukk alle steg' })).toBeTruthy();
    expectAccessible();
  });

  it('says Ikke priset when the run has no price, not 0 øre', async () => {
    const base = mockFetch();
    await renderAt('#/log/t1', async (input, init) => {
      const response = await base(input, init);
      if (!/\/tasks\/t1\/timeline$/.test(String(input))) return response;
      return Response.json({ ...((await response.json()) as object), costOre: null });
    });
    await steps();

    expect(screen.getByText('Ikke priset')).toBeTruthy();
    expect(screen.queryByText(/0 øre/)).toBeNull();
  });

  it('shows a cost below one øre from the run in micro-NOK', async () => {
    const base = mockFetch();
    await renderAt('#/log/t1', async (input, init) => {
      const response = await base(input, init);
      if (!/\/tasks\/t1\/timeline$/.test(String(input))) return response;
      return Response.json({
        ...((await response.json()) as object),
        costOre: 0,
        costMicroNok: 714,
      });
    });
    await steps();

    expect(screen.getByText('0,1 øre')).toBeTruthy();
  });

  it('Vis hvem requires a reason, shows a notice and adds an entry under Endringer', async () => {
    await renderAt('#/log/t1');
    await steps();

    fireEvent.click(screen.getByRole('button', { name: 'Vis hvem' }));
    const confirm = screen.getAllByRole('button', { name: 'Vis hvem' })[0] as HTMLElement;
    fireEvent.click(confirm);
    expect(screen.getByText('Velg en grunn.')).toBeTruthy();
    expect(screen.getByLabelText('Grunn').getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(screen.getByLabelText('Grunn'), { target: { value: 'Sikkerhetshendelse' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Vis hvem' })[0] as HTMLElement);
    expect(
      screen.getByText(
        'A-4K7Q er Per Hansen. Grunn: Sikkerhetshendelse. Visningen er logget, og Per Hansen ser den i sin egen logg.',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Endringer' }));
    await waitFor(() => expect(window.location.hash).toBe('#/log?tab=changes'));
    const changes = await screen.findByRole('list', { name: 'Endringer' });
    expect(within(changes).getByText(/Viste hvem A-4K7Q er i kjøringen t1/)).toBeTruthy();
    expect(within(changes).getByText(/«Sikkerhetshendelse»/)).toBeTruthy();
  });

  it('t2: approval opens by default, needs a comment to reject and stays named', async () => {
    await renderAt('#/log/t2');
    await steps();

    expect(
      screen.getByText(
        'Godkjenninger vises alltid med navn. Det er ansvar for beslutninger, ikke overvåking.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Ukjent steg: testetaten.risikoscore')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Avvis/ }));
    expect(screen.getByText('Skriv hvorfor du avviser utkastet.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Kommentar'), { target: { value: 'Feil beløp' } });
    fireEvent.click(screen.getByRole('button', { name: /Avvis/ }));

    expect(
      screen.getByText('Utkastet er avvist. Ingenting er sendt til saksbehandlingssystemet.'),
    ).toBeTruthy();
    expect(screen.getByText('Avvist av Kari Nordmann: «Feil beløp»')).toBeTruthy();
    expect(screen.getByText('Ikke levert')).toBeTruthy();
    const list = screen.getByRole('region', { name: 'Siste kjøringer' });
    expect(
      within(within(list).getByRole('link', { name: /Vedtaksutkast/ })).getByText('Avbrutt'),
    ).toBeTruthy();
  });

  it('t2: approving delivers the draft', async () => {
    await renderAt('#/log/t2');
    await steps();
    fireEvent.click(screen.getByRole('button', { name: 'Godkjenn' }));
    expect(screen.getByText('Utkastet er godkjent og levert til sak 2026/1432.')).toBeTruthy();
    expect(screen.getByText('Levert til saksbehandlingssystemet')).toBeTruthy();
    expect(screen.getByText('41 min 21 s')).toBeTruthy();
  });

  it('t3: shows extracted fields when the result step is opened', async () => {
    await renderAt('#/log/t3');
    const list = await steps();
    fireEvent.click(within(list).getByRole('button', { name: /Felter hentet ut/ }));
    expect(screen.getByText('Elvebakken Musikkorps')).toBeTruthy();
  });

  it('t4: a failed run can be started again', async () => {
    await renderAt('#/log/t4');
    await steps();
    expect(
      screen.getByText(
        'Ikke sendt til Langfuse: tjenesten er ikke valgt under Sporing og evaluering.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Kjør på nytt' }));
    expect(screen.getByText('Kjøringen er startet på nytt.')).toBeTruthy();
    expect(screen.getByText('Pågår')).toBeTruthy();
  });

  it('t5: batch view with a 10 % live region, progressbar, filters and item timelines', async () => {
    await renderAt('#/log/t5');
    const bar = await screen.findByRole('progressbar', { name: 'Fremdrift for jobben' });
    expect(bar.getAttribute('aria-valuetext')).toMatch(/av 214 ferdig/);
    expect(screen.getByText('Omtrent 60 % ferdig').getAttribute('role')).toBe('status');
    expect(screen.getByText('Viser 12 av 214')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /Feilet/ }));
    expect(
      screen.getAllByText(/Filen er passordbeskyttet/, { selector: '.meta' }).length,
    ).toBeGreaterThan(0);
    const open = screen.getAllByRole('link', {
      name: /Åpne tidslinjen for Høringssvar_017.pdf/,
    })[0];
    expect(open?.getAttribute('href')).toBe('#/log/t5/17');

    fireEvent.click(screen.getByRole('button', { name: 'Avbryt jobben' }));
    expect(screen.getByText(/Jobben er avbrutt\./)).toBeTruthy();
    expectAccessible();
  });

  it('t5: a batch item has its own timeline with a breadcrumb back', async () => {
    await renderAt('#/log/t5/17');
    const crumbs = await screen.findByRole('navigation', { name: 'Brødsmuler' });
    expect(
      within(crumbs).getByRole('link', { name: 'Høringsoppsummering' }).getAttribute('href'),
    ).toBe('#/log/t5');
    expect(screen.getByText('Kunne ikke lese filen')).toBeTruthy();
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
    expect(screen.getByText('Fullført med 1 hoppet over')).toBeTruthy();
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

  it('shows an error when the timeline cannot be fetched', async () => {
    await renderAt('#/log/t1', failingFetch(/\/timeline$/, 404));
    expect(await screen.findByText('Vi fant ikke det du lette etter.')).toBeTruthy();
  });
});

const playgroundRun: TaskTimeline = {
  id: 'tp1',
  service: 'rapportassistenten',
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

    expect(await screen.findByRole('heading', { level: 2, name: 'Vedtaksutkast' })).toBeTruthy();
    const list = await screen.findByRole('region', { name: 'Siste kjøringer' });
    expect(
      within(list)
        .getByRole('link', { name: /Vedtaksutkast/ })
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  it('opens a run started in the playground in example mode', async () => {
    await renderAt('#/log?oppgave=tp7');

    expect(await screen.findByRole('heading', { level: 2, name: 'Prøveområdet' })).toBeTruthy();
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
  it('filters changes by type and shows an empty state', async () => {
    await renderAt('#/log?tab=changes');
    const list = await screen.findByRole('list', { name: 'Endringer' });
    expect(within(list).getByText(/Lise Dahl, Digdir, åpnet portalen/)).toBeTruthy();
    expect(within(list).getByText(/kan endre på vegne av Testetaten/)).toBeTruthy();
    expect(within(list).getByText(/Under støttetilgang kl\. 10\.41–11\.11/)).toBeTruthy();
    expect(within(list).queryByText(/bare lesing/)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Publisering' }));
    expect(
      within(screen.getByRole('list', { name: 'Endringer' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    expectAccessible();
  });
});
