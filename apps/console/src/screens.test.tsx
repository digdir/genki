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
import type { GridSetting, TaskTimeline } from './types';

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

const giveContentReason = async () => {
  const dialog = await screen.findByRole('dialog', { name: /^Se innhold fra / });
  fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
    target: { value: 'Kunden melder feil svar, sak DIG-4412' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Se innholdet' }));
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

describe('katalog', () => {
  it('lists design elements, tools and work instructions with the drawn columns', async () => {
    await open('#/building-blocks');

    expect(await screen.findByRole('heading', { level: 1, name: 'Katalog' })).toBeTruthy();
    const table = await screen.findByRole('region', { name: 'Katalog' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Navn', 'Type', 'Fra', 'Utgave', 'Brukes av', 'Status', 'Handling']);
    const figure = (await within(table).findByText('Figur')).closest('tr') as HTMLElement;
    expect(within(figure).getByText('Designelement')).toBeTruthy();
    expect(within(figure).getByText('Til gjennomgang')).toBeTruthy();
    expect(within(figure).getByRole('link', { name: 'Gjennomgå Figur' }).getAttribute('href')).toBe(
      '#/block-reviews',
    );
    const skill = within(table).getByText('Klarspråk').closest('tr') as HTMLElement;
    expect(within(skill).getByText('Arbeidsinstruks')).toBeTruthy();
    expect(within(skill).getByRole('link', { name: 'Gjennomgå Klarspråk' })).toBeTruthy();
    expect(within(table).queryByRole('button', { name: /Fjern|Gjør til felles/ })).toBeNull();
  });

  it('filters the list by type and shows the pressed filter', async () => {
    await open('#/building-blocks');
    const table = await screen.findByRole('region', { name: 'Katalog' });
    await within(table).findByText('Figur');

    const tools = screen.getByRole('button', { name: 'Verktøy' });
    fireEvent.click(tools);
    expect(tools.getAttribute('aria-pressed')).toBe('true');
    expect(within(table).queryByText('Figur')).toBeNull();
    const types = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.querySelectorAll('td')[1]?.textContent);
    expect(types.length).toBeGreaterThan(0);
    expect(new Set(types)).toEqual(new Set(['Verktøy']));
  });

  it('shows a tool open to selected organisations as such, not as open to everyone', async () => {
    const base = mockFetch();
    const selected: typeof fetch = async (input, init) => {
      const response = await base(input, init);
      if (!String(input).endsWith('/operator/building-blocks')) return response;
      const body = (await response.json()) as {
        registry: { id: string; availability?: string }[];
      };
      for (const b of body.registry) if (b.id === 'lovdata') b.availability = 'selected';
      return Response.json(body);
    };
    await open('#/building-blocks', selected);

    const table = await screen.findByRole('region', { name: 'Katalog' });
    const lovdata = within(table)
      .getByRole('link', { name: 'Lovdata' })
      .closest('tr') as HTMLElement;
    expect(within(lovdata).getByText('Utvalgte virksomheter')).toBeTruthy();
    expect(within(lovdata).queryByText('For alle')).toBeNull();
  });

  it('still lists the catalogue when one source of reviews fails', async () => {
    const base = mockFetch();
    const failing: typeof fetch = async (input, init) =>
      String(input).includes('/operator/block-share-requests')
        ? new Response('{}', { status: 500 })
        : base(input, init);
    await open('#/building-blocks', failing);

    const table = await screen.findByRole('region', { name: 'Katalog' });
    expect(within(table).getByRole('link', { name: 'Lovdata' })).toBeTruthy();
    expect(within(table).queryByText('Figur')).toBeNull();
    expect(within(table).getByText('Klarspråk', { selector: 'td' })).toBeTruthy();
  });

  it('offers no availability, release or disable action, since the API has none', async () => {
    await open('#/building-blocks?block=borealis');

    expect(await screen.findByRole('heading', { level: 1, name: /Borealis-27B/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /tilgjengelig|Deaktiver|Forhåndsvis/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Utvalgte virksomheter' })).toBeNull();
  });
});

describe('byggeklosser fra manifestene', () => {
  const plugin = (passed: boolean) => ({
    kind: 'tool-source',
    id: 'model.openai-chat',
    version: '1',
    contract: 'tool-source@1',
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

  it('shows real manifests and contract results, reruns the suite and keeps the chosen filter', async () => {
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
    render(<App auth={auth} fetch={live} />);

    const table = await screen.findByRole('region', { name: 'Katalog' });
    fireEvent.click(screen.getByRole('button', { name: 'Verktøy' }));
    fireEvent.click(within(table).getByRole('link', { name: 'OpenAI-kompatibel chat' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Kontrakttester' }));
    expect(screen.getByText('content: expected "Hei"')).toBeTruthy();
    expect(screen.getByText('Ikke relevant')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Manifest' }));
    expect(screen.getByText(/contract: tool-source@1/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Kontrakttester' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør på nytt' }));
    expect(
      await screen.findByText(/Kontrakttestene for OpenAI-kompatibel chat 1 er bestått/),
    ).toBeTruthy();
    expect(posted).toEqual(['/api/operator/building-blocks/model.openai-chat/contract-tests']);
    expect(screen.getByRole('heading', { level: 1, name: /OpenAI-kompatibel chat/ })).toBeTruthy();

    fireEvent.click(within(screen.getByRole('main')).getByRole('link', { name: 'Katalog' }));
    expect(
      (await screen.findByRole('button', { name: 'Verktøy' })).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});

describe('innstillinger', () => {
  it('builds the settings from the platform routes and never asks for a grid', async () => {
    const { calls, fetch } = recording();
    await open('#/settings', fetch);

    await screen.findByRole('region', { name: 'Standardverdier' });
    expect(calls.some((c) => c.path.endsWith('/operator/settings/overrides'))).toBe(true);
    expect(calls.some((c) => c.path.includes('/settings/grid'))).toBe(false);
  });

  it('shows each setting by name with its default and how many organisations have their own', async () => {
    await open('#/settings');

    const table = await screen.findByRole('region', { name: 'Standardverdier' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Innstilling', 'Standard', 'Egen verdi hos', 'Handling']);
    const tokens = within(table).getByText('Tokens per måned').closest('tr') as HTMLElement;
    expect(within(tokens).getByText('20 mill.')).toBeTruthy();
    expect(within(tokens).getByText('3 virksomheter')).toBeTruthy();
    const calls = within(table)
      .getByText('Kall per minutt for virksomheten')
      .closest('tr') as HTMLElement;
    expect(within(calls).getByText('1 virksomhet')).toBeTruthy();
    const assistant = within(table)
      .getByText('Tokens per dag for assistenten')
      .closest('tr') as HTMLElement;
    expect(within(assistant).getByText('200 000')).toBeTruthy();
    expect(within(assistant).getByText('Ingen')).toBeTruthy();
  });

  it('checks a new default, shows who keeps their own value, and needs a reason to save', async () => {
    const { calls, fetch } = recording();
    await open('#/settings', fetch);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Endre kall per minutt for virksomheten' }),
    );
    const panel = screen.getByRole('dialog', { name: 'Kall per minutt for virksomheten' });
    expect(panel.getAttribute('aria-modal')).toBe('false');
    fireEvent.change(within(panel).getByRole('textbox', { name: /Verdi/ }), {
      target: { value: '90' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Sjekk endringen' }));
    expect(await within(panel).findByText('Endringen gjelder med en gang.')).toBeTruthy();
    expect(within(panel).getByText('Beholder egen verdi')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Lagre' }));
    expect(await within(panel).findByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PUT' && !c.path.includes('dryRun'))).toEqual([]);

    fireEvent.change(within(panel).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Flere kall i pilotene' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText(/Kall per minutt for virksomheten er lagret/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT' && !c.path.includes('dryRun'))).toMatchObject({
      body: { value: 90 },
      reason: 'Flere kall i pilotene',
    });
    expect(screen.getByRole('dialog', { name: 'Kall per minutt for virksomheten' })).toBeTruthy();
  });

  it('closes the side panel with Escape', async () => {
    await open('#/settings');
    fireEvent.click(await screen.findByRole('button', { name: 'Endre målform i svar' }));
    expect(screen.getByRole('dialog', { name: 'Målform i svar' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Målform i svar' })).toBeNull();
  });

  it('formats risk-level defaults per level', () => {
    const s = { key: 'guard.x', type: 'risk' } as unknown as GridSetting;
    expect(
      formatValue(
        s,
        { minimal: false, limited: true, high: true },
        translator('nb'),
        createFormat('nb'),
      ),
    ).toBe('Per risikonivå: av / på / på');
    expect(
      parseDraft(
        s,
        '',
        { minimal: 'true', limited: 'true', high: 'false' },
        translator('nb'),
        createFormat('nb'),
      ),
    ).toEqual({ value: { minimal: true, limited: true, high: false } });
  });

  it('runs an import dry run through a support session and applies only chosen conflicts', async () => {
    const { calls, fetch } = recording();
    await open('#/settings', fetch);

    fireEvent.click(await screen.findByText('Eksporter, importer og klon'));
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
      within(within(table).getByRole('radiogroup', { name: /search\.top_k/ })).getByRole('radio', {
        name: 'Overskriv',
      }),
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
  it('shows the services that dropped, largest drop first, and the automatic evaluation', async () => {
    await open('#/quality');

    const table = await screen.findByRole('region', { name: 'Kvalitet per tjeneste' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('td')?.textContent)).toEqual([
      'Klarspråk',
      'Spør regelverket',
      'Rapportassistenten',
      'Innbyggerspørsmål',
      'Oppsummering',
    ]);
    expect(within(rows[0] as HTMLElement).getByText('ned 8')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Automatisk vurdering' })).toBeTruthy();
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
    const box = await screen.findByRole('dialog', { name: 'Gjør tilgjengelig: Borealis-27B 2.2' });
    fireEvent.click(within(box).getByRole('button', { name: 'Gjør tilgjengelig' }));
    expect(await within(box).findByText(/minst 10 tegn/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    fireEvent.change(within(box).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Testsettene er grønne' },
    });
    fireEvent.click(within(box).getByRole('button', { name: 'Gjør tilgjengelig' }));
    expect(await screen.findByText(/Ingen tjenester bytter av seg selv/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.reason).toBe('Testsettene er grønne');
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
    const box = await screen.findByRole('dialog', { name: 'Gjør tilgjengelig: Borealis-27B 2.2' });
    fireEvent.change(within(box).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Testsettene er grønne' },
    });
    fireEvent.click(within(box).getByRole('button', { name: 'Gjør tilgjengelig' }));
    expect(
      await within(box).findByText('Kvalitetsmatrisen er ikke kjørt for modellen'),
    ).toBeTruthy();
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
    expect(screen.queryByText(/Den automatiske vurderingen svarte/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lagre vurderingen' }));
    expect(screen.getAllByText('Velg et svar.')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('radio', { name: 'Ja' })[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole('radio', { name: 'Ja' })[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Lagre vurderingen' }));
    expect(
      await screen.findByText(
        /Den automatiske vurderingen svarte: riktig «Delvis», dekket av kilder «Nei». Dere er uenige/,
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

describe('etiketter fra Langfuse', () => {
  it('counts a label only after its batch is accepted with a reason, in the audit log', async () => {
    const { calls, fetch } = recording();
    await open('#/quality-matrix?tab=sink', fetch);

    const batch = await screen.findByRole('region', { name: /kudos_quotes_covered/ });
    expect(
      within(batch).getByText(
        '3 etiketter venter: 1 lik vurderingen, 1 ulik, 1 uten score · 2 merkere',
      ),
    ).toBeTruthy();
    expect(within(batch).getAllByText(/^pseudonym:/).length).toBe(3);
    fireEvent.click(within(batch).getByRole('button', { name: 'Godta…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Godta etikettene' }));
    expect(
      await within(dialog).findByText(
        /Skriv en begrunnelse på minst \d+ tegn\. Den vises i loggen\./,
      ),
    ).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/sink-labels/accept'))).toBe(false);

    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Merket av fagfolk i DFØ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Godta etikettene' }));

    expect(await screen.findByText('3 etiketter teller nå i samsvaret.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /kudos_quotes_covered/ })).toBeNull(),
    );
    expect(calls.find((c) => c.path === '/api/operator/quality/sink-labels/accept')).toMatchObject({
      method: 'POST',
      reason: 'Merket av fagfolk i DFØ',
      body: {
        tenant: '991825827',
        connection: 'kudos',
        judge: 'langfuse:991825827/kudos/kudos_quotes_covered',
      },
    });
  });
  it('says after a fetch which evaluators got no labels because rules share them', async () => {
    const base = mockFetch();
    const shared: typeof globalThis.fetch = async (input, init) =>
      new URL(String(input), 'http://mock').pathname === '/api/operator/quality/sink-labels/fetch'
        ? Response.json({
            pending: 2,
            shared: [{ name: 'svar_oppfyller_kriteriene', rules: ['regel_a', 'regel_b'] }],
          })
        : base(input, init);
    await open('#/quality-matrix?tab=sink', shared);

    const fetchButton = (await screen.findAllByRole('button', { name: 'Hent nye etiketter' }))[0];
    fireEvent.click(fetchButton as HTMLElement);

    const notice = await screen.findByText(
      '2 nye etiketter fra kudos. Ingen etiketter for svar_oppfyller_kriteriene: reglene regel_a, regel_b skriver vurderinger med samme navn, så merkingene kan ikke skilles fra hverandre.',
    );
    // Some labels were left out: a warning, not a plain success.
    expect(notice.closest('.ds-alert')?.getAttribute('data-color')).toBe('warning');
  });
});

describe('sporing og evaluering', () => {
  it('shows the platform tracing and the fixed rule, with no actions the API does not have', async () => {
    await open('#/tracing');

    expect(await screen.findByRole('heading', { name: 'Plattformens sporing' })).toBeTruthy();
    expect(screen.getByText(/navn på ansatte sendes aldri til eksterne verktøy/)).toBeTruthy();
    expect(screen.getByText('https://langfuse.digdir.example.no/api/public/otel')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /^(Lagre|Koble til|Koble fra|Send testspor)$/ }),
    ).toBeNull();
  });
});

describe('drift', () => {
  it('cancels a running task only with a reason of at least 10 characters', async () => {
    await open('#/operations');

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
    expect(within(row).getByText('Tjeneste · utgave 4')).toBeTruthy();
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
  it('shows a run with the service name, a pseudonym and resolved settings in the layered layout', async () => {
    await open('#/diagnostics?tenant=999888777');

    const field = (await screen.findByRole('textbox', {
      name: 'ID for kjøringen',
    })) as HTMLInputElement;
    expect(field.value).toBe('');
    fireEvent.change(field, { target: { value: 'opg_7f2kq9d1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Slå opp' }));
    await giveContentReason();
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
    expect(screen.getAllByText('Satt på dokumentsamlingen').length).toBeGreaterThan(0);
  });

  it("shows the provider's status and error body on a failed run", async () => {
    const base = mockFetch();
    const failed: typeof fetch = async (input, init) => {
      if (!String(input).endsWith('/tasks/opg_7f2kq9d1/timeline')) return base(input, init);
      const answered = await base(input, init);
      if (!answered.ok) return answered;
      const run = (await answered.json()) as TaskTimeline;
      return Response.json({
        ...run,
        status: 'failed',
        steps: [
          {
            id: 'e9f',
            type: 'error',
            title: 'Steget «svar» feilet',
            summary: 'Vi fikk ikke svar fra modellen.',
            at: 1,
            blocks: [
              { kind: 'quote', text: 'step svar failed: the model is unavailable' },
              { kind: 'quote', label: 'Leverandøren svarte 503', text: 'upstream reset' },
            ],
          },
        ],
      });
    };
    await open('#/diagnostics?tenant=999888777', failed);

    fireEvent.change(await screen.findByRole('textbox', { name: 'ID for kjøringen' }), {
      target: { value: 'opg_7f2kq9d1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Slå opp' }));
    await giveContentReason();
    expect(await screen.findByText('Leverandøren svarte 503: upstream reset')).toBeTruthy();
  });

  it('says when a run is not found', async () => {
    await open('#/diagnostics?tenant=999888777');

    fireEvent.change(await screen.findByRole('textbox', { name: 'ID for kjøringen' }), {
      target: { value: 'opg_x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Slå opp' }));
    await giveContentReason();
    expect(
      await screen.findByText(
        'Fant ingen kjøring med ID «opg_x». Kjøringer slettes etter oppbevaringstiden.',
      ),
    ).toBeTruthy();
  });
});

describe('fellestjenester', () => {
  it('shows who owns each service and who it is shared with, with the drawn columns', async () => {
    await open('#/shared-services');

    const table = await screen.findByRole('region', { name: 'Delte tjenester' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Tjeneste', 'Eier', 'Utgave', 'Delt med', 'Endre']);
    const ka = within(table).getByText('Kunnskapsassistenten').closest('tr') as HTMLElement;
    expect(within(ka).getByText('Bare eieren')).toBeTruthy();
  });

  it('refuses to save the sharing that already applies, and says when a service goes back to its owner', async () => {
    await open('#/shared-services');

    const table = await screen.findByRole('region', { name: 'Delte tjenester' });
    fireEvent.click(within(table).getByRole('button', { name: 'Endre Klarspråk' }));
    const box = await screen.findByRole('dialog', { name: /Klarspråk/ });
    fireEvent.change(within(box).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Bare eieren skal bruke den' },
    });
    fireEvent.click(within(box).getByRole('button', { name: 'Lagre' }));
    expect(await within(box).findByText(/en annen deling enn den som gjelder/)).toBeTruthy();

    fireEvent.click(within(box).getByRole('radio', { name: 'Bare eieren' }));
    fireEvent.click(within(box).getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText('Klarspråk er nå bare tilgjengelig for eieren.')).toBeTruthy();
  });

  it('shares a service with all organisations only after a reason', async () => {
    const { calls, fetch } = recording();
    await open('#/shared-services', fetch);

    const table = await screen.findByRole('region', { name: 'Delte tjenester' });
    fireEvent.click(within(table).getByRole('button', { name: 'Endre Kunnskapsassistenten' }));
    const box = await screen.findByRole('dialog', { name: /Kunnskapsassistenten/ });
    fireEvent.click(within(box).getByRole('radio', { name: 'Alle virksomheter' }));
    fireEvent.click(within(box).getByRole('button', { name: 'Lagre' }));
    expect(await within(box).findByText(/minst 10 tegn/)).toBeTruthy();
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);

    fireEvent.change(within(box).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Felles for alle virksomheter' },
    });
    fireEvent.click(within(box).getByRole('button', { name: 'Lagre' }));
    expect(
      await screen.findByText('Kunnskapsassistenten er nå delt med alle virksomheter.'),
    ).toBeTruthy();
    const ka = within(table).getByText('Kunnskapsassistenten').closest('tr') as HTMLElement;
    expect(within(ka).getByText('Alle')).toBeTruthy();
    expect(calls.find((c) => c.method !== 'GET')?.reason).toBe('Felles for alle virksomheter');
  });
});
