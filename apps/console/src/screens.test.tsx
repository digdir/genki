// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';
import { validOrgNumber } from './screens/Onboarding';
import { createFormat } from '@genai/i18n';
import { translator } from './i18n';
import { formatValue, parseDraft } from './settings-model';
import type { GridSetting } from './types';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const open = async (path: string, fetch = mockFetch()) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} />);
};

const recording = (fetch = mockFetch()) => {
  const calls: { method: string; path: string; body?: unknown; reason?: string }[] = [];
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://mock');
    const raw = new Headers(init?.headers).get('change-reason');
    const reason = raw && decodeURIComponent(raw);
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      ...(reason ? { reason } : {}),
    });
    return fetch(input, init);
  };
  return { calls, fetch: wrapped };
};

const startSupport = async (tenant = '999888777') => {
  window.location.hash = `#/support-access?tenant=${tenant}`;
  fireEvent.change(await screen.findByRole('textbox', { name: /Begrunnelse/ }), {
    target: { value: 'Kunden melder feil svar, sak DIG-4412' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start støttetilgang' }));
  await screen.findByRole('heading', { name: /^Portalen til / });
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('oppstart', () => {
  it('checks the organisation number with its control digit', () => {
    expect(validOrgNumber('991825827')).toBe(true);
    expect(validOrgNumber('991825828')).toBe(false);
    expect(validOrgNumber('12345')).toBe(false);
  });
});

describe('byggeklosser', () => {
  it('groups the registry by type with contract test, usage and availability as text', async () => {
    await open('#/building-blocks');

    const models = await screen.findByRole('region', { name: 'Modeller' });
    const borealis = within(models).getByRole('button', { name: /Borealis-27B/ });
    expect(borealis.textContent).toMatch(/Bestått/);
    expect(borealis.textContent).toMatch(/Alle virksomheter/);
    expect(
      screen.getByRole('button', { name: /Klarspråk \(fellestjeneste\)/ }).textContent,
    ).toMatch(/Ikke bestått/);

    fireEvent.click(screen.getByRole('radio', { name: 'Ikke bestått' }));
    expect(screen.queryByRole('button', { name: /Borealis-27B/ })).toBeNull();
  });

  it('makes a new version available with a preview that says no service switches', async () => {
    const { calls, fetch } = recording();
    await open('#/building-blocks?block=borealis', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Gjør 2.2 tilgjengelig' }));
    expect(screen.getByText(/Ingen tjeneste bytter versjon av seg selv/)).toBeTruthy();
    expect(screen.getByText('Svarer i snitt 6 % lengre')).toBeTruthy();
    const confirm = screen
      .getAllByRole('button', { name: 'Gjør 2.2 tilgjengelig' })
      .at(-1) as HTMLElement;
    fireEvent.click(confirm);
    expect(await screen.findByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Bedre på nynorsk' },
    });
    fireEvent.click(confirm);
    expect(
      await screen.findByText(/Borealis-27B \(AIVAR, Norge\) 2.2 er tilgjengelig/),
    ).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.path).toBe(
      '/api/operator/building-blocks/borealis/versions/2.2/release',
    );
  });

  it('blocks a version that failed its contract tests with aria-disabled', async () => {
    const { calls, fetch } = recording();
    await open('#/building-blocks?block=mcp', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Gjør 2.0 tilgjengelig' }));
    expect(screen.getByText(/har ikke bestått kontrakttestene/)).toBeTruthy();
    const confirm = screen
      .getAllByRole('button', { name: 'Gjør 2.0 tilgjengelig' })
      .at(-1) as HTMLElement;
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Ny spesifikasjon' },
    });
    fireEvent.click(confirm);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('falls back to the live registry shape when types are missing', async () => {
    const base = mockFetch();
    const live: typeof fetch = async (input, init) => {
      const response = await base(input, init);
      if (!String(input).endsWith('/operator/building-blocks')) return response;
      const { strategies, blocks, tools } = (await response.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ strategies, blocks, tools }), { status: 200 });
    };
    await open('#/building-blocks', live);

    const strategies = await screen.findByRole('region', { name: 'Strategier' });
    expect(within(strategies).getByRole('button', { name: /single-call/ }).textContent).toMatch(
      /Ikke målt/,
    );
  });
});

describe('byggeklosser fra manifestene', () => {
  const plugin = (passed: boolean) => ({
    kind: 'model',
    id: 'model.openai-chat',
    version: '1',
    contract: 'model@1',
    title: 'OpenAI-kompatibel chat',
    description: '',
    publisher: 'digdir',
    origin: 'builtin',
    capabilities: ['stream', 'tools'],
    dataLocation: null,
    secrets: ['api-key'],
    hosts: [],
    verifiable: true,
    contractTests: {
      passed,
      version: '1',
      at: '2026-10-08T10:00:00Z',
      trigger: 'boot',
      results: [
        {
          name: 'chat returns the text',
          status: passed ? 'passed' : 'failed',
          reason: passed ? undefined : 'content: expected "Hei"',
          ms: 3,
        },
        { name: 'chatStream yields deltas', status: 'skipped', ms: 0 },
      ],
    },
    history: [],
  });

  it('shows real manifests and contract results, and reruns the suite', async () => {
    const base = mockFetch();
    let passed = false;
    const posted: string[] = [];
    const live: typeof fetch = async (input, init) => {
      const path = new URL(String(input), 'http://mock').pathname;
      if (path === '/api/operator/building-blocks')
        return new Response(JSON.stringify({ strategies: [], blocks: [], tools: [] }));
      if (path === '/api/operator/plugins')
        return new Response(JSON.stringify({ data: [plugin(passed)] }));
      if (path.endsWith('/contract-tests') && init?.method === 'POST') {
        posted.push(path);
        passed = true;
        return new Response(
          JSON.stringify({ passed: true, results: plugin(true).contractTests.results }),
        );
      }
      return base(input, init);
    };
    const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
    await auth.login();
    window.location.hash = '#/building-blocks';
    render(<App auth={auth} fetch={live} live />);

    const models = await screen.findByRole('region', { name: 'Modeller' });
    fireEvent.click(within(models).getByRole('button', { name: /OpenAI-kompatibel chat/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Kontrakttester' }));
    expect(screen.getByText('content: expected "Hei"')).toBeTruthy();
    expect(screen.getByText('Ikke relevant')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Manifest' }));
    expect(screen.getByText(/contract: model@1/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Kontrakttester' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør på nytt' }));
    expect(
      await screen.findByText(/Kontrakttestene for OpenAI-kompatibel chat 1 er bestått/),
    ).toBeTruthy();
    expect(posted).toEqual(['/api/operator/building-blocks/model.openai-chat/contract-tests']);
  });
});

describe('innstillinger', () => {
  it('shows the layered grid with the effective value marked and its source', async () => {
    await open('#/settings');

    const grid = await screen.findByRole('region', { name: 'Innstillinger per lag' });
    const row = within(grid)
      .getByRole('button', { name: 'Antall treff som leses' })
      .closest('tr') as HTMLElement;
    expect(within(row).getByText('Satt på tjenesten')).toBeTruthy();
    expect(within(row).getByText('(gjelder)')).toBeTruthy();
    const pinned = within(grid)
      .getByRole('button', { name: 'Oppbevaring av logg' })
      .closest('tr') as HTMLElement;
    expect(within(pinned).getByText('Festet til v11')).toBeTruthy();
    const risk = within(grid)
      .getByRole('button', { name: 'Fjern personopplysninger før modellkall' })
      .closest('tr') as HTMLElement;
    expect(
      within(risk).getAllByText(/Per risikonivå: av \/ på \/ på \(gulv: på for høy\)/).length,
    ).toBeGreaterThan(0);
    expect(within(risk).getByText('På (begrenset risiko)')).toBeTruthy();
    expect(within(grid).getAllByText('Foreslått som standard').length).toBeGreaterThan(0);
  });

  it('switches to all agencies and filters to overridden settings', async () => {
    await open('#/settings');
    await screen.findByRole('region', { name: 'Innstillinger per lag' });

    fireEvent.click(screen.getByRole('radio', { name: 'Alle virksomheter' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Bare de som er overstyrt' }));
    const grid = screen.getByRole('region', { name: 'Innstillinger per lag' });
    expect(within(grid).getByRole('columnheader', { name: 'Kontrollrådet' })).toBeTruthy();
    expect(within(grid).queryByRole('button', { name: 'Kildehenvisning' })).toBeNull();
  });

  it('previews a platform default with who changes, keeps or breaks, and needs a reason to save', async () => {
    const { calls, fetch } = recording();
    await open('#/settings', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Maks tokens per kjøring' }));
    const panel = screen.getByRole('dialog', { name: 'Maks tokens per kjøring' });
    expect(panel.getAttribute('aria-modal')).toBe('false');
    fireEvent.change(within(panel).getByRole('textbox', { name: /Verdi/ }), {
      target: { value: '16000' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Forhåndsvis endring' }));
    expect(await within(panel).findByText('Ville brutt')).toBeTruthy();
    const save = within(panel).getByRole('button', { name: 'Lagre' });
    expect(save.getAttribute('aria-disabled')).toBe('true');

    fireEvent.change(within(panel).getByRole('textbox', { name: /Verdi/ }), {
      target: { value: '64000' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Forhåndsvis endring' }));
    await waitFor(() => expect(within(panel).queryByText('Ville brutt')).toBeNull());
    expect(within(panel).getByText('Beholder egen verdi')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Lagre' }));
    expect(await within(panel).findByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();

    fireEvent.change(within(panel).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Lange høringer' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Lagre' }));
    expect(
      await screen.findByText(/Maks tokens per kjøring er lagret \(64 000 tokens\)/),
    ).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT' && !c.path.includes('dryRun'))).toMatchObject({
      body: { value: 64000 },
      reason: 'Lange høringer',
    });
  });

  it('closes the side panel with Escape', async () => {
    await open('#/settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Svarspråk' }));
    expect(screen.getByRole('dialog', { name: 'Svarspråk' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Svarspråk' })).toBeNull();
  });

  it('formats and validates risk-level defaults with a floor', () => {
    const s = {
      key: 'guard.x',
      type: 'risk',
      floor: { high: true },
      floorText: 'på for høy',
      rule: 'Kan ikke slås av for høy risiko.',
    } as unknown as GridSetting;
    expect(
      formatValue(
        s,
        { minimal: false, limited: true, high: true },
        translator('nb'),
        createFormat('nb'),
      ),
    ).toBe('Per risikonivå: av / på / på (gulv: på for høy)');
    expect(
      parseDraft(
        s,
        '',
        { minimal: 'true', limited: 'true', high: 'false' },
        translator('nb'),
        createFormat('nb'),
      ),
    ).toEqual({
      error: 'Kan ikke slås av for høy risiko.',
    });
  });

  it('runs an import dry run through a support session and applies only chosen conflicts', async () => {
    const { calls, fetch } = recording();
    await open('#/settings', fetch);

    fireEvent.click(await screen.findByRole('tab', { name: 'Eksporter, importer og klon' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Klon fra en annen virksomhet' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Til' }), {
      target: { value: '910111222' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Samme oppsett' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør prøvekjøring' }));

    expect(
      await screen.findByRole('heading', { name: 'Prøvekjøring: ingenting er endret ennå' }),
    ).toBeTruthy();
    expect(screen.getByText('2 konflikter')).toBeTruthy();
    const table = screen.getByRole('region', { name: 'Endringer i prøvekjøringen' });
    fireEvent.click(
      within(within(table).getByRole('radiogroup', { name: /Antall treff som leses/ })).getByRole(
        'radio',
        { name: 'Overskriv' },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));

    expect(await screen.findByText('Konfigurasjonen er klonet til Prøvekommunen')).toBeTruthy();
    const applied = calls.find((c) => c.path.includes('/import?dryRun=false'));
    expect(applied?.body).toMatchObject({
      definitions: [{ definition: { metadata: { id: 'soknadsuttrekk' } } }],
      settings: { values: { 'search.top_k': 12, 'answer.max_tokens': 600 } },
    });
  });
});

describe('kvalitet', () => {
  it('shows regressions, a chart with a legend and a table', async () => {
    await open('#/quality');

    expect(await screen.findByText(/tilbakeganger etter/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /Poeng på testsett per uke/ })).toBeTruthy();
    const table = screen.getByRole('region', { name: 'Kvalitet per tjeneste' });
    expect(within(table).getByText('Tilbakegang -8')).toBeTruthy();
  });
});

describe('kvalitetsmatrise og dommere', () => {
  it('blocks a version that is more than 3 points worse and explains why', async () => {
    const { calls, fetch } = recording();
    await open('#/quality-matrix', fetch);

    const matrix = await screen.findByRole('region', { name: 'Kvalitetsmatrise' });
    expect(within(matrix).getAllByText(/tilbakegang/).length).toBeGreaterThan(0);
    const blocked = within(matrix).getByRole('button', {
      name: 'Tillat modellen: NorLlama-70B 0.9',
    });
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(blocked);
    expect(
      await screen.findByText(/kan ikke tillates: minst ett testsett er mer enn 3 poeng dårligere/),
    ).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);

    fireEvent.click(
      within(matrix).getByRole('button', { name: 'Gjør tilgjengelig: Borealis-27B 2.2' }),
    );
    expect(await screen.findByText(/Ingen tjenester bytter av seg selv/)).toBeTruthy();
  });

  it('shows the estimated cost and starts the quality matrix only after it is confirmed', async () => {
    const { calls, fetch } = recording();
    await open('#/quality-matrix', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Beregn kostnad' }));
    expect(await screen.findByText(/Anslått kostnad: 4,20 kr/)).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/operator/quality/matrix/runs')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Kjør for omtrent 4,20 kr' }));
    expect(
      await screen.findByText('Skriv en begrunnelse på minst 10 tegn. Nå er det 0.'),
    ).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/operator/quality/matrix/runs')).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Ny modell fra AIVAR, sak DIG-4500' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør for omtrent 4,20 kr' }));

    const runs = await screen.findByRole('region', { name: 'Kjøringer av kvalitetsmatrisen' });
    expect(within(runs).getByText('Venter')).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/operator/quality/matrix/runs')).toMatchObject({
      method: 'POST',
      body: { model: 'NorLlama-70B 0.9', current: 'Borealis-27B 2.1', confirmedCostNok: 4.2 },
      reason: 'Ny modell fra AIVAR, sak DIG-4500',
    });
  });

  it('releases a model with no test sets to compare against only with a long enough reason', async () => {
    const { calls, fetch } = recording();
    await open('#/quality-matrix', fetch);

    fireEvent.change(await screen.findByLabelText('Ny modell'), {
      target: { value: 'Fjord-8B 1.0' },
    });
    expect(screen.getByText('Ingen testsett å sammenligne mot.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Beregn kostnad' })).toBeNull();
    const reason = screen.getByRole('textbox', { name: /Begrunnelse/ });
    const release = screen.getByRole('button', { name: 'Slipp modellen' });
    fireEvent.change(reason, { target: { value: 'For kort' } });
    fireEvent.click(release);
    expect(
      await screen.findByText('Skriv en begrunnelse på minst 20 tegn. Nå er det 8.'),
    ).toBeTruthy();
    fireEvent.change(reason, { target: { value: 'Ingen tjenester bruker modellen ennå' } });
    fireEvent.click(release);

    expect(await screen.findByText(/Fjord-8B 1.0 er sluppet/)).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/operator/quality/matrix/release')).toMatchObject({
      body: { kind: 'models', name: 'Fjord-8B 1.0' },
      reason: 'Ingen tjenester bruker modellen ennå',
    });
  });

  it('shows why the platform refused to release a model', async () => {
    const base = mockFetch();
    const refusing: typeof globalThis.fetch = async (input, init) =>
      String(input).endsWith('/operator/quality/matrix/release')
        ? new Response(
            JSON.stringify({
              title: 'Kvalitetsmatrisen er ikke kjørt for modellen',
              status: 409,
              errors: [],
            }),
            { status: 409, headers: { 'content-type': 'application/problem+json' } },
          )
        : base(input, init);
    await open('#/quality-matrix', refusing);

    const matrix = await screen.findByRole('region', { name: 'Kvalitetsmatrise' });
    fireEvent.click(
      within(matrix).getByRole('button', { name: 'Gjør tilgjengelig: Borealis-27B 2.2' }),
    );
    expect(await screen.findByText('Kvalitetsmatrisen er ikke kjørt for modellen')).toBeTruthy();
  });

  it('shows kappa per language and job type, and moves judges with the threshold', async () => {
    await open('#/quality-matrix?tab=judges');

    const table = await screen.findByRole('region', { name: 'Kappa for Svarkvalitet' });
    expect(within(table).getByRole('columnheader', { name: 'Oppsummerer' })).toBeTruthy();
    expect(within(table).getAllByText('Bare veiledende')).toHaveLength(2);

    fireEvent.change(screen.getByRole('textbox', { name: 'Terskel (kappa)' }), {
      target: { value: '0,45' },
    });
    expect(within(table).queryAllByText('Bare veiledende')).toHaveLength(0);
    fireEvent.change(screen.getByRole('textbox', { name: 'Terskel (kappa)' }), {
      target: { value: '2' },
    });
    expect(screen.getByText('Skriv et tall fra 0,40 til 0,90.')).toBeTruthy();
  });

  it('shows the judge verdict only after the human rating is saved', async () => {
    const { calls, fetch } = recording();
    await open('#/quality-matrix?tab=rate', fetch);

    expect(await screen.findByRole('heading', { name: /frivillige organisasjoner/ })).toBeTruthy();
    expect(screen.queryByText(/Dommeren svarte/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lagre vurderingen' }));
    expect(screen.getAllByText('Velg et svar.')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('radio', { name: 'Ja' })[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole('radio', { name: 'Ja' })[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Lagre vurderingen' }));
    expect(
      await screen.findByText(
        /Dommeren svarte: riktig «Delvis», dekket av kilder «Nei». Dere er uenige/,
      ),
    ).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/operator/quality/labels')?.body).toMatchObject({
      humanLabel: 'good',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Neste svar' }));
    const question = await screen.findByRole('heading', { name: /ventetida på telefon/ });
    expect(question.getAttribute('lang')).toBe('nn');
  });
});

describe('sporing og evaluering', () => {
  it('states the fixed privacy rule and warns when the tool is hosted outside EU/EØS', async () => {
    await open('#/tracing');

    expect(
      await screen.findByText(/navn på ansatte sendes aldri til eksterne verktøy/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Langfuse/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Utenfor EU/EØS' }));
    expect(screen.getByText(/Spor sendes da ut av EU\/EØS/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Virksomheter med egen kobling' })).toBeTruthy();
  });

  it('validates a new connection with an error summary and never shows the secret', async () => {
    const { calls, fetch } = recording();
    await open('#/tracing', fetch);

    fireEvent.click(await screen.findByRole('button', { name: /Arize Phoenix/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Koble til' }));
    expect(await screen.findByText('Rett opp i dette før du lagrer:')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Adresse til Phoenix' }), {
      target: { value: 'https://phoenix.digdir.example.no' },
    });
    fireEvent.change(screen.getByLabelText(/API-nøkkel/), {
      target: { value: 'hemmelig-nokkel-123456' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kontrollrådet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Koble til' }));

    expect(await screen.findByText(/Arize Phoenix er koblet til/)).toBeTruthy();
    expect((screen.getByLabelText(/API-nøkkel/) as HTMLInputElement).value).toBe('');
    expect(calls.find((c) => c.method === 'PUT')?.path).toBe('/api/operator/tracing/phoenix');
  });
});

describe('drift', () => {
  it('shows incidents, component health, queues, failing triggers and running tasks', async () => {
    await open('#/operations');

    expect(
      await screen.findByRole('heading', { name: 'AIVAR (norske modeller) svarer tregt' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Redusert ytelse hos AIVAR' })).toBeTruthy();
    const endpoints = screen.getByRole('region', { name: 'Database og modellendepunkter' });
    expect(within(endpoints).getByText('Tregt')).toBeTruthy();
    expect(screen.getByText('Tilgangsnøkkelen er utløpt')).toBeTruthy();
    const running = await screen.findByRole('region', { name: 'Pågående kjøringer' });
    fireEvent.click(within(running).getByRole('button', { name: 'Avbryt kjøringen t-101' }));
    expect(await screen.findByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse', { exact: false }), {
      target: { value: '123456789' },
    });
    fireEvent.click(within(running).getByRole('button', { name: 'Avbryt kjøringen t-101' }));
    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    expect(screen.queryByText('Kjøringen t-101 er avbrutt.')).toBeNull();
    fireEvent.change(screen.getByLabelText('Begrunnelse', { exact: false }), {
      target: { value: 'Henger og må stoppes' },
    });
    fireEvent.click(within(running).getByRole('button', { name: 'Avbryt kjøringen t-101' }));
    expect(await screen.findByText('Kjøringen t-101 er avbrutt.')).toBeTruthy();
  });

  it('lists quarantined definitions with their errors and the tenant name', async () => {
    await open('#/operations');

    const panel = await screen.findByRole('region', { name: 'Definisjoner i karantene' });
    const row = (await within(panel).findByText('vedtaksutkast')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Tjeneste · versjon 4')).toBeTruthy();
    expect(within(row).getByText('spec.strategy.ref: ukjent strategi «agent-loop@3»')).toBeTruthy();
    await waitFor(() => expect(within(row).getByText('Testetaten')).toBeTruthy());
  });

  it('falls back to API health when the platform does not report components', async () => {
    const base = mockFetch();
    const live: typeof fetch = async (input, init) =>
      String(input).endsWith('/operator/operations')
        ? new Response('{}', { status: 404 })
        : base(input, init);
    await open('#/operations', live);

    expect((await screen.findByText(/API-et svarer/)).textContent).toMatch(/Kodeversjon 484179f/);
  });
});

describe('diagnostikk', () => {
  it('asks for a support session before reading tenant data', async () => {
    await open('#/diagnostics?tenant=999888777');

    fireEvent.change(await screen.findByRole('textbox', { name: 'ID for kjøringen' }), {
      target: { value: 'opg_7f2kq9d1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Slå opp' }));
    expect(await screen.findByText(/krever derfor en støttetilgang/)).toBeTruthy();
  });

  it('shows a run with the service name, a pseudonym and resolved settings in the layered layout', async () => {
    await open('#/tenants');
    await screen.findByRole('table');
    await startSupport();
    window.location.hash = '#/diagnostics?tenant=999888777';

    const field = (await screen.findByRole('textbox', {
      name: 'ID for kjøringen',
    })) as HTMLInputElement;
    expect(field.value).toBe('');
    fireEvent.change(field, { target: { value: 'opg_7f2kq9d1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Slå opp' }));
    expect(await screen.findByRole('heading', { name: 'opg_7f2kq9d1' })).toBeTruthy();
    expect(screen.getByText(/Ansatt i Testetaten \(A-4K7Q\)/, { selector: 'span' })).toBeTruthy();
    expect(screen.getByText(/Rapportassistenten v7/, { selector: 'span' })).toBeTruthy();
    expect(screen.queryByText(/Kari Nordmann/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Se innstillingene for tjenesten' }));
    const grid = await screen.findByRole('region', { name: 'Innstillinger' });
    const row = within(grid)
      .getByRole('rowheader', { name: 'Kall per minutt' })
      .closest('tr') as HTMLElement;
    expect(within(row).getByText('Overstyrt av virksomheten')).toBeTruthy();
    expect(within(row).getByText('(gjelder)')).toBeTruthy();
    const pinned = within(grid)
      .getByRole('rowheader', { name: 'Logg oppbevares' })
      .closest('tr') as HTMLElement;
    expect(within(pinned).getByText('Festet til v11')).toBeTruthy();
    expect(screen.getAllByText('Satt på datasettet').length).toBeGreaterThan(0);
  });

  it('says when a run is not found', async () => {
    await open('#/tenants');
    await screen.findByRole('table');
    await startSupport();
    window.location.hash = '#/diagnostics?tenant=999888777';

    fireEvent.change(await screen.findByRole('textbox', { name: 'ID for kjøringen' }), {
      target: { value: 'opg_x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Slå opp' }));
    expect(
      await screen.findByText(
        'Fant ingen kjøring med ID «opg_x». Kjøringer slettes etter oppbevaringstiden.',
      ),
    ).toBeTruthy();
  });
});

describe('fellestjenester', () => {
  it('shares a service with all agencies after a reason', async () => {
    await open('#/shared-services');

    const table = await screen.findByRole('region', { name: 'Tjenester og deling' });
    fireEvent.click(
      within(table).getByRole('button', { name: 'Del Kunnskapsassistenten med alle virksomheter' }),
    );
    expect(await screen.findByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse', { exact: false }), {
      target: { value: 'Felles for alle virksomheter' },
    });
    fireEvent.click(
      within(table).getByRole('button', { name: 'Del Kunnskapsassistenten med alle virksomheter' }),
    );
    expect(
      await screen.findByText('Kunnskapsassistenten er nå delt med alle virksomheter.'),
    ).toBeTruthy();
  });
});
