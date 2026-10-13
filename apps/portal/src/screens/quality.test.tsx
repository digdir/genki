// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../mock';
import { expectAccessible, failingFetch, renderAt } from '../test-utils';

const base = '#/services/rapportassistenten/quality';

const open = async (tab = '', fetch?: typeof globalThis.fetch) => {
  await renderAt(`${base}${tab}`, fetch);
  await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
  await screen.findByRole('tablist', { name: 'Kvalitet' });
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const scrollRegion = (name: string) =>
  screen
    .getAllByRole('region', { name })
    .find((el) => el.getAttribute('tabindex') === '0') as HTMLElement;

describe('quality header and tabs', () => {
  it('shows the five tabs with badges inside the service page', async () => {
    await open();

    const nav = screen.getByRole('navigation', { name: 'Tjenesten' });
    expect(within(nav).getByRole('link', { name: 'Kvalitet' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.queryByRole('navigation', { name: 'Brødsmuler' })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual([
      'Testsett',
      'Tilbakemeldinger, 7 nye',
      'Forbedringsforslag, 3 nye',
      'Publiser',
      'Slik ser brukerne det',
    ]);
    expect(screen.getByRole('tab', { name: 'Testsett' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expectAccessible();
  });

  it('shows an error with retry when the service cannot be loaded', async () => {
    await renderAt(base, failingFetch(/definitions\/services/));
    expect(await screen.findByText('Kunne ikke hente dataene')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
  });

  it('follows the risiko override to high risk', async () => {
    await open('?tab=proposals&risk=hoy');
    expect(screen.getByText(/to personer må godkjenne/)).toBeTruthy();
  });
});

describe('Testsett', () => {
  it('shows counts, emne heatmap with drops, runs with kodeversjon and the case list', async () => {
    await open();

    const counts = screen
      .getByText('Testtilfeller', { selector: 'dt' })
      .closest('dl') as HTMLElement;
    expect(within(counts).getByText('8')).toBeTruthy();
    const heat = scrollRegion('Poeng per emne');
    expect(within(heat).getByRole('rowheader', { name: 'Tall og statistikk' })).toBeTruthy();
    expect(within(heat).getAllByText(/^Ned 0,\d\d$/).length).toBeGreaterThan(0);
    const runs = scrollRegion('Siste kjøringer av testsettet');
    expect(within(runs).getByRole('columnheader', { name: 'Versjon og kodeversjon' })).toBeTruthy();
    expect(within(runs).getByText('v8-utkast · c41e7a9')).toBeTruthy();
    expect(within(runs).getAllByText('Ny modell')).toHaveLength(1);
    expect(runs.getAttribute('tabindex')).toBe('0');

    const open14 = screen.getByRole('button', { name: /T-014/ });
    expect(open14.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Brukte årsrapporten for 2023.')).toBeTruthy();
    expect(
      screen.getByText('Kva seier evalueringane om ventetid på telefon?').getAttribute('lang'),
    ).toBe('nn');
  });

  it('filters cases by split and result', async () => {
    await open();
    fireEvent.click(screen.getByRole('radio', { name: 'Ikke bestått' }));
    expect(screen.getAllByRole('button', { name: /^T-\d+/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('radio', { name: 'Låst' }));
    expect(screen.getByText('Ingen testtilfeller passer med filtrene.')).toBeTruthy();
  });

  it('validates and adds a testtilfelle by hand', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Nytt testtilfelle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lagre testtilfelle' }));
    expect(screen.getByText('Skriv inputen tjenesten skal få.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'Hva koster tilsyn?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre testtilfelle' }));
    expect(await screen.findByText('T-149 er lagt til i validering.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /T-149/ })).toBeTruthy();
  });

  it('imports a spreadsheet and shows rejected rows', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Importer regneark' }));
    expect(screen.queryByRole('link', { name: 'Last ned mal' })).toBeNull();
    expect(screen.getByText('Ikke bestemt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bruk eksempelfil' }));
    expect(screen.getByText(/Rad 7: mangler forventet resultat/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til 22 testtilfeller' }));
    expect(screen.getByText(/22 testtilfeller er lagt til/)).toBeTruthy();
  });

  it('adds from a run id and rejects unknown ids', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til fra en kjøring' }));
    fireEvent.change(screen.getByLabelText('ID for kjøringen'), { target: { value: 'feil' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hent' }));
    expect(screen.getByText(/Fant ingen kjøring med den ID-en/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('ID for kjøringen'), { target: { value: 'opg_5b2c' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hent' }));
    expect((screen.getByLabelText('Input') as HTMLTextAreaElement).value).toBe(
      'Hvor mange tilsyn hadde vi i fjor?',
    );
  });

  it('runs the test set and blocks a second run with aria-disabled', async () => {
    await open();
    const run = screen.getByRole('button', { name: 'Kjør testsettet nå' });
    fireEvent.click(run);
    expect(run.getAttribute('aria-disabled')).toBe('true');
    expect(
      await screen.findByText(/Resultatet er lagt øverst/, {}, { timeout: 3000 }),
    ).toBeTruthy();
  });

  it('shows an empty state when the service has no test cases', async () => {
    await renderAt(
      base,
      mockFetch(undefined, undefined, undefined, undefined, { testSets: [], runs: [] }),
    );
    expect(await screen.findByText('Ingen testtilfeller ennå')).toBeTruthy();
  });

  it('says the test set has not run instead of showing empty tables', async () => {
    await renderAt(base, mockFetch(undefined, undefined, undefined, undefined, { runs: [] }));

    await screen.findByRole('tablist', { name: 'Kvalitet' });
    expect(screen.getAllByText('Testsettet er ikke kjørt ennå.')).toHaveLength(2);
    expect(document.querySelector('.runs-table')).toBeNull();
    expect(document.querySelector('.heat-table')).toBeNull();
    expect(screen.getByRole('button', { name: 'Kjør testsettet nå' })).toBeTruthy();
  });
});

describe('Tilbakemeldinger', () => {
  it('protects employees: privacy notice, small clusters hidden, additions underlined', async () => {
    await open('?tab=fb');

    expect(screen.getByText(/gjelder tjenesten, ikke den enkelte ansatte/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Bruker gamle tall' })).toBeTruthy();
    expect(screen.getAllByText('For få til å vise.').length).toBe(3);
    expect(screen.queryByText('Vedtaksutkast, sak 2026/1432')).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: 'Grupper like' }));
    expect(screen.getAllByText('For få til å vise.')).toHaveLength(1);
    expect(screen.getAllByText(/Kjøring opg_/)).toHaveLength(5);
    expectAccessible();
  });

  it('links a cluster to its proposal', async () => {
    await open('?tab=fb');
    fireEvent.click(screen.getByRole('button', { name: 'Se forbedringsforslaget' }));
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Bruk nyeste rapport når spørsmålet gjelder et bestemt år',
      }),
    ).toBeTruthy();
  });

  it('makes an anonymised testtilfelle in three steps', async () => {
    await open('?tab=fb');
    fireEvent.click(screen.getAllByRole('button', { name: 'Lag testtilfelle' })[0] as HTMLElement);

    expect(screen.getByText('Anonymiser').closest('li')?.getAttribute('aria-current')).toBe('step');
    fireEvent.click(screen.getByRole('checkbox', { name: '«Ola Nordmann» med [NAVN]' }));
    expect(screen.getByText(/1 personopplysning blir stående/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '«Ola Nordmann» med [NAVN]' }));
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));

    fireEvent.change(screen.getByLabelText('Et godt resultat'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(screen.getByText('Beskriv hva et godt resultat er.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Et godt resultat'), {
      target: { value: 'Oppgir tall for 2025.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));

    fireEvent.click(screen.getByRole('radio', { name: /Låst/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Legg til testtilfelle' }));
    expect(
      screen.getByText(/T-149 er lagt til i låst. Personopplysningene er fjernet./),
    ).toBeTruthy();
    expect(screen.getByText('Lagt til som T-149')).toBeTruthy();
  });
});

describe('Forbedringsforslag', () => {
  it('shows the diff with words, scores with uncertainty and the locked set', async () => {
    await open('?tab=proposals');

    expect(screen.getByText(/Ingenting endres før noen godkjenner/)).toBeTruthy();
    const instr = screen.getByRole('list', { name: 'Endringer i instruksjoner' });
    expect(within(instr).getAllByText('Legges til')).toHaveLength(2);
    expect(within(instr).getByText('Fjernes')).toBeTruthy();
    expect(within(instr).getByText('Uendret')).toBeTruthy();
    expect(screen.getByText('0,66 → 0,79 (±0,05)')).toBeTruthy();
    expect(screen.getByText('Bedre, mer enn usikkerheten')).toBeTruthy();
    expect(screen.getByText('0,79 → 0,82 (±0,03)')).toBeTruthy();
    expect(
      screen
        .getByText('Ventetida var 4 minutt i snitt (Årsrapport 2025, s. 21).')
        .getAttribute('lang'),
    ).toBe('nn');
    expectAccessible();
  });

  it('requires a comment to reject and approves with one person for limited risk', async () => {
    await open('?tab=proposals');
    fireEvent.click(screen.getByRole('button', { name: 'Avvis' }));
    expect(screen.getByText('Skriv hvorfor du avviser forslaget.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Godkjenn' }));
    expect(screen.getByText('Forslaget er godkjent. Versjon 8 ligger i test.')).toBeTruthy();
    expect(screen.getByText(/Godkjent av Kari Nordmann/)).toBeTruthy();
  });

  it('needs two different approvers for high risk', async () => {
    await open('?tab=proposals&risk=hoy');
    fireEvent.click(screen.getByRole('button', { name: 'Godkjenn' }));
    expect(screen.getByText('Godkjenninger: 1 av 2')).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Godkjenn' });
    expect(approve.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/Den andre godkjenningen må komme fra en annen person/)).toBeTruthy();
    fireEvent.click(approve);
    expect(screen.getByText('Godkjenninger: 1 av 2')).toBeTruthy();
  });
});

describe('Publiser', () => {
  it('blocks Publiser on a failed gate but keeps it focusable, and offers the updates', async () => {
    await open('?tab=pub');

    expect(screen.getByRole('heading', { name: 'Oppdatering tilgjengelig' })).toBeTruthy();
    expect(screen.getByText('Borealis-27B 2.1 → 2.2')).toBeTruthy();
    expect(screen.getByText('digdir.klarsprak@2.3 → @2.4')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Versjon 8 i test, endret siden versjon 7' }),
    ).toBeTruthy();
    expect(screen.getByText('Kan ikke publiseres ennå')).toBeTruthy();
    const publish = screen.getAllByRole('button', { name: 'Publiser' }).at(-1) as HTMLElement;
    expect(publish.getAttribute('aria-disabled')).toBe('true');
    expect(publish.hasAttribute('disabled')).toBe(false);
    fireEvent.click(publish);
    expect(
      screen.getByText(/Publiser er låst fordi et kvalitetskrav ikke er oppfylt/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Publiser til test' }).at(-1) as HTMLElement,
    );
    expect(await screen.findByText(/publisert til test/)).toBeTruthy();
    expectAccessible();
  });

  it('fixes the gate, requires a reason and publishes through the API', async () => {
    const calls: { path: string; reason: string | null }[] = [];
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === 'POST')
        calls.push({
          path: new URL(url, 'http://x').pathname,
          reason: decodeURIComponent(new Headers(init.headers).get('change-reason') ?? ''),
        });
      return base(input, init);
    };
    await open('?tab=pub', fetch);

    fireEvent.click(
      screen.getByRole('button', { name: 'Legg til linjen om målform og kjør på nytt' }),
    );
    expect(
      await screen.findByText(/Alle kvalitetskrav er bestått/, {}, { timeout: 3000 }),
    ).toBeTruthy();
    const publish = screen.getAllByRole('button', { name: 'Publiser' }).at(-1) as HTMLElement;
    expect(publish.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Ta med i v8: Borealis/ }));
    expect(screen.getByText('Oppdatering fra Digdir: Borealis-27B 2.1 → 2.2')).toBeTruthy();

    fireEvent.click(publish);
    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Hva er endret, og hvorfor?'), {
      target: { value: 'Nyeste rapport og målform' },
    });
    fireEvent.click(publish);
    await waitFor(() => expect(screen.getByText(/Versjon 8 er publisert og i bruk/)).toBeTruthy());
    expect(calls).toEqual([{ path: '/api/definitions', reason: 'Nyeste rapport og målform' }]);
  });

  it('opens the API call side panel', async () => {
    await open('?tab=pub');
    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));
    const panel = screen.getByRole('dialog', { name: 'Publiser versjon 8' });
    expect(within(panel).getByText('/definitions')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Lukk' }));
    expect(screen.queryByRole('dialog', { name: 'Publiser versjon 8' })).toBeNull();
  });
});

describe('Slik ser brukerne det', () => {
  it('uses aria-pressed, optional reasons and a status message that names the service', async () => {
    await open('?tab=chat');
    const no = screen.getByRole('button', { name: 'Nei' });
    fireEvent.click(no);
    expect(no.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Ja' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Utdatert' }));
    const comment = screen.getByLabelText('Kommentar (valgfritt)');
    expect(comment.getAttribute('maxlength')).toBe('300');
    fireEvent.change(comment, { target: { value: 'Gammelt tall' } });
    expect(screen.getByText('12 av 300 tegn. Ikke skriv personopplysninger.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('status').textContent).toMatch(/lagres for tjenesten, ikke for deg/);
    expect(no.getAttribute('aria-disabled')).toBe('true');
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill eksempelet' }));
    expect(screen.getByRole('button', { name: 'Nei' }).getAttribute('aria-pressed')).toBe('false');
  });
});
