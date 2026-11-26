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
const allTable = () => screen.findByRole('region', { name: 'Alle innstillinger' });
const panel = () => screen.getByRole('dialog');
const open = async (label: string, region = allTable) => {
  fireEvent.click(within(await region()).getByRole('button', { name: label }));
  return panel();
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Innstillinger for virksomheten', () => {
  it('lists every setting with its key, the value that applies and where it comes from', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/developer/settings', fetch);

    const region = await allTable();
    expect(calls.some((c) => c.url.endsWith('/settings') && c.method === 'GET')).toBe(true);
    expect(screen.getByRole('heading', { level: 2, name: 'Innstillingsnøkler' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Alle innstillinger' })).toBeNull();

    const heads = within(region)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(heads).toEqual(['Innstilling', 'Verdi', 'Kommer fra']);

    const topK = within(region)
      .getByRole('button', { name: 'Treff som hentes (top-k)' })
      .closest('tr') as HTMLElement;
    expect(within(topK).getByText('retrieval.retrieveTopK')).toBeTruthy();
    expect(within(topK).getByText('100')).toBeTruthy();
    expect(within(topK).getByText('Standard')).toBeTruthy();

    expect(
      within(region).getByRole('button', { name: 'Fjern personopplysninger før modellkall' }),
    ).toBeTruthy();
    expectAccessible();
  });

  it('keeps the open setting in the address, and opens it again from the address', async () => {
    await renderAt('#/developer/settings');
    const region = await allTable();
    fireEvent.click(within(region).getByRole('button', { name: 'Antall treff som leses' }));
    expect(window.location.hash).toBe('#/developer/settings?setting=search.top_k');

    cleanup();
    await renderAt('#/developer/settings?setting=search.top_k');
    const again = await allTable();
    expect(
      within(again)
        .getByRole('button', { name: 'Antall treff som leses' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('keeps sensitivity, type, allowed values and the layers behind Tekniske detaljer in the panel', async () => {
    await renderAt('#/developer/settings');
    const region = await allTable();
    fireEvent.click(within(region).getByRole('button', { name: 'Antall treff som leses' }));
    const details = (await screen.findByText('Tekniske detaljer')).closest('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toMatch(/Sensitivitet/);
  });

  it('marks the setting whose panel is open as expanded', async () => {
    await renderAt('#/developer/settings');
    const region = await allTable();
    const button = within(region).getByRole('button', { name: 'Antall treff som leses' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('filters by name or key and by changed settings, and resets both', async () => {
    await renderAt('#/developer/settings');
    await allTable();
    const total = /Viser (\d+) av (\d+) innstillinger/.exec(document.body.textContent ?? '');
    expect(total?.[1]).toBe(total?.[2]);

    const search = screen.getByLabelText('Søk i innstillingene');
    expect(search.getAttribute('placeholder')).toBe('Navn eller nøkkel');
    fireEvent.change(search, { target: { value: 'personopplysninger' } });
    expect(screen.getByText(/^Viser 2 av \d+ innstillinger$/)).toBeTruthy();

    fireEvent.change(search, { target: { value: 'rag.topK' } });
    expect(screen.getByText(/^Viser 1 av \d+ innstillinger$/)).toBeTruthy();

    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bare endrede' }));
    const changed = within(await allTable())
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.lastElementChild?.textContent);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed).not.toContain('Standard');

    fireEvent.change(search, { target: { value: 'finnes ikke' } });
    expect(screen.getByText('Ingen innstillinger passer søket og filteret.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill søk og filter' }));
    expect(screen.getByText(total?.[0] ?? '')).toBeTruthy();
    expect(
      (screen.getByRole('checkbox', { name: 'Bare endrede' }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('previews a tenant value through the API and saves it with a reason', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/developer/settings', fetch);
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
    const dry = calls.find((c) => c.url.endsWith('/settings/rag.topK?dryRun=true'));
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
    const saved = calls.filter((c) => c.url.endsWith('/settings/rag.topK') && c.method === 'PUT');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ reason: 'Flere treff gir bedre svar', body: { value: 15 } });
    const log = within(panel()).getByRole('region', { name: 'Endringer her' });
    expect(within(log).getByText('«Flere treff gir bedre svar»')).toBeTruthy();
    expectAccessible();
  });

  it('the mock answers a real save like the API, and a dry run with the preview', async () => {
    const fetch = mockFetch();
    const put = (query: string) =>
      fetch(`/tenants/999888777/settings/rag.topK${query}`, {
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
    await renderAt('#/developer/settings');
    const side = await open('Antall treff som leses');
    fireEvent.change(within(side).getByLabelText('Verdi (treff)'), { target: { value: '12' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    await within(side).findByRole('region', { name: 'Forhåndsvisning' });
    fireEvent.click(within(side).getByRole('button', { name: /Vis API-kall/ }));
    const api = await screen.findByRole('dialog', { name: 'Endre «Antall treff som leses»' });
    expect(within(api).getByText('/tenants/999888777/settings/rag.topK')).toBeTruthy();
    expect(within(api).getByText('PUT')).toBeTruthy();
  });

  it('blocks saving when the preview API fails', async () => {
    await renderAt('#/developer/settings', failingFetch(/dryRun=true/));
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
    await renderAt('#/developer/settings');
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
    await renderAt('#/developer/settings');
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
    await renderAt('#/developer/settings');
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
    await renderAt('#/developer/settings', (input, init) =>
      fail ? broken(input, init) : ok(input, init),
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Innstillingsnøkler' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Vi fikk ikke hentet innstillingene deres' }),
    ).toBeTruthy();
    fail = false;
    fireEvent.click(await screen.findByRole('button', { name: 'Prøv igjen' }));
    await allTable();
    expect(screen.getByRole('heading', { level: 2, name: 'Innstillingsnøkler' })).toBeTruthy();
  });
});

describe('Innstillinger for en tjeneste', () => {
  it('reads effective settings and puts a change in the service draft without a reason', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/services/vedtaksutkast/setup/limits', fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Endre begrensninger' }));
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
      .getByRole('button', { name: 'Treff som hentes (top-k)' })
      .closest('tr') as HTMLElement;
    expect(within(topK).getByText('Satt på tjenesten')).toBeTruthy();

    const side = await open('Maks lengde på svar', grid);
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

  it('explains inherited values in the legend in words, without a sample digit', async () => {
    await renderAt('#/services/vedtaksutkast/setup/limits');
    fireEvent.click(await screen.findByRole('button', { name: 'Endre begrensninger' }));
    await grid();
    const legend = document.querySelector('.settings-legend') as HTMLElement;
    expect(legend.textContent).toContain('arvet: verdien kommer fra laget til venstre');
    expect(legend.querySelector('em')?.textContent).toBe('arvet');
  });

  it('keeps the wide grid inside its own scroll box, so a phone page does not scroll sideways', async () => {
    await renderAt('#/services/vedtaksutkast/setup/limits');
    fireEvent.click(await screen.findByRole('button', { name: 'Endre begrensninger' }));
    await grid();
    const table = document.querySelector('.settings-table') as HTMLElement;
    expect(table.parentElement?.className).toContain('settings-grid-scroll');
    expect(table.parentElement?.className).toContain('table-scroll');
  });

  it('blocks turning off human approval for a high-risk service', async () => {
    await renderAt('#/services/vedtaksutkast/setup/limits');
    fireEvent.click(await screen.findByRole('button', { name: 'Endre begrensninger' }));
    const side = await open('Menneskelig godkjenning', grid);
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

describe('Innstillinger for en dokumentsamling', () => {
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
    ).toContain('Kudos-rapporterDokumentsamling');
    const chunk = within(region)
      .getByRole('button', { name: 'Størrelse på tekstbiter' })
      .closest('tr') as HTMLElement;
    expect(within(chunk).getByText('Satt på dokumentsamlingen')).toBeTruthy();
    expectAccessible();
  });
});

describe('Eksporter og importer', () => {
  it('exports a YAML file', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL ??= () => 'blob:settings';
    await renderAt('#/developer/settings');
    expect(await screen.findByRole('heading', { name: 'Eksporter og importer' })).toBeTruthy();
    expect(screen.getByText(/Hemmeligheter eksporteres aldri/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(screen.getByLabelText('Innholdet i eksportfilen').textContent).toContain('testetaten');
    fireEvent.click(screen.getByRole('button', { name: 'Last ned' }));
    expect(await screen.findByText('Filen er lastet ned. Eksporten er logget.')).toBeTruthy();
    click.mockRestore();
    expectAccessible();
  });

  it('runs a dry run before importing and needs a reason', async () => {
    await renderAt('#/developer/settings');
    fireEvent.click(await screen.findByRole('radio', { name: 'Importer fra fil' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør prøvekjøring' }));
    expect(screen.getByText('Velg en fil, eller bruk eksempelfilen.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bruk eksempelfil fra genki-test' }));
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
