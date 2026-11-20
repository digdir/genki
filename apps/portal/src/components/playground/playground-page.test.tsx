// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PlaygroundRunRequest } from '../../api/playground';
import { mockFetch } from '../../mock';
import type { PlaygroundMockOptions } from '../../mock/playground';
import { expectAccessible, renderAt } from '../../test-utils';

document.getAnimations ??= () => [];
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const question = 'Hva sier evalueringene om digital veiledning?';

const openPage = async (
  playground: PlaygroundMockOptions = {},
  wrap: (inner: typeof fetch) => typeof fetch = (inner) => inner,
) => {
  await renderAt(
    '#/playground/backend',
    wrap(mockFetch(undefined, undefined, undefined, undefined, { features: { playground } })),
  );
  return screen.findByRole('complementary', { name: 'Oppsett' });
};

const promptFile = 'prompts/rapportassistenten.nb.md';
const promptText = 'Svar saksbehandlere kort. Vis alltid kilden.';

type Stored = {
  definition: { spec: { strategy: { config?: Record<string, unknown> } } };
  files?: Record<string, string>;
};

const withPromptIn = (stored: Stored) => {
  const strategy = stored.definition.spec.strategy;
  strategy.config = { ...strategy.config, instructions: promptFile };
  stored.files = { ...stored.files, [promptFile]: promptText };
};

const withPromptFile =
  (puts: { definition: unknown; files: Record<string, string> }[] = []) =>
  (inner: typeof fetch): typeof fetch =>
  async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const draftUrl = /\/services\/rapportassistenten\/draft(\?|$)/.test(url);
    const definitionUrl = /\/definitions\/services\/rapportassistenten$/.test(url);
    if (draftUrl && init?.method === 'PUT' && typeof init.body === 'string')
      puts.push(JSON.parse(init.body) as (typeof puts)[number]);
    const response = await inner(input, init);
    if (!(draftUrl || definitionUrl) || (init?.method ?? 'GET') !== 'GET' || !response.ok)
      return response;
    const body = (await response.json()) as (Stored & { latest?: Stored }) | null;
    if (body?.latest) withPromptIn(body.latest);
    else if (body?.definition) withPromptIn(body);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

const chooseStart = (panel: HTMLElement, label: string) => {
  const select = within(panel).getByRole('combobox', { name: /^Start fra/ });
  const option = within(select).getByRole('option', { name: label }) as HTMLOptionElement;
  fireEvent.change(select, { target: { value: option.value } });
};

const run = async (text = question) => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Spørsmål' }), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
  return screen.findByRole('link', { name: 'Åpne i Logg' });
};

describe('the playground page', () => {
  it('shows the page title and the compare button while the setup loads', async () => {
    const pending: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('/playground/options')
        ? new Promise<Response>(() => undefined)
        : mockFetch()(input, init);
    };
    await renderAt('#/playground/backend', pending);

    expect(await screen.findByRole('heading', { level: 1, name: 'Prøveområdet' })).toBeTruthy();
    expect(
      (await screen.findByRole('button', { name: 'Sammenlign med et annet oppsett' })).getAttribute(
        'aria-disabled',
      ),
    ).toBe('true');
  });

  it('keeps the setup in a side panel next to the conversation, and a change applies to the next run', async () => {
    const runs: PlaygroundRunRequest[] = [];
    const panel = await openPage({ runs });

    expect(within(panel).getByText('Gjelder neste kjøring')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Samtale' })).toBeTruthy();
    chooseStart(panel, 'Tomt oppsett');
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Tilsynsrapporter 2025' }));
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Instruksjoner' }), {
      target: { value: 'Svar kort. Vis kilden.' },
    });
    await run();

    expect(runs[0]?.setup).toMatchObject({
      datasets: ['999888777/tilsynsrapporter-2025'],
      instructions: 'Svar kort. Vis kilden.',
      output: 'text',
    });
    expect(runs[0]?.setup.service).toBeUndefined();
    expectAccessible();
  });

  it('sends instructions and knowledge changed on a service start with the run and counts them as changes', async () => {
    const runs: PlaygroundRunRequest[] = [];
    const panel = await openPage({ runs });

    const instructions = within(panel).getByRole('textbox', { name: 'Instruksjoner' });
    await waitFor(() =>
      expect((instructions as HTMLTextAreaElement).value).toMatch(/^Svar saksbehandlere/),
    );
    fireEvent.change(instructions, { target: { value: 'Svar kort. Vis kilden.' } });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Tilsynsrapporter 2025' }));

    expect(
      within(panel).getByText('2 endringer fra utkastet: instruksjoner, Tilsynsrapporter 2025 på.'),
    ).toBeTruthy();
    await run();
    expect(runs[0]?.setup).toMatchObject({
      service: { id: 'rapportassistenten', version: 'draft' },
      instructions: 'Svar kort. Vis kilden.',
      datasets: ['digdir/kudos', '999888777/tilsynsrapporter-2025'],
    });
  });

  it('shows the instructions read-only with the reason when the way of working has no instructions field', async () => {
    const runs: PlaygroundRunRequest[] = [];
    const panel = await openPage({ runs });
    chooseStart(panel, 'Postsortering, utkast');

    const instructions = within(panel).getByRole('textbox', { name: 'Instruksjoner' });
    expect(instructions.hasAttribute('readonly')).toBe(true);
    expect(instructions.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      document.getElementById(instructions.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toMatch(/har ingen instruksjoner å bytte ut/);
    expect(within(panel).getByText('Fast stegflyt «Sorter posten», v1')).toBeTruthy();
    expect(runs).toHaveLength(0);
  });

  it('shows the price of each model with its unit and where its data is processed', async () => {
    const panel = await openPage();

    const facts = within(panel).getByText(/^Data i Norge ·/);
    expect(facts.textContent).toBe(
      'Data i Norge · inn 11,90\u00a0kr / ut 95,20\u00a0kr per 1M tokens',
    );
  });

  it('shows the instruction text when the service keeps its instructions in a prompt file', async () => {
    await openPage({}, withPromptFile());
    const panel = await screen.findByRole('complementary', { name: 'Oppsett' });
    const instructions = within(panel).getByRole('textbox', { name: 'Instruksjoner' });

    await waitFor(() => expect((instructions as HTMLTextAreaElement).value).toBe(promptText));
    expect(within(panel).queryByText(/endring fra utkastet/)).toBeNull();
  });

  it('saves changed instructions into the prompt file and keeps the file reference', async () => {
    const puts: { definition: unknown; files: Record<string, string> }[] = [];
    await openPage({}, withPromptFile(puts));
    const panel = await screen.findByRole('complementary', { name: 'Oppsett' });
    const instructions = within(panel).getByRole('textbox', { name: 'Instruksjoner' });
    await waitFor(() => expect((instructions as HTMLTextAreaElement).value).toBe(promptText));
    fireEvent.change(instructions, { target: { value: 'Svar kort. Vis kilden.' } });

    fireEvent.click(
      within(panel).getByRole('button', { name: 'Lagre i utkastet til Rapportassistenten' }),
    );
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Lagre i utkastet' }),
    );
    await screen.findByText(/Endringene er lagret i utkastet/);

    expect(puts[0]?.definition).toMatchObject({
      spec: { strategy: { config: { instructions: promptFile } } },
    });
    expect(puts[0]?.files).toEqual({ [promptFile]: 'Svar kort. Vis kilden.' });
  });

  it('saves the changes in the service draft only after asking, and never publishes', async () => {
    const requests: { method: string; url: string; body?: unknown }[] = [];
    const inner = mockFetch();
    const recording: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push({
        method: init?.method ?? 'GET',
        url,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      return inner(input, init);
    };
    await renderAt('#/playground/backend', recording);
    const panel = await screen.findByRole('complementary', { name: 'Oppsett' });
    const instructions = within(panel).getByRole('textbox', { name: 'Instruksjoner' });
    await waitFor(() =>
      expect((instructions as HTMLTextAreaElement).value).toMatch(/^Svar saksbehandlere/),
    );
    fireEvent.change(instructions, { target: { value: 'Svar kort. Vis kilden.' } });

    fireEvent.click(
      within(panel).getByRole('button', { name: 'Lagre i utkastet til Rapportassistenten' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Lagre i utkastet til Rapportassistenten?' });
    expect(within(dialog).getByText('instruksjoner')).toBeTruthy();
    expect(within(dialog).getByText(/blir ikke publisert/)).toBeTruthy();
    const writes = () => requests.filter((r) => r.method !== 'GET');
    expect(writes().filter((r) => r.url.endsWith('/draft'))).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre i utkastet' }));
    expect(
      await screen.findByText(
        'Endringene er lagret i utkastet til Rapportassistenten. Ingenting er publisert.',
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Åpne utkastet til Rapportassistenten' })
        .getAttribute('href'),
    ).toBe('#/services/rapportassistenten/setup');
    const saved = writes().find(
      (r) => r.method === 'PUT' && r.url.endsWith('/services/rapportassistenten/draft'),
    );
    expect(saved?.body).toMatchObject({
      definition: { spec: { strategy: { config: { instructions: 'Svar kort. Vis kilden.' } } } },
    });
    expect(
      writes().filter((r) => r.url.includes('publish') || /\/definitions$/.test(r.url)),
    ).toEqual([]);
  });

  it('stops counting instructions as a change once they are saved in the draft', async () => {
    const panel = await openPage();
    const instructions = within(panel).getByRole('textbox', { name: 'Instruksjoner' });
    await waitFor(() =>
      expect((instructions as HTMLTextAreaElement).value).toMatch(/^Svar saksbehandlere/),
    );
    fireEvent.change(instructions, { target: { value: 'Svar kort. Vis kilden.' } });
    expect(within(panel).getByText('1 endring fra utkastet: instruksjoner.')).toBeTruthy();

    fireEvent.click(
      within(panel).getByRole('button', { name: 'Lagre i utkastet til Rapportassistenten' }),
    );
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Lagre i utkastet' }),
    );
    await screen.findByText(/Endringene er lagret i utkastet/);

    await waitFor(() => expect(within(panel).queryByText(/endring fra utkastet/)).toBeNull());
    expect((instructions as HTMLTextAreaElement).value).toBe('Svar kort. Vis kilden.');
  });

  it('keeps a dataset the draft added when saving a change made from an older version', async () => {
    const puts: { definition: { spec: { knowledge?: { datasets?: { dataset: string }[] } } } }[] =
      [];
    const inner = mockFetch();
    const recording: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === 'PUT' && url.endsWith('/draft') && typeof init.body === 'string')
        puts.push(JSON.parse(init.body) as (typeof puts)[number]);
      return inner(input, init);
    };
    await renderAt('#/playground/backend', recording);
    const panel = await screen.findByRole('complementary', { name: 'Oppsett' });
    const save = async () => {
      fireEvent.click(
        within(panel).getByRole('button', { name: 'Lagre i utkastet til Rapportassistenten' }),
      );
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Lagre i utkastet' }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    };

    fireEvent.click(
      within(panel).getByRole('checkbox', { name: 'Veiledere fra Statens eksempelverk' }),
    );
    await save();
    chooseStart(panel, 'Rapportassistenten, versjon 7');
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Tilsynsrapporter 2025' }));
    expect(
      within(panel).getByText('1 endring fra versjon 7: Tilsynsrapporter 2025 på.'),
    ).toBeTruthy();
    await save();

    expect(puts).toHaveLength(2);
    expect(puts[1]?.definition.spec.knowledge?.datasets?.map((d) => d.dataset)).toEqual(
      expect.arrayContaining(['999888777/veiledere', '999888777/tilsynsrapporter-2025']),
    );
  });

  it('shows the way of working on each side and offers to use B in its draft only after asking', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Sammenlign med et annet oppsett' }));
    const sideA = screen.getByRole('region', { name: /^Oppsett A:/ });
    const sideB = screen.getByRole('region', { name: /^Oppsett B:/ });
    expect(within(sideA).getByText('Arbeidsmåte').nextElementSibling?.textContent).toBe(
      'Agent (søker selv)',
    );
    expect(within(sideA).queryByRole('button', { name: 'Bruk A i utkastet' })).toBeNull();

    fireEvent.click(within(sideB).getByRole('button', { name: 'Bruk B i utkastet' }));
    const dialog = screen.getByRole('dialog', { name: 'Lagre i utkastet til Rapportassistenten?' });
    expect(within(dialog).getByText('modell Qwen3.8-27B')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Avbryt' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the sources of an answer in one line and opens a source from its citation', async () => {
    await openPage();
    await run();

    const answer = screen.getByRole('article');
    expect(
      within(answer).getByText(/^Kilder?: Evaluering av digital veiledning i Testetaten \(2023\)/),
    ).toBeTruthy();
    expect(within(answer).queryByRole('list', { name: 'Kilder' })).toBeNull();
    const [citation] = within(answer).getAllByRole('button', { name: /Kilde 1/ });
    fireEvent.click(citation as HTMLElement);
    expect(
      within(answer).getByRole('region', { name: /Evaluering av digital veiledning/ }),
    ).toBeTruthy();
  });

  it('picks the model with the model picker and counts it as a change from the start', async () => {
    const runs: PlaygroundRunRequest[] = [];
    const panel = await openPage({ runs });

    fireEvent.click(within(panel).getByRole('button', { name: 'Bytt modell' }));
    const picker = screen.getByRole('dialog', { name: 'Velg modell' });
    fireEvent.click(within(picker).getByRole('radio', { name: /Qwen3\.8-27B/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Bruk Qwen3.8-27B' }));

    expect(within(panel).getByText(/^1 endring fra utkastet: modell Qwen3\.8-27B\.$/)).toBeTruthy();
    await run();
    expect(runs[0]?.setup.model).toBe('aivar/qwen3-8');
  });

  it('shows the timeline of the answer with each step and its duration, and a step opens to show what went in and out', async () => {
    await openPage();
    await run();

    const timeline = screen.getByRole('region', { name: 'Tidslinje for svaret' });
    const rows = within(timeline).getAllByRole('button');
    expect(rows.length).toBeGreaterThan(2);
    const model = within(timeline).getByRole('button', { name: /^Modellkall\s*·\s*Borealis-27B/ });
    expect(model.textContent).toMatch(/\d s$/);
    expect(model.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(model);
    expect(model.getAttribute('aria-expanded')).toBe('true');
    const detail = document.getElementById(model.getAttribute('aria-controls') ?? '');
    expect(detail).toBeTruthy();
    expect(
      within(detail as HTMLElement).getByRole('list', { name: 'Modellkall · Borealis-27B' }),
    ).toBeTruthy();
    expect(within(detail as HTMLElement).getByText('Tokens')).toBeTruthy();

    fireEvent.click(model);
    expect(model.getAttribute('aria-expanded')).toBe('false');
    expectAccessible();
  });

  it('gives a step without a duration a time in the timeline instead of a blank', async () => {
    await openPage();
    await run();

    const timeline = screen.getByRole('region', { name: 'Tidslinje for svaret' });
    const answer = within(timeline).getByRole('button', { name: /^Svar/ });
    expect(answer.textContent).toMatch(/<1 ms$/);
  });

  it('links an answer to its run in Logg with an English query key', async () => {
    await openPage();
    const link = await run();

    expect(link.getAttribute('href')).toMatch(/^#\/log\?run=tp\d+$/);
  });

  it('marks as different only what differs between A and B', async () => {
    const panel = await openPage();
    await waitFor(() =>
      expect(
        (within(panel).getByRole('textbox', { name: 'Instruksjoner' }) as HTMLTextAreaElement)
          .value,
      ).toMatch(/^Svar saksbehandlere/),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sammenlign med et annet oppsett' }));

    const sideA = screen.getByRole('region', { name: /^Oppsett A:/ });
    const marks = within(sideA)
      .getAllByText('Ulikt')
      .map((tag) => tag.closest('dd')?.previousElementSibling?.textContent);
    expect(marks).toEqual(['Modell']);

    const sideB = screen.getByRole('region', { name: /^Oppsett B:/ });
    chooseStart(sideB, 'Tomt oppsett');
    expect(within(sideB).getByRole('heading', { name: /Tomt oppsett$/ })).toBeTruthy();
    expect(
      within(sideA)
        .getAllByText('Ulikt')
        .map((tag) => tag.closest('dd')?.previousElementSibling?.textContent),
    ).toEqual(['Modell', 'Instruksjoner', 'Kunnskap']);
  });

  it('hides and shows the setup of one side with a button that says whether it is open', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Sammenlign med et annet oppsett' }));
    const sideA = screen.getByRole('region', { name: /^Oppsett A:/ });

    const toggle = within(sideA).getByRole('button', { name: 'Skjul oppsett' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(
      within(sideA).getByRole('button', { name: 'Vis oppsett' }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(within(sideA).queryByRole('combobox', { name: /Start fra/ })).toBeNull();
  });

  it('runs both setups with Enter in the question to both, and Shift+Enter adds a line', async () => {
    const runs: PlaygroundRunRequest[] = [];
    await openPage({ runs });
    fireEvent.click(screen.getByRole('button', { name: 'Sammenlign med et annet oppsett' }));
    const input = screen.getByRole('textbox', { name: 'Spørsmål til begge' });
    fireEvent.change(input, { target: { value: question } });

    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(runs).toHaveLength(0);
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.compareWith).toBeTruthy();
    expect(screen.getByText(/^To kjøringer, koster som to vanlige kjøringer\./)).toBeTruthy();
  });

  it('keeps the conversation when leaving a comparison, and sends no compared answer as history', async () => {
    const runs: PlaygroundRunRequest[] = [];
    await openPage({ runs });
    await run();
    fireEvent.click(screen.getByRole('button', { name: 'Sammenlign med et annet oppsett' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Spørsmål til begge' }), {
      target: { value: 'Noe annet?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør begge' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Avslutt sammenligning' }));

    expect(screen.getAllByRole('article')).toHaveLength(1);
    await run('Og så?');
    await waitFor(() => expect(runs).toHaveLength(3));
    expect(runs[2]?.history?.map((turn) => turn.text)).toEqual([question, expect.any(String)]);
  });
});
