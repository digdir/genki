// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../mock';
import { expectAccessible, failingFetch, renderAt } from '../test-utils';

interface Call {
  url: string;
  method: string;
  reason: string | null;
  body: unknown;
}

const recording = (base: typeof fetch = mockFetch()) => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      reason: decodeURIComponent(new Headers(init?.headers).get('change-reason') ?? ''),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return base(input, init);
  };
  return { calls, fetch };
};

const grid = () => screen.findByRole('region', { name: 'Innstillinger per lag' });
const panel = () => screen.getByRole('dialog');
const open = async (label: string) => {
  fireEvent.click(within(await grid()).getByRole('button', { name: label }));
  return panel();
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Innstillinger for virksomheten', () => {
  it('shows the layered grid built from the settings catalog', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/settings', fetch);

    const region = await grid();
    expect(calls.some((c) => c.url.endsWith('/settings') && c.method === 'GET')).toBe(true);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Innstillinger for Testetaten' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Det dere setter her, gjelder alle tjenester og datasett i Testetaten som ikke har satt noe selv.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Tjeneste')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Innstillinger' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    const heads = within(region)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(heads).toEqual([
      'Innstilling',
      'PlattformstandardDigdir',
      'VirksomhetTestetaten',
      'Gjelder',
    ]);
    for (const cat of ['Søk', 'Svar', 'Modell', 'Vern', 'Innlesing', 'Grenser'])
      expect(
        within(region).getByRole('rowheader', { name: new RegExp(`^${cat} \\(\\d+\\)$`) }),
      ).toBeTruthy();

    const topK = within(region)
      .getByRole('button', { name: 'Antall treff som leses' })
      .closest('tr') as HTMLElement;
    expect(within(topK).getByText('retrieval.topK')).toBeTruthy();
    expect(within(topK).getByText('Arvet fra plattformstandard')).toBeTruthy();
    expect(within(topK).getAllByText('10 treff').length).toBeGreaterThan(0);

    const language = within(region)
      .getByRole('button', { name: 'Svarspråk' })
      .closest('tr') as HTMLElement;
    expect(within(language).getByText('Kan ikke settes')).toBeTruthy();

    expect(
      within(region).getByRole('button', { name: 'Fjern personopplysninger før modellkall' }),
    ).toBeTruthy();
    expect(
      within(region).getByRole('button', { name: 'Hold personopplysninger utenfor loggen' }),
    ).toBeTruthy();
    expectAccessible();
  });

  it('filters by search, category and overridden values', async () => {
    await renderAt('#/settings');
    await grid();
    const total = /Viser (\d+) av (\d+) innstillinger/.exec(document.body.textContent ?? '');
    expect(total?.[1]).toBe(total?.[2]);

    fireEvent.change(screen.getByLabelText('Søk i innstillinger'), {
      target: { value: 'personopplysninger' },
    });
    expect(screen.getByText(/^Viser 2 av \d+ innstillinger$/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Søk i innstillinger'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Innlesing' }));
    expect(screen.getByText(/^Viser 3 av \d+ innstillinger$/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole('switch', { name: 'Bare de som er satt her eller overstyrt' }),
    );
    expect(screen.getByText(/^Viser 1 av \d+ innstillinger$/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tekstgjenkjenning' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Søk i innstillinger'), {
      target: { value: 'finnes ikke' },
    });
    expect(screen.getByText(/Ingen innstillinger passer søket/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill' }));
    expect(screen.getByText(total?.[0] ?? '')).toBeTruthy();
  });

  it('previews a tenant value through the API and saves it with a reason', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/settings', fetch);
    const side = await open('Antall treff som leses');

    expect(
      within(side).getByRole('heading', { level: 2, name: 'Antall treff som leses' }),
    ).toBeTruthy();
    expect(within(side).getByText('Redigerer: Virksomhet (Testetaten)')).toBeTruthy();
    expect(within(side).queryByText(/Legges i utkastet/)).toBeNull();

    const input = within(side).getByLabelText('Verdi (treff)');
    fireEvent.change(input, { target: { value: 'mange' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    expect(within(side).getByText('Skriv et tall.')).toBeTruthy();
    fireEvent.change(input, { target: { value: '60' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    expect(within(side).getByText('Må være mellom 1 og 50.')).toBeTruthy();

    fireEvent.change(input, { target: { value: '15' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    const preview = await within(side).findByRole('region', { name: 'Forhåndsvisning' });
    const dry = calls.find((c) => c.url.endsWith('/settings/retrieval.topK?dryRun=true'));
    expect(dry).toMatchObject({ method: 'PUT', body: { value: 15 } });
    expect(within(preview).getByText('klarsprak (v2)')).toBeTruthy();
    expect(within(preview).getByText('rapportassistenten (v6): 20')).toBeTruthy();
    expect(within(preview).getByText('15 treff')).toBeTruthy();

    fireEvent.click(within(preview).getByRole('button', { name: 'Lagre' }));
    expect(within(preview).getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(within(preview).getByLabelText('Begrunnelse'), {
      target: { value: 'Flere treff gir bedre svar' },
    });
    fireEvent.click(within(preview).getByRole('button', { name: 'Lagre' }));

    expect(
      await screen.findByText('Antall treff som leses er lagret (15 treff). Endringen er logget.'),
    ).toBeTruthy();
    const saved = calls.filter(
      (c) => c.url.endsWith('/settings/retrieval.topK') && c.method === 'PUT',
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ reason: 'Flere treff gir bedre svar', body: { value: 15 } });
    const log = within(panel()).getByRole('region', { name: 'Endringer her' });
    expect(within(log).getByText('«Flere treff gir bedre svar»')).toBeTruthy();
    expectAccessible();
  });

  it('the mock answers a real save like the API, and a dry run with the preview', async () => {
    const fetch = mockFetch();
    const put = (query: string) =>
      fetch(`/tenants/999888777/settings/retrieval.topK${query}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'change-reason': 'Flere treff gir bedre svar',
        },
        body: JSON.stringify({ value: 15 }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>);

    expect(await put('')).toEqual({ task: 'mock', value: 15 });
    expect(await put('?dryRun=true')).toMatchObject({ dryRun: true });
  });

  it('shows the API call for a tenant change', async () => {
    await renderAt('#/settings');
    const side = await open('Antall treff som leses');
    fireEvent.change(within(side).getByLabelText('Verdi (treff)'), { target: { value: '12' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    await within(side).findByRole('region', { name: 'Forhåndsvisning' });
    fireEvent.click(within(side).getByRole('button', { name: /Vis API-kall/ }));
    const api = await screen.findByRole('dialog', { name: 'Endre «Antall treff som leses»' });
    expect(within(api).getByText('/tenants/999888777/settings/retrieval.topK')).toBeTruthy();
    expect(within(api).getByText('PUT')).toBeTruthy();
  });

  it('blocks saving when the preview API fails', async () => {
    await renderAt('#/settings', failingFetch(/dryRun=true/));
    const side = await open('Antall treff som leses');
    fireEvent.change(within(side).getByLabelText('Verdi (treff)'), { target: { value: '12' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    expect(
      await within(side).findByText('Kunne ikke vise hva endringen gjør. Prøv igjen om litt.'),
    ).toBeTruthy();
    expect(within(side).getByRole('button', { name: 'Lagre' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('blocks a limit that would stop a service', async () => {
    await renderAt('#/settings');
    const side = await open('Maks tokens per kjøring');
    fireEvent.change(within(side).getByLabelText('Verdi (tokens)'), { target: { value: '16000' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    const preview = await within(side).findByRole('region', { name: 'Forhåndsvisning' });
    expect(within(preview).getByText('Vedtaksutkast trenger minst 20 000 tokens')).toBeTruthy();
    expect(within(preview).getByText(/^Endringen ville stoppe Vedtaksutkast\./)).toBeTruthy();
    expect(
      within(preview).getByRole('button', { name: 'Lagre' }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('lists the categories of personal data for both PII settings', async () => {
    await renderAt('#/settings');
    let side = await open('Fjern personopplysninger før modellkall');
    let cats = within(side).getByRole('list', { name: 'Kategorier av personopplysninger' });
    expect(within(cats).getByText('Fødselsnummer og D-nummer')).toBeTruthy();
    expect(within(cats).queryByText('Helseopplysninger')).toBeNull();
    expect(within(side).getByText('Kan ikke slås av for høy risiko.')).toBeTruthy();
    fireEvent.click(within(side).getByRole('button', { name: 'Lukk' }));

    side = await open('Hold personopplysninger utenfor loggen');
    cats = within(side).getByRole('list', { name: 'Kategorier av personopplysninger' });
    expect(within(cats).getByText('Helseopplysninger')).toBeTruthy();
    expectAccessible();
  });

  it('sets retention with one value per risk level', async () => {
    await renderAt('#/settings');
    const side = await open('Oppbevaring av logg');
    expect(within(side).getByText('Ikke bestemt')).toBeTruthy();
    expect(within(side).getByText('Én verdi per risikonivå')).toBeTruthy();
    expect(
      within(side).getAllByText('Gulv: minst 30 dager på alle nivåer.').length,
    ).toBeGreaterThan(0);
    fireEvent.change(within(side).getByLabelText('Begrenset risiko'), { target: { value: '180' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    const preview = await within(side).findByRole('region', { name: 'Forhåndsvisning' });
    expect(
      within(preview).getByText('Minimal 30 dager, begrenset 180 dager, høy 10 år'),
    ).toBeTruthy();
    expectAccessible();
  });

  it('shows an error with retry when the catalog cannot be loaded', async () => {
    let fail = true;
    const ok = mockFetch();
    const broken = failingFetch(/\/settings$/);
    await renderAt('#/settings', (input, init) => (fail ? broken(input, init) : ok(input, init)));
    expect(await screen.findByRole('heading', { level: 1, name: 'Innstillinger' })).toBeTruthy();
    fail = false;
    fireEvent.click(await screen.findByRole('button', { name: 'Prøv igjen' }));
    await grid();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Innstillinger for Testetaten' }),
    ).toBeTruthy();
  });
});

describe('Innstillinger for en tjeneste', () => {
  it('reads effective settings and puts a change in the service draft without a reason', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/services/vedtaksutkast/settings', fetch);
    const region = await grid();

    expect(calls.some((c) => c.url.endsWith('/settings/effective?service=vedtaksutkast'))).toBe(
      true,
    );
    expect(screen.queryByRole('heading', { name: 'Innstillinger for Vedtaksutkast' })).toBeNull();
    expect(screen.queryByLabelText('Tjeneste')).toBeNull();
    expect(
      within(region)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toContain('VedtaksutkastTjeneste');

    const topK = within(region)
      .getByRole('button', { name: 'Antall treff som leses' })
      .closest('tr') as HTMLElement;
    expect(within(topK).getByText('Satt på tjenesten')).toBeTruthy();

    const side = await open('Maks lengde på svar');
    expect(within(side).getByText('Legges i utkastet til v8')).toBeTruthy();
    fireEvent.change(within(side).getByLabelText('Verdi (tokens)'), { target: { value: '2500' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    const preview = await within(side).findByRole('region', { name: 'Forhåndsvisning' });
    expect(within(preview).queryByLabelText('Begrunnelse')).toBeNull();
    expect(
      within(preview).getByText('Legges i utkastet til v8. Tas i bruk når du publiserer.'),
    ).toBeTruthy();

    const before = calls.length;
    fireEvent.click(within(preview).getByRole('button', { name: 'Legg i utkastet' }));
    const status = await screen.findByText(/Endringen er lagt i utkastet til v8 av tjenesten\./);
    expect(status.closest('[role="status"]')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gå til Publiser' }).getAttribute('href')).toBe(
      '#/services/vedtaksutkast/quality?tab=publish',
    );
    expect(calls.slice(before).some((c) => c.method === 'PUT')).toBe(false);
    expectAccessible();
  });

  it('blocks turning off human approval for a high-risk service', async () => {
    await renderAt('#/services/vedtaksutkast/settings');
    const side = await open('Menneskelig godkjenning');
    fireEvent.change(within(side).getByLabelText('Verdi'), { target: { value: 'av' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    const preview = await within(side).findByRole('region', { name: 'Forhåndsvisning' });
    expect(
      within(preview).getByText('«Aldri» er ikke tillatt for tjenester med høy risiko.'),
    ).toBeTruthy();
    expect(
      within(preview)
        .getByRole('button', { name: 'Legg i utkastet' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });
});

describe('Innstillinger for et datasett', () => {
  it('shows the dataset layer', async () => {
    await renderAt('#/datasets/kudos-rapporter/settings');
    const region = await grid();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Innstillinger for Kudos-rapporter' }),
    ).toBeTruthy();
    expect(
      within(region)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toContain('Kudos-rapporterDatasett');
    const chunk = within(region)
      .getByRole('button', { name: 'Størrelse på tekstbiter' })
      .closest('tr') as HTMLElement;
    expect(within(chunk).getByText('Satt på datasettet')).toBeTruthy();
    expectAccessible();
  });
});

describe('Eksporter og importer', () => {
  it('exports a YAML file', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL ??= () => 'blob:settings';
    await renderAt('#/settings?tab=transfer');
    expect(
      (await screen.findByRole('tab', { name: 'Eksporter og importer' })).getAttribute(
        'aria-selected',
      ),
    ).toBe('true');
    expect(screen.getByText(/Hemmeligheter eksporteres aldri/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(screen.getByLabelText('Innholdet i eksportfilen').textContent).toContain('testetaten');
    fireEvent.click(screen.getByRole('button', { name: 'Last ned' }));
    expect(await screen.findByText('Filen er lastet ned. Eksporten er logget.')).toBeTruthy();
    click.mockRestore();
    expectAccessible();
  });

  it('runs a dry run before importing and needs a reason', async () => {
    await renderAt('#/settings?tab=transfer');
    fireEvent.click(await screen.findByRole('radio', { name: 'Importer fra fil' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør prøvekjøring' }));
    expect(screen.getByText('Velg en fil, eller bruk eksempelfilen.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bruk eksempelfil fra testmiljøet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør prøvekjøring' }));
    expect(
      screen.getByRole('heading', { name: 'Prøvekjøring: ingenting er endret ennå' }),
    ).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Endringer i prøvekjøringen' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));
    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Flytter oppsett fra test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));
    expect(screen.getByRole('heading', { name: 'Importen er ferdig' })).toBeTruthy();
    expectAccessible();
  });
});
